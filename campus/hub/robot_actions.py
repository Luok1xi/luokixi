"""Owner-authorized maintenance tools shared by both original companions."""
import json
import time
import uuid
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from .core import Problem, text
from .models import Audit, BeikuangTask, Entry, ExternalCache, Job, Member
from .robot_inventory import ROBOTS, snapshot
from .studio_workspace import digest


READ = {'inventory', 'content_list', 'project_read', 'code_read', 'code_status', 'action_status', 'job_status', 'skills', 'tools', 'studio_status'}
MUTATIONS = {'run_robot', 'review_content', 'edit_content', 'withdraw_content', 'restore_content',
             'curate_project', 'code_candidate', 'code_test', 'code_apply', 'code_rollback', 'skill_review', 'skill_install', 'tool_install', 'tool_run', 'discuss', 'studio_module_save'}


def policy():
    from .studio_config import config
    cfg = config()
    return {'enabled': not settings.PRODUCTION and cfg.get('robot_autonomy') is True and cfg.get('enabled') is True,
            'scope': '机器人业务源码、隔离测试、技能文档、工具下载与试运行、网站内容和开源广场；保留历史与回退记录',
            'dailyConversationLimit': None if cfg.get('codex_unlimited') else cfg.get('codex_daily_calls')}


def actor(seat):
    if seat == 'beikuang':
        from .beikuang import agent
        return agent()
    if seat != 'codex': raise Problem('角色身份无效。', 403)
    user, made = Member.objects.get_or_create(username='Codex', defaults={'email': 'codex@system.invalid'})
    # Never elevate an ordinary user's colliding account.
    if not made and (user.email != 'codex@system.invalid' or user.has_usable_password()):
        raise Problem('Codex 系统账号存在名称冲突。', 409)
    user.is_staff, user.email_verified, user.is_active = True, True, True
    user.set_unusable_password()
    user.save()
    return user


def entry_view(entry):
    return {'id': str(entry.pk), 'kind': entry.kind, 'state': entry.state, 'revision': entry.revision,
            'data': entry.draft, 'published': entry.published, 'updated': entry.updated.isoformat()}


def content(args, seat):
    from .core import save_entry, submit_entry, review_entry, withdraw_entry
    who, operation = actor(seat), args['_operation']
    with transaction.atomic():
        entry = Entry.objects.select_for_update().filter(pk=args.get('id')).first()
        if not entry: raise Problem('网站内容不存在。', 404)
        if args.get('revision') != entry.revision or args.get('state') != entry.state:
            raise Problem('内容版本或状态已变化，请先重新读取。', 409)
        note = text(args.get('reason', ''), 1500, True)
        if operation == 'edit_content':
            entry = save_entry(who, {'revision': entry.revision, 'data': args.get('data')}, entry)
        elif operation == 'review_content':
            if args.get('decision') not in ('approve', 'reject'): raise Problem('审核决定无效。')
            if entry.state in ('draft', 'rejected'): entry = submit_entry(who, entry, entry.revision)
            entry = review_entry(who, entry, {'revision': entry.revision, 'decision': args['decision'], 'note': note,
                'locationChecked': args.get('locationChecked') is True,
                'supervisorQuestionsResolved': args.get('supervisorQuestionsResolved') is True})
            BeikuangTask.objects.filter(target=str(entry.pk), state__in=('queued', 'escalated')).update(
                state='published' if entry.state == 'published' else 'dismissed', decided_by=who.username,
                decided=timezone.now(), note=note)
        elif operation == 'withdraw_content':
            if entry.state == 'withdrawn': raise Problem('内容已经下架。', 409)
            ExternalCache.objects.update_or_create(key='robot-withdraw:'+str(entry.pk), defaults={'data': {
                'revision': entry.revision, 'state': entry.state, 'hash': digest(entry.draft)}})
            withdraw_entry(who, entry, note)
        else:
            saved = ExternalCache.objects.filter(pk='robot-withdraw:'+str(entry.pk)).first()
            if entry.state != 'withdrawn' or not saved or saved.data.get('revision') != entry.revision or saved.data.get('hash') != digest(entry.draft):
                raise Problem('没有匹配的下架前版本，不能自动恢复。', 409)
            entry.state = saved.data['state']
            entry.save(update_fields=['state', 'updated'])
            from .models import Contribution
            Contribution.objects.filter(entry=entry).update(active=entry.state == 'published', reason=note)
        entry.refresh_from_db()
        return entry_view(entry)


