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


def run_data(run):
    return {'id': str(run.pk), 'room': str(run.room_id), 'mode': run.mode, 'prompt': run.prompt,
            'seats': run.seats, 'rounds': run.rounds, 'state': run.state, 'stopRequested': run.stop_requested,
            'error': run.error, 'artifact': run.artifact, 'approvedHash': run.approved_hash,
            'created': run.created.isoformat(), 'updated': run.updated.isoformat(),
            'messages': [{'id': m.pk, 'sequence': m.sequence, 'seat': m.seat, 'provider': m.provider,
                          'model': m.model, 'body': m.body, 'tasks': m.tasks, 'usage': m.usage,
                          'created': m.created.isoformat()} for m in run.messages.order_by('sequence')]}


def get(request, route):
    cfg = owner(request)
    parts = route.split('/')
    if route == 'studio/capabilities':
        day = StudioDay.objects.filter(day=timezone.localdate()).first()
        return dict(capabilities(cfg), budget={'day': timezone.localdate().isoformat(),
            'reservedCny': str(day.reserved_cny if day else 0), 'codexCalls': day.codex_calls if day else 0})
    if route == 'studio/rooms':
        return {'items': [room_data(r) for r in StudioRoom.objects.filter(owner=request.user).order_by('-created')[:50]]}
    if len(parts) == 3 and parts[1] == 'rooms':
        room = room_for(request.user, parts[2])
        return dict(room_data(room), runs=[run_data(r) for r in room.runs.order_by('-created')[:20]])
    if len(parts) == 3 and parts[1] == 'runs':
        run = StudioRun.objects.filter(pk=parts[2], room__owner=request.user).first()
        if not run:
            raise Problem('讨论不存在。', 404)
        return run_data(run)
    raise Problem('接口不存在。', 404)


@transaction.atomic
def post(request, route, body):
    cfg = owner(request)
    parts = route.split('/')
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
        seats = body.get('seats', ['deepseek', 'design', 'codex'])
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
        if StudioRun.objects.filter(room=room, state__in=['queued', 'running']).exists():
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
            if run.state in {'queued', 'running'}:
                run.stop_requested = True
                if run.state == 'queued':
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
