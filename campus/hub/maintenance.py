"""维护机器人：让网站自己保持新鲜，但每一步都留痕、可核对。

- 学校新闻：读矿大新闻网的公开列表，取新文章的标题、发布时间、作者/来源、摘要、第一张配图的原图地址和署名，
  建成“待审核”的新闻条目。维护者点通过才会上首页和校圈头条。不复制学校图片，只记原图地址、署名和原文链接。
- 公告：体育教研部（场馆预约指南、通知公告）和图书馆（通知公告，页面靠脚本渲染，需要浏览器读取）的公开列表。
- 链接巡检：站内引用的官方链接（竞赛名录、编辑精选、楼的官方服务）逐个请求，坏了通知维护者。
- 项目配图：读开源项目 README 里的第一张图（项目自己的实拍或截图），给开源广场当封面。
- 本站下载：按许可证镜像项目的正式发布包（见 mirror.py）。

所有网络请求都走 discovery.fetch_public（只连公开地址、限制大小）；每个站点先看 robots.txt；每次运行有数量上限。
"""
import hashlib
import json
import os
import re
from datetime import timedelta

from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser
from django.db import transaction
from django.utils import timezone
from .core import Problem, notify
from .discovery import UA, fetch_public
from .models import Entry, ExternalCache, Member, Revision

NEWS_LISTS = ['https://news8.cumtb.edu.cn/xwtt.htm', 'https://news8.cumtb.edu.cn/zhyw.htm']
SPORTS_LISTS = ['https://tiyu.cumtb.edu.cn/bkjx/tzgg.htm', 'https://tiyu.cumtb.edu.cn/xwzx/cgyy.htm']
LIBRARY_NOTICES = 'https://lib.cumtb.edu.cn/engine2/general/more?t=A48583A68E8548415E2E9E1FDECB699CC12C57197B522A5CA1425FAD878E4A30B1C0F2A9FC91A5DC157439F2D448CD73'
# 楼的官方服务入口（和 src/js/campus-services.js 保持一致）
SERVICE_LINKS = ['https://lib.cumtb.edu.cn/', 'https://tiyu.cumtb.edu.cn/xwzx/cgyy.htm', 'https://jwc.cumtb.edu.cn/']
MAX_NEW_ARTICLES = 6


def public_data():
    return Path(__file__).resolve().parents[2] / 'public' / 'data'


def selector(raw, origin):
    from scrapling.parser import Selector
    return Selector(content=raw, url=origin)


_robots = {}


def allowed(target):
    """按站点缓存 robots.txt；没有 robots.txt（404）视为允许。"""
    p = urlsplit(target)
    key = f'{p.scheme}://{p.netloc}'
    if key not in _robots:
        rules = RobotFileParser()
        try:
            raw, _, _, _ = fetch_public(key + '/robots.txt', 256 * 1024)
            rules.parse(raw.decode('utf-8', errors='replace').splitlines())
        except Problem as exc:
            if 'HTTP 404' not in str(exc):
                raise
            rules.parse([])
        _robots[key] = rules
    return _robots[key].can_fetch(UA, target)


def get_page(target, limit=2 * 1024 * 1024):
    if not allowed(target):
        raise Problem(f'{urlsplit(target).netloc} 的 robots.txt 不允许读取这一页。')
    raw, _, final, _ = fetch_public(target, limit)
    return raw, final


def save_cache(key, data, error=''):
    cache, _ = ExternalCache.objects.get_or_create(pk=key)
    cache.data, cache.checked, cache.error = data, timezone.now(), error[:300]
    if not error:
        cache.success = cache.checked
    cache.save()
    return cache


def staff_notice(key, message):
    """机器人要找站主的话先交给北矿娘（beikuang.py）：她审核过的自己发布，没过的才在她的窗口里告诉站主。
    HUB_BEIKUANG=0 时恢复为直接通知所有维护者。"""
    from .beikuang import receive
    if receive(key, message):
        return
    for member in Member.objects.filter(is_staff=True, is_active=True):
        notify(member, None, 'maintenance', f'{key}:{member.pk}', message)


def beikuang_review():
    from .beikuang import review_all
    return review_all()


# ---------- 学校新闻 ----------

