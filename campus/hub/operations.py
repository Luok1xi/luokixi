"""Deterministic, private maintenance state. Alerts do not depend on an LLM."""
import logging
import hashlib
import os
import re
import threading
import uuid
from datetime import timedelta
from django.conf import settings
from django.db import close_old_connections, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from .core import Problem, require, text
from .models import Audit, Entry, ExternalCache, Job, Member, Notification, Report, Reply

STATE_KEY = 'ops:alerts'
WORKER_KEY = 'ops:worker'
RELEASE = 'foundation-local-20261007'


def worker_mode(enabled, kinds=None):
    ExternalCache.objects.update_or_create(pk=WORKER_KEY, defaults={
        'checked': timezone.now(), 'data': {'enabled': bool(enabled), 'heartbeat': None, 'kinds': list(kinds or [])}})


def heartbeat(kinds=None):
    now = timezone.now()
    ExternalCache.objects.update_or_create(pk=WORKER_KEY, defaults={
        'checked': now, 'success': now, 'data': {'enabled': True, 'heartbeat': now.isoformat(), 'kinds': list(kinds or [])}})


def clean_error(value):
    value = re.sub(r'(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})', '[已隐藏凭据]', str(value))
    return value[:300]


def diagnostics(now=None):
    now = now or timezone.now()
    worker = ExternalCache.objects.filter(pk=WORKER_KEY).first()
    data = worker.data if worker else {}
    jobs = Job.objects.all()
    if data.get('kinds'):
        jobs = jobs.filter(kind__in=data['kinds'])
    latest = {}
    for job in jobs.order_by('-updated')[:500]:
        latest.setdefault(job.kind, job)
    failed = [j for j in latest.values() if j.state in ('failed', 'partial')]
    overdue = jobs.filter(state='queued', due__lt=now-timedelta(minutes=15)).count()
    stuck = jobs.filter(state='running', updated__lt=now-timedelta(minutes=15)).count()
    seen = parse_datetime(data.get('heartbeat') or '')
    recent = seen or (worker.checked if worker else None)
    worker_state = 'unknown' if not worker else 'disabled' if not data.get('enabled') else (
        'stale' if not recent or now-recent >= timedelta(minutes=15) else 'ok' if seen else 'waiting')
    checks = {
        'failed-jobs': {'ok': not failed, 'text': f'有 {len(failed)} 类后台任务最后一次执行未完成，请查看维护记录。'},
        'queue-delay': {'ok': not (overdue or stuck), 'text': f'有 {overdue} 个到期任务等待超过 15 分钟、{stuck} 个执行任务超过 15 分钟。'},
        'worker': {'ok': worker_state != 'stale', 'text': '后台处理器已超过 15 分钟没有心跳，请检查本机进程。'},
    }
    return {'checkedAt': now.isoformat(), 'release': RELEASE,
        'worker': {'state': worker_state, 'lastHeartbeat': data.get('heartbeat'),
                   'scope': '备份与恢复验证（本地验收模式）' if data.get('kinds') else '全部网站后台任务',
                   'notice': '未启动后台处理器' if worker_state == 'disabled' else '心跳只证明进程运行，不代表每项采集已完成。'},
        'queue': {state: Job.objects.filter(state=state).count() for state in ('queued', 'running', 'failed', 'partial')},
        'failures': [{'id': str(j.pk), 'kind': j.kind, 'state': j.state,
                      'updated': j.updated.isoformat(), 'error': clean_error(j.error)} for j in failed[:15]],
        'review': {'pending': Entry.objects.filter(state='pending').count(),
                   'reports': Report.objects.filter(state='open').count()},
        'email': {'mode': 'smtp' if settings.EMAIL_HOST else 'local-preview',
                  'notice': '邮件已配置，投递结果以发送任务为准。' if settings.EMAIL_HOST else '邮件仅保存在本机预览，未向外投递。'},
        'checks': checks}


def _deliver(event):
    recipients = Member.objects.filter(is_staff=True, is_active=True).exclude(email__endswith='.invalid')
    count = 0
    for member in recipients:
        if not member.has_usable_password():
            continue
        Notification.objects.get_or_create(user=member, key='operations:'+event['id'], defaults={
            'event': 'operations', 'text': event['text'][:300], 'entry': None})
        count += 1
    return count


