"""Bounded source-image recovery, attribution and local caching; no image search guesses."""
import hashlib
import os
import re
from datetime import timedelta
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from django.conf import settings
from django.http import FileResponse
from django.utils import timezone
from .core import Problem
from .models import ExternalCache

VERSION = 1
INSTITUTIONS = (
    ('清华大学', r'清华|tsinghua', 'tsinghua.edu.cn'),
    ('北京大学', r'北京大学|北大|peking university|\bpku\b', 'pku.edu.cn'),
)


def institution(title):
    found = [row for row in INSTITUTIONS if re.search(row[1], str(title), re.I)]
    return found[0] if len(found) == 1 else None


def matches_entity(title, image):
    """Only logos demand an exact official institution; an author's handle proves nothing."""
    identity = institution(title)
    if not identity:
        return True
    target = str(image.get('url') or image.get('image') or image.get('src') or '')
    label = str(image.get('alt') or '')
    host = urlsplit(target).hostname or ''
    path = urlsplit(target).path
    for name, pattern, domain in INSTITUTIONS:
        if domain == identity[2]:
            continue
        if host == domain or host.endswith('.' + domain) or re.search(pattern, label, re.I):
            return False
        if re.search(r'(?:^|[/_.-])(?:pku|peking)(?:[/_.-]|$)', path, re.I) and domain == 'pku.edu.cn':
            return False
    if re.search(r'logo|校徽|校标|校名标识|avatar|icon', path + ' ' + label, re.I):
        return host == identity[2] or host.endswith('.' + identity[2])
    return True


def generated(media):
    address = str((media or {}).get('url') or (media or {}).get('src') or '')
    return not address or address.startswith(('/api/hub/illustration/', '/art/', 'art/'))


def source_url(data):
    links = data.get('links') or {}
    address = links.get('source') or (data.get('languageVersions') or {}).get('original', {}).get('url') or ''
    return address if isinstance(address, str) and address.startswith('https://') else ''


def cache_key(data):
    seed = source_url(data) + '\n' + str(institution(data.get('title')) or '')
    return 'source-media:' + hashlib.sha256(seed.encode()).hexdigest()


def needs_refresh(data):
    if not source_url(data):
        return False
    row = ExternalCache.objects.filter(pk=cache_key(data)).first()
    return not row or not row.checked or row.checked < timezone.now() - timedelta(hours=24)


def store(raw, info, origin, alt='', credit=''):
    """Keep verified source bytes, never replace them with screenshots of another page."""
    digest = hashlib.sha256(raw).hexdigest()
    folder = settings.DATA / 'source-media'
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / digest
    if not path.exists():
        temporary = folder / (digest + '.part-' + os.urandom(5).hex())
        try:
            temporary.write_bytes(raw); os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    ExternalCache.objects.update_or_create(key='source-image:' + digest, defaults={
        'data': {**info, 'sourceUrl': origin, 'alt': alt}, 'checked': timezone.now(), 'success': timezone.now()})
    return {'url': '/api/hub/source-media/' + digest, 'originalUrl': info.get('originalUrl', ''),
            'kind': 'source', 'alt': alt, 'sourceUrl': origin, 'credit': credit or '来源页面原图 · 权利归原作者',
            'method': f'source-article-v{VERSION}', **{k: info[k] for k in ('width', 'height', 'fit', 'position') if k in info}}


def article_candidates(raw, origin, title=''):
    from .maintenance import selector
    from .news_media import candidates, DECORATION
    page = selector(raw, origin)
    found = []
    for meta in page.css('meta[property="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]'):
        src = urljoin(origin, meta.attrib.get('content', ''))
        if src.startswith('https://') and not DECORATION.search(urlsplit(src).path):
            found.append({'url': src, 'alt': title})
    body = page.css('article, .v_news_content, .article-content, .entry-content, main')
    if body:
        found.extend(candidates(body[0], origin))
    seen = set()
    return [image for image in found if image['url'] not in seen and not seen.add(image['url']) and matches_entity(title, image)][:6]


def resolve(data, refresh=False):
    title = data.get('title', '')
    repo = (data.get('repo') or {}).get('fullName') or data.get('repository')
    if not repo:
        link = (data.get('links') or {}).get('repo', '')
        match = re.match(r'^https://github\.com/([^/?#]+/[^/?#]+)', link)
        repo = match[1].removesuffix('.git') if match else None
    if repo:
        row = ExternalCache.objects.filter(pk='maint:project-media').first()
        picture = (row.data.get('items', {}) if row else {}).get(repo, {})
        original = dict(picture, url=picture.get('originalImage') or picture.get('image'))
        if picture.get('image') and matches_entity(title, original):
            return {'url': picture['image'], 'kind': 'source', 'alt': picture.get('alt') or title,
                    'sourceUrl': picture.get('sourceUrl') or f'https://github.com/{repo}',
                    'credit': picture.get('credit') or f'{repo} · README 原图', 'method': 'project-readme-v3'}
    origin = source_url(data)
    if not origin:
        return None
    row = ExternalCache.objects.filter(pk=cache_key(data)).first()
    if row and not needs_refresh(data):
        return row.data.get('media')
    if not refresh:
        return row.data.get('media') if row else None
    media, errors = None, []
    try:
        from .maintenance import get_page
        from .news_media import select
        raw, final = get_page(origin)
        title = (data.get('languageVersions') or {}).get('original', {}).get('title') or title
        blobs = {}
        def fetch_image(address, limit):
            image, resolved = get_page(address, limit)
            blobs[address] = image
            return image, resolved
        selected, errors = select(article_candidates(raw, final, title), fetch_image)
        if selected:
            info = {**selected, 'originalUrl': selected['resolvedUrl']}
            media = store(blobs[selected['url']], info, origin, selected.get('alt') or data.get('title', ''))
    except Exception as exc:
        errors.append(str(exc)[:200])
    # A transient fetch failure preserves a previously verified source image.
    media = media or (row.data.get('media') if row else None)
    ExternalCache.objects.update_or_create(key=cache_key(data), defaults={'data': {'media': media,
        'sourceUrl': origin, 'errors': errors}, 'checked': timezone.now(),
        'success': timezone.now() if media else None, 'error': '；'.join(errors)[:300]})
    return media


def get(identifier):
    if not re.fullmatch('[a-f0-9]{64}', identifier):
        raise Problem('来源图片编号无效。', 404)
    row = ExternalCache.objects.filter(pk='source-image:' + identifier).first()
    path = settings.DATA / 'source-media' / identifier
    if not row or not path.is_file():
        raise Problem('来源图片暂不可用。', 404)
    response = FileResponse(path.open('rb'), content_type={'JPEG':'image/jpeg','PNG':'image/png','WEBP':'image/webp','GIF':'image/gif'}.get(row.data.get('format'), 'application/octet-stream'))
    response['Cache-Control'] = 'public, max-age=86400'
    response['X-Content-Type-Options'] = 'nosniff'
    return response
