"""Owner-adjustable ceilings; never erase usage or imply a provider top-up."""
import json
import os
import uuid
from decimal import Decimal, InvalidOperation
from django.utils import timezone
from .core import Problem
from .models import Audit, StudioDay
from .studio_config import config_path


def view(cfg=None):
    from .studio_config import config
    cfg = cfg or config()
    day = StudioDay.objects.filter(day=timezone.localdate()).first()
    used = day.reserved_cny if day else Decimal(0)
    calls = day.codex_calls if day else 0
    return {'day': str(timezone.localdate()), 'timezone': 'Asia/Shanghai',
            'dailyCny': str(cfg['daily_cny']), 'reservedCny': str(used),
            'remainingCny': str(max(Decimal(0), cfg['daily_cny'] - used)),
            'codexDailyCalls': cfg['codex_daily_calls'], 'codexCalls': calls,
            'codexUnlimited': bool(cfg.get('codex_unlimited')),
            'codexRemaining': None if cfg.get('codex_unlimited') else max(0, cfg['codex_daily_calls'] - calls),
            'providerBalance': None, 'reset': '每日北京时间 00:00',
            'explanation': '这是本站限额；预留金额是保守估算，不是账单。调整不会给模型账号充值，也不会恢复服务商额度。'}


def save(owner, body):
    if set(body) not in ({'dailyCny', 'codexDailyCalls'}, {'dailyCny', 'codexDailyCalls', 'codexUnlimited'}):
        raise Problem('只允许修改每日金额和 Codex 调用次数。')
    try:
        amount = Decimal(str(body['dailyCny']))
        if not amount.is_finite() or not Decimal('0.1') <= amount <= 100 or amount != amount.quantize(Decimal('.01')):
            raise ValueError()
    except (InvalidOperation, ValueError, TypeError):
        raise Problem('每日金额应为 0.10 至 100 元，最多两位小数。')
    calls = body['codexDailyCalls']
    if type(calls) is not int or not 1 <= calls <= 500:
        raise Problem('Codex 每日调用次数应为 1 至 500。')
    path = config_path()
    saved = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    previous = view()
    if 'codexUnlimited' in body:
        if type(body['codexUnlimited']) is not bool: raise Problem('次数开关格式错误。')
        saved['codex_unlimited'] = body['codexUnlimited']
    saved.update(daily_cny=str(amount), codex_daily_calls=calls, budget_owner_override=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temp.write_text(json.dumps(saved, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)
    Audit.objects.create(actor=owner, action='studio.budget', target=str(owner.pk),
                         detail={'before': {'dailyCny': previous['dailyCny'], 'codexDailyCalls': previous['codexDailyCalls']},
                                 'after': body})
    return view()
