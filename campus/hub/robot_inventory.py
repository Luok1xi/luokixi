"""Measured robot inventory. Missing historical measurements remain unknown."""
from collections import Counter
from datetime import timedelta
from django.db.models import Count
from django.utils import timezone
from .models import Audit, BeikuangTask, Entry, Job, ExternalCache

# Each entry is backed by a real dispatcher, never a marketing capability.
ROBOTS = {
    'pipeline-library': ('资料持续归类', '已采集大学目录与本机文件入库、来源审核、增量更新', 'campus/hub/content_pipeline.py', 'hub.test_content_pipeline'),
    'pipeline-projects': ('项目持续整理', '中文十章导读、来源审核、分类和本机镜像', 'campus/hub/content_pipeline.py', 'hub.test_content_pipeline'),
    'pipeline-frontier': ('AI 与科研前沿', '官方新闻源、日期核对、站内中文摘要与讨论', 'campus/hub/frontier_news.py', 'hub.test_content_pipeline'),
    'pipeline-illustrations': ('全站自动配图', '优先来源原图、README 图片与校标校验；缺原图时使用标明的主题封面', 'campus/hub/auto_media.py', 'hub.test_source_media'),
    'pipeline-journal': ('角色服务器日志', '两位原版角色依据实际执行结果发布日志', 'campus/hub/content_pipeline.py', 'hub.test_content_pipeline'),
    'maint-github': ('开源搜寻', 'GitHub 公开 API · 有许可项目筛选、去重', 'campus/hub/github_crawler.py', 'hub.test_github_crawler'),
    'maint-news': ('校园新闻', '学校官网 · 标题、正文、日期与来源', 'campus/hub/maintenance.py', 'hub.test_maintenance'),
    'maint-notices': ('校园通知', '体育部、图书馆 · Scrapling 浏览器读取', 'campus/hub/maintenance.py', 'hub.test_maintenance'),
    'maint-links': ('链接巡检', '公开链接可达性与故障记录', 'campus/hub/maintenance.py', 'hub.test_maintenance'),
    'maint-media': ('项目配图', 'README 图片验证、尺寸检查与缓存', 'campus/hub/project_media.py', 'hub.test_maintenance'),
    'maint-organize': ('项目分类', '学科与用途分类、分类理由', 'campus/hub/project_catalog.py', 'hub.test_maintenance'),
    'maint-summaries': ('中文导读', '模型生成导读，保留原文指纹', 'campus/hub/project_summaries.py', 'hub.test_maintenance'),
    'maint-mirror': ('项目镜像', 'GitHub 发行文件缓存，不运行安装包', 'campus/hub/mirror.py', 'hub.test_maintenance'),
    'maint-supervisor': ('资料监督', '核对来源、提出问题、公告草稿', 'campus/hub/supervisor.py', 'hub.test_beikuang'),
    'maint-beikuang': ('批量审核', '既有新闻、项目、导读与图片审核规则', 'campus/hub/beikuang.py', 'hub.test_beikuang'),
    'site-browser-audit': ('网页巡检', 'Playwright · 图片、脚本、手机溢出', 'campus/hub/site_browser_audit.py', ''),
    'question-process': ('题目识别', '原文提取、OCR、结构化题目与分类', 'campus/hub/question_robot.py', 'hub.test_question_robot'),
    'source': ('资料来源采集', '已登记的大学与公开课程来源', 'campus/hub/discovery.py', 'hub.test_question_sources'),
    'extract': ('文档提取', '上传文档的文本提取与索引', 'campus/hub/files.py', 'hub.test_question_robot'),
    'github-inspect': ('项目精读', 'GitHub README、许可、发行信息', 'campus/hub/github_guides.py', 'hub.test_github_crawler'),
    'github-summary': ('单项目导读', '中文导读生成与原文版本核对', 'campus/hub/project_summaries.py', 'hub.test_maintenance'),
    'mirror-repo': ('单项目镜像', '指定仓库发行文件的本机缓存', 'campus/hub/mirror.py', 'hub.test_maintenance'),
    'supervisor-draft': ('公告草拟', '监督发现转为公告候选', 'campus/hub/supervisor.py', 'hub.test_beikuang'),
    'site-backup': ('数据备份', 'SQLite 一致性备份与私有归档', 'campus/hub/backup.py', ''),
    'site-backup-check': ('备份验证', '在隔离目录检查备份恢复', 'campus/hub/backup.py', ''),
    'beikuang-chat': ('北矿娘对话', '原版 campus-companion 人格、记忆和消息链', '', ''),
    'beikuang-report': ('工作日志', '原版角色依据真实工作记录撰写', '', ''),
    'digest': ('订阅摘要', '按用户订阅生成摘要', '', ''),
}


