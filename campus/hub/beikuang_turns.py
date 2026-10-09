"""Owner-scoped turn leases, short-message coalescing and stale reply suppression."""
import time
import uuid
import re
from datetime import timedelta
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from .models import BeikuangMessage, ExternalCache, Job


SETTLE_SECONDS = .45
MAX_SETTLE_SECONDS = 1.5


class Superseded(Exception):
    pass


def lease_key(owner_id):
    return f'beikuang:turn:{owner_id}'


def settle(owner_id):
    deadline = time.monotonic() + MAX_SETTLE_SECONDS
    while True:
        last = BeikuangMessage.objects.filter(owner_id=owner_id, role='owner', kind='chat').order_by('-created').first()
        gap = (timezone.now() - last.created).total_seconds() if last else SETTLE_SECONDS
        remaining = min(SETTLE_SECONDS - gap, deadline - time.monotonic())
        if remaining <= 0:
            return
        time.sleep(min(remaining, .15))


@transaction.atomic
def claim(message):
    now, token = timezone.now(), uuid.uuid4().hex
    lease, _ = ExternalCache.objects.get_or_create(key=lease_key(message.owner_id), defaults={'data': {}})
    lease = ExternalCache.objects.select_for_update().get(pk=lease.pk)
    if lease.data.get('token') and lease.data.get('until', '') > now.isoformat():
        return None
    lease.data = {'token': token, 'until': (now + timedelta(minutes=15)).isoformat()}
    lease.checked = now
    lease.save(update_fields=['data', 'checked'])
    messages = list(BeikuangMessage.objects.filter(owner_id=message.owner_id, role='owner', kind='chat')
                    .filter(Q(state='waiting') | Q(pk=message.pk)).exclude(state='answered').order_by('created')[:20])
    last = BeikuangMessage.objects.filter(owner_id=message.owner_id, role='owner', kind='chat').order_by('-created').first()
    cutoff = last.created if last else now
    boundary_ids = list(BeikuangMessage.objects.filter(owner_id=message.owner_id, role='owner', kind='chat', created=cutoff).values_list('pk', flat=True))
    return {'token': token, 'messages': messages, 'cutoff': cutoff, 'boundaryIds': boundary_ids,
            'owner': message.owner, 'lease': lease.pk}


def current(turn):
    return not BeikuangMessage.objects.filter(owner=turn['owner'], role='owner', kind='chat',
                                             created__gte=turn['cutoff']).exclude(pk__in=turn['boundaryIds']).exists()


def release(turn):
    with transaction.atomic():
        row = ExternalCache.objects.select_for_update().get(pk=turn['lease'])
        if row.data.get('token') == turn['token']:
            row.data = {}
            row.save(update_fields=['data'])


@transaction.atomic
def deliver(turn, body, data, outcome=None):
    # Start with a write so SQLite serializes this check/commit with incoming messages.
    ExternalCache.objects.filter(pk=turn['lease']).update(checked=timezone.now())
    row = ExternalCache.objects.get(pk=turn['lease'])
    if row.data.get('token') != turn['token'] or not current(turn):
        return None
    messages = turn['messages']
    ids = [str(m.pk) for m in messages]
    if not messages or BeikuangMessage.objects.filter(owner=turn['owner'], data__replyTo=ids[-1]).exists():
        return None
    from .beikuang_memory import learn
    from .beikuang import emotion_state
    if data.get('engine') == 'campus-companion':
        learned = {'owner': 'campus-companion'}
        feeling = data.get('emotion') or {'name':'neutral','intensity':0}
        ExternalCache.objects.update_or_create(key=f'beikuang:feeling:{turn["owner"].pk}',
            defaults={'data':feeling,'checked':timezone.now(),'success':timezone.now()})
    else:
        learned = learn(turn['owner'], messages, outcome or {})
    data.update(replyTo=ids[-1], replyToMessages=ids, learning=learned, emotion=data.get('emotion') or emotion_state(turn['owner']))
    answer = BeikuangMessage.objects.create(owner=turn['owner'], role='beikuang', kind='chat', body=body, data=data)
    BeikuangMessage.objects.filter(pk__in=ids).update(state='answered')
    Job.objects.filter(key__in=[f'beikuang-chat:{pk}' for pk in ids], state='queued').update(
        state='done', result={'answeredBy': str(answer.pk), 'coalesced': len(ids)}, error='')
    return answer


