"""Private reservation preparation. No school credentials or fabricated provider confirmations."""
import uuid
from datetime import timedelta
from django.db import transaction
from django.http import HttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from .core import Problem, require, text, throttle
from .models import SeatPlan, Notification

RULE_URL = 'https://lib.cumtb.edu.cn/engine2/general/24637324/detail?engineInstanceId=5650719&pageId=909208&typeId=11212707'
CAPABILITIES = {'providerConnected':False,'automaticSubmission':False,'inventoryAvailable':False,
    'officialUrl':'https://lib.cumtb.edu.cn/', 'rulesUrl':RULE_URL,'rulesPublished':'2023-03-28',
    'checkedAt':'2026-10-06','mode':'reminder-and-owner-confirmation',
    'note':'学院路公开规则要求校园网，写明 06:30 放号；规则可能更新，沙河请核对对应入口。未接入实时座位与自动提交。'}
STATES = {'scheduled':'等待提醒','action_required':'待本人预约','reported_reserved':'本人已预约（未向学校核验）','checked_in':'本人已签到','cancelled':'已取消助手任务','expired':'已过期'}

def data(p):
    return {'id':str(p.pk),'campus':p.campus,'starts':p.starts.isoformat(),'ends':p.ends.isoformat(),
        'remindAt':p.remind_at.isoformat(),'preference':p.preference,'state':p.state,'stateLabel':STATES[p.state],
        'version':p.version,'providerConfirmed':False,'calendarUrl':f'/api/hub/bookings/{p.pk}/calendar'}

def date(value):
    d=parse_datetime(value) if isinstance(value,str) else None
    if not d or timezone.is_naive(d): raise Problem('时间必须包含时区。')
    return d

@transaction.atomic
def advance(owner=None):
    now=timezone.now()
    q=SeatPlan.objects.select_for_update().filter(state__in=['scheduled','action_required','reported_reserved'])
    if owner is not None:q=q.filter(owner=owner)
    count=0
    for p in q.filter(ends__lte=now):
        p.state='expired';p.version+=1;p.save();count+=1
    for p in q.filter(state='scheduled',remind_at__lte=now,ends__gt=now):
        Notification.objects.get_or_create(user=p.owner,key=f'seat:{p.pk}:due',defaults={'event':'reservation','text':'图书馆预约时间到了：请连接校园网，在校园 → 座位预约助手查看计划并到官方入口确认。'})
        p.state='action_required';p.reminded=True;p.version+=1;p.save();count+=1
    return count

def owned(user,key,lock=False):
    qs=SeatPlan.objects.select_for_update() if lock else SeatPlan.objects
    try:return qs.get(pk=key,owner=user)
    except (SeatPlan.DoesNotExist,ValueError):raise Problem('预约任务不存在。',404)

def calendar(p):
    stamp=lambda d:d.astimezone(__import__('datetime').timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    # Fixed fields only: user text never enters calendar syntax.
    lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Luokixi//Seat Assistant//ZH','BEGIN:VEVENT',f'UID:{p.pk}@luokixi',
      f'DTSTAMP:{stamp(p.created)}',f'DTSTART:{stamp(p.remind_at)}',f'DTEND:{stamp(p.remind_at+timedelta(minutes=5))}',
      'SUMMARY:图书馆座位预约提醒','DESCRIPTION:请连接校园网并到图书馆官方入口确认。此提醒不是预约凭证。',
      'URL:https://lib.cumtb.edu.cn/','BEGIN:VALARM','TRIGGER:PT0M','ACTION:DISPLAY','DESCRIPTION:到官方入口预约图书馆座位','END:VALARM','END:VEVENT','END:VCALENDAR','']
    response=HttpResponse('\r\n'.join(lines),content_type='text/calendar; charset=utf-8')
    response['Content-Disposition']='attachment; filename="library-reminder.ics"';response['Cache-Control']='private, no-store'
    return response

def get(request,route):
    if route=='bookings/capabilities':return CAPABILITIES
    require(request.user)
    advance(request.user)
    if route=='bookings':return {'items':[data(p) for p in SeatPlan.objects.filter(owner=request.user).order_by('-created')[:100]],'capabilities':CAPABILITIES}
    parts=route.split('/')
    if len(parts)==3 and parts[2]=='calendar':return calendar(owned(request.user,parts[1]))
    raise Problem('接口不存在。',404)

@transaction.atomic
def post(request,route,body):
    user=request.user;require(user)
    if route=='bookings':
        key=uuid.UUID(body.get('requestKey',''))
        existing=SeatPlan.objects.filter(owner=user,request_key=key).first()
        if existing:return data(existing)
        throttle('seat-plan',str(user.pk),30)
        if SeatPlan.objects.filter(owner=user,state__in=['scheduled','action_required','reported_reserved']).count()>=20:raise Problem('请先处理已有预约任务，最多保留 20 个进行中的任务。')
        starts,ends,remind=date(body.get('starts')),date(body.get('ends')),date(body.get('remindAt'))
        now=timezone.now()
        if not now<starts<=now+timedelta(days=30) or not starts<ends<=starts+timedelta(hours=16):raise Problem('请选择未来 30 天内的时间，使用时长不超过 16 小时。')
        if not now<=remind<=starts:raise Problem('提醒时间应在现在之后、使用开始之前。')
        campus=body.get('campus')
        if campus not in ('xueyuanlu','shahe'):raise Problem('请选择校区。')
        p=SeatPlan.objects.create(owner=user,request_key=key,campus=campus,starts=starts,ends=ends,remind_at=remind,preference=text(body.get('preference',''),200))
        return data(p)
    parts=route.split('/')
    if len(parts)!=3 or parts[2]!='action':raise Problem('接口不存在。',404)
    p=owned(user,parts[1],True)
    if body.get('version')!=p.version:raise Problem('任务已经更新，请刷新后再操作。',409)
    transitions={
      'cancel':({'scheduled','action_required','reported_reserved'},'cancelled'),
      'reserved':({'scheduled','action_required'},'reported_reserved'),
      'checkin':({'reported_reserved'},'checked_in')}
    action=body.get('action')
    if action not in transitions:raise Problem('不支持此操作。')
    allowed,state=transitions[action]
    if p.state not in allowed or p.ends<=timezone.now():raise Problem('当前状态不能执行此操作。',409)
    if action in ('reserved','checkin') and body.get('confirmedByOwner') is not True:raise Problem('请确认你已经在学校系统完成操作。')
    p.state=state;p.version+=1;p.save()
    return data(p)