def flush_alerts(now=None):
    """Retry a durable outbox; recovery never overtakes its incident's failure notice."""
    now = now or timezone.now()
    with transaction.atomic():
        cache, _ = ExternalCache.objects.select_for_update().get_or_create(pk=STATE_KEY)
        data = dict(cache.data or {})
        blocked = set()
        for event in data.get('outbox', []):
            if event.get('sentAt'):
                continue
            incident = event['incident']
            due = parse_datetime(event.get('nextTry') or '')
            if incident in blocked or (due and due > now):
                blocked.add(incident)
                continue
            try:
                # Savepoint protects partial deliveries if a database write fails.
                with transaction.atomic():
                    count = _deliver(event)
                if not count:
                    raise RuntimeError('尚无可接收告警的站主账号')
                event['sentAt'], event['recipients'] = now.isoformat(), count
                event.pop('lastError', None)
            except Exception as exc:
                event['attempts'] = event.get('attempts', 0)+1
                event['nextTry'] = (now+timedelta(seconds=min(300, 15*2**min(event['attempts'], 5)))).isoformat()
                event['lastError'] = type(exc).__name__
                blocked.add(incident)
        cache.data, cache.checked = data, now
        cache.save(update_fields=['data', 'checked'])


def poll_once(now=None, observations=None):
    now = now or timezone.now()
    checks = observations if observations is not None else diagnostics(now)['checks']
    with transaction.atomic():
        cache, _ = ExternalCache.objects.select_for_update().get_or_create(pk=STATE_KEY)
        data = dict(cache.data or {})
        states, events = data.setdefault('checks', {}), data.setdefault('outbox', [])
        for category, check in checks.items():
            state = states.setdefault(category, {'failures': 0, 'open': False})
            state['lastChecked'] = now.isoformat()
            if not check['ok']:
                state['failures'] += 1
                if state['failures'] >= 2 and not state['open']:
                    state.update(open=True, incident=uuid.uuid4().hex, since=now.isoformat(), text=check['text'], acknowledged=False)
                    events.append({'id': uuid.uuid4().hex, 'incident': state['incident'], 'kind': 'failure',
                        'created': now.isoformat(), 'text': '网站维护提醒：'+check['text']})
            else:
                state['failures'] = 0
                if state['open']:
                    events.append({'id': uuid.uuid4().hex, 'incident': state['incident'], 'kind': 'recovery',
                        'created': now.isoformat(), 'text': '网站维护恢复：'+state.get('text', category)+' 当前检查已恢复。'})
                    state.update(open=False, recoveredAt=now.isoformat())
        # Keep all pending notices; prune only old completed delivery receipts.
        sent = [e for e in events if e.get('sentAt')][-60:]
        data['outbox'] = [e for e in events if not e.get('sentAt')] + sent
        data['outbox'].sort(key=lambda e: e['created'])
        cache.data, cache.checked = data, now
        cache.save(update_fields=['data', 'checked'])
    flush_alerts(now)
    return alert_status()


def alert_status():
    cache = ExternalCache.objects.filter(pk=STATE_KEY).first()
    data = cache.data if cache else {}
    return {'checkedAt': cache.checked.isoformat() if cache and cache.checked else None,
        'incidents': [{'category': category, **state} for category, state in data.get('checks', {}).items() if state.get('incident')],
        'pendingDelivery': sum(not event.get('sentAt') for event in data.get('outbox', [])),
        'deliveries': [{k: e.get(k) for k in ('kind', 'text', 'created', 'sentAt', 'attempts')} for e in data.get('outbox', [])[-20:]]}


def status():
    from .backup import status as backup_status
    result = {**diagnostics(), 'alerts': alert_status(), 'backups': backup_status()}
    preview = os.environ.get('HUB_ALERT_PREVIEW', '')
    if not settings.PRODUCTION and re.fullmatch(r'http://127\.0\.0\.1:\d{2,5}/', preview):
        result['alertPreview'] = preview
    return result


