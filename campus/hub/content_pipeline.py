"""Continuous existing collectors -> classified, attributed, published site content."""
import hashlib
import json
import os
import time
from datetime import timedelta
from pathlib import Path
from django.conf import settings
from django.db import close_old_connections, transaction
from django.utils import timezone
from .core import Problem
from .models import Audit, Entry, ExternalCache, Job, Revision

INTERVALS = {'library': 6*3600, 'projects': 10*60, 'frontier': 3*3600, 'illustrations': 15*60, 'journal': 12*3600}
KINDS = tuple('pipeline-'+name for name in INTERVALS)


def enabled():
    from .robot_actions import policy
    from .studio_config import config
    return policy()['enabled'] and config().get('continuous_content') is True


def data_dir():
    return Path(os.environ.get('CAMPUS_DATA_DIR', settings.BASE/'.data'))


def library():
    from library_pipeline import sync
    from university_sources_robot import load_registry, run_lock, Collector, UniversityRobot
    folder = data_dir()
    # Existing resources become browsable even if this round's network access fails.
    initial = sync(folder)
    state = folder/'university-crawler'
    registry = load_registry(settings.BASE/'university-sources.json')
    errors = []
    try:
        with run_lock(state):
            collector = Collector(registry['sources'], state, max_requests=24, max_seconds=150, delay=.2)
            result = UniversityRobot(registry, folder/'university-sources.json', state, collector=collector,
                max_sources=4, max_downloads=6, max_extractions=12, download=True).run()
            initial['collection'] = result.get('runStats', {})
            errors = [str(e)[:240] for e in result.get('failures', [])[:5]]
        from learning_sources_robot import refresh_learning_sources
        refresh_learning_sources(folder)
    except Exception as exc:
        errors.append(str(exc)[:240])
    result = sync(folder)
    return dict(result, collected=initial['collected']+result['collected'], collection=initial.get('collection'), errors=result['errors']+errors)