def measure(kind, result):
    """Only normalize actual output fields; GitHub search total_count is NOT collected."""
    result = result if isinstance(result, dict) else {}
    mappings = {
        'pipeline-library': {'classified':'classified','collected':'collected','refreshed':'refreshed'},
        'pipeline-projects': {'examined':'processed'},
        'pipeline-frontier': {'discovered':'discovered','published':'published'},
        'pipeline-illustrations': {'illustrated':'illustrated','sourceRecovered':'sourceRecovered','sourceChecks':'sourceChecks'},
        'pipeline-journal': {'published':'published'},
        'maint-github': {'examined': 'inspected', 'collected': 'created', 'refreshed': 'refreshed', 'skipped': 'skipped'},
        'maint-news': {'discovered': 'listed', 'examined': 'checked', 'collected': 'created'},
        'maint-links': {'examined': 'checked', 'broken': 'broken'},
        'maint-media': {'examined': 'checked', 'cached': 'cached', 'illustrated': 'withImage'},
        'maint-organize': {'classified': 'classified'},
        'maint-summaries': {'generated': 'generated'},
        'maint-beikuang': {'published': 'published', 'escalated': 'escalated'},
        'question-process': {'questions': 'questions'},
    }
    counts = {}
    for label, key in mappings.get(kind, {}).items():
        v = result.get(key)
        if isinstance(v, list): counts[label] = len(v)
        elif type(v) is int and v >= 0: counts[label] = v
    return counts


def record_run(job, started, elapsed_ms):
    Audit.objects.create(action='robot.run', target=str(job.pk), detail={
        'kind': job.kind, 'attempt': job.attempts, 'state': job.state,
        'seat': job.payload.get('actorSeat', 'scheduler'), 'started': started.isoformat(),
        'durationMs': max(0, int(elapsed_ms)), 'counts': measure(job.kind, job.result),
        'error': job.error[:240],
    })


def publication_coverage():
    from .models import MirrorAsset
    from .mirror_store import local_path
    from .core import Problem
    packages = Counter()
    for asset in MirrorAsset.objects.all():
        try:
            path = local_path(asset)
            if path.is_file() and path.stat().st_size == asset.size: packages[asset.repository.lower()] += 1
        except (OSError, Problem):
            continue
    receipts = {d.get('repository','').lower(): d for d in ExternalCache.objects.filter(key__startswith='pipeline-project:').values_list('data', flat=True)}
    rows = []
    for data in ExternalCache.objects.filter(key__startswith='github:').values_list('data', flat=True):
        repo = data.get('repository')
        if not repo or (data.get('selection') or {}).get('shelf') == 'unlisted': continue
        guide, receipt = data.get('guide') or {}, receipts.get(repo.lower(), {})
        rows.append({'repository': repo, 'stars': data.get('stars'), 'guide': guide.get('reviewState','unavailable'),
            'chapters': len(guide.get('sections',[])), 'packages': packages[repo.lower()],
            'error': (receipt.get('guideError') if guide.get('reviewState') != 'reviewed' else '') or receipt.get('mirrorError') or receipt.get('error','')})
    rows.sort(key=lambda r: r['stars'] or 0, reverse=True)
    return {'projects': len(rows), 'chineseGuides': sum(r['guide']=='reviewed' for r in rows),
            'withPackages': sum(r['packages']>0 for r in rows), 'packages': sum(packages.values()), 'items': rows}


