"""Transport to the original campus-companion runtime, not a second persona engine."""
import hashlib
import hmac
import ipaddress
import json
import time
import uuid
from decimal import Decimal, InvalidOperation
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from .core import Problem
from .models import ExternalCache, StudioDay, Member, BeikuangMessage, Job


def connection(seat='beikuang'):
    path = settings.DATA / ('codex-companion-bridge.json' if seat=='codex' else 'companion-bridge.json')
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else None


def autonomy_enabled():
    return bool((connection() or {}).get('work_autonomy'))


def work_state():
    from .beikuang import today_stats, enabled as review_enabled
    from .studio import collaboration_context
    from .studio_config import config
    jobs = list(Job.objects.filter(kind__in=['maint-beikuang', 'site-browser-audit']).filter(
        Q(result__skipped__isnull=True) | ~Q(result__skipped='awaiting-companion-decision')
    ).order_by('-updated')[:8])
    from .companion_team import observation
    stats = today_stats()
    team = observation(stats)
    return {'enabled': autonomy_enabled() and review_enabled(), 'day': str(timezone.localdate()),
            'maintenance': __import__('hub.robot_actions', fromlist=['policy']).policy(),
            'team': team, 'today': stats, 'collaboration':collaboration_context(config().get('owner_id')),
            'jobs': [{'key': j.key, 'state': j.state, 'decisionId': j.payload.get('companionDecision', {}).get('id'),
                      'goal': j.payload.get('companionDecision', {}).get('goal'), 'result': j.result,
                      'error': j.error[:240], 'updated': j.updated.isoformat()} for j in jobs]}


@transaction.atomic
def work_action(owner, body):
    from .beikuang import enabled as review_enabled, today_stats
    if not autonomy_enabled() or not review_enabled():
        raise Problem('自主网站工作已暂停。', 403)
    if body.get('action') not in ('review', 'discuss', 'inspect_site'):
        raise Problem('这项自主工作尚未授权。', 403)
    ident = str(uuid.UUID(body['id']))
    for field in ('goal', 'reason'):
        if not isinstance(body.get(field), str) or not body[field].strip() or len(body[field]) > 300:
            raise Problem('自主工作需要具体目标和选择理由。')
    if body['action'] != 'review':
        from .companion_team import dispatch
        return dispatch(owner, dict(body, id=ident), today_stats())
    # Serialize dispatch and replay on an idempotency row; never infer permission from a model's prose.
    receipt, _ = ExternalCache.objects.get_or_create(key='companion-work:' + ident)
    ExternalCache.objects.filter(pk=receipt.pk).update(checked=timezone.now())
    receipt.refresh_from_db()
    if receipt.data.get('key'):
        job = Job.objects.filter(key=receipt.data['key']).first()
        if job:
            return {'key': job.key, 'state': job.state, 'duplicate': True}
    job = Job.objects.filter(kind='maint-beikuang', state__in=('queued', 'running')).first()
    if not job and today_stats()['queued'] <= 0:
        return {'state': 'done', 'key': '', 'message': '待办已变化，当前没有需要启动的审核。'}
    if not job:
        job = Job.objects.create(key='companion-review:' + ident, kind='maint-beikuang', owner=owner,
            payload={'actorSeat':body.get('seat','beikuang'),'companionDecision': {'id': ident, 'goal': body['goal'], 'reason': body['reason']}}, due=timezone.now())
    receipt.data = {'key': job.key}
    receipt.save(update_fields=['data'])
    return {'key': job.key, 'state': job.state, 'completed': False}


def enabled():
    return bool(connection()) and not settings.PRODUCTION


_state_cache = {}


def runtime_state(owner, seat='beikuang'):
    """Display the same original state used for decisions, without a model call."""
    from .studio_config import config
    if settings.PRODUCTION or not connection(seat) or owner.pk != config().get('owner_id'):
        return {}
    now = time.monotonic()
    key=(owner.pk,seat)
    cached=_state_cache.get(key,{})
    if now < cached.get('until', 0):
        return cached['data']
    try:
        status = call('status', timeout=2, seat=seat)
        data = {key: status.get(key) for key in ('engine', 'emotion', 'self', 'work', 'readingNotes', 'studySessions', 'toolGroups', 'backgroundError')}
    except Problem as exc:
        data = {'error': exc.message}
    for stale in [k for k,v in _state_cache.items() if v['until']<=now]:
        del _state_cache[stale]
    _state_cache[key]={'until':now+8,'data':data}
    return data


