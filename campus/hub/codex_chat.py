"""One-seat local Codex chat backed by the existing studio, account and quota."""
from datetime import timedelta
from django.db import transaction
from django.utils import timezone
from .core import text, throttle, Problem
from .models import ExternalCache, Member, StudioRoom, StudioRun
from .studio_config import ready

ROOM_BRIEF = 'luokixi:codex-direct-chat:v1'


def chat_room(owner, create=False):
    room=StudioRoom.objects.filter(owner=owner,brief=ROOM_BRIEF).order_by('created').first()
    if room or not create:
        return room
    # Serialize first-send initialization with the existing owner row, without a schema migration.
    with transaction.atomic():
        Member.objects.select_for_update().get(pk=owner.pk)
        room=StudioRoom.objects.filter(owner=owner,brief=ROOM_BRIEF).order_by('created').first()
        return room or StudioRoom.objects.create(owner=owner,title='Codex 对话',brief=ROOM_BRIEF,context_files=[])


def view(owner,cfg):
    room=chat_room(owner)
    try:
        ready('codex',cfg)
        available,reason=True,''
    except Problem as exc:
        available,reason=False,exc.message
    from .companion_bridge import connection,runtime_state
    runtime=runtime_state(owner,'codex') if connection('codex') else {}
    if runtime.get('error'): available,reason=False,runtime['error']
    worker=ExternalCache.objects.filter(pk='studio:worker').first()
    worker_live=bool(worker and worker.checked and worker.checked>=timezone.now()-timedelta(seconds=360))
    from .studio import run_data, collaboration_context
    runs=list(room.runs.order_by('-created').prefetch_related('messages')[:40]) if room else []
    waiting=bool(runs and runs[0].state=='queued' and StudioRun.objects.filter(state='running').exclude(pk=runs[0].pk).exists())
    from .models import ContentTask
    from .content_management import task_data
    return {'name':'Codex','room':str(room.pk) if room else None,'ready':available,'reason':reason,
            'workerAvailable':worker_live,'runs':[run_data(run) for run in runs],
            'waitingForWork':waiting,
            'contentTasks': [task_data(t) for t in ContentTask.objects.filter(owner=owner, seat='codex').order_by('-created')[:8]],
            'collaboration':collaboration_context(owner),
            'emotion':runtime.get('emotion'), 'runtime':runtime,
            'consoleUrl':'http://127.0.0.1:17840' if connection('codex') else None,
            'connection':'本机已登录的 Codex；独立网站会话，不同步桌面 ChatGPT 历史',
            'dailyCallsLimit':cfg['codex_daily_calls']}


def send(owner,cfg,body):
    ready('codex',cfg)
    prompt=text(body.get('body',''),6000,True)
    from .studio_workspace import checked_text
    prompt=checked_text(prompt)
    request_key=text(body.get('requestKey',''),80,True)
    room=chat_room(owner,True)
    from .studio import run_data
    previous=room.runs.filter(request_key=request_key).first()
    if previous:
        if previous.prompt!=prompt:
            raise Problem('此消息编号已经用于不同内容。',409)
        return run_data(previous)
    throttle('codex-direct-chat',str(owner.pk),40)
    if room.runs.filter(state__in=('queued','running')).exists():
        raise Problem('Codex 正在回复上一条消息；可先停止该回复。',409)
    run=StudioRun.objects.create(room=room,request_key=request_key,prompt=prompt,mode='chat',seats=['codex'],rounds=1)
    from .content_management import ensure_task
    ensure_task(owner, 'codex', 'studio:'+str(run.pk)+':0', prompt)
    return run_data(run)


def deliver(owner,ident,content,messages):
    """Original Codex proactive outbox -> the same private conversation, idempotently."""
    from .models import StudioMessage
    room=chat_room(owner,True)
    run,_=StudioRun.objects.get_or_create(room=room,request_key='proactive:'+ident[:60],defaults={
        'prompt':'','mode':'chat','seats':['codex'],'rounds':1,'state':'completed'})
    msg,_=StudioMessage.objects.get_or_create(run=run,sequence=0,defaults={
        'seat':'codex','provider':'codex','model':'codex-cli','body':content,'messages':messages,
        'expression':next((p.get('expression','neutral') for p in messages if p.get('type')=='text'),'neutral')})
    return msg
