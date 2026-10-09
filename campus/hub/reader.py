"""Same-origin reading of stored files and published content; never fetch arbitrary URLs."""
import json
import re
import zipfile
import uuid
from pathlib import Path, PurePosixPath
from django.conf import settings
from django.http import FileResponse, HttpResponse
from django.utils.http import content_disposition_header
from .core import Problem, entry_for
from .models import ExternalCache, MirrorAsset, Reply

TEXT_LIMIT = 256 * 1024
TEXT_EXTENSIONS = {'.txt', '.md', '.csv', '.json', '.ipynb', '.py', '.js', '.mjs', '.ts', '.tsx', '.jsx',
                   '.c', '.cpp', '.h', '.rs', '.go', '.java', '.css', '.html', '.xml', '.yaml', '.yml', '.toml', '.ini', '.step', '.stp'}
INLINE_TYPES = {'.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
                '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm'}


def text_file(name):
    p = PurePosixPath(name)
    return p.suffix.lower() in TEXT_EXTENSIONS or p.name.lower().startswith(('readme', 'license', 'copying', 'notice'))


def archived(path, member=''):
    """Inspect bounded ZIP members without extracting or executing package contents."""
    try:
        with zipfile.ZipFile(path) as archive:
            all_items = archive.infolist()
            if len(all_items) > 20000:
                raise Problem('压缩包目录过大，请下载后查看。', 422)
            items = [i for i in all_items if not i.is_dir() and not i.filename.startswith(('/', '\\'))
                     and '..' not in PurePosixPath(i.filename.replace('\\', '/')).parts]
            if member:
                matches = [i for i in items if i.filename == member]
                if len(matches) != 1:
                    raise Problem('压缩包中的文件不存在或名称重复。', 404)
                info = matches[0]
                if not text_file(info.filename) or info.file_size > TEXT_LIMIT or info.flag_bits & 1:
                    raise Problem('此文件不适合文本预览，请下载压缩包查看。', 422)
                with archive.open(info) as stream:
                    raw = stream.read(TEXT_LIMIT + 1)
                if len(raw) > TEXT_LIMIT:
                    raise Problem('文件超出预览大小。', 422)
                return {'member': member, 'text': raw.decode('utf-8-sig', errors='replace')}
            return {'files': [{'name': i.filename, 'bytes': i.file_size,
                               'readable': text_file(i.filename) and i.file_size <= TEXT_LIMIT and not i.flag_bits & 1}
                              for i in items[:2000]], 'fileCount': len(items), 'truncated': len(items) > 2000}
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError):
        raise Problem('压缩包无法预览，可下载原件。', 422)


def entry_document(user, identifier):
    entry = entry_for(user, identifier)
    data = entry.published if entry.public_revision else entry.draft
    title = data.get('title') or '未命名内容'
    author = (entry.owner.display_name or entry.owner.username) if entry.owner_id else '未记录'
    lines = ['# ' + title, '', '上传者：' + author, '上传时间：' + entry.created.isoformat(),
             '更新于：' + entry.updated.isoformat(), '版本：' + str(entry.public_revision or entry.revision),
             '状态：' + ('已公开' if entry.public_revision and entry.state != 'withdrawn' else entry.state), '']
    for key, label in [('summary', '简介'), ('body', '正文'), ('setup', '上手说明'), ('needs', '准备'),
                       ('environment', '环境'), ('steps', '步骤'), ('results', '结果'), ('failures', '未解决问题'),
                       ('license', '许可'), ('credit', '署名'), ('sourceNote', '来源说明')]:
        if data.get(key):
            lines += ['## ' + label, '', str(data[key]), '']
    if entry.kind == 'project':
        from .github_guides import repository, cache_key
        try:
            repo = repository(data.get('links', {}).get('repo', ''))
            cached = ExternalCache.objects.filter(pk=cache_key(repo)).first()
        except Problem:
            cached = None
        if cached:
            guide = cached.data.get('guide') or {}
            for section in guide.get('sections', []):
                label = '已核对' if guide.get('reviewState') == 'reviewed' else '自动导读，尚未核对'
                lines += ['## ' + str(section.get('heading', '中文导读')) + ' · ' + label, '', str(section.get('text') or section.get('body') or ''), '']
    if data.get('maintenanceFacts'):
        facts = data['maintenanceFacts']
        lines += ['## 未解决事项（执行记录）','']
        lines += [str(r['robot'])+'：'+{'failed':'失败','partial':'部分完成'}.get(r['state'],r['state'])+' · '+str(r.get('error','')) for r in facts.get('unresolved',[])] or ['此次记录没有失败项；不代表全站没有问题。']
    for label, target in data.get('links', {}).items():
        if isinstance(target, str) and target.startswith(('https://', 'http://')):
            lines += [f'{label}：{target}']
    replies = Reply.objects.filter(entry=entry, state='published').select_related('author').order_by('created')[:500]
    if replies:
        lines += ['', '## 公开讨论', '']
        for reply in replies:
            lines += [f'### {reply.author.display_name or reply.author.username} · {reply.created.isoformat()}', '', reply.body, '']
    original = (data.get('languageVersions') or {}).get('original') or {}
    original_text = ('# '+str(original.get('title','原文'))+'\n\n'+str(original.get('body',''))) if original else ''
    if entry.kind == 'project' and cached and cached.data.get('readme'):
        original_text = '# 原文 README\n\n'+str(cached.data['readme'])
    return {'title': title, 'mode': 'markdown', 'text': '\n'.join(lines), 'originalText':original_text,
            'downloadUrl': f'/api/hub/reader/entry/{entry.pk}/download',
            'backUrl': f'/project.html?id={entry.pk}', 'entryId': str(entry.pk)}


