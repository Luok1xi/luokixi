"""Durable small-site job queue. A job's effects are idempotent and failures stay visible."""
import logging
import threading
import time
from datetime import timedelta
from django.conf import settings
from django.core import signing
from django.core.mail import send_mail
from django.db import close_old_connections, transaction
from django.utils import timezone
from .models import Job, Member, Notification, Source, Watch


def digest(user_id):
    member = Member.objects.get(pk=user_id)
    if not member.digest_enabled or not member.email_verified:
        return {'sent':False,'reason':'unsubscribed'}
    records = Notification.objects.filter(user=member,read=False).order_by('created')
    if member.digest_cursor:
        records = records.filter(created__gt=member.digest_cursor)
    selected = []
    for n in records[:200]:
        if n.subscription:
            watch = Watch.objects.filter(user=member,entry=n.entry).first()
            if not watch or n.event not in watch.events:
                continue
        selected.append(n)
    if not selected:
        return {'sent':False,'reason':'empty'}
    token = signing.dumps({'id':member.pk,'email':member.email},salt='hub.unsubscribe')
    message = '\n'.join(n.text for n in selected[:30])+'\n\n查看消息：'+settings.PUBLIC_ORIGIN+'/hub/#messages'
    message += '\n取消邮件摘要：'+settings.PUBLIC_ORIGIN+'/hub/#unsubscribe/'+token
    send_mail('Luokixi 本周关注更新',message,settings.DEFAULT_FROM_EMAIL,[member.email])
    member.digest_cursor = selected[-1].created
    member.save(update_fields=['digest_cursor'])
    return {'sent':bool(settings.EMAIL_HOST),'preview':not bool(settings.EMAIL_HOST),'count':len(selected)}


def schedule():
    now = timezone.now()
    for source in Source.objects.filter(enabled=True):
        if source.last_attempt and now-source.last_attempt<timedelta(hours=source.interval_hours):
            continue
        key = f'source:{source.pk}:{int(now.timestamp())//(source.interval_hours*3600)}'
        Job.objects.get_or_create(key=key,defaults={'kind':'source','payload':{'id':str(source.pk)},'due':now})
    from .maintenance import schedule_jobs
    schedule_jobs(now)
    week = now.strftime('%G-%V')
    for user in Member.objects.filter(digest_enabled=True,email_verified=True,is_active=True):
        Job.objects.get_or_create(key=f'digest:{user.pk}:{week}',defaults={'kind':'digest','owner':user,'payload':{'user':user.pk},'due':now})
    Job.objects.filter(state='running',updated__lt=now-timedelta(minutes=10)).update(state='queued',due=now,error='上次处理被中断，将重试。')


# 站主在等的活：和北矿娘聊天、让她写日报。另有一条线程专门跑（loop_interactive），不排在几分钟的采集任务后面
INTERACTIVE = ('beikuang-chat','beikuang-report')


def run_one(kinds=None):
    close_old_connections()
    with transaction.atomic():
        queued = Job.objects.filter(state='queued',due__lte=timezone.now())
        if kinds:
            job = queued.filter(kind__in=kinds).order_by('due').first()
        else:
            job = queued.filter(kind__in=INTERACTIVE).order_by('due').first() or queued.order_by('due').first()
        if not job:
            return False
        job.state,job.attempts = 'running',job.attempts+1
        job.save(update_fields=['state','attempts','updated'])
    try:
        if job.kind=='extract':
            from .files import extract
            result = extract(job.payload['sha'])
        elif job.kind=='source':
            from .discovery import refresh_source
            result = refresh_source(job.payload['id'])
        elif job.kind=='github-inspect':
            from .github_guides import inspect
            result = inspect(job.payload['repository'],refresh=True)
        elif job.kind=='github-summary':
            from .github_guides import generate_guide
            from .project_summaries import authorize
            authorize(job.owner)
            result = generate_guide(job.payload['repository'],str(job.pk))
            from .maintenance import staff_notice
            staff_notice('github-guides:'+str(job.pk),'中文导读机器人：详细说明已完成，请打开通知逐章核对。')
            from .supervisor import inspect_all
            inspect_all()
        elif job.kind=='supervisor-draft':
            from .supervisor import draft_announcement
            from .project_summaries import authorize
            authorize(job.owner)
            result=draft_announcement(str(job.pk))
        elif job.kind=='digest':
            result = digest(job.payload['user'])
        elif job.kind=='beikuang-chat':
            from .beikuang import reply
            result = reply(job.payload['message'])
        elif job.kind=='beikuang-report':
            from .beikuang import report_job
            result = report_job(job.payload['owner'])
        elif job.kind.startswith('maint-'):
            from .maintenance import run
            result = run(job.kind.removeprefix('maint-'))
        elif job.kind=='mirror-repo':
            from .mirror import mirror_repository
            from .maintenance import save_cache
            from .models import ExternalCache as Cache
            result = mirror_repository(job.payload['repository'])
            previous = Cache.objects.filter(pk='maint:mirror').first()
            repos = dict(previous.data.get('repositories', {}) if previous else {})
            repos[result['repository']] = result
            save_cache('maint:mirror', {'repositories': repos})
        else:
            raise ValueError('未知任务类型。')
        job.result,job.state,job.error = result,'done',''
        if job.kind.startswith('maint-') and isinstance(result,dict) and result.get('errors'):
            job.state,job.error = 'partial','；'.join(result['errors'])[:300]
    except Exception as exc:
        job.error = str(exc)[:300]
        job.state = 'failed' if job.kind in ('github-summary','maint-summaries','supervisor-draft') or job.attempts>=3 else 'queued'
        job.due = timezone.now()+timedelta(seconds=60*job.attempts)
        logging.getLogger('hub.worker').warning('Job %s failed (%s)',job.pk,type(exc).__name__)
    job.save(update_fields=['result','state','error','due','updated'])
    close_old_connections()
    return True


def loop(stop=None):
    stop = stop or threading.Event()
    last_schedule = 0
    while not stop.is_set():
        try:
            if time.monotonic()-last_schedule>60:
                from .bookings import advance
                advance()
                schedule()
                last_schedule = time.monotonic()
            if not run_one():
                stop.wait(2)
        except Exception:
            logging.getLogger('hub.worker').exception('Worker iteration failed')
            stop.wait(5)


def loop_interactive(stop=None):
    """和北矿娘聊天、日报单独一条线：主队列在跑几分钟的采集时，她也能马上回话。领任务在事务里，两条线不会领到同一个。"""
    stop = stop or threading.Event()
    while not stop.is_set():
        try:
            if not run_one(INTERACTIVE):
                stop.wait(1)
        except Exception:
            logging.getLogger('hub.worker').exception('Interactive worker iteration failed')
            stop.wait(5)

