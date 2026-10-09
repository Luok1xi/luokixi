"""Owner-only studio API. UI and visual composition belong to Opus."""
import ipaddress
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from .core import Problem, require, text
from .models import Audit, StudioRoom, StudioRun, StudioMessage, StudioDay
from .studio_config import config, capabilities, PERSONAS, ready
from .studio_workspace import context_files, checked_text, verify_artifact


def owner(request):
    require(request.user, staff=True)
    cfg = config()
    try:
        local = ipaddress.ip_address(request.META.get('REMOTE_ADDR', '')).is_loopback
    except ValueError:
        local = False
    if settings.PRODUCTION or not local or not cfg['enabled'] or request.user.pk != cfg['owner_id']:
        raise Problem('工作室仅向本机配置的站主开放。', 403)
    if not request.user.email_verified and not (request.user.is_superuser and cfg.get('local_owner_bootstrap') is True):
        raise Problem('请先验证邮箱；本机初始化的开发者账号单独授权。', 403)
    return cfg


def room_for(user, key):
    room = StudioRoom.objects.filter(pk=key, owner=user).first()
    if not room:
        raise Problem('工作室房间不存在。', 404)
    return room


def room_data(room):
    return {'id': str(room.pk), 'title': room.title, 'brief': room.brief,
            'contextFiles': room.context_files, 'created': room.created.isoformat()}


def joint_runs(user):
    from django.db.models import TextField
    from django.db.models.functions import Cast
    # A joint run is explicit room-sharing. Ordinary private chat rooms stay separate.
    return (StudioRun.objects.filter(room__owner=user).exclude(mode='chat')
                .annotate(seat_names=Cast('seats',TextField()))
                .filter(seat_names__contains='"beikuang"').filter(seat_names__contains='"codex"')
                .order_by('-updated'))


def collaboration_context(user):
    """Read the existing joint rooms; do not create a second memory or task store."""
    from .studio_config import TEAM_RELATION
    runs = list(joint_runs(user).select_related('room').prefetch_related('messages')[:4])
    return {'relationship': TEAM_RELATION, 'source': 'existing-studio-rooms',
            'meaning':'历史讨论、任务建议和候选不是已执行成果；状态与实际检查记录为准。',
            'runs':[{'id':str(r.pk),'room':str(r.room_id),'title':r.room.title,'goal':r.prompt[:1200],
                'mode':r.mode,'state':r.state,'updated':r.updated.isoformat(),
                'checks':r.artifact.get('checks',[]),'functionalTests':r.artifact.get('functionalTests','not-run'),
                'messages':[{'seat':m.seat,'body':m.body[:1800],'tasks':m.tasks[:6]}
                            for m in sorted(r.messages.all(),key=lambda m:m.sequence)[-4:]]} for r in runs]}


def run_data(run):
    from .studio_workflow import task
    cached = getattr(run, '_prefetched_objects_cache', {}).get('messages')
    messages = sorted(cached, key=lambda m: m.sequence) if cached is not None else run.messages.order_by('sequence')
    return {'id': str(run.pk), 'room': str(run.room_id), 'mode': run.mode, 'prompt': run.prompt,
            'seats': run.seats, 'rounds': run.rounds, 'state': run.state, 'stopRequested': run.stop_requested,
            'error': run.error, 'artifact': run.artifact, 'approvedHash': run.approved_hash, 'workflow':task(run) if run.mode!='chat' else {},
            'created': run.created.isoformat(), 'updated': run.updated.isoformat(),
            'messages': [{'id': m.pk, 'sequence': m.sequence, 'seat': m.seat, 'provider': m.provider,
                          'model': m.model, 'body': m.body, 'tasks': m.tasks, 'usage': m.usage, 'expression': m.expression, 'messages':m.messages,
                          'created': m.created.isoformat()} for m in messages]}


def get(request, route):
    cfg = owner(request)
    parts = route.split('/')
    if route == 'studio/robots':
        from .robot_actions import policy
        from .robot_inventory import snapshot
        return dict(snapshot(), policy=policy())
    if route == 'studio/budget':
        from .studio_budget import view
        return view(cfg)
    if route == 'studio/activity':
        from .companion_team import activity
        return activity(request.user)
    if route == 'studio/voice':
        from .companion_bridge import call
        return call('voice')
    if route == 'studio/codex/chat':
        from .codex_chat import view
        return view(request.user, cfg)
    if route == 'studio/capabilities':
        day = StudioDay.objects.filter(day=timezone.localdate()).first()
        return dict(capabilities(cfg), budget={'day': timezone.localdate().isoformat(),
            'reservedCny': str(day.reserved_cny if day else 0), 'codexCalls': day.codex_calls if day else 0})
    if route == 'studio/rooms':
        preferred = joint_runs(request.user).values_list('room_id', flat=True).first()
        return {'preferredRoom': str(preferred) if preferred else None,
                'items': [room_data(r) for r in StudioRoom.objects.filter(owner=request.user).order_by('-created')[:50]]}
    if len(parts) == 3 and parts[1] == 'rooms':
        room = room_for(request.user, parts[2])
        from . import studio_workflow
        runs = list(room.runs.order_by('-created').prefetch_related('messages')[:20])
        for run in runs: run.room = room
        if hasattr(studio_workflow, 'preload'):
            studio_workflow.preload(runs)
        return dict(room_data(room), runs=[run_data(r) for r in runs])
    if len(parts) == 3 and parts[1] == 'runs':
        run = StudioRun.objects.filter(pk=parts[2], room__owner=request.user).first()
        if not run:
            raise Problem('讨论不存在。', 404)
        return run_data(run)
    raise Problem('接口不存在。', 404)