def projects(limit=2):
    from .github_guides import inspect, cache_key
    from .project_catalog import organize_repository, fingerprint
    from .project_summaries import generate
    from .maintenance import public_data
    from .beikuang import review_guides, review_projects, agent
    from .mirror import mirror_repository
    from .auto_media import choose
    try: seeds = json.loads((public_data()/'community.json').read_text(encoding='utf-8')).get('projects', [])
    except (ValueError, OSError): seeds = []
    repos = list(dict.fromkeys(p.get('repo', {}).get('fullName') for p in seeds if p.get('repo', {}).get('fullName')))
    repos += [d['repository'] for d in ExternalCache.objects.filter(key__startswith='github:', success__isnull=False).values_list('data', flat=True)
              if d.get('repository') and d['repository'] not in repos and (d.get('selection') or {}).get('shelf') != 'unlisted']
    results, errors, processed = [], [], 0
    for repo in repos:
        key = 'pipeline-project:'+hashlib.sha256(repo.lower().encode()).hexdigest()[:40]
        receipt = ExternalCache.objects.filter(pk=key).first()
        cache = ExternalCache.objects.filter(pk=cache_key(repo)).first()
        current = cache.data if cache else {}
        source = fingerprint(current) if current else ''
        if receipt and receipt.data.get('processorVersion') == 3 and receipt.checked and receipt.checked > timezone.now()-timedelta(hours=24) and receipt.data.get('source') == source:
            continue
        processed += 1
        steps = {}; guide = {}
        try:
            data = inspect(repo, refresh=not cache or not cache.success or cache.success < timezone.now()-timedelta(days=1))
            organize_repository(repo)
            cache = ExternalCache.objects.get(pk=cache_key(repo))
            if not cache.data.get('autoMedia'):
                cache.data['autoMedia'] = choose({'title': repo, 'category': cache.data.get('classification', {}).get('primary')})
                cache.save(update_fields=['data'])
            try:
                from .studio_budget import view as budget_view
                budget = budget_view()
                # Use the already authorized Codex seat when the shared currency allowance is low.
                provider = 'codex' if float(budget['remainingCny']) < .5 and budget.get('codexUnlimited') else None
                guide = generate(repo, 'continuous-v2:'+str(timezone.localdate())+':'+fingerprint(data), provider_override=provider)
                steps['guide'] = guide.get('reviewState')
            except Problem as exc:
                steps['guideError'] = exc.message
            run = {'published': [], 'escalated': [], 'errors': []}
            from .robot_actions import actor
            me = actor('codex') if guide.get('generatedBy') == 'Codex' else agent()
            run['reviewer'] = me.username
            review_projects(me, run); review_guides(me, run)
            steps['reviewed'] = len(run['published'])
            try:
                mirrored = mirror_repository(repo)
                steps['mirror'] = {k: v for k, v in mirrored.items() if k in ('repository', 'mirrored', 'skipped', 'errors', 'state', 'status', 'reason')}
            except Exception as exc:
                steps['mirrorError'] = str(exc)[:240]
            mirror_state = steps.get('mirror', {})
            if mirror_state.get('status') == 'license-blocked' or mirror_state.get('errors'):
                steps['mirrorError'] = mirror_state.get('reason') or str(mirror_state.get('errors'))[:240]
            cache.refresh_from_db()
            steps['source'] = fingerprint(cache.data)
            steps['repository'] = repo
            steps['guide'] = (cache.data.get('guide') or {}).get('reviewState', 'unavailable')
            if steps['guide'] != 'reviewed' and 'guideError' not in steps:
                steps['guideError'] = '中文导读尚未通过核对：'+steps['guide']
            steps['state'] = 'partial' if any(k.endswith('Error') for k in steps) else 'done'
            results.append(steps)
        except Exception as exc:
            steps = {'repository': repo, 'state': 'failed', 'error': str(exc)[:240], 'source': source}
        errors.extend(repo+'：'+str(v)[:240] for k, v in steps.items() if k.endswith('Error') or k == 'error')
        steps['processorVersion'] = 3
        ExternalCache.objects.update_or_create(key=key, defaults={'data': steps, 'checked': timezone.now(), 'error': '；'.join(errors[-2:])[:300]})
        if processed >= max(1, min(32, limit)): break
    return {'projects': len(repos), 'processed': processed, 'items': results, 'errors': errors,
            'note': '每轮推进两个项目；已完成版本不重复生成，失败保留原因。'}


def journal_facts():
    """One public context for the scheduled writer and local acceptance preview."""
    from .robot_inventory import snapshot
    stats = snapshot()
    return {'periodDays': stats['days'], 'seats': stats['seats'],
        'catalogue':{k:v for k,v in stats['coverage'].items() if k!='items'},
        'robots': [{k: r[k] for k in ('name', 'states', 'counts')} for r in stats['robots']],
        'unresolved': [{'robot': r['name'], 'state': r['latest']['state'], 'error': r['latest']['error'][:180]}
                       for r in stats['robots'] if r['latest'] and r['latest']['state'] in ('failed','partial')],
        'instruction': '写一篇给站主和同学看的中文小日志，保持当前人格和此刻情绪。先聊今天一件让你有感受的小事，再自然说结果和打算；允许得意、好奇、犯困、沮丧和克制的玩笑，但不强行卖萌，不套固定开头。北矿娘保持自己的活泼和小脾气；Codex 保持冷静简短、对闺蜜亲近的原人格，不模仿北矿娘。依据当前情绪选择消息表情与立绘，不要求每段都加。感受可以自由表达，事实只使用这里的公开运行记录；不引用私人聊天、记忆、账号、密钥或本机路径。不替搭档编台词，不把尝试、排队说成成功，不编造亲自调用过的工具。执行器会在正文之外列未解决事项，不必机械抄一遍全部数字。'}


