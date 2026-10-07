"""Bounded public GitHub reads, shared conditional cache and persistent rate backoff."""
import hashlib
import json
import os
import re
from urllib.error import HTTPError
from django.utils import timezone
from .core import Problem
from .github_transport import fetch_public
from .models import ExternalCache


def request(path, ttl=43200):
    if not re.match(r'^/(?:repos/|search/repositories\?)', path) or '\\' in path:
        raise Problem('无效的 GitHub API 路径。')
    now = timezone.now()
    key = 'gh-api:' + hashlib.sha256(path.encode()).hexdigest()
    cache = ExternalCache.objects.filter(pk=key).first()
    if cache and cache.success and (now-cache.success).total_seconds() < ttl:
        return cache.data['value']
    gate = ExternalCache.objects.filter(pk='gh-api:backoff').first()
    if gate and gate.data.get('until', 0) > now.timestamp():
        raise Problem('GitHub 请求额度暂不可用，已暂停并保留上次结果；稍后自动重试。', 503)
    headers = {'Accept':'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28'}
    if os.environ.get('HUB_GITHUB_READ_TOKEN'):
        headers['Authorization'] = 'Bearer ' + os.environ['HUB_GITHUB_READ_TOKEN']
    if cache and cache.data.get('etag'):
        headers['If-None-Match'] = cache.data['etag']
    try:
        raw, response_headers, _, status = fetch_public('https://api.github.com'+path, 3*1024*1024, headers)
    except Problem as exc:
        code = getattr(exc, 'http_status', None)
        if code in (403, 429):
            h = {k.lower():v for k,v in getattr(exc, 'headers', {}).items()}
            try:
                until = max(now.timestamp()+60, float(h.get('x-ratelimit-reset', 0)), now.timestamp()+float(h.get('retry-after', 60)))
            except (ValueError, TypeError):
                until = now.timestamp()+3600
            until = min(until, now.timestamp()+86400)
            ExternalCache.objects.update_or_create(pk='gh-api:backoff', defaults={'data':{'until':until},'checked':now,'error':'GitHub 限流，等待额度恢复'})
        if code == 404:
            raise HTTPError('https://api.github.com'+path, 404, 'Not Found', {}, None) from exc
        raise
    value = cache.data['value'] if status == 304 and cache else json.loads(raw)
    if isinstance(value, dict) and value.get('private'):
        raise Problem('仅允许采集公开仓库。')
    h = {k.lower():v for k,v in response_headers.items()}
    ExternalCache.objects.update_or_create(pk=key, defaults={
        'data':{'value':value, 'etag':h.get('etag', cache.data.get('etag','') if cache else '')},
        'checked':now, 'success':now, 'error':''})
    if h.get('x-ratelimit-remaining') == '0':
        try:
            until = max(now.timestamp()+60, float(h.get('x-ratelimit-reset', now.timestamp()+3600)))
        except ValueError:
            until = now.timestamp()+3600
        ExternalCache.objects.update_or_create(pk='gh-api:backoff', defaults={'data':{'until':until},'checked':now})
    return value
