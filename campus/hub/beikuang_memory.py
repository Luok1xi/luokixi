"""Private, source-bearing conversation memory. Extraction shares the reply call."""
import hashlib
import math
import re
import unicodedata
from django.db import transaction
from django.utils import timezone
from .models import ExternalCache


STYLE_WORDS = re.compile(r'说话|语气|回复|回答|问号|提问|反问|简短|简洁|人机|客服|卖萌|冷淡|介绍自己|称呼')
PREFERENCE = re.compile(r'喜欢|不喜欢|希望|习惯|以后|不要|别|少|多|叫我|请')
HYPOTHETICAL = re.compile(r'假如|假设|如果|扮演|小说|举个例子|网页(?:说|上)|[他她]说')
ALIASES = (('简洁', '简短', '短点', '少说'), ('语气', '口吻', '说话', '客服', '人机'),
           ('六级', 'cet6', 'cet-6'), ('四级', 'cet4', 'cet-4'),
           ('高等数学', '高数'), ('线性代数', '线代'), ('大学物理', '大物'),
           ('配图', '图片', '照片'), ('记住', '记忆', '记得'))


def normal(value):
    value = unicodedata.normalize('NFKC', str(value or '')).casefold()
    return re.sub(r'[\s，。！？、,.!?“”\"\'：:；;]+', '', value)


def memory_key(owner, content):
    return f'beikuang:memory:{owner.pk}:' + hashlib.sha256(normal(content).encode()).hexdigest()[:32]


def forgotten_key(owner, content):
    return f'bk-forgot:{owner.pk}:' + hashlib.sha256(normal(content).encode()).hexdigest()[:32]


def terms(value):
    value = unicodedata.normalize('NFKC', str(value or '')).casefold()
    for group in ALIASES:
        for term in group[1:]:
            value = value.replace(term, group[0])
    result = set(re.findall(r'[a-z0-9]+', value))
    for chunk in re.findall(r'[\u4e00-\u9fff]+', value):
        result.update(chunk[i:i + 2] for i in range(len(chunk) - 1))
    return result


def recall(owner, query='', limit=6):
    rows = list(ExternalCache.objects.filter(key__startswith=f'beikuang:memory:{owner.pk}:')
                .order_by('-checked')[:500])
    wanted = terms(query)
    if wanted:
        bags = [terms(r.data.get('content', '') + ' ' + r.data.get('source', '')) for r in rows]
        weights = {w: math.log(1 + len(rows) / (1 + sum(w in bag for bag in bags))) for w in wanted}
        scored = [(sum(weights[w] for w in wanted & bag), i, row) for i, (row, bag) in enumerate(zip(rows, bags))]
        # Unrelated old facts are not silently presented as a relevant recollection.
        rows = [r for score, _, r in sorted(scored, key=lambda item: (-item[0], item[1])) if score > 0]
    return [{'content': r.data.get('content', ''), 'source': r.data.get('source', ''),
             'message': r.data.get('message', ''), 'confirmed': r.data.get('confirmed', True),
             'category': r.data.get('category', 'preference'),
             'at': r.checked.isoformat() if r.checked else None} for r in rows[:limit]]


def state_key(owner):
    return f'beikuang:conversation:{owner.pk}'


def conversation_state(owner):
    row = ExternalCache.objects.filter(pk=state_key(owner)).first()
    return dict(row.data) if row else {'version': 1, 'events': [], 'styleRules': []}


def dialogue_frame(owner, messages, recent):
    state = conversation_state(owner)
    body = '\n'.join(m.body for m in messages)
    phase = ('repair' if STYLE_WORDS.search(body) and PREFERENCE.search(body) else
             'closing' if re.fullmatch(r'(?:晚安|拜拜|再见|先这样)[。！!\s]*', body) else 'conversation')
    return {'phase': phase, 'alreadyMet': any(m['from'] == '北矿娘' for m in recent),
            'lastAnswer': next((m['text'] for m in reversed(recent) if m['from'] == '北矿娘'), ''),
            'preferences': state.get('styleRules', [])[-8:],
            'recentEvents': state.get('events', [])[-4:], 'messageCount': len(messages),
            'continuity': '这些用户短句属于同一轮；未发送的回复不算已经说过的话。'}


def source_message(messages, evidence):
    if not isinstance(evidence, str) or not 4 <= len(evidence.strip()) <= 400:
        return None
    return next((m for m in messages if evidence in m.body), None)


def save_expression(owner, outcome):
    from .beikuang import EMOTIONS
    feeling, body = outcome.get('feeling'), outcome.get('message', '')
    if not isinstance(feeling, dict) or not isinstance(body, str):
        return
    evidence, intensity = feeling.get('evidence'), feeling.get('intensity')
    if (feeling.get('name') not in EMOTIONS or type(intensity) not in (int, float) or not 0 <= intensity <= 1
            or not isinstance(evidence, str) or not evidence.strip() or evidence not in body):
        return
    now = timezone.now()
    prior = ExternalCache.objects.filter(pk=f'beikuang:feeling:{owner.pk}').first()
    data = dict(prior.data) if prior else {}
    data.update(name=feeling['name'], intensity=intensity)
    ExternalCache.objects.update_or_create(key=f'beikuang:feeling:{owner.pk}', defaults={
        'data': data, 'checked': now, 'success': now})