def run_robot(args, owner, seat, request_id):
    kind = args.get('kind')
    allowed = {k for k in ROBOTS if k.startswith(('maint-', 'pipeline-'))} | {'site-browser-audit', 'site-backup'}
    if kind not in allowed: raise Problem('这个任务需要具体资料参数，不能以全站机器人任务启动。')
    if kind in ('maint-mirror', 'maint-summaries'):
        import os
        flag = 'HUB_MIRROR_AUTO' if kind == 'maint-mirror' else 'HUB_GUIDE_AUTO'
        if os.environ.get(flag) != '1': raise Problem('该机器人的自动下载或模型生成配置未开启。', 409)
    with transaction.atomic():
        job = Job.objects.filter(kind=kind, state__in=['queued', 'running']).first()
        if not job:
            job = Job.objects.create(kind=kind, key='robot-tool:'+request_id, owner=owner, due=timezone.now(), payload={
                'actorSeat': seat, 'ownerRequested': True, 'reason': text(args.get('reason', ''), 1000, True)})
    return {'id': str(job.pk), 'kind': kind, 'state': job.state, 'completed': False}


def execute(owner, seat, operation, args, request_id=None):
    if operation not in READ | MUTATIONS or not isinstance(args, dict): raise Problem('维护工具参数无效。')
    if seat not in ('beikuang', 'codex'): raise Problem('维护角色无效。', 403)
    if operation in MUTATIONS and not policy()['enabled']: raise Problem('自主维护已暂停。', 403)
    if operation in READ: return dispatch(owner, seat, operation, args, '')
    request_id = str(uuid.UUID(request_id))
    payload_hash = digest({'seat': seat, 'operation': operation, 'args': args})
    key = 'robot-action:'+request_id
    with transaction.atomic():
        receipt, made = ExternalCache.objects.get_or_create(key=key, defaults={'data': {
            'hash': payload_hash, 'seat': seat, 'operation': operation, 'state': 'running'}})
        if not made:
            if receipt.data.get('hash') != payload_hash: raise Problem('同一操作编号不能用于不同内容。', 409)
            if receipt.data['state'] == 'done': return dict(receipt.data['result'], duplicate=True)
            raise Problem('操作仍在执行或已失败。先查操作记录，不自动重复写入。', 409)
    started = time.monotonic()
    try:
        result = dispatch(owner, seat, operation, args, request_id)
        receipt.data.update(state='done', result=result)
        return result
    except Exception as exc:
        receipt.data.update(state='failed', error=str(exc)[:300])
        raise
    finally:
        receipt.save(update_fields=['data'])
        Audit.objects.create(actor=owner, action='robot.action', target=request_id, detail={
            'seat': seat, 'operation': operation, 'state': receipt.data['state'],
            'durationMs': int((time.monotonic()-started)*1000), 'error': receipt.data.get('error', ''),
            'result': {k: receipt.data.get('result', {}).get(k) for k in ('id', 'state', 'name', 'kind', 'completed')
                       if k in receipt.data.get('result', {})}})


