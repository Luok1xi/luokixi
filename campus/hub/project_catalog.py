"""Explainable classification and a cached, searchable project repository directory."""
import hashlib
import json
import re
from django.db import transaction
from django.utils import timezone
from .core import Problem, public_entries
from .search_matching import text_score
from .models import ExternalCache, MirrorAsset

TAXONOMY = {
    'mech': ('机器人与机械', ('robot', 'robotics', 'ros', 'ros2', 'slam', 'robot-arm', 'mechanical', '机器人', '机械臂')),
    'embedded': ('嵌入式与硬件', ('embedded', 'arduino', 'esp32', 'stm32', 'firmware', 'microcontroller', 'fpga', 'foc-algorithm', 'bldc', 'motor-control', '嵌入式', '单片机')),
    'software': ('软件与效率工具', ('developer-tools', 'automation', 'cli', 'workflow', 'productivity', 'web', 'database', '工具', '自动化')),
    'algo': ('算法与刷题', ('algorithm', 'algorithms', 'leetcode', 'competitive-programming', 'data-structures', '算法', '题解')),
    'course': ('课程与学习资料', ('course', 'tutorial', 'education', 'learning-resources', 'textbook', '课程', '教程')),
    'research': ('科研与数据分析', ('research', 'paper', 'dataset', 'machine-learning', 'deep-learning', 'visualization', 'scientific', '科研', '论文')),
}


def fingerprint(data):
    fields = {k: data.get(k) for k in ('repository', 'readmeSha', 'description', 'topics', 'releaseVersion', 'downloads', 'evidence')}
    fields['downloads'] = [{k:d.get(k) for k in ('name','url','kind','bytes','version','digest','upstreamId','updatedAt')} for d in data.get('downloads', [])]
    return hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def matches(word, value):
    return bool(re.search(r'(?<![a-z0-9])' + re.escape(word) + r'(?![a-z0-9])', value.lower()))


def classify(data):
    labels = []
    topics = ' '.join(data.get('topics') or [])
    description = (data.get('repository') or '') + ' ' + (data.get('description') or '')
    for key, (label, words) in TAXONOMY.items():
        reasons, score = [], 0
        for field, value, weight in (('GitHub 标签', topics, 4), ('名称与简介', description, 3)):
            hits = [w for w in words if matches(w, value)]
            if key == 'algo' and field == 'GitHub 标签':
                # Domain-specific control algorithms do not imply coding practice.
                hits = [w for w in hits if w in {t.lower() for t in data.get('topics',[])}]
            if hits:
                score += weight * min(2, len(hits))
                reasons.append({'field': field, 'matches': hits[:4], 'evidenceId': 'repository'})
        evidence = next((e for e in data.get('evidence', []) if e['id'].startswith('readme-') and any(matches(w, e['text']) for w in words)), None)
        if evidence:
            score += 1
            reasons.append({'field': 'README', 'matches': [w for w in words if matches(w, evidence['text'])][:4], 'evidenceId': evidence['id']})
        if score >= 3:
            labels.append({'id': key, 'name': label, 'score': score, 'reasons': reasons})
    labels.sort(key=lambda item: (-item['score'], item['id']))
    return {'version': 2, 'method': 'metadata-rules', 'primary': labels[0]['id'] if labels else 'unclassified',
            'labels': labels, 'needsReview': True, 'sourceFingerprint': fingerprint(data),
            'classifiedAt': timezone.now().isoformat(), 'notice': '自动分类建议，可由维护者修改；不代表严选或实测。'}


def download_hint(item):
    name = item.get('name', '').lower()
    source = item.get('kind') == 'source-archive'
    platform = 'source' if source else 'unknown'
    if not source:
        for key, pattern in [('windows', r'windows|win32|win64|(?:^|[-_.])win[-_.]|\.(exe|msi)$'),
                             ('macos', r'macos|darwin|osx|\.dmg$'), ('android', r'android|\.apk$'),
                             ('linux', r'linux|\.(appimage|deb|rpm)$')]:
            if re.search(pattern, name):
                platform = key
                break
    arch = next((a for a, pattern in [('arm64', r'aarch64|arm64'), ('x64', r'amd64|x86_64|x64|win64'), ('x86', r'i686|win32|x86(?![_-]64)')] if re.search(pattern, name)), 'unknown')
    return dict(item, platform=platform, architecture=arch, platformBasis='源码包' if source else '根据作者文件名识别，仍需核对原说明',
                installable=False if source else None)