def stored_file(user, kind, identifier):
    if kind == 'upload':
        from .files import visible_upload
        upload = visible_upload(user, identifier, for_photo=True)
        root = settings.MEDIA_ROOT.resolve()
        path = (root / upload.asset.path).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise Problem('原件暂不可用。', 404)
        # Public photos always use the existing metadata-free display copy.
        if upload.asset.extension in {'.png', '.jpg', '.jpeg', '.webp'}:
            return path, upload.name, f'/api/hub/uploads/{upload.pk}/photo', True
        visible_upload(user, identifier)
        return path, upload.name, f'/api/hub/uploads/{upload.pk}/file', False
    if kind == 'mirror':
        from .mirror_store import local_path, serialize
        asset = MirrorAsset.objects.filter(pk=identifier).first()
        if not asset or not serialize(asset)['available']:
            raise Problem('本站副本暂不可用。', 404)
        return local_path(asset), asset.name, f'/api/hub/mirror/{asset.pk}/file', False
    raise Problem('不支持此阅读类型。', 404)


def get(request, route):
    parts = route.split('/')
    if len(parts) not in (3, 4):
        raise Problem('阅读入口不存在。', 404)
    _, kind, identifier, *rest = parts
    try:
        uuid.UUID(identifier)
    except ValueError:
        raise Problem('阅读入口不存在。', 404)
    action = rest[0] if rest else ''
    if action not in ('', 'inline', 'download'):
        raise Problem('阅读操作不存在。', 404)
    if kind == 'entry':
        data = entry_document(request.user, identifier)
        if request.GET.get('lang') == 'original' and data.get('originalText'):
            data['text'] = data['originalText']
        if action == 'download':
            response = HttpResponse(data['text'], content_type='text/markdown; charset=utf-8')
            filename = re.sub(r'[\\/:*?"<>|\r\n]', '_', data['title'])[:120] + '.md'
            response['Content-Disposition'] = content_disposition_header(True, filename)
            response['Cache-Control'] = 'private, no-store'
            return response
        return data
    path, name, download, photo = stored_file(request.user, kind, identifier)
    ext = Path(name).suffix.lower()
    mime = INLINE_TYPES.get(ext)
    if action == 'inline':
        if photo:
            from .files import photo_preview
            return photo_preview(request.user, identifier)
        if not mime:
            raise Problem('此文件请通过文本预览或下载查看。', 422)
        response = FileResponse(path.open('rb'), content_type=mime, filename=name)
        response['Content-Security-Policy'] = "default-src 'none'; sandbox"
        response['X-Frame-Options'] = 'SAMEORIGIN'
        response['X-Content-Type-Options'] = 'nosniff'
        response['Cache-Control'] = 'private, no-store'
        return response
    data = {'title': name, 'bytes': path.stat().st_size, 'downloadUrl': download,
            'previewUrl': download if photo else f'/api/hub/reader/{kind}/{identifier}/inline'}
    if photo:
        data.update(filename=Path(name).stem+'.jpg', note='展示与下载均使用已移除隐私元数据的图片副本。')
    if mime:
        return dict(data, mode='pdf' if ext == '.pdf' else mime.split('/')[0])
    if ext == '.zip':
        try:
            return dict(data, mode='archive', **archived(path, request.GET.get('member', '')))
        except Problem as error:
            if request.GET.get('member'):
                raise
            return dict(data, mode='download', note=str(error))
    if text_file(name):
        with path.open('rb') as f:
            raw = f.read(TEXT_LIMIT + 1)
        return dict(data, mode='text', text=raw[:TEXT_LIMIT].decode('utf-8-sig', errors='replace'), truncated=len(raw) > TEXT_LIMIT)
    return dict(data, mode='download', note='这个格式暂不支持浏览器预览，可下载完整原件。')