DATE = re.compile(r'(20\d{2})[/\-.年](\d{1,2})[/\-.月](\d{1,2})')


def parse_news_list(raw, origin):
    """博达（VSB）站群的列表页：<li><a href="info/1003/40766.htm">标题</a><span>2026/10/01</span></li>"""
    page = selector(raw, origin)
    items = {}
    for li in page.css('li'):
        a = li.css('a[href*="info/"]')
        if not a:
            continue
        a = a[0]
        href = urljoin(origin, a.attrib.get('href', ''))
        title = (a.attrib.get('title') or ' '.join(a.css('::text').getall())).strip()
        if not re.search(r'/info/\d+/\d+\.htm$', href) or len(title) < 4:
            continue
        m = DATE.search(' '.join(li.css('::text').getall()))
        items[href] = {'title': title[:160], 'url': href, 'date': f'{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}' if m else ''}
    return list(items.values())


def parse_article(raw, origin):
    page = selector(raw, origin)
    head = ' '.join(page.css('title::text').getall()).strip()
    title = head.split('-')[0].strip() if head else ''
    text = ' '.join(t.strip() for t in page.css('body ::text').getall() if t.strip())
    published = re.search(r'发布时间[：:]\s*(20\d{2}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2})(?::\d{2})?)?', text)
    author = re.search(r'作者[：:]\s*([^\s]{1,30}(?:\s[^\s来]{1,10})?)', text)
    source = re.search(r'来源[：:]\s*([^\s]{1,30})', text)
    content = page.css('.v_news_content')
    body = ' '.join(t.strip() for t in content[0].css('::text').getall() if t.strip()) if content else ''
    from .news_media import candidates
    images = candidates(content[0], origin) if content else []
    image = images[0]['url'] if images else ''
    photo = re.search(r'(?:图|摄影|摄)\s*[/／:：]\s*([^\s，。；;）)]{1,20})', body)
    words = re.search(r'(?<![图摄])文\s*[/／:：]\s*([^\s，。；;）)]{1,20})', body)
    summary = re.split(r'(?<=[。！？])', body)[0][:160] if body else ''
    credit = ' / '.join(x for x in [f'摄影：{photo[1]}' if photo else '', f'文：{words[1]}' if words else '',
                                    f'来源：{source[1]}' if source else ''] if x)
    return {
        'title': title[:160],
        'publishedAt': f'{published[1]}T{published[2] or "08:00"}:00+08:00' if published else '',
        'author': author[1].strip() if author else '',
        'source': source[1] if source else '',
        'summary': summary,
        'image': image,
        'imageCandidates': images,
        'credit': credit,
    }


def school_news(max_new=MAX_NEW_ARTICLES):
    seen, created, errors = 0, [], []
    listing = []
    for target in NEWS_LISTS:
        try:
            raw, final = get_page(target)
            listing += parse_news_list(raw, final)
        except Exception as exc:
            errors.append(f'{target}：{exc}')
    unique = list({i['url']: i for i in listing}.values())
    unique.sort(key=lambda i: i['date'], reverse=True)
    for item in unique:
        seen += 1
        slug = 'news-' + hashlib.sha256(item['url'].encode()).hexdigest()
        if Entry.objects.filter(slug=slug).exists():
            continue
        if len(created) >= max_new:
            break
        try:
            raw, final = get_page(item['url'])
            a = parse_article(raw, final)
        except Exception as exc:
            errors.append(f'{item["url"]}：{exc}')
            continue
        payload = {
            'title': a['title'] or item['title'], 'summary': a['summary'] or item['title'], 'body': '',
            'links': {'source': item['url']}, 'sourceNote': '矿大新闻网', 'license': '来源版权保留，仅提供索引链接',
            'publishedAt': a['publishedAt'] or (f"{item['date']}T08:00:00+08:00" if item['date'] else ''),
            'author': a['author'], 'origin': a['source'], 'tags': ['学校新闻'], 'year': (item['date'] or '')[:4],
            'audience': '全校', 'uploads': [], 'rightsConfirmed': False, 'collectedBy': 'maintenance-bot',
            'collectedAt': timezone.now().isoformat(),
        }
        from .news_media import select
        selected, image_errors = select(a['imageCandidates'], get_page)
        if selected:
            payload['media'] = {'src': selected['url'], 'alt': selected['alt'] or payload['title'], 'credit': f"矿大新闻网原报道{(' · ' + a['credit']) if a['credit'] else ''}",
                                'sourceUrl': item['url'], 'usage': '引用官方原图链接；未复制原图，版权归原权利人。',
                                **{k: selected[k] for k in ('width', 'height', 'fit', 'position', 'selectionVersion', 'resolvedUrl')}}
        if image_errors:
            payload['mediaCheck'] = {'checkedAt': timezone.now().isoformat(), 'errors': image_errors,
                                     'status': 'selected' if selected else 'unavailable'}
        with transaction.atomic():
            entry = Entry.objects.create(kind='news', slug=slug, state='pending', draft=payload)
            Revision.objects.create(entry=entry, number=entry.revision, data=payload, state='pending')
        created.append({'id': str(entry.pk), 'title': payload['title'], 'image': bool(selected)})
    if created:
        staff_notice('maint-news:' + created[0]['id'], f'维护机器人发现 {len(created)} 条学校新闻，等你审核后上首页。')
    result = {'listed': len(unique), 'checked': seen, 'created': created, 'errors': errors}
    save_cache('maint:news', result, '；'.join(errors)[:300])
    return result