def get(request, route):
    require(request.user, staff=True)
    if route == 'operations/status':
        return status()
    if route == 'operations/backups':
        from .backup import list_backups
        return {'items': list_backups()}
    if route.startswith('operations/backups/') and route.endswith('/download'):
        from .backup import open_backup_file, BackupError
        from django.http import FileResponse
        identifier = route.split('/')[2]
        try:
            stream = open_backup_file(identifier)
        except BackupError as exc:
            raise Problem(str(exc), 400)
        Audit.objects.create(actor=request.user, action='site-backup-download', target=identifier)
        result = FileResponse(stream, as_attachment=True, filename=identifier)
        result['Cache-Control'] = 'private, no-store'
        return result
    raise Problem('维护入口不存在。', 404)


def post(request, route, body):
    require(request.user, staff=True)
    if route == 'operations/check':
        poll_once()
        return status()
    if route == 'operations/acknowledge':
        incident = text(body.get('incident', ''), 80, True)
        with transaction.atomic():
            cache = ExternalCache.objects.select_for_update().filter(pk=STATE_KEY).first()
            found = False
            if cache:
                for value in cache.data.get('checks', {}).values():
                    if value.get('incident') == incident:
                        value['acknowledged'] = True
                        found = True
                if found:
                    cache.save(update_fields=['data'])
            if not found:
                raise Problem('告警不存在。', 404)
            Audit.objects.create(actor=request.user, action='operations-acknowledge', target=incident)
        return status()
    if route in ('operations/backup', 'operations/backup-check'):
        from .api import enqueue, serialize_job
        from .backup import BackupError, get_backup_path
        payload = {}
        if route.endswith('backup-check'):
            identifier = text(body.get('id', ''), 100, True)
            try:
                get_backup_path(identifier)
            except BackupError as exc:
                raise Problem(str(exc), 400)
            payload['id'] = identifier
        with transaction.atomic():
            kind = 'site-backup-check' if payload else 'site-backup'
            running = Job.objects.filter(kind__in=['site-backup', 'site-backup-check'], state__in=['queued', 'running']).first()
            if running:
                if running.kind != kind or running.payload != payload:
                    raise Problem('另一个备份或恢复验证正在进行，请完成后再执行本次操作。', 409)
                return serialize_job(running)
            token = text(body.get('requestId', ''), 80) or str(int(timezone.now().timestamp())//300)
            key = 'operations:'+kind+':'+hashlib.sha256((token+payload.get('id', '')).encode()).hexdigest()
            job = enqueue(kind, payload, owner=request.user, key=key)
            Audit.objects.get_or_create(actor=request.user, action=kind, target=str(job.pk))
        return serialize_job(job)
    raise Problem('维护操作不存在。', 404)


def schedule_backup(now=None):
    """One private backup per local day; no model or crawler is required."""
    if os.environ.get('HUB_BACKUP_AUTO', '1') == '0':
        return
    now = now or timezone.now()
    if Job.objects.filter(kind__in=['site-backup', 'site-backup-check'], state__in=['queued', 'running']).exists():
        return
    if Job.objects.filter(kind='site-backup', state='done', updated__gt=now-timedelta(hours=24)).exists():
        return
    from .backup import list_backups
    backups = list_backups()
    latest = parse_datetime(backups[0]['createdAt']) if backups else None
    if latest and latest > now-timedelta(hours=24):
        return
    Job.objects.get_or_create(key='operations:backup-daily:'+timezone.localtime(now).strftime('%Y-%m-%d'),
        defaults={'kind': 'site-backup', 'payload': {}, 'due': now})


def loop(stop=None):
    stop = stop or threading.Event()
    while not stop.is_set():
        try:
            close_old_connections()
            poll_once()
            schedule_backup()
            close_old_connections()
        except Exception:
            logging.getLogger('hub.operations').exception('Local maintenance monitor failed')
        stop.wait(30)


def review_loop(stop=None):
    """Run backup jobs for local acceptance without consuming crawler/model queues."""
    import time
    from .worker import run_one
    stop = stop or threading.Event()
    kinds = ('site-backup', 'site-backup-check', 'question-process')
    last_check = 0
    while not stop.is_set():
        try:
            if time.monotonic()-last_check > 30:
                from .worker import INTERACTIVE
                heartbeat(kinds + INTERACTIVE + ('maint-beikuang',))
                poll_once()
                schedule_backup()
                last_check = time.monotonic()
            if not run_one(kinds):
                stop.wait(2)
        except Exception:
            logging.getLogger('hub.operations').exception('Local acceptance worker failed')
            stop.wait(5)