@transaction.atomic
def learn(owner, messages, outcome):
    """Validate model proposals against user messages; never learn from tool/web output."""
    if not messages or not isinstance(outcome, dict):
        return {'memories': 0, 'preferences': 0, 'events': 0}
    now = timezone.now()
    row, _ = ExternalCache.objects.get_or_create(key=state_key(owner), defaults={'data': {}})
    row = ExternalCache.objects.select_for_update().get(pk=row.pk)
    state = dict(row.data)
    seen = state.get('processed', [])
    fresh = [m for m in messages if str(m.pk) not in seen]
    if not fresh:
        return {'memories': 0, 'preferences': 0, 'events': 0}
    save_expression(owner, outcome)
    result = {'memories': 0, 'preferences': 0, 'events': 0}
    eligible = [m for m in fresh if not re.match(r'^(?:请)?(?:忘记|忘掉|不要记住)', m.body.strip())]
    style = outcome.get('styleLearning')
    if isinstance(style, dict):
        evidence = style.get('evidence')
        source = source_message(eligible, evidence)
        if source and STYLE_WORDS.search(evidence) and PREFERENCE.search(evidence) and not HYPOTHETICAL.search(source.body):
            # Store the user's words, not an unrestricted model-written instruction.
            rules = [r for r in state.get('styleRules', []) if normal(r.get('source')) != normal(evidence)]
            rules.append({'source': evidence, 'message': str(source.pk), 'at': now.isoformat()})
            state['styleRules'] = rules[-8:]
            result['preferences'] = 1
    appraisal = outcome.get('appraisal')
    if isinstance(appraisal, dict):
        evidence, event = appraisal.get('evidence'), appraisal.get('event')
        source = source_message(fresh, evidence)
        confidence = appraisal.get('confidence', 0)
        events = {'praise': 'happy', 'interest': 'curious', 'explained': 'neutral', 'repaired': 'neutral',
                  'playful': 'happy', 'correction': 'think', 'conflict': 'sad'}
        valid = (source and isinstance(event, str) and event in events and type(confidence) in (int, float) and .7 <= confidence <= 1)
        if valid and event == 'conflict':
            # Ordinary corrections, disagreement and silence are not personal injury.
            valid = not STYLE_WORDS.search(evidence) and bool(re.search(r'你(?:就是|是个|这个)?(?:废物|垃圾|傻逼)|讨厌你|滚开', evidence))
        if valid and not HYPOTHETICAL.search(source.body):
            record = {'event': event, 'source': evidence, 'message': str(source.pk), 'at': now.isoformat()}
            state['events'] = (state.get('events', []) + [record])[-30:]
            mood = events[event]
            ExternalCache.objects.update_or_create(key=f'beikuang:feeling:{owner.pk}', defaults={
                'data': {'name': mood, 'intensity': 0 if mood == 'neutral' else .45, 'cause': record},
                'checked': now, 'success': now})
            result['events'] = 1
    proposals = outcome.get('memories', [])
    if not isinstance(proposals, list):
        proposals = []
    known = recall(owner, '', 200)
    for item in proposals[:2]:
        if not isinstance(item, dict):
            continue
        source = source_message(eligible, item.get('source'))
        content = item.get('content')
        category = item.get('category')
        if (not source or not isinstance(content, str) or not 4 <= len(content.strip()) <= 240
                or category not in ('preference', 'profile', 'goal', 'event')
                or HYPOTHETICAL.search(source.body) or re.search(r'[?？]', item['source'])):
            continue
        if ExternalCache.objects.filter(pk__in=[forgotten_key(owner, content), forgotten_key(owner, item['source'])]).exists():
            continue
        if any(normal(content) == normal(m['content']) or normal(item['source']) == normal(m['source']) for m in known):
            continue
        _, made = ExternalCache.objects.get_or_create(key=memory_key(owner, content), defaults={
            'data': {'owner': owner.pk, 'content': content.strip(), 'source': item['source'],
                     'message': str(source.pk), 'confirmed': False, 'category': category,
                     'automatic': True}, 'checked': now, 'success': now})
        result['memories'] += int(made)
        known.append({'content': content, 'source': item['source']})
    state.update(version=1, processed=(seen + [str(m.pk) for m in fresh])[-80:])
    row.data, row.checked, row.success = state, now, now
    row.save(update_fields=['data', 'checked', 'success'])
    return result


@transaction.atomic
def forget(owner, content):
    forgotten_sources = {normal(content)}
    key = memory_key(owner, content)
    row = ExternalCache.objects.filter(pk=key).first()
    if not row:
        # A verbatim source can identify an automatically summarized memory too.
        candidates = list(ExternalCache.objects.filter(key__startswith=f'beikuang:memory:{owner.pk}:')[:500])
        matches = [r for r in candidates if normal(content) == normal(r.data.get('source'))]
        row = matches[0] if len(matches) == 1 else None
    now = timezone.now()
    if row:
        forgotten_sources.add(normal(row.data.get('source', '')))
        content = row.data['content']
        row.delete()
    for value in forgotten_sources | {normal(content)}:
        ExternalCache.objects.update_or_create(key=forgotten_key(owner, value), defaults={
            'data': {}, 'checked': now, 'success': now})
    state = ExternalCache.objects.filter(pk=state_key(owner)).first()
    if state:
        rules = state.data.get('styleRules', [])
        kept = [r for r in rules if normal(r.get('source')) not in forgotten_sources]
        state.data = dict(state.data, styleRules=kept)
        state.save(update_fields=['data'])
        return bool(row or len(kept) != len(rules))
    return bool(row)
