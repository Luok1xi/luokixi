"""Immutable project files, attribution, integrity verification and resumable same-origin downloads."""
import base64
import hashlib
import os
import re
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from django.db.models import F, Sum
from django.http import FileResponse, HttpResponse, StreamingHttpResponse
from django.utils.http import content_disposition_header
from django.utils import timezone
from .core import Problem
from .models import MirrorAsset
from .project_catalog import download_hint

PERMISSIVE_BINARY = {'MIT','MIT-0','Apache-2.0','BSD-2-Clause','BSD-3-Clause','ISC','Zlib','BSL-1.0','Unlicense','0BSD','CC0-1.0'}


@contextmanager
def store_lock():
    from .mirror import mirror_root
    with (mirror_root() / '.store.lock').open('a+b') as f:
        f.seek(0);f.write(b'0');f.flush();f.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:
            raise Problem('另一个下载机器人正在写入仓库，稍后重试。',409)
        try: yield
        finally:
            f.seek(0)
            if os.name == 'nt': msvcrt.locking(f.fileno(),msvcrt.LK_UNLCK,1)
            else: fcntl.flock(f,fcntl.LOCK_UN)


def local_path(asset):
    from .mirror import mirror_root
    root=mirror_root().resolve()
    path=(root/asset.path).resolve()
    if path.parent != root or not re.fullmatch(r'[a-f0-9]{32}[.a-z0-9]+',asset.path):
        raise Problem('文件路径无效。',404)
    return path


def serialize(asset):
    meta=asset.metadata or {}
    try: available=local_path(asset).is_file() and local_path(asset).stat().st_size == asset.size
    except (OSError,Problem): available=False
    data={'id':str(asset.pk),'name':asset.name,'tag':asset.tag,'size':asset.size,'sha256':asset.sha256,
          'license':asset.license,'sourceUrl':asset.source_url,'releaseUrl':asset.release_url,
          'published':asset.published.isoformat() if asset.published else None,'downloads':asset.downloads,
          'kind':meta.get('kind','unknown'),'sourceCommit':meta.get('sourceCommit'), 'upstreamDigest':meta.get('upstreamDigest'),
          'integrity':meta.get('integrity','local-sha256'),'available':available,
          'credit':meta.get('credit',asset.repository.split('/')[0]),'licenseUrl':f'/api/hub/mirror/{asset.pk}/license' if meta.get('licenseText') else None,
          'executable':asset.name.lower().endswith(('.exe','.msi','.dmg','.apk','.appimage','.deb','.rpm')),
          'url':f'/api/hub/mirror/{asset.pk}/file' if available else None}
    return download_hint(data)


