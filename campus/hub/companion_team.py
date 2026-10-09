"""Actions chosen by the original Agency, executed in the existing studio and Job queue."""
import hashlib
import json
from datetime import timedelta
from django.db import transaction
from django.utils import timezone
from .core import Problem
from .models import ExternalCache, Job, StudioRoom, StudioRun
from .studio_config import ready
from . import studio_config


def observation(today):
    cfg = studio_config.config()
    inspection = Job.objects.filter(kind='site-browser-audit').order_by('-updated').first()
    recent = StudioRun.objects.filter(request_key__startswith='initiative:').order_by('-created').first()
    actions = []
    now = timezone.now()
    if not inspection or (inspection.state not in ('queued', 'running') and now-inspection.updated >= timedelta(hours=6)):
        actions.append('inspect_site')
    evidence = {'queued': today.get('queued', 0), 'failures': today.get('botFailures', 0),
                'inspection': str(inspection.pk) if inspection else None}
    fingerprint = hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()[:32]
    meaningful = evidence['queued'] or evidence['failures'] or (inspection and inspection.result.get('issues'))
    from .studio_budget import view
    budget = view(cfg)
    can_pay = float(budget['remainingCny']) >= .1 and (budget.get('codexUnlimited') or (budget['codexRemaining'] or 0) >= 1)
    running = StudioRun.objects.filter(state__in=('queued', 'running', 'reconnecting', 'interrupted', 'waiting_jobs'), room__owner_id=cfg['owner_id']).exists()
    if meaningful and can_pay and not running and (not recent or now-recent.created >= timedelta(minutes=5)):
        if not ExternalCache.objects.filter(key='companion-discussed:' + fingerprint, checked__gte=now-timedelta(minutes=30)).exists():
            actions.append('discuss')
    return {'actions': actions, 'fingerprint': fingerprint, 'budget': budget,
            'inspection': ({'id': str(inspection.pk), 'state': inspection.state, 'result': inspection.result,
                            'error': inspection.error, 'at': inspection.updated.isoformat()} if inspection else None),
            'discussion': ({'room': str(recent.room_id), 'run': str(recent.pk), 'state': recent.state,
                            'goal': recent.prompt[:500], 'error': recent.error,
                            'at': recent.updated.isoformat()} if recent else None),
            'discussionReason': '等待她选择是否与 Codex 商量' if 'discuss' in actions else
                '本站额度不足，自动讨论暂缓' if not can_pay else '没有新问题，或已有讨论正在进行、尚在冷却中'}


@transaction.atomic
def dispatch(owner, body, today):
    action, ident = body['action'], body['id']
    actor='Codex' if body.get('seat')=='codex' else '北矿娘'
    receipt, _ = ExternalCache.objects.get_or_create(key='companion-team:' + ident)
    if receipt.data:
        return dict(receipt.data, duplicate=True)
    observed = observation(today)
    if action not in observed['actions'] and not (action=='discuss' and body.get('explicit') and not StudioRun.objects.filter(state__in=('queued','running','reconnecting','interrupted','waiting_jobs')).exists()):
        raise Problem('当前没有可重复启动的这项工作，请先读取最新状态。', 409)
    if action == 'inspect_site':
        job = Job.objects.create(key='companion-browser:' + ident, kind='site-browser-audit', owner=owner,
            payload={'actorSeat':body.get('seat','beikuang'),'companionDecision': {k: body[k] for k in ('id', 'goal', 'reason')}}, due=timezone.now())
        result = {'key': job.key, 'state': job.state, 'completed': False}
    elif action == 'discuss':
        cfg = studio_config.config()
        ready('codex', cfg); ready('deepseek', cfg)
        room, _ = StudioRoom.objects.get_or_create(owner=owner, title='她们的工作间',
            defaults={'brief':'北矿娘和 Codex 的持续维护记录。读取上一轮工具结果，分清待办、尝试、验证和仍未解决的问题。'})
        run = StudioRun.objects.create(room=room, request_key='initiative:' + ident,
            prompt=body['goal'] + '\n'+actor+'选择的理由：' + body['reason'] + '\n刚观察到的网站事实：' +
                json.dumps({'today': today, 'inspection': observed['inspection']}, ensure_ascii=False)[:4300],
            mode='discuss', seats=['beikuang','codex'] if actor=='Codex' else ['codex', 'beikuang'], rounds=min(3, cfg['max_rounds']))
        ExternalCache.objects.update_or_create(key='companion-discussed:' + observed['fingerprint'], defaults={'checked':timezone.now(),'data':{'run': str(run.pk)}})
        result = {'key': 'studio:' + str(run.pk), 'state': run.state, 'room': str(room.pk), 'completed': False}
    else:
        raise Problem('未知工作。')
    receipt.data = result; receipt.save(update_fields=['data'])
    return result


def activity(owner):
    from .beikuang import today_stats
    from .companion_bridge import runtime_state, autonomy_enabled
    runtime = runtime_state(owner)
    work = runtime.get('work') or {}
    return {'enabled': autonomy_enabled(), 'team': observation(today_stats()),
            'decisions': work.get('decisions', []), 'intentions': work.get('intentions', []),
            'readingNotes': runtime.get('readingNotes'), 'studySessions': runtime.get('studySessions'),
            'tools': runtime.get('toolGroups', []), 'runtimeError': runtime.get('error') or runtime.get('backgroundError', '')}
