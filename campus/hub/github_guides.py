"""Evidence-linked Chinese project guides. Repository text is data, never instructions."""
import base64
import hashlib
import json
import os
import re
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen
from django.utils import timezone
from django.db import transaction
from .core import Problem, require, text
from .models import Audit, Entry, ExternalCache, Revision


def repository(value):
    value = text(value,300,True)
    if value.startswith('https://github.com/'):
        p = urlsplit(value)
        if p.query or p.fragment or p.username or p.port:
            raise Problem('请使用 GitHub 仓库主页链接。')
        value = p.path.strip('/')
    value = value.removesuffix('.git')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',value):
        raise Problem('请输入 https://github.com/作者/仓库 或 作者/仓库。')
    return value


def cache_key(repo):
    return 'github:'+hashlib.sha256(repo.lower().encode()).hexdigest()


def api(repo, suffix=''):
    from .github_api import request
    return request('/repos/'+repository(repo)+suffix)


def ai_capabilities():
    from .project_summaries import capabilities
    return capabilities()


def inspect(repo, refresh=False):
    repo = repository(repo)
    cache, _ = ExternalCache.objects.get_or_create(key=cache_key(repo))
    if cache.success and (timezone.now()-cache.success).total_seconds()<1800 and not refresh:
        return dict(cache.data,lastSuccess=cache.success.isoformat(),stale=bool(cache.error),error=cache.error)
    previous = cache.data
    try:
        info = api(repo)
        if info.get('private'):
            raise Problem('项目导读仅处理公开仓库。')
        full = info['full_name']
        try:
            readme = api(full,'/readme')
            raw = base64.b64decode(readme.get('content','')).decode('utf-8',errors='replace')[:80000]
        except HTTPError as exc:
            if exc.code!=404:
                raise
            readme, raw = {}, ''
        try:
            release = api(full,'/releases/latest')
        except HTTPError as exc:
            if exc.code!=404:
                raise
            release = {}
        try:
            root = api(full,'/contents')
            files = [f['name'] for f in root if isinstance(f,dict)] if isinstance(root,list) else []
        except HTTPError:
            files = []
        readme_url = readme.get('html_url') or info['html_url']+'#readme'
        evidence = [{'id':'repository','url':info['html_url'],'text':json.dumps({k:info.get(k) for k in ('description','language','topics','license','archived')},ensure_ascii=False)}]
        lines = raw.splitlines()
        # Stable identifiers and exact line ranges provide inspectable provenance.
        for offset in range(0,min(len(lines),750),30):
            block = '\n'.join(lines[offset:offset+30])[:5000]
            evidence.append({'id':f'readme-{offset+1}','url':readme_url+f'#L{offset+1}-L{min(offset+30,len(lines))}',
                             'text':block,'startLine':offset+1,'endLine':min(offset+30,len(lines))})
        # Include a Chinese README or dependency manifest when explicitly present.
        documents = []
        names = [f for f in files if f.lower() in ('readme_cn.md','readme_zh.md','readme.zh-cn.md','readme_zh-cn.md','requirements.txt','package.json','pyproject.toml','platformio.ini','cargo.toml')]
        for name in names[:2]:
            if name == readme.get('path'): continue
            try:
                doc = api(full,'/contents/'+quote(name,safe=''))
                content = base64.b64decode(doc.get('content','')).decode('utf-8',errors='replace')[:10000]
                doc_url = doc.get('html_url') or info['html_url']
                documents.append({'path':name,'sha':doc.get('sha'),'url':doc_url})
                for index in range(0,len(content),3000):
                    evidence.append({'id':f'doc-{len(documents)}-{index}','url':doc_url,'text':content[index:index+3000]})
            except HTTPError: pass
        evidence.append({'id':'release','url':release.get('html_url') or info['html_url']+'/releases',
                         'text':json.dumps({'version':release.get('tag_name'), 'notes':(release.get('body') or '')[:5000],
                                            'assets':[{'name':a.get('name'),'size':a.get('size')} for a in release.get('assets',[])[:30]]},ensure_ascii=False)})
        # Bound model context deterministically. Original README remains available separately.
        budget, bounded = 30000, []
        for e in [evidence[0], evidence[-1], *evidence[1:-1]]:
            if budget <= 0: break
            e['text'] = e['text'][:budget];budget -= len(e['text']);bounded.append(e)
        evidence = bounded
        downloads = []
        for asset in release.get('assets',[])[:30]:
            link = asset.get('browser_download_url','')
            if link.startswith('https://github.com/'+full+'/releases/download/'):
                downloads.append({'name':asset['name'],'url':link,'bytes':asset['size'],
                                  'kind':'official-release','version':release.get('tag_name',''),
                                  'upstreamId':asset.get('id'), 'digest':asset.get('digest'), 'updatedAt':asset.get('updated_at')})
        branch = quote(info.get('default_branch','main'),safe='')
        downloads.append({'name':'源代码 ZIP（需要按说明构建）','url':info['html_url']+'/archive/refs/heads/'+branch+'.zip','kind':'source-archive'})
        license_info = info.get('license') or {}
        license_id = license_info.get('spdx_id')
        if license_id in ('NOASSERTION','OTHER'):
            license_id = None
        result = {'repository':full,'url':info['html_url'],'description':info.get('description') or '',
                  'credit':info['owner']['login'],'stars':info.get('stargazers_count',0),
                  'language':info.get('language'),'topics':info.get('topics',[]),'archived':info.get('archived',False),
                  'license':license_id,'pushedAt':info.get('pushed_at'),'createdAt':info.get('created_at'),
                  'readmeUrl':readme_url,'readme':raw,'readmeSha':readme.get('sha',''),
                  'defaultBranch':info.get('default_branch','HEAD'), 'readmePath':readme.get('path','README.md'),
                  'discovery':previous.get('discovery'),
                  'releaseUrl':release.get('html_url') or info['html_url']+'/releases',
                  'releaseVersion':release.get('tag_name'), 'downloads':downloads,'evidence':evidence,'documents':documents,
                  'checks':{'readme':bool(raw),'licenseDeclared':bool(license_id),'officialRelease':bool(release),
                            'testsDirectory':any(f.lower() in ('test','tests','__tests__') for f in files),
                            'archived':bool(info.get('archived'))},
                  'guide':{'state':'awaiting-model','message':ai_capabilities()['message']},
                  'selection':previous.get('selection'), 'entryId':previous.get('entryId'),
                  'verifiedAt':timezone.now().isoformat()}
        from .project_catalog import classify, download_hint, fingerprint
        result['downloads'] = [download_hint(d) for d in downloads]
        result['classification'] = previous['classification'] if (previous.get('classification') or {}).get('method') == 'maintainer' else classify(result)
        old_guide = previous.get('guide') or {}
        unchanged = (old_guide.get('sourceFingerprint') == fingerprint(result)) if old_guide.get('formatVersion') == 2 else previous.get('readmeSha') == result['readmeSha']
        if unchanged and old_guide.get('state')=='generated':
            result['guide'] = previous['guide']
        if result.get('selection') and previous.get('readmeSha') != result['readmeSha']:
            result['selection'] = dict(result['selection'],needsRecheck=True)
        cache.data, cache.success, cache.error = result, timezone.now(), ''
    except Exception as exc:
        cache.error = 'GitHub 信息暂时无法更新，请稍后重试。'
        if not previous:
            cache.checked = timezone.now()
            cache.save()
            raise Problem(cache.error,502) from exc
    cache.checked = timezone.now()
    cache.save()
    return dict(cache.data,lastSuccess=cache.success.isoformat() if cache.success else None,stale=bool(cache.error),error=cache.error)