def reply(message_id):
    from . import beikuang, beikuang_tools as tools
    from . import companion_bridge
    from .beikuang_memory import dialogue_frame
    msg = BeikuangMessage.objects.select_related('owner').filter(pk=message_id, role='owner', kind='chat').first()
    if not msg:
        return {'skipped': 'missing'}
    if msg.state == 'answered' or BeikuangMessage.objects.filter(owner=msg.owner, data__replyTo=str(msg.pk)).exists():
        return {'skipped': 'answered'}
    settle(msg.owner_id)
    turn = claim(msg)
    if turn is None:
        return {'deferred': True, 'reason': 'owner-turn-in-progress'}
    try:
        messages = turn['messages']
        if not messages:
            return {'skipped': 'answered'}
        words = '\n'.join(m.body for m in messages)
        trace = []
        extra = {}
        for index, source in enumerate(messages):
            if companion_bridge.enabled():
                extra = {'tools': [], 'auditLessons': []}
                # Memory/persona commands go exclusively to the original runtime.
                for name in ('review', 'work_log'):
                    if tools.command_authorized(source, name, {}):
                        extra['tools'].append(tools.execute(source.owner, name, {}, source))
            else:
                extra = tools.prepare_context(source, reads=index == len(messages) - 1, memories=False)
            trace.extend(extra['tools'])
        ids = [m.pk for m in messages]
        recent_rows = list(BeikuangMessage.objects.filter(owner=msg.owner, kind='chat', created__lte=messages[0].created)
                           .exclude(state='archived').exclude(pk__in=ids).order_by('-created')[:16])
        recent = [{'from': '站主' if m.role == 'owner' else '北矿娘', 'text': m.body[:900]} for m in reversed(recent_rows)]
        work = bool(re.search(r'进度|今日|今天.*(情况|工作|发布)|审核|待办|资料|机器人|故障|巡检', words))
        stats = next((t['result']['today'] for t in trace if t['tool'] == 'site_status' and t['status'] == 'done'), None)
        if work and stats is None:
            stats = beikuang.today_stats()
        context = {'owner': words, 'ownerId': msg.owner.pk, 'recent': recent,
                   'sourceMessages': [{'id': str(m.pk), 'text': m.body} for m in messages],
                   'frame': dialogue_frame(msg.owner, messages, recent), 'feeling': beikuang.emotion_state(msg.owner),
                   'today': stats, 'waiting': beikuang.waiting(msg.owner) if work else [],
                   'tools': trace, 'memories': tools.recall(msg.owner, words),
                   'auditLessons': extra.get('auditLessons', []), 'capabilities': tools.TOOLS,
                   '_messages': messages, '_deferLearning': True, '_isCurrent': lambda: current(turn)}
        body, generated, model, reason = '', 'template', '', '模型尚未接通'
        if messages[-1].data.get('allowModel'):
            try:
                body, model = beikuang.write('chat', context, f'chat:{messages[-1].pk}')
                generated = 'model'
            except Superseded:
                return {'superseded': True}
            except beikuang.Problem as exc:
                reason = exc.message
        else:
            reason = beikuang.model_ready(msg.owner)[1] or '本机没有为这次对话启用模型'
        companion = context.get('_companion', {})
        if companion.get('silent') and not body:
            BeikuangMessage.objects.filter(pk__in=ids).update(state='answered')
            return {'generated':'model','engine':'campus-companion','silent':True,'coalesced':len(messages)}
        if not body:
            body = (beikuang.say('chat', reason=beikuang.short_reason(reason), **(stats or beikuang.today_stats()))
                    if work else '这次没能完成回复，你的话已经保留了。')
            for result in trace:
                data = result.get('result', {})
                if result['status'] != 'done':
                    body += '\n' + result.get('title', result['tool']) + '：' + data.get('error', '暂未完成')
                elif result['tool'] == 'remember':
                    body += '\n已保存这条明确记忆：' + data['content']
                elif result['tool'] == 'forget':
                    body += '\n' + ('已忘记这条记忆。' if data['forgotten'] else '没有找到这条记忆。')
                elif result['tool'] in ('review', 'work_log'):
                    body += '\n' + result['title'] + '已排队，尚未完成。'
                elif result['tool'] == 'library_search':
                    body += '\n资料库匹配 ' + str(data['total']) + ' 项：' + '、'.join(i['title'] for i in data['items'])
        answer = deliver(turn, body, {'generated': generated, 'model': model,
            'fallback': '' if generated == 'model' else reason, 'tools': trace,
            **({'engine':'campus-companion','emotion':companion.get('emotion'), 'self':companion.get('self'),
                'messages':companion.get('messages',[]), 'upstream':companion.get('revision')} if companion else {}),
            'modelRounds': context.get('_modelRounds', 0)}, context.get('_outcome'))
        return {'generated': generated, 'coalesced': len(messages)} if answer else {'superseded': True}
    finally:
        release(turn)
