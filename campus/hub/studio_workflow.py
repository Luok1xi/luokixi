"""Durable task handoff, adapted from Luok1xi/opus-codex-studio's task/report contract.

The framework supplies ownership, dependencies, acceptance and evidence. The existing
studio remains the executor; recovery never refunds or repeats an uncertain payment.
"""
import hashlib
from datetime import timedelta
from django.db import transaction
from django.utils import timezone
from .core import Problem
from .models import ExternalCache, StudioRun, StudioCall


def key(run):
    return 'studio-workflow:' + str(run.pk)


def task(run):
    if hasattr(run, '_workflow_data'):
        saved = run._workflow_data
    else:
        row = ExternalCache.objects.filter(pk=key(run)).first()
        saved = row.data if row else {}
    return {'id': str(run.pk), 'goal': run.prompt[:2000], 'owner': run.room.owner_id,
            'assignees': run.seats, 'scope': run.room.context_files,
            'dependencies': '核验搭档返回的任务编号和实际结果，再决定下一步',
            'acceptance': ['回答具体问题或返回实际执行凭据', '说明实际验证和未解决项', '排队不算完成'],
            **saved}


def record(run, **values):
    with transaction.atomic():
        row, _ = ExternalCache.objects.select_for_update().get_or_create(key=key(run))
        row.data = {**row.data, **values}
        row.checked = timezone.now()
        row.save()
    return row.data


def job_id(run, sequence, attempt=0):
    suffix = f':reconcile:{attempt}' if attempt else ''
    return hashlib.sha256(f'studio:{run.pk}:{sequence}{suffix}'.encode()).hexdigest()


def recover():
    """Release dead leases, then resume checkpoints. No network/model call here."""
    now = timezone.now()
    for pending in StudioRun.objects.filter(state='waiting_jobs', stop_requested=False):
        state = settle_work(pending)
        if state != 'waiting_jobs':
            StudioRun.objects.filter(pk=pending.pk,state='waiting_jobs',stop_requested=False).update(state=state,updated=now)
    StudioRun.objects.filter(state='running', updated__lt=now-timedelta(seconds=75)).update(
        state='interrupted', updated=now)
    count = 0
    for run in StudioRun.objects.filter(state__in=['interrupted', 'reconnecting'], stop_requested=False):
        saved = task(run)
        if saved.get('retryAfter') and saved['retryAfter'] > now.isoformat():
            continue
        # Only the original transports have durable, addressable jobs. Legacy one-shot
        # providers with unknown outcomes stay explicit instead of duplicating charges.
        from . import companion_bridge as bridge
        completed = set(run.messages.values_list('sequence', flat=True))
        next_sequence = next((s for s in range(run.rounds) if s not in completed), run.rounds)
        seat = run.seats[next_sequence % len(run.seats)]
        if next_sequence < run.rounds and StudioCall.objects.filter(run=run, sequence=next_sequence).exists() and not bridge.connection(seat):
            continue
        changed = StudioRun.objects.filter(pk=run.pk, state=run.state, stop_requested=False).update(
            state='queued', claim=None, error='正在接续上次进度；已完成发言不会重发。', updated=now)
        count += changed
    return count


def settle_work(run):
    from .models import Job
    import uuid
    ids = set()
    for item in task(run).get('evidence', []):
        receipt = item.get('receipt', {})
        if receipt.get('operation') in ('run_robot', 'job_status') and receipt.get('id'):
            try: ids.add(str(uuid.UUID(receipt['id'])))
            except (ValueError, TypeError, AttributeError): pass
    if not ids: return 'completed'
    jobs = list(Job.objects.filter(pk__in=ids, owner_id=run.room.owner_id))
    results = [{'id': str(j.pk), 'state': j.state, 'error': j.error, 'result': j.result} for j in jobs]
    record(run, executionResults=results)
    if len(jobs) != len(ids) or any(j.state in ('failed', 'partial') for j in jobs): return 'needs_attention'
    if any(j.state != 'done' for j in jobs): return 'waiting_jobs'
    return 'completed'


def waiting(run, message):
    data = task(run)
    failures = data.get('connectionFailures', 0) + 1
    record(run, connectionFailures=failures,
           retryAfter=(timezone.now()+timedelta(seconds=min(300, 15*failures))).isoformat(),
           blocker=message)


def checkpoint(run, sequence, usage):
    execution = usage.get('maintenance') or {}
    receipts = [r.get('receipt') for r in execution.get('trace', []) if isinstance(r, dict) and r.get('receipt')]
    data = task(run)
    evidence = list(data.get('evidence', []))
    evidence.extend({'sequence': sequence, 'receipt': r} for r in receipts)
    record(run, completedSequence=sequence, connectionFailures=0, retryAfter='', blocker='',
           evidence=evidence[-30:], unresolved=execution.get('gaps', []))


def modules():
    return [row.data for row in ExternalCache.objects.filter(key__startswith='studio-module:').order_by('key')]


def save_module(args):
    """Hot-loaded task guidance, not executable code or a new permission grant."""
    import re
    from .studio_workspace import digest
    name = args.get('id', '')
    if not isinstance(name, str) or not re.fullmatch(r'[a-z][a-z0-9-]{1,47}', name):
        raise Problem('模块编号使用 2 至 48 位英文、数字和短横线。')
    title, instructions, checks = args.get('title'), args.get('instructions'), args.get('acceptance')
    if not isinstance(title, str) or not 1 <= len(title) <= 80 or not isinstance(instructions, str) or not 1 <= len(instructions) <= 3000:
        raise Problem('模块需要名称和具体执行说明。')
    if not isinstance(checks, list) or not 1 <= len(checks) <= 8 or any(not isinstance(c, str) or not 1 <= len(c) <= 240 for c in checks):
        raise Problem('模块需要 1 至 8 项可验证的验收标准。')
    with transaction.atomic():
        row, made = ExternalCache.objects.select_for_update().get_or_create(key='studio-module:'+name)
        if not made and args.get('beforeHash') != row.data.get('hash'):
            raise Problem('模块已更新，请先读取当前版本。', 409)
        if made and ExternalCache.objects.filter(key__startswith='studio-module:').count() > 12:
            raise Problem('同时最多保留 12 个工作室模块。')
        value = {'id': name, 'title': title, 'instructions': instructions, 'acceptance': checks,
                 'enabled': args.get('enabled', True) is True, 'version': row.data.get('version', 0)+1}
        value['hash'] = digest(value)
        row.data, row.checked = value, timezone.now()
        row.save()
    return value


def preload(runs):
    """One query for a room's task receipts; callers already loaded room metadata."""
    values = dict(ExternalCache.objects.filter(key__in=[key(r) for r in runs]).values_list('key', 'data'))
    for run in runs:
        run._workflow_data = values.get(key(run), {})