def generate_guide(repo, request_key=None):
    from .project_summaries import generate
    return generate(repository(repo), request_key)


@transaction.atomic
def curate(user, body):
    require(user,staff=True)
    repo = repository(body.get('repository',''))
    cache = ExternalCache.objects.filter(pk=cache_key(repo)).first()
    if not cache or not cache.success:
        raise Problem('请先获取项目原始资料。')
    shelf = body.get('shelf')
    if shelf not in ('practical','creative','potential','unlisted'):
        raise Problem('请选择实用精选、新奇实验或潜力项目。')
    reason = text(body.get('reason',''),1500,True)
    checks = body.get('checks',{})
    if shelf != 'unlisted' and (not isinstance(checks,dict) or not all(checks.get(k) is True for k in ('sourceRead','licenseChecked','downloadsChecked'))):
        raise Problem('精选前请核对原文、许可和下载入口。')
    tested = text(body.get('testEvidence',''),1000)
    from .project_catalog import TAXONOMY
    category = body.get('category')
    if category is not None and category not in TAXONOMY and category != 'unclassified':
        raise Problem('项目分类无效。')
    if category:
        labels = [] if category == 'unclassified' else [{'id':category,'name':TAXONOMY[category][0],'reasons':[]}]
        cache.data['classification'] = dict(cache.data.get('classification') or {}, primary=category,labels=labels,
                                            needsReview=False,method='maintainer',reviewer=user.username,reviewedAt=timezone.now().isoformat())
    cache.data = dict(cache.data,selection={'shelf':shelf,'reason':reason,'reviewer':user.username,
        'reviewedAt':timezone.now().isoformat(),'sourceSha':cache.data.get('readmeSha'),
        'checks':{k:checks.get(k) is True for k in ('sourceRead','licenseChecked','downloadsChecked')},
        'testEvidence':tested,'tested':bool(tested),'needsRecheck':False})
    # A curated external project gets the same Star/watch/discussion identity as other content.
    canonical = 'project:'+cache.data['url'].rstrip('/')
    entry = Entry.objects.filter(canonical_key=canonical).first()
    if not entry and shelf!='unlisted':
        payload = {'title':cache.data['repository'],'summary':cache.data.get('description') or reason,
                   'body':reason,'credit':cache.data['credit'],'license':cache.data.get('license') or '许可待核，仅链接',
                   'links':{'repo':cache.data['url'],'release':cache.data['releaseUrl']},
                   'tags':cache.data.get('topics',[])[:12],'uploads':[],'category':(cache.data.get('classification') or {}).get('primary','software'),
                   'sourceNote':'外部项目推荐，原作者保留署名'}
        entry = Entry.objects.create(kind='project',slug='github-'+hashlib.sha256(repo.lower().encode()).hexdigest()[:20],
            state='published',draft=payload,published=payload,public_revision=1,canonical_key=canonical,
            search_text=json.dumps(payload,ensure_ascii=False))
        Revision.objects.create(entry=entry,number=1,data=payload,state='published',reviewer=user,note=reason)
    if entry:
        cache.data['entryId'] = str(entry.pk)
    if cache.data.get('guide',{}).get('state')=='generated' and body.get('approveGuide') is True:
        from .project_catalog import fingerprint
        if cache.data['guide'].get('formatVersion') == 2 and cache.data['guide'].get('sourceFingerprint') != fingerprint(cache.data):
            raise Problem('导读原文已变化，请重新生成后再核对。',409)
        cache.data['guide'] = dict(cache.data['guide'],reviewState='reviewed',reviewer=user.username,
                                   notice='AI 辅助导读，维护者已核对；原文与实测记录分别列示。')
    cache.save(update_fields=['data'])
    if shelf != 'unlisted':
        from .models import Job
        Job.objects.get_or_create(key='mirror-after-curate:'+hashlib.sha256((repo+str(cache.data.get('releaseVersion'))).encode()).hexdigest(),
                                  defaults={'kind':'mirror-repo','payload':{'repository':repo},'due':timezone.now(),'owner':user})
    Audit.objects.create(actor=user,action='github:curate',target=repo,detail={'shelf':shelf,'reason':reason})
    return cache.data