# ---------- 公告：体育教研部、图书馆 ----------

def parse_library_text(text):
    """图书馆公告列表渲染出来是“标题\\n2026-07-09 12:19”这样一行标题一行时间。"""
    items = []
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    for i, line in enumerate(lines[:-1]):
        m = re.fullmatch(r'(20\d{2}-\d{2}-\d{2})(?:\s+\d{2}:\d{2})?', lines[i + 1])
        if m and 4 <= len(line) <= 80 and not DATE.fullmatch(line):
            items.append({'title': line, 'date': m[1]})
    return items[:12]


def library_notices():
    try:
        from scrapling.fetchers import DynamicFetcher
    except Exception:  # 没装浏览器组件
        return {'status': 'needs-browser', 'items': [], 'url': LIBRARY_NOTICES,
                'reason': '图书馆公告页靠脚本渲染，这台服务器没有安装浏览器组件（scrapling[fetchers]）。'}
    if not allowed(LIBRARY_NOTICES):
        return {'status': 'blocked', 'items': [], 'url': LIBRARY_NOTICES, 'reason': 'robots.txt 不允许读取。'}
    try:
        page = DynamicFetcher.fetch(LIBRARY_NOTICES, headless=True, network_idle=True, timeout=30000)
    except Exception as exc:
        if "Executable doesn't exist" in str(exc) or 'playwright install' in str(exc).lower():
            return {'status': 'needs-browser', 'items': [], 'url': LIBRARY_NOTICES,
                    'reason': '图书馆公告页靠脚本渲染，这台服务器还没下载浏览器内核。维护者运行一次 scrapling install（或 python -m playwright install chromium）即可。'}
        raise
    text = '\n'.join(page.css('body ::text').getall())
    return {'status': 'ok', 'items': parse_library_text(text), 'url': LIBRARY_NOTICES}


def notices():
    out = {'sports': [], 'library': {}, 'checkedAt': timezone.now().isoformat(), 'errors': []}
    for target in SPORTS_LISTS:
        try:
            raw, final = get_page(target)
            for item in parse_news_list(raw, final)[:8]:
                out['sports'].append({**item, 'list': target})
        except Exception as exc:
            out['errors'].append(f'{target}：{exc}')
    out['sports'] = list({i['url']: i for i in out['sports']}.values())[:10]
    try:
        out['library'] = library_notices()
    except Exception as exc:
        out['library'] = {'status': 'error', 'items': [], 'url': LIBRARY_NOTICES, 'reason': str(exc)[:200]}
        out['errors'].append(f'图书馆：{exc}')
    save_cache('maint:notices', out, '；'.join(out['errors'])[:300])
    return {'sports': len(out['sports']), 'library': len(out['library'].get('items', [])), 'libraryStatus': out['library'].get('status'), 'errors': out['errors']}


# ---------- 链接巡检 ----------