def journal():
    from .companion_bridge import call
    from .robot_actions import actor
    from .auto_media import choose
    from .studio_config import config
    cfg = config(); results, errors = [], []
    public_facts = journal_facts()
    for seat in ('beikuang', 'codex'):
        slug = 'server-journal-'+seat+'-'+str(timezone.localdate())
        if Entry.objects.filter(slug=slug).exists(): continue
        ident = hashlib.sha256(slug.encode()).hexdigest()
        try:
            call('jobs', {'id': ident, 'owner': cfg['owner_id'], 'kind': 'report', 'text': '', 'report': public_facts}, seat=seat)
            deadline = time.monotonic()+480
            while time.monotonic() < deadline:
                result = call('jobs/'+ident, seat=seat)
                if result['state'] == 'failed': raise Problem(result.get('error', '日志生成失败'))
                if result['state'] == 'done': break
                time.sleep(.5)
            else: raise Problem('日志生成超时')
            body = result['result'].get('text', '')
            from .studio_workspace import checked_text
            checked_text(body)
            if not body.strip() or len(body)>9000 or any(word in body for word in ('C:\\Users\\', 'Bearer ', 'api_key')):
                raise Problem('日志正文为空、过长或包含私有配置线索，未公开。')
            label = 'Codex' if seat == 'codex' else '北矿娘'
            # Keep the original model's expression; execution facts remain separate,
            # visible and exportable instead of a mandatory robotic sign-off.
            payload = {'title': label+'的服务器日志 · '+str(timezone.localdate()), 'summary': body[:220], 'body': body,
                'credit': label, 'license': '本站原创维护日志', 'links': {}, 'uploads': [],
                'provenance': {'uploadedAt': timezone.now().isoformat(), 'uploadedBy': label, 'reviewedBy': '发布检查机器人', 'reviewMode': 'automated'},
                'maintenanceFacts': public_facts,
                'journalExpression': {'seat': seat, 'messages': [
                    {k: m[k] for k in ('type','text','emotion','expression','id') if k in m}
                    for m in result['result'].get('messages', []) if isinstance(m, dict)][:12]},
                'aiDisclosure': 'AI 角色维护日志，非学校官方通知'}
            payload['autoMedia'] = choose(payload)
            who = actor(seat)
            entry = Entry.objects.create(kind='announcement', owner=who, slug=slug, state='published', draft=payload,
                published=payload, public_revision=1, search_text=json.dumps(payload, ensure_ascii=False))
            Revision.objects.create(entry=entry, number=1, data=payload, state='published', reviewer=who, note='依据执行记录生成，私密字段检查通过')
            Audit.objects.create(actor=who, action='journal.publish', target=str(entry.pk), detail={'seat': seat, 'unresolved': len(public_facts['unresolved'])})
            results.append(str(entry.pk))
        except Exception as exc: errors.append(seat+'：'+str(exc)[:240])
    return {'published': len(results), 'items': results, 'errors': errors}


def run(name, payload=None):
    if not enabled(): return {'skipped': 'continuous-content-paused'}
    if name == 'library': return library()
    if name == 'projects': return projects(int((payload or {}).get('limit', 2)))
    if name == 'frontier':
        from .frontier_news import run as collect
        return collect()
    if name == 'illustrations':
        from .auto_media import sweep
        return sweep()
    if name == 'journal': return journal()
    raise Problem('持续更新任务不存在。')


def schedule():
    if not enabled(): return
    now = timezone.now()
    for name, seconds in INTERVALS.items():
        kind = 'pipeline-'+name
        latest = Job.objects.filter(kind=kind).order_by('-updated').first()
        if latest and (latest.state in ('running', 'queued') or (now-latest.updated).total_seconds() < seconds): continue
        Job.objects.get_or_create(key=kind+':'+str(int(now.timestamp())//seconds), defaults={'kind': kind, 'due': now})


def loop(stop):
    from .worker import run_one
    while not stop.is_set():
        try:
            close_old_connections()
            schedule()
            # In review-mode, drain only explicitly requested robot jobs as well as this pipeline.
            requested = tuple(Job.objects.filter(state='queued', payload__actorSeat__in=['beikuang','codex'])
                              .values_list('kind', flat=True).distinct()) if enabled() else ()
            if not run_one(KINDS+requested): stop.wait(5)
        except Exception:
            import logging
            logging.getLogger('hub.pipeline').exception('Continuous content worker failed')
            stop.wait(10)