def collect(repository):
    from . import mirror
    repo=mirror.repository_name(repository)
    info=mirror.github_json(f'/repos/{repo}')
    if info.get('private') or info.get('disabled'):
        raise Problem('只收录公开且可用的仓库。')
    repo=mirror.repository_name(info.get('full_name') or repo)
    spdx=mirror.license_of(info)
    state={'repository':repo,'license':spdx or '未声明','checkedAt':timezone.now().isoformat(),
           'htmlUrl':f'https://github.com/{repo}','mirrored':[],'skipped':[],'errors':[]}
    if spdx not in mirror.ALLOWED_LICENSES:
        return dict(state,status='license-blocked',reason='没有可确认的再分发许可；保留官方入口，不转存文件。')
    try: release=mirror.github_json(f'/repos/{repo}/releases/latest')
    except (HTTPError,Problem) as exc:
        if getattr(exc,'code',None)!=404 and 'HTTP 404' not in str(exc): raise
        release={}
    ref=(release or {}).get('tag_name') or info.get('default_branch') or 'main'
    commit=mirror.github_json(f'/repos/{repo}/commits/'+quote(ref,safe='')).get('sha','')
    if not re.fullmatch('[0-9a-fA-F]{40}',commit):
        raise Problem('无法确认源码版本，暂不镜像可变分支。',502)
    try:
        license_info=mirror.github_json(f'/repos/{repo}/license?ref='+commit)
        license_text=base64.b64decode(license_info.get('content','')).decode('utf-8')
        if not license_text.strip() or len(license_text)>80000 or mirror.license_of(license_info)!=spdx: raise ValueError()
    except (HTTPError,ValueError,UnicodeError,Problem):
        return dict(state,status='license-blocked',reason='尚未取得这个版本的许可证正文，需核对后才能转存。')
    tag=(release or {}).get('tag_name') or 'source-'+commit[:12]
    page=(release or {}).get('html_url') or f'https://github.com/{repo}/tree/{commit}'
    source={'name':repo.split('/')[1]+'-'+commit[:12]+'.zip','size':0,'url':f'https://codeload.github.com/{repo}/zip/{commit}',
            'kind':'source-archive','id':'source:'+commit,'updated':commit,'digest':None}
    candidates=[source]
    for asset in (release or {}).get('assets',[]):
        name=asset.get('name','')
        if not mirror.extension_of(name): continue
        if spdx not in PERMISSIVE_BINARY:
            state['skipped'].append({'name':name,'reason':'此许可的发布包需要额外核对对应源码与再分发条件，本轮仅保存源码。'});continue
        target=asset.get('browser_download_url','')
        if not target.startswith(f'https://github.com/{repo}/releases/download/'):
            state['skipped'].append({'name':name,'reason':'不是该仓库的官方发布附件地址。'});continue
        candidates.append({'name':name,'size':int(asset.get('size') or 0),'url':target,'kind':'official-release',
                           'id':asset.get('id'),'updated':asset.get('updated_at'),'digest':asset.get('digest')})
        if len(candidates)>mirror.MAX_ASSETS_PER_RELEASE: break
    # Source is first so every binary has a local source reference as well.
    with store_lock():
        used=MirrorAsset.objects.aggregate(n=Sum('size'))['n'] or 0
        for item in candidates:
            if not item['name'] or len(item['name'])>200 or any(c in item['name'] for c in '\\/:\r\n'):
                state['skipped'].append({'name':item['name'],'reason':'附件名称不适合本站存储。'});continue
            upstream={'id':item['id'],'updated':item['updated'],'digest':item['digest'],'commit':commit}
            old=MirrorAsset.objects.filter(repository=repo,tag=tag,name=item['name']).first()
            if old:
                if old.metadata.get('upstream')!=upstream:
                    state['skipped'].append({'name':item['name'],'reason':'同版本同名文件已变化，保留旧副本，需维护者核对。'});continue
                if serialize(old)['available']:
                    state['skipped'].append({'name':item['name'],'reason':'已经镜像过'});continue
            allowance=min(mirror.MAX_ASSET_BYTES,mirror.MAX_TOTAL_BYTES-used+(old.size if old else 0))
            if allowance<=0 or item['size']>allowance:
                state['skipped'].append({'name':item['name'],'reason':'超过单文件或本站剩余空间上限。'});continue
            destination=mirror.mirror_root()/(uuid.uuid4().hex+(mirror.extension_of(item['name']) or '.zip'))
            try:
                size,sha,final=mirror.stream_public(item['url'],destination,allowance)
                if size<=0 or size>allowance or (item['size'] and size!=item['size']):
                    raise Problem('文件大小与官方信息不一致，未入库。')
                # Check actual stored bytes, not only the download helper's return value.
                hasher=hashlib.sha256()
                with destination.open('rb') as f:
                    for chunk in iter(lambda:f.read(1024*1024),b''): hasher.update(chunk)
                if hasher.hexdigest()!=sha: raise Problem('落盘校验失败，未入库。')
                digest=item['digest'] or ''
                if digest and (not re.fullmatch('sha256:[a-fA-F0-9]{64}',digest) or sha.lower()!=digest.split(':')[1].lower()):
                    raise Problem('文件与 GitHub 官方校验值不一致，未入库。')
                when=(release or {}).get('published_at') or info.get('pushed_at')
                try: when=datetime.fromisoformat(when.replace('Z','+00:00')) if when else None
                except ValueError: when=None
                meta={'kind':item['kind'],'sourceCommit':commit,'credit':repo.split('/')[0],'licenseText':license_text,
                      'licenseSource':license_info.get('html_url'),'upstream':upstream,'upstreamDigest':digest,
                      'integrity':'upstream-sha256-matched' if digest else 'local-sha256','downloadedAt':timezone.now().isoformat()}
                values=dict(size=size,sha256=sha,license=spdx,source_url=item['url'],release_url=page,published=when,path=destination.name,metadata=meta)
                if old:
                    oldpath=local_path(old)
                    MirrorAsset.objects.filter(pk=old.pk).update(**values)
                    oldpath.unlink(missing_ok=True)
                    used-=old.size
                else: MirrorAsset.objects.create(repository=repo,tag=tag,name=item['name'],**values)
                used+=size;state['mirrored'].append({'name':item['name'],'size':size,'sha256':sha,'kind':item['kind']})
            except Exception as exc:
                destination.unlink(missing_ok=True)
                state['errors'].append(f'{item["name"]}：{exc}')
    return dict(state,status='partial' if state['errors'] else 'ok',tag=tag,sourceCommit=commit)


def download(request, asset, license_only=False):
    if license_only:
        content=(asset.metadata or {}).get('licenseText')
        if not content: raise Problem('尚未保存许可证正文，请查看原仓库。',404)
        response=HttpResponse(content,content_type='text/plain; charset=utf-8')
        response['Content-Disposition']=content_disposition_header(True,asset.repository.replace('/','-')+'-LICENSE.txt')
        return response
    path=local_path(asset)
    if not path.is_file() or path.stat().st_size!=asset.size:
        raise Problem('本站副本不可用，请选择原站入口。',410)
    etag='"'+asset.sha256+'"'
    start,end=0,asset.size-1
    range_header=request.headers.get('Range','')
    if request.headers.get('If-Range') not in (None,etag): range_header=''
    if range_header:
        match=re.fullmatch(r'bytes=(\d*)-(\d*)',range_header)
        if not match or not any(match.groups()):
            response=HttpResponse(status=416);response['Content-Range']=f'bytes */{asset.size}';return response
        a,b=match.groups()
        if a: start=int(a);end=min(int(b) if b else end,end)
        else: start=max(0,asset.size-int(b))
        if start>end or start>=asset.size or (not a and int(b)==0):
            response=HttpResponse(status=416);response['Content-Range']=f'bytes */{asset.size}';return response
    def stream():
        with path.open('rb') as f:
            f.seek(start);remaining=end-start+1
            while remaining:
                chunk=f.read(min(1024*1024,remaining))
                if not chunk: break
                remaining-=len(chunk);yield chunk
    response=StreamingHttpResponse(stream(),status=206 if range_header else 200,content_type='application/octet-stream')
    response['Content-Disposition']=content_disposition_header(True,asset.name)
    response['Content-Length']=str(end-start+1)
    response['Accept-Ranges']='bytes';response['ETag']=etag;response['X-Checksum-SHA256']=asset.sha256
    response['X-Content-Type-Options']='nosniff';response['Cache-Control']='public, max-age=86400'
    if range_header: response['Content-Range']=f'bytes {start}-{end}/{asset.size}'
    if start==0 and end>0: MirrorAsset.objects.filter(pk=asset.pk).update(downloads=F('downloads')+1)
    return response