def site_links():
    base = public_data()
    links = {}
    try:
        comps = json.loads((base / 'competitions.json').read_text('utf-8'))
        for c in comps.get('competitions', []):
            for key in ('officialUrl', 'sourceUrl'):
                if c.get(key):
                    links.setdefault(c[key], f'竞赛名录 · {c.get("name", "")}')
    except (OSError, ValueError):
        pass
    try:
        featured = json.loads((base / 'featured.json').read_text('utf-8'))
        for f in featured.get('items', []):
            if (f.get('source') or {}).get('url'):
                links.setdefault(f['source']['url'], f'编辑精选 · {f.get("title", "")}')
    except (OSError, ValueError):
        pass
    for u in SERVICE_LINKS:
        links.setdefault(u, '楼的官方服务入口')
    return links


def check_links(limit=60):
    results, broken = [], []
    for target, where in list(site_links().items())[:limit]:
        try:
            fetch_public(target, 4 * 1024 * 1024)
            results.append({'url': target, 'where': where, 'ok': True})
        except Exception as exc:
            row = {'url': target, 'where': where, 'ok': False, 'error': str(exc)[:160]}
            results.append(row)
            broken.append(row)
    previous = ExternalCache.objects.filter(pk='maint:links').first()
    before = {r['url'] for r in (previous.data.get('broken', []) if previous else [])}
    fresh = [b for b in broken if b['url'] not in before]
    if fresh:
        staff_notice('maint-links:' + timezone.now().strftime('%Y%m%d'), f'链接巡检发现 {len(fresh)} 个官方链接打不开，请到“维护机器人”查看。')
    save_cache('maint:links', {'checked': len(results), 'broken': broken, 'results': results, 'checkedAt': timezone.now().isoformat()})
    return {'checked': len(results), 'broken': len(broken)}


# ---------- 开源项目配图：README 里的第一张图 ----------

BADGE = re.compile(r'shields\.io|badge|badgen|travis-ci|codecov|circleci|github/workflow|actions/workflow|\.svg(\?|$)|img\.shields|forthebadge|visitor', re.I)


def readme_image(markdown, repository, branch='HEAD'):
    for m in re.finditer(r'!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img[^>]+src=["\']([^"\']+)["\']', markdown):
        src = (m[1] or m[2] or '').strip()
        if not src or BADGE.search(src):
            continue
        if src.startswith('//'):
            src = 'https:' + src
        if not re.match(r'https?://', src):
            src = f'https://raw.githubusercontent.com/{repository}/{branch}/{src.lstrip("./")}'
        src = re.sub(r'^https://github\.com/([^/]+/[^/]+)/blob/', r'https://raw.githubusercontent.com/\1/', src)
        if src.startswith('https://'):
            return src
    return ''


def project_media():
    from .project_media import collect
    return collect()


def github_projects():
    from .github_crawler import crawl
    return crawl()


def organize_projects():
    from .project_catalog import organize_all
    return organize_all()


def summarize_projects():
    from .project_summaries import generate_batch
    return generate_batch()


def supervise_projects():
    from .supervisor import inspect_all
    return inspect_all()


def mirror_projects(limit=12):
    from .mirror import mirror_repository
    try:
        community = json.loads((public_data() / 'community.json').read_text('utf-8'))
    except (OSError, ValueError):
        community = {'projects': []}
    # Include real approved submissions as well as the original editorial set.
    from .github_guides import repository
    repositories = []
    candidates = [e.published.get('links',{}).get('repo','') for e in Entry.objects.filter(kind='project',state='published').order_by('-updated')]
    candidates += [(p.get('repo') or {}).get('fullName','') for p in community.get('projects', [])]
    for candidate in candidates:
        try:
            full = repository(candidate)
        except Problem:
            continue
        if full.lower() not in {r.lower() for r in repositories}: repositories.append(full)
    states = {}
    for full in repositories[:limit]:
        try:
            states[full] = mirror_repository(full)
        except Exception as exc:
            states[full] = {'repository': full, 'status': 'error', 'reason': str(exc)[:200]}
    previous = ExternalCache.objects.filter(pk='maint:mirror').first()
    merged = dict(previous.data.get('repositories', {}) if previous else {})
    merged.update(states)
    save_cache('maint:mirror', {'repositories': merged})
    return {'repositories': len(states), 'mirrored': sum(len(s.get('mirrored', [])) for s in states.values()),
            'blocked': sum(1 for s in states.values() if s.get('status') == 'license-blocked')}