@transaction.atomic
def organize_repository(repo):
    from .github_guides import repository, cache_key
    repo = repository(repo)
    cache = ExternalCache.objects.select_for_update().filter(pk=cache_key(repo), success__isnull=False).first()
    if not cache:
        raise Problem('请先读取仓库资料。', 404)
    data = dict(cache.data)
    if (data.get('classification') or {}).get('method') != 'maintainer':
        old=data.get('classification') or {}
        data['classification'] = classify(data)
        if old.get('version') == data['classification']['version'] and old.get('sourceFingerprint') == data['classification']['sourceFingerprint'] and old.get('reviewedBy'):
            for k in ('reviewedBy','needsReview','reviewScope'): data['classification'][k]=old.get(k)
    data['downloads'] = [download_hint(d) for d in data.get('downloads', [])]
    cache.data = data
    cache.save(update_fields=['data'])
    return data['classification']


def organize_all():
    repos = [d['repository'] for d in ExternalCache.objects.filter(key__startswith='github:', success__isnull=False).values_list('data', flat=True) if d.get('repository')]
    for repo in repos[:100]:
        organize_repository(repo)
    return {'classified': min(len(repos), 100), 'errors': []}


def catalogue(query, user):
    from .mirror import serialize
    category, q = query.get('category', ''), query.get('q', '').strip().lower()[:160]
    if category and category not in TAXONOMY and category != 'unclassified':
        raise Problem('未知项目分类。')
    pending = query.get('includePending') == '1'
    if pending and not (user.is_authenticated and user.is_staff):
        raise Problem('待审项目只对维护者开放。', 403)
    # The static community catalogue is already editorially published.
    from .maintenance import public_data
    try:
        static = json.loads((public_data() / 'community.json').read_text('utf-8')).get('projects', [])
    except (OSError, ValueError):
        static = []
    known = {(p.get('repo') or {}).get('fullName', '').lower(): p for p in static}
    published = {e.published.get('links', {}).get('repo', '').lower().removeprefix('https://github.com/').rstrip('/').removesuffix('.git'): e for e in public_entries().filter(kind='project')}
    assets = {}
    for asset in MirrorAsset.objects.order_by('-created'):
        if (item := serialize(asset))['available']:
            assets.setdefault(asset.repository.lower(), []).append(item)
    items, counts = [], {k: 0 for k in TAXONOMY}
    search_scores = {}
    for cache in ExternalCache.objects.filter(key__startswith='github:', success__isnull=False).order_by('-success'):
        data = cache.data
        repo = data.get('repository', '')
        entry, seed = published.get(repo.lower()), known.get(repo.lower())
        selected = (data.get('selection') or {}).get('shelf') in ('practical', 'creative', 'potential')
        if not pending and not (entry or seed) or (data.get('selection') or {}).get('shelf') == 'unlisted':
            continue
        classification = data.get('classification') or classify(data)
        categories = [x['id'] for x in classification['labels']]
        for c in categories:
            counts[c] += 1
        if category and category not in categories and not (category == 'unclassified' and not categories):
            continue
        guide = data.get('guide') or {}
        intro = guide.get('oneLiner', '') if guide.get('reviewState') == 'reviewed' or pending else ''
        haystack = ' '.join([repo, data.get('description', ''), intro, ' '.join(data.get('topics', [])), ' '.join(x['name'] for x in classification['labels'])]).lower()
        score = text_score(q, repo, body=haystack, keywords=' '.join(data.get('topics', []))) if q else 1
        if not score:
            continue
        search_scores[repo] = score
        files = assets.get(repo.lower(), [])
        if query.get('download') == 'local' and not files:
            continue
        link = f'project.html?id={entry.pk}' if entry else f'project.html?slug={seed["slug"]}' if seed else ''
        items.append({'repository': repo, 'url': data.get('url'), 'pageUrl': link, 'description': intro or data.get('description', ''),
                      'stars': data.get('stars',0), 'uploadedAt': (data.get('discovery') or {}).get('collectedAt') or (entry.created.isoformat() if entry else cache.success.isoformat()),
                      'uploader': (data.get('discovery') or {}).get('source') or data.get('credit') or '开源采集机器人',
                      'reviewer': (data.get('selection') or {}).get('reviewer') or '历史审核者未记录',
                      'classification': classification, 'license': data.get('license'), 'language': data.get('language'),
                      'guideState': guide.get('reviewState') if guide.get('state') == 'generated' else 'missing',
                      'downloads': [download_hint(d) for d in data.get('downloads', [])], 'localFiles': files,
                      'downloadState': 'local' if files else 'upstream-only', 'reviewed': bool(entry or seed or selected),
                      'lastSuccess': cache.success.isoformat(), 'stale': bool(cache.error)})
    try:
        offset = max(0, int(query.get('offset', 0)))
    except (TypeError, ValueError):
        raise Problem('分页参数无效。')
    items.sort(key=lambda item: (-item['stars'], item['repository'].lower()))
    if q:
        items.sort(key=lambda item: (-search_scores[item['repository']], item['repository']))
    return {'items': items[offset:offset + 30], 'total': len(items), 'offset': offset,
            'categories': [{'id': k, 'name': v[0], 'count': counts[k]} for k, v in TAXONOMY.items()]}