def post(request, route, body):
    owner(request)
    if route == 'studio/voice':
        from .companion_bridge import call
        from .studio_providers import EXPRESSIONS
        words = text(body.get('text', ''), 600, True)
        if body.get('seat') not in ('beikuang', 'codex') or body.get('expression', 'neutral') not in EXPRESSIONS:
            raise Problem('角色或表情无效。')
        if body.get('language', 'ja') not in ('ja','zh','en'):
            raise Problem('朗读语言无效。')
        return call('voice', {'language':body.get('language','ja'), 'text': words, 'seat': body.get('seat', 'beikuang'), 'expression': body.get('expression', 'neutral')}, timeout=300)
    return transactional_post(request, route, body)


@transaction.atomic
def transactional_post(request, route, body):
    cfg = owner(request)
    parts = route.split('/')
    if route == 'studio/robots':
        from .robot_actions import policy
        from .robot_inventory import snapshot
        return dict(snapshot(), policy=policy())
    if route == 'studio/budget':
        from .studio_budget import save
        return save(request.user, body)
    if route == 'studio/inspect':
        import uuid
        from .companion_team import dispatch
        from .beikuang import today_stats
        return dispatch(request.user, {'id': str(uuid.uuid4()), 'action': 'inspect_site',
            'goal': '检查当前网站的页面和图片', 'reason': '站主在工作室请求浏览器巡检'}, today_stats())
    if route == 'studio/codex/messages':
        from .codex_chat import send
        return send(request.user, cfg, body)
    if route == 'studio/rooms':
        names = body.get('contextFiles', [])
        context_files(names)
        room = StudioRoom.objects.create(owner=request.user, title=text(body.get('title', ''), 120, True),
            brief=checked_text(text(body.get('brief', ''), 8000)), context_files=names)
        return room_data(room)
    if len(parts) == 4 and parts[1] == 'rooms' and parts[3] == 'runs':
        room = room_for(request.user, parts[2])
        key = text(body.get('requestKey', ''), 80, True)
        prompt = checked_text(text(body.get('prompt', ''), 6000, True))
        mode = body.get('mode', 'discuss')
        seats = body.get('seats', ['beikuang', 'codex'])
        rounds = body.get('rounds', 6 if mode == 'work' else 3)
        if mode not in {'discuss', 'work'} or type(rounds) is not int or not 1 <= rounds <= cfg['max_rounds']:
            raise Problem('模式或轮数无效；一次最多 6 轮。')
        if not isinstance(seats, list) or not seats or len(seats) > len(PERSONAS) or any(s not in PERSONAS for s in seats) or len(set(seats)) != len(seats):
            raise Problem('请从工作室成员中选择发言席位。')
        if mode == 'work' and ('codex' not in seats or rounds < seats.index('codex') + 1):
            raise Problem('写代码模式需要包含 Codex 工程席的一轮发言。')
        existing = room.runs.filter(request_key=key).first()
        if existing:
            if (existing.prompt, existing.mode, existing.seats, existing.rounds) != (prompt, mode, seats, rounds):
                raise Problem('此请求编号已用于不同内容。', 409)
            return run_data(existing)
        if StudioRun.objects.filter(room=room, state__in=['queued', 'running', 'reconnecting', 'interrupted', 'waiting_jobs']).exists():
            raise Problem('该房间还有工作未结束。', 409)
        for seat in set(seats[:rounds]):
            ready(PERSONAS[seat]['provider'], cfg)
        run = StudioRun.objects.create(room=room, request_key=key, prompt=prompt, mode=mode, seats=seats, rounds=rounds)
        Audit.objects.create(actor=request.user, action='studio.queued', target=str(run.pk), detail={'mode': mode, 'rounds': rounds})
        return run_data(run)
    if len(parts) == 4 and parts[1] == 'runs':
        run = StudioRun.objects.select_for_update().filter(pk=parts[2], room__owner=request.user).first()
        if not run:
            raise Problem('讨论不存在。', 404)
        action = parts[3]
        if action == 'stop':
            if run.state in {'queued', 'running', 'interrupted', 'reconnecting', 'waiting_jobs'}:
                run.stop_requested = True
                if run.state != 'running':
                    run.state = 'cancelled'
                run.save(update_fields=['stop_requested', 'state', 'updated'])
            return run_data(run)
        if action == 'approve':
            if run.state not in {'awaiting_review', 'approved'}:
                raise Problem('这轮工作尚未形成可确认的产物。', 409)
            artifact = verify_artifact(run)
            if body.get('hash') != artifact['hash']:
                raise Problem('确认内容与当前产物不一致。', 409)
            if body.get('acknowledgeUnrunTests') is not True:
                raise Problem('请确认已知当前自动检查范围，不等于完整功能验收。')
            if any(c['state'] in {'failed', 'unavailable'} for c in artifact['checks']):
                raise Problem('自动检查尚未通过，不能确认。', 409)
            if run.state != 'approved':
                run.approved_hash, run.state = artifact['hash'], 'approved'
                run.save(update_fields=['approved_hash', 'state', 'updated'])
                Audit.objects.create(actor=request.user, action='studio.approved', target=str(run.pk), detail={'hash': artifact['hash'], 'published': False})
            return run_data(run)
    raise Problem('接口不存在；工作室没有自动发布接口。', 404)