def snapshot():
    since = timezone.now() - timedelta(days=7)
    jobs = list(Job.objects.filter(updated__gte=since).order_by('-updated').values(
        'id', 'kind', 'state', 'result', 'updated', 'error', 'attempts'))
    receipts = list(Audit.objects.filter(action='robot.run', created__gte=since).values('detail', 'target'))
    robots = []
    for kind, (name, function, source, _) in ROBOTS.items():
        selected = [j for j in jobs if j['kind'] == kind]
        recorded = [r['detail'] for r in receipts if r['detail'].get('kind') == kind]
        totals = Counter()
        for j in selected:
            if j['state'] in ('done', 'partial'): totals.update(measure(kind, j['result']))
        durations = [r['durationMs'] for r in recorded if type(r.get('durationMs')) is int]
        # Throughput numerator and denominator must come from the SAME measured attempts.
        measured_items = sum(r.get('counts', {}).get('examined', 0) for r in recorded)
        elapsed = sum(durations)
        terminal = [j for j in selected if j['state'] in ('done', 'partial', 'failed')]
        robots.append({'id': kind, 'name': name, 'function': function, 'source': source,
            'states': dict(Counter(j['state'] for j in selected)), 'jobs': len(selected),
            'successRate': sum(j['state'] == 'done' for j in terminal) / len(terminal) if terminal else None,
            'counts': dict(totals), 'measuredAttempts': len(durations),
            'meanDurationMs': round(elapsed / len(durations)) if durations else None,
            'examinedPerMinute': round(measured_items * 60000 / elapsed, 2) if elapsed and measured_items else None,
            'latest': {'id': str(selected[0]['id']), 'state': selected[0]['state'],
                'at': selected[0]['updated'].isoformat(), 'error': selected[0]['error']} if selected else None})
    from .beikuang import AGENT_USERNAME
    reviews = BeikuangTask.objects.filter(decided__gte=since)
    seats = []
    actions = Audit.objects.filter(action='robot.action', created__gte=since)
    for seat, username in [('beikuang', AGENT_USERNAME), ('codex', 'Codex')]:
        rows = list(reviews.filter(decided_by=username).values('state', 'created', 'decided'))
        own = list(actions.filter(detail__seat=seat).values_list('detail', flat=True))
        seats.append({'seat': seat, 'reviewed': len(rows), 'published': sum(r['state'] == 'published' for r in rows),
            'dismissed': sum(r['state'] == 'dismissed' for r in rows),
            'meanQueueSeconds': round(sum((r['decided']-r['created']).total_seconds() for r in rows)/len(rows)) if rows else None,
            'actions': dict(Counter(r.get('operation') for r in own if r.get('state') == 'done')),
            'failedActions': sum(r.get('state') == 'failed' for r in own)})
    from .robot_tools import catalogue as tools_catalogue
    return {'at': timezone.now().isoformat(), 'days': 7, 'robots': robots, 'seats': seats, 'coverage':publication_coverage(), 'tools':tools_catalogue()['items'],
        'queue': dict(BeikuangTask.objects.filter(state__in=['queued', 'escalated']).values('state').annotate(n=Count('pk')).values_list('state', 'n')),
        'content': dict(Entry.objects.values('state').annotate(n=Count('pk')).values_list('state', 'n')),
        'recent': [{'id': a.pk, 'at': a.created.isoformat(), **a.detail} for a in actions.order_by('-created')[:30]],
        'integrations': [
            {'name': 'Opus Codex Studio', 'mode': '任务契约、断点接续、交接凭据与自动维护；保留本站原运行时', 'url': 'https://github.com/Luok1xi/opus-codex-studio'},
            {'name': 'campus-companion', 'mode': '原版运行时，两位独立记忆', 'url': 'https://github.com/Luok1xi/campus-companion'},
            {'name': 'QQ Bridge', 'mode': '检索与阅读能力适配；不是整个 QQ 服务', 'url': 'https://github.com/Derpyu520/qq-bridge'},
            {'name': 'Shinsekai', 'mode': '分组工具机制参考、角色语音协议适配；不是完整移植', 'url': 'https://rachelforster.github.io/Shinsekai/'},
            {'name': 'GPT-SoVITS', 'mode': '本机日语语音服务', 'url': 'https://github.com/RVC-Boss/GPT-SoVITS'},
            {'name': 'Playwright', 'mode': '真实网页巡检', 'url': 'https://github.com/microsoft/playwright'},
            {'name': 'Scrapling', 'mode': '动态公开页面采集', 'url': 'https://github.com/D4Vinci/Scrapling'},
        ],
        'measurement': '近 7 天。旧任务没有耗时就显示未测；速度只计算同一批实测任务。排队、讨论、语法通过均不计作上架。'}