TASKS = {
    'github': github_projects,
    'news': school_news,
    'notices': notices,
    'links': check_links,
    'media': project_media,
    'mirror': mirror_projects,
    'organize': organize_projects,
    'summaries': summarize_projects,
    'supervisor': supervise_projects,
    'beikuang': beikuang_review,
}
# 每项多久跑一次（小时）
SCHEDULE = {'github': 24, 'news': 6, 'notices': 12, 'links': 24, 'media': 72, 'mirror': 168, 'organize':24, 'summaries':24,'supervisor':6, 'beikuang': 1}


def status():
    from .models import Job
    from .github_crawler import candidates
    from .supervisor import status as supervisor_status
    rows = {}
    for task in TASKS:
        job = Job.objects.filter(kind='maint-' + task).order_by('-updated').first()
        rows[task] = {'state': job.state if job else 'never', 'updated': job.updated.isoformat() if job else None,
                      'result': job.result if job else {}, 'error': job.error if job else '', 'everyHours': SCHEDULE[task]}
    caches = {c.pk: c for c in ExternalCache.objects.filter(pk__in=['maint:news', 'maint:links', 'maint:notices', 'maint:mirror', 'maint:project-media'])}
    pending = Entry.objects.filter(kind='news', state='pending', slug__startswith='news-').order_by('-created')[:20]
    return {
        'tasks': rows,
        'supervisor': supervisor_status(),
        'pendingProjects': candidates(),
        'pendingGuides': [dict(repository=c.data['repository'],guide=c.data['guide'],evidence=c.data.get('evidence',[]))
                          for c in ExternalCache.objects.filter(key__startswith='github:')
                          if (c.data.get('guide') or {}).get('reviewState')=='pending'][:30],
        'pendingNews': [{'id': str(e.pk), 'revision': e.revision, 'title': e.draft.get('title', ''), 'publishedAt': e.draft.get('publishedAt', ''),
                         'image': (e.draft.get('media') or {}).get('src', ''), 'credit': (e.draft.get('media') or {}).get('credit', ''),
                         'source': (e.draft.get('links') or {}).get('source', ''), 'summary': e.draft.get('summary', '')} for e in pending],
        'brokenLinks': caches['maint:links'].data.get('broken', []) if 'maint:links' in caches else [],
        'mirror': caches['maint:mirror'].data.get('repositories', {}) if 'maint:mirror' in caches else {},
        'notices': caches['maint:notices'].data if 'maint:notices' in caches else {},
    }


def schedule_jobs(now=None):
    """worker.schedule() 每分钟调一次：到点的维护任务各排一个（同一时间段只排一次）。
    HUB_MAINTENANCE=0 关掉自动维护；本站下载的镜像会占硬盘，只有 HUB_MIRROR_AUTO=1 时才自动跑，否则由维护者手动触发。"""
    from .models import Job
    if os.environ.get('HUB_MAINTENANCE', '1') == '0':
        return
    now = now or timezone.now()
    for task, hours in SCHEDULE.items():
        if task == 'github' and os.environ.get('HUB_GITHUB_CRAWL', '1') == '0':
            continue
        if task == 'mirror' and os.environ.get('HUB_MIRROR_AUTO') != '1':
            continue
        if task == 'summaries' and os.environ.get('HUB_GUIDE_AUTO') != '1':
            continue
        latest = Job.objects.filter(kind='maint-'+task).order_by('-updated').first()
        if latest:
            if latest.state in ('queued','running'):
                continue
            wait_hours = 1 if latest.state in ('partial','failed') else hours
            if now-latest.updated < timedelta(hours=wait_hours):
                continue
        # Retry partial work after one hour; successful manual runs also satisfy the interval.
        slot = int(now.timestamp()) // 3600
        Job.objects.get_or_create(key=f'maint:{task}:{slot}', defaults={'kind': 'maint-' + task, 'payload': {}, 'due': now})


def run(task):
    if task not in TASKS:
        raise Problem('未知的维护任务。')
    return TASKS[task]()