def call(route, body=None, timeout=8, seat='beikuang'):
    cfg = connection(seat)
    if not cfg:
        raise Problem(('Codex' if seat=='codex' else '小煤渣')+'的原版运行时还没有接入本机。', 503)
    request = Request(f'http://127.0.0.1:{int(cfg["port"])}/{route}',
                      data=json.dumps(body, ensure_ascii=False).encode() if body is not None else None,
                      headers={'Authorization': 'Bearer ' + cfg['token'], 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except HTTPError as exc:
        try:
            error = json.load(exc).get('error', '原版小煤渣未完成这次操作。')
        except (ValueError, OSError):
            error = '原版小煤渣未完成这次操作。'
        raise Problem(error, exc.code) from None
    except (URLError, TimeoutError, OSError):
        raise Problem('原版小煤渣服务暂未连接；没有切回另一套人格。', 503) from None


def respond(context, key, report=False):
    from .beikuang_turns import Superseded
    from .studio_config import config
    cfg = config()
    owner = context.get('ownerId') or cfg.get('owner_id')
    if not cfg.get('enabled') or owner != cfg.get('owner_id'):
        raise Problem('此窗口没有原版小煤渣的站主权限。', 403)
    ident = hashlib.sha256(key.encode()).hexdigest()
    current = context.get('_isCurrent', lambda: True)
    call('jobs', {'id': ident, 'owner': owner, 'kind': 'report' if report else 'chat',
                  'text': context.get('owner', ''),
                  'material': {k: context[k] for k in ('tools', 'today', 'waiting', 'auditLessons') if context.get(k)},
                  'report': {k: v for k, v in context.items() if not k.startswith('_')} if report else None})
    deadline = time.monotonic() + 660
    while time.monotonic() < deadline:
        if not current():
            call('cancel', {'id': ident})
            raise Superseded()
        result = call('jobs/' + ident)
        if result['state'] == 'failed':
            raise Problem(result.get('error') or '原版小煤渣未完成回复。', 502)
        if result['state'] == 'done':
            value = result['result']
            if value.get('superseded'):
                raise Superseded()
            context['_companion'] = value
            return value.get('text', ''), 'deepseek-flash'
        time.sleep(.35)
    call('cancel', {'id': ident})
    raise Problem('原版小煤渣处理超时，任务已取消。', 504)


def studio_respond(run, sequence, material, stopped=lambda: False, seat='beikuang', can_code=False):
    """Same original writer, existing studio records, no parallel persona or task engine."""
    from .studio_workflow import job_id, task, record
    row = ExternalCache.objects.filter(pk='studio-workflow:'+str(run.pk)).first()
    saved = row.data if row else {}
    reconciliations = dict(saved.get('reconciliations', {}))
    attempt = reconciliations.get(str(sequence), 0)
    ident = job_id(run, sequence, attempt)
    if stopped():
        raise Problem('工作室已停止。',409)
    if material.pop('_resume', False) or attempt:
        try:
            prior = call('jobs/'+ident, seat=seat)
        except Problem as exc:
            if exc.status != 404: raise
            prior = {'state':'missing'}
        if prior['state'] in ('missing','interrupted') and not (attempt and prior['state']=='missing'):
            if attempt:
                raise Problem('续接核验也被中断；已保留交接记录和预算，请查看执行器状态。',409)
            # Legacy hosts lost in-memory replies on restart. A fresh read-only
            # reconciliation can finish the conversation without repeating writes.
            attempt = 1
            reconciliations[str(sequence)] = attempt
            record(run, reconciliations=reconciliations,
                   recovery='原结果不可取回：只补充核验和交接，不重复旧工具操作；旧预算保留。')
            ident = job_id(run, sequence, attempt)
    if attempt:
        can_code = False
        material = dict(material, maintenance={'enabled':False}, workPrompt='',
            recovery='上次调用中断且结果无法取回。只根据当前提供的已有发言、任务和凭据继续核验与交接。不要重做操作，不声称旧操作已成功；缺少凭据时明确留下未解决项。')
    kind='chat' if run.mode=='chat' else 'work' if can_code else 'studio'
    call('jobs', {'id':ident,'owner':run.room.owner_id,'kind':kind,'text':run.prompt if kind=='chat' else '', 'material':material}, seat=seat)
    deadline = time.monotonic()+720
    while time.monotonic()<deadline:
        if stopped():
            call('cancel',{'id':ident},seat=seat)
            raise Problem('工作室已停止，返回内容未采用。',409)
        try:
            result = call('jobs/'+ident,seat=seat)
        except Problem as exc:
            if exc.status == 404:
                raise Problem('原版执行器重载中，正在重新连接同一任务。',503) from None
            raise
        if result['state']=='interrupted':
            raise Problem('原版运行进程中断，正在等待续接核验。',503)
        if result['state']=='failed':
            raise Problem(result.get('error') or '原版北矿娘未完成工作室发言。',502)
        if result['state']=='done':
            output = result['result']
            if output.get('superseded'):
                raise Problem('这轮工作室发言已取消。',409)
            # Studio owns the history. Do not insert collaborators' words as owner chat.
            if can_code:
                from .studio_providers import reply_json
                result=reply_json(json.dumps({k:output[k] for k in ('message','tasks','files','expression','messages') if k in output}))
                return result,output.get('model','codex-cli'),{}
            return {'message':output['text'],'tasks':[],'files':[], 'messages':output.get('messages',[]),
                    'expression':next((m.get('expression') for m in output.get('messages', []) if m.get('expression')), (output.get('emotion') or {}).get('name','neutral'))},output.get('model','deepseek-flash' if seat=='beikuang' else 'codex-cli'),{'maintenance':output.get('maintenance')}
        time.sleep(.35)
    call('cancel',{'id':ident},seat=seat)
    raise Problem('工作室发言超时，任务已取消。',504)


@transaction.atomic
def reserve(body):
    from .studio_config import config, price_rates
    cfg = config()
    if not cfg['enabled']:
        raise Problem('本机模型已暂停。', 403)
    rates = price_rates(cfg)
    try:
        units, output = body['inputUnits'], body['outputTokens']
        if type(units) is not int or type(output) is not int or not 0 < units <= 2000000 or not 0 < output <= 6000:
            raise Problem('费用预留参数超出范围。')
        amount = (Decimal(units) * rates[0] + Decimal(output) * rates[1]) / 1000000
    except (InvalidOperation, KeyError):
        raise Problem('费用预留格式错误。')
    if not amount.is_finite() or not 0 < amount <= 5:
        raise Problem('费用预留超出范围。')
    key = 'companion-call:' + str(uuid.UUID(body['id']))
    call, made = ExternalCache.objects.get_or_create(key=key)
    if not made:
        raise Problem('该调用已预留，不重复调用。', 409)
    day, _ = StudioDay.objects.get_or_create(day=timezone.localdate())
    day = StudioDay.objects.select_for_update().get(pk=day.pk)
    if day.reserved_cny + amount > cfg['daily_cny']:
        raise Problem(f'已达到本站每日 ¥{cfg["daily_cny"]} 预算，可在聊天旁的“额度设置”调整。', 429)
    day.reserved_cny += amount
    day.save(update_fields=['reserved_cny'])
    call.data = {'state': 'reserved', 'provider': 'deepseek', 'reservedCny': str(amount),
                 'day': str(day.day), 'rates': [str(r) for r in rates],
                 'purpose': str(body.get('purpose', 'dialogue'))[:80]}
    call.checked = timezone.now()
    call.save()
    return {'ok': True}


@transaction.atomic
def settle(body):
    """Release excess only after a confirmed complete token receipt, using reserved-time rates."""
    key = 'companion-call:' + str(uuid.UUID(body['id']))
    row = ExternalCache.objects.select_for_update().get(pk=key)
    if row.data.get('state') != 'reserved':
        return {'ok': True, 'duplicate': True}
    usage = body.get('usage', {})
    if not isinstance(usage, dict):
        raise Problem('模型用量格式错误。')
    data = dict(row.data, state='failed' if body.get('failed') else 'done', usage=usage)
    tokens = [usage.get(k) for k in ('prompt_tokens', 'completion_tokens')]
    rates = data.get('rates')
    if not body.get('failed') and rates and all(type(n) is int and 0 <= n <= 2000000 for n in tokens):
        charge = sum(Decimal(n) * Decimal(r) for n, r in zip(tokens, rates)) / 1000000
        day = StudioDay.objects.select_for_update().get(day=data['day'])
        day.reserved_cny = max(Decimal(0), day.reserved_cny - Decimal(data['reservedCny']) + charge)
        day.save(update_fields=['reserved_cny'])
        data['accountedCny'] = str(charge)
    row.data = data
    row.success = None if body.get('failed') else timezone.now()
    row.save()
    return {'ok': True}


@csrf_exempt
def endpoint(request):
    try:
        candidates=[(seat,connection(seat)) for seat in ('beikuang','codex')]
        remote = ipaddress.ip_address(request.META.get('REMOTE_ADDR', ''))
        auth = request.headers.get('Authorization', '')
        seat,cfg=next(((seat,cfg) for seat,cfg in candidates if cfg and hmac.compare_digest(auth,'Bearer '+cfg['token'])),(None,None))
        if settings.PRODUCTION or not remote.is_loopback or not cfg:
            raise Problem('连接未授权。', 403)
        if request.method != 'POST' or request.content_type != 'application/json' or len(request.body) > 12 * 1024 * 1024:
            raise Problem('连接请求格式错误。', 400)
        body = json.loads(request.body)
        from .studio_config import config
        owner = Member.objects.filter(pk=config().get('owner_id'), is_staff=True, is_active=True).first()
        if not owner:
            raise Problem('本机站主未配置。', 503)
        op = body.get('op')
        if op == 'codex-model':
            if seat!='codex': raise Problem('该连接不是 Codex 运行时。',403)
            from .companion_codex import respond as codex_respond
            result=codex_respond(body)
        elif op == 'voice':
            if seat!='codex': raise Problem('该连接不是 Codex 运行时。',403)
            content=body.get('text','')
            if not isinstance(content,str) or not content.strip() or len(content)>6000 or body.get('language','ja') not in ('ja','zh','en'):
                raise Problem('角色朗读格式错误。')
            result=call('voice',{'seat':'codex','text':content,'language':body.get('language','ja'),
                                'expression':str(body.get('expression') or 'neutral')[:40]},timeout=300)
        elif op == 'reserve':
            result = reserve(body)
        elif op == 'settle':
            result = settle(body)
        elif op == 'tool':
            from .beikuang_tools import execute
            if body.get('name') not in ('site_status','library_search','library_read','audit_queue','audit_lessons','site_browser_report'):
                raise Problem('该工具未授权。', 403)
            if body['name'] == 'site_browser_report':
                from .companion_team import observation
                result = observation({})['inspection'] or {'state': 'not-run'}
            else:
                result = execute(owner, body['name'], body.get('arguments', {}))
        elif op == 'maintenance':
            from .robot_actions import execute
            result = execute(owner, seat, body.get('operation'), body.get('arguments', {}), body.get('id'))
        elif op == 'work-state':
            result = work_state()
        elif op == 'continuity':
            from .companion_continuity import seat_context
            result = seat_context(owner, seat, str(body.get('query', ''))[:2000])
        elif op == 'work-action':
            from .robot_workbench import reload_source
            reload_source('campus/hub/companion_team.py')
            result = work_action(owner, dict(body,seat=seat))
        elif op == 'delivery':
            ident = str(body.get('id', ''))
            content = body.get('text', '')
            if not ident or not isinstance(content, str) or not content.strip() or len(content) > 20000:
                raise Problem('主动消息格式错误。')
            key = 'companion-delivery:'+seat+':' + hashlib.sha256(ident.encode()).hexdigest()
            with transaction.atomic():
                row, made = ExternalCache.objects.get_or_create(key=key)
                if made:
                    if seat=='codex':
                        from .codex_chat import deliver
                        msg=deliver(owner,ident,content,body.get('messages',[]))
                    else:
                        msg = BeikuangMessage.objects.create(owner=owner, role='beikuang', kind='chat', body=content,
                        data={'generated':'model','model':'deepseek-flash','engine':'campus-companion',
                              'proactive':True,'messages':body.get('messages',[])})
                    row.data = {'message':str(msg.pk)}
                    row.save()
            result = {'ok':True,'duplicate':not made}
        else:
            raise Problem('未知连接操作。')
        return JsonResponse(result, json_dumps_params={'ensure_ascii':False})
    except Problem as exc:
        return JsonResponse({'error':exc.message}, status=exc.status)
    except (ValueError, TypeError, KeyError):
        return JsonResponse({'error':'连接请求格式错误。'}, status=400)