def dispatch(owner, seat, operation, args, request_id):
    if operation == 'studio_status':
        from .studio_workflow import task, modules
        from .models import StudioRun
        from .robot_workbench import FILES
        runs = StudioRun.objects.filter(room__owner=owner).exclude(mode='chat').order_by('-created')[:8]
        return {'framework':'Luok1xi/opus-codex-studio', 'modules':modules(),
                'tasks':[dict(task(r), state=r.state, error=r.error) for r in runs],
                'editable': [p for p in FILES if 'studio_' in p or 'companion_team' in p]}
    if operation == 'studio_module_save':
        from .studio_workflow import save_module
        return save_module(args)
    if operation == 'inventory': return dict(snapshot(), policy=policy())
    if operation == 'content_list':
        entries = Entry.objects.order_by('-updated')
        if args.get('state'): entries = entries.filter(state=args['state'])
        if args.get('kind'): entries = entries.filter(kind=args['kind'])
        if args.get('id'): entries = entries.filter(pk=args['id'])
        return {'total': entries.count(), 'items': [entry_view(e) for e in entries[:10]]}
    if operation == 'action_status':
        row = ExternalCache.objects.filter(pk='robot-action:'+str(uuid.UUID(args['id']))).first()
        if not row: raise Problem('操作不存在。', 404)
        return row.data
    if operation == 'job_status':
        row = Job.objects.filter(pk=str(uuid.UUID(args['id']))).first()
        if not row: raise Problem('任务不存在。', 404)
        return {'id': str(row.pk), 'kind': row.kind, 'state': row.state, 'completed': row.state == 'done',
                'terminal': row.state in ('done','partial','failed'), 'result': row.result,
                'error': row.error, 'updated': row.updated.isoformat()}
    if operation == 'skills':
        return {'items': [{k: r.data.get(k) for k in ('id', 'name', 'description', 'state', 'url', 'sha256', 'assessment')}
                          for r in ExternalCache.objects.filter(key__startswith='robot-skill:')]}
    if operation == 'tools':
        from .robot_tools import catalogue
        return catalogue(args)
    if operation in ('tool_install', 'tool_run'):
        from . import robot_tools
        return getattr(robot_tools, operation.removeprefix('tool_'))(args)
    if operation == 'run_robot': return run_robot(args, owner, seat, request_id)
    if operation in ('review_content', 'edit_content', 'withdraw_content', 'restore_content'):
        return content(dict(args, _operation=operation), seat)
    if operation in ('project_read', 'curate_project'):
        from .github_guides import cache_key, repository, curate
        repo = repository(args.get('repository', ''))
        row = ExternalCache.objects.filter(pk=cache_key(repo)).first()
        if not row: raise Problem('项目尚未采集。先调用开源搜寻机器人。', 404)
        if operation == 'project_read': return {'repository': repo, 'hash': digest(row.data), 'data': row.data}
        with transaction.atomic():
            row = ExternalCache.objects.select_for_update().get(pk=row.pk)
            if args.get('beforeHash') != digest(row.data): raise Problem('项目资料已变化，请重新精读。', 409)
            data = curate(actor(seat), args)
            state = 'published' if args.get('shelf') != 'unlisted' else 'dismissed'
            BeikuangTask.objects.filter(kind='project', target=repo, state__in=('queued', 'escalated')).update(
                state=state, decided_by='Codex' if seat == 'codex' else '北矿娘', decided=timezone.now(), note=args.get('reason', ''))
        return {'repository': repo, 'state': state, 'selection': data.get('selection'), 'hash': digest(data)}
    if operation.startswith('code_'):
        from . import robot_workbench as code
        if operation == 'code_read': return code.read(args.get('paths', []))
        if operation == 'code_candidate': return code.candidate(args.get('files'))
        if operation == 'code_status': return code.summary(code.get(args['id']).data)
        return getattr(code, operation.removeprefix('code_'))(args['id'])
    if operation.startswith('skill_'):
        from . import robot_skills
        return getattr(robot_skills, operation.removeprefix('skill_'))(args)
    if operation == 'discuss':
        from .companion_team import dispatch as discuss
        from .beikuang import today_stats
        return discuss(owner, {'seat': seat, 'action': 'discuss', 'id': request_id,
            'goal': text(args.get('goal'), 300, True), 'reason': text(args.get('reason'), 300, True), 'explicit': True}, today_stats())
    raise Problem('未知维护操作。')
