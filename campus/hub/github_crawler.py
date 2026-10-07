"""Discover candidates. Automation never signs a human review or claims a runtime test."""
import json
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlencode
from django.db import transaction
from django.utils import timezone
from .core import Problem
from .models import ExternalCache, Job
from . import github_api, github_guides


def config():
    return json.loads((Path(__file__).resolve().parents[1]/'github-sources.json').read_text('utf-8'))


def eligible(info, min_stars=100):
    license_id = (info.get('license') or {}).get('spdx_id')
    return (not any(info.get(k) for k in ('private','archived','disabled','fork'))
            and license_id not in (None,'','NOASSERTION','OTHER')
            and bool((info.get('description') or '').strip())
            and info.get('stargazers_count',0) >= min_stars)


def crawl():
    from .maintenance import save_cache, staff_notice
    cfg = config()
    now = timezone.now()
    since = (now-timedelta(days=cfg['activeDays'])).date().isoformat()
    pools, errors, queries, skipped = [], [], [], 0
    for lane in cfg['sources'][:6]:
        query = f"{lane['query']} stars:>={cfg['minStars']} archived:false fork:false pushed:>={since}"
        try:
            found = github_api.request('/search/repositories?'+urlencode({'q':query,'sort':'stars','order':'desc','per_page':8}), ttl=86400)
            queries.append({'name':lane['name'],'query':query,'total':found.get('total_count'), 'incomplete':bool(found.get('incomplete_results'))})
            pools.append((lane, [r for r in found.get('items',[]) if eligible(r,cfg['minStars'])]))
        except Exception as exc:
            errors.append(f"{lane['name']}：{exc}")
            break  # Do not hammer a rate-limited provider.
    created, refreshed, seen, inspected = [], [], set(), 0
    for index in range(8):
        for lane, pool in pools:
            if index >= len(pool) or inspected >= min(cfg['maxInspect'],12):
                continue
            info = pool[index]
            repo = github_guides.repository(info['full_name'])
            if repo.lower() in seen:
                continue
            seen.add(repo.lower())
            key = github_guides.cache_key(repo)
            previous = ExternalCache.objects.filter(pk=key).first()
            # Keep editorial decisions; rotate to unseen candidates on future days.
            if previous and (previous.data.get('selection') or (previous.success and now-previous.success<timedelta(hours=24))):
                skipped += 1
                continue
            inspected += 1
            try:
                details = github_guides.inspect(repo)
                if details.get('stale'):
                    raise Problem(details.get('error') or '获取失败')
                if details.get('archived') or not details.get('license') or len(details.get('readme','').strip()) < 150:
                    skipped += 1
                    continue
                reasons = [f"方向：{lane['name']}",f"GitHub {details['stars']} Star（仅作参考）",'声明了许可证','提供 README',f"最近提交：{(details.get('pushedAt') or '')[:10]}"]
                with transaction.atomic():
                    cache = ExternalCache.objects.select_for_update().get(pk=key)
                    is_new = not cache.data.get('discovery')
                    cache.data = dict(cache.data,discovery={
                        'state':'candidate','category':lane['category'],'source':lane['name'],
                        'reason':'；'.join(reasons), 'query':next(q['query'] for q in queries if q['name']==lane['name']),
                        'firstSeen':(cache.data.get('discovery') or {}).get('firstSeen', now.isoformat()),
                        'checkedAt':now.isoformat(),'notice':'自动筛选候选，未人工严选，未运行验证。'})
                    cache.save(update_fields=['data'])
                (created if is_new else refreshed).append(repo)
            except Exception as exc:
                errors.append(f'{repo}：{exc}')
                break
        if errors or inspected >= min(cfg['maxInspect'],12):
            break
    if created or refreshed:
        Job.objects.get_or_create(key=f'media-after-crawl:{now.strftime("%Y%m%d%H")}', defaults={'kind':'maint-media','due':now,'payload':{}})
        Job.objects.get_or_create(key=f'organize-after-crawl:{now.strftime("%Y%m%d%H")}', defaults={'kind':'maint-organize','due':now,'payload':{}})
    if created:
        staff_notice('github-candidates:'+now.strftime('%Y%m%d'), f'GitHub 采集发现 {len(created)} 个候选项目，可在维护机器人核对后加入开源广场。')
    result = {'created':created,'refreshed':refreshed,'inspected':inspected,'skipped':skipped,'queries':queries,'errors':errors,
              'checkedAt':now.isoformat(),'status':'partial' if errors else 'ok'}
    save_cache('maint:github', result, '；'.join(errors)[:300])
    return result


def candidates():
    out = []
    media = ExternalCache.objects.filter(pk='maint:project-media').first()
    pictures = media.data.get('items',{}) if media else {}
    for cache in ExternalCache.objects.filter(key__startswith='github:').order_by('-checked'):
        data = cache.data
        if not data.get('discovery') or data.get('selection'):
            continue
        out.append({k:data.get(k) for k in ('repository','url','description','license','stars','pushedAt','readmeUrl','releaseUrl','downloads','discovery','classification','guide','evidence')})
        out[-1]['cover'] = pictures.get(data['repository'],{}).get('image','')
        out[-1]['stale'] = bool(cache.error)
    return out[:60]
