import json
import uuid
from pathlib import Path
from django.conf import settings
from django.contrib.auth import logout
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Q, Count
from django.http import FileResponse, HttpResponse, JsonResponse
from django.http.response import HttpResponseBase
from django.shortcuts import render
from django.utils import timezone
from . import accounts, files, github_guides
from .core import (Problem, EVENTS, accept_reply, broadcast, categories, contribute, entry_data, entry_for, record_view,
                   member_data, notify, public_entries, publish_reply, require, review_entry,
                   save_entry, string_list, submit_entry, text, throttle, url, withdraw_entry)
from .models import (Audit, Contribution, Entry, ExternalCache, Job, Member, Notification,
                     Report, Reply, Revision, Source, Star, Task, Upload, Watch, Workspace)


def csrf_failure(request, reason=''):
    return JsonResponse({'error':'安全验证已失效，请刷新页面后重试。'},status=403)


def serialize_job(job):
    return {'id':str(job.pk),'kind':job.kind,'state':job.state,'attempts':job.attempts,
            'result':job.result,'error':job.error,'updated':job.updated.isoformat()}


def enqueue(kind, payload, owner=None, key=None):
    return Job.objects.get_or_create(key=key or uuid.uuid4().hex, defaults={
        'kind':kind,'payload':payload,'owner':owner,'due':timezone.now()})[0]


def serialize_task(task):
    return {'id':str(task.pk),'entry':str(task.entry_id),'title':task.title,'description':task.description,
            'beginner':task.beginner,'state':task.state,'assignee':member_data(task.assignee) if task.assignee_id else None,
            'evidence':task.evidence,'note':task.note}


def serialize_reply(reply):
    return {'id':str(reply.pk),'body':reply.body,'author':member_data(reply.author),
            'accepted':reply.accepted,'state':reply.state,'created':reply.created.isoformat()}


def serialize_workspace(w):
    return {'id':str(w.pk),'kind':w.kind,'title':w.title,'data':w.data,'version':w.version,'updated':w.updated.isoformat()}


def endpoint(request, route=''):
    try:
        if request.method not in ('GET','POST'):
            raise Problem('不支持此请求方式。',405)
        if request.method=='POST':
            if route=='uploads':
                result = files.receive(request)
            elif route=='clips':
                from . import clips
                result = clips.receive(request)
            else:
                if request.content_type != 'application/json' or len(request.body)>1024*1024:
                    raise Problem('请发送不超过 1 MB 的 JSON。')
                body = json.loads(request.body)
                if not isinstance(body,dict):
                    raise Problem('请求应为 JSON 对象。')
                result = post(request,route.strip('/'),body)
        else:
            result = get(request,route.strip('/'))
        if isinstance(result,HttpResponseBase):
            return result
        response = JsonResponse(result,json_dumps_params={'ensure_ascii':False})
        response['Cache-Control'] = 'private, no-store'
        return response
    except Problem as exc:
        return JsonResponse({'error':exc.message},status=exc.status)
    except (ValidationError,ValueError,TypeError,KeyError,json.JSONDecodeError):
        return JsonResponse({'error':'参数格式不正确，请检查后重试。'},status=400)
    except IntegrityError:
        return JsonResponse({'error':'记录已存在或已被其他操作更新，请刷新。'},status=409)
    except Exception:
        import logging
        logging.getLogger('hub').exception('Hub request failed: %s',route)
        return JsonResponse({'error':'服务暂时无法完成操作，请稍后重试。'},status=500)


def get(request, route):
    if route.startswith('illustration/'):
        from .editorial_art import get as illustration
        return illustration(route.removeprefix('illustration/'))
    if route.startswith('reader/'):
        from . import reader
        return reader.get(request, route)
    if route == 'question-papers' or route.startswith('question-papers/'):
        from . import question_api
        return question_api.get(request, route)
    if route == 'learning/sources':
        from .source_health import list_sources
        return list_sources(request)
    if route.startswith('learning/'):
        from . import learning
        return learning.get(request, route)
    if route == 'club-schedule' or route.startswith('club-schedule/'):
        from . import club_schedule
        return club_schedule.get(request, route)
    if route == 'map/names':
        from . import building_names
        return building_names.get(request)
    user, query = request.user, request.GET
    if route == 'bookings' or route.startswith('bookings/'):
        from . import bookings
        return bookings.get(request,route)
    parts = route.split('/')
    if parts[0] == 'planner':
        from . import planner
        return planner.get(request, route)
    if parts[0] == 'operations':
        from . import operations
        return operations.get(request, route)
    if parts[0] == 'sync':
        from . import sync
        return sync.get(request, route)
    if parts[0] == 'beikuang':
        from . import beikuang
        return beikuang.get(request, route)
    if parts[0] == 'studio':
        from . import studio
        return studio.get(request, route)
    if parts[0] == 'circle':
        from . import circle
        return circle.get(request, route)
    if parts[0] == 'clips':
        from . import clips
        return clips.get(request, route)
    if parts[0] in {'teachers', 'courses', 'offerings', 'reviews', 'reputation'}:
        from . import reputation
        return reputation.get(request, route)
    # 维护机器人的结果：公告、项目配图是公开的；运行状态和待审新闻只给维护者
    if route=='maintenance/status':
        require(user, staff=True)
        from .maintenance import status
        return status()
    if route=='supervisor':
        require(user,staff=True)
        from .supervisor import status
        return status()
    if route in ('campus/notices','projects/media'):
        cache = ExternalCache.objects.filter(pk='maint:notices' if route=='campus/notices' else 'maint:project-media').first()
        return {**(cache.data if cache else {}), 'checked': cache.checked.isoformat() if cache and cache.checked else None,
                'error': cache.error if cache else '', 'ready': bool(cache and (cache.success or (route=='projects/media' and any(v.get('image') for v in cache.data.get('items',{}).values()))))}
    if parts[0]=='mirror':
        from .mirror import repository_name, serialize
        from .models import MirrorAsset
        if len(parts)==3 and parts[2] in ('file','license'):
            asset = MirrorAsset.objects.filter(pk=parts[1]).first()
            if not asset:
                raise Problem('这个文件不存在或已下架。',404)
            from .mirror_store import download
            return download(request,asset,parts[2]=='license')
        repository = repository_name(query.get('repository',''))
        state = (ExternalCache.objects.filter(pk='maint:mirror').first() or ExternalCache(data={})).data.get('repositories',{}).get(repository,{})
        assets = MirrorAsset.objects.filter(repository=repository).order_by('-published','-created')[:20]
        return {'repository':repository,'items':[serialize(a) for a in assets],'status':state.get('status','unknown' if not assets else 'ok'),
                'license':state.get('license',assets[0].license if assets else ''),'reason':state.get('reason',''),
                'checkedAt':state.get('checkedAt'),'githubUrl':f'https://github.com/{repository}'}
    if route=='health':
        from .operations import RELEASE
        return {'ok':True,'version':'2.0','build':RELEASE,'beikuangChatVersion':34,'accounts':True,'ai':github_guides.ai_capabilities(),**accounts.capabilities()}
    if route=='categories':
        return {'categories':categories()}
    if route=='map/places':
        from .places import collection
        return collection(request)
    if route=='recommendations':
        require(user)
        preferences = user.preferences
        wanted = set(preferences.get('interests',[]) + preferences.get('courses',[]) + preferences.get('goals',[]))
        ranked = []
        for entry in public_entries().select_related('owner').order_by('-updated')[:500]:
            data = entry.published
            labels = set(data.get('tags',[]) + data.get('courses',[]))
            labels.update(x for x in (data.get('course'),data.get('category')) if x)
            matched = sorted(wanted & labels)
            if matched:
                ranked.append((len(matched),entry,matched))
        ranked.sort(key=lambda row:row[0],reverse=True)
        return {'items':[dict(entry_data(e,user),reasons=['与你选择的“'+v+'”匹配' for v in matches]) for _,e,matches in ranked[:30]],
                'notice':'依据你主动选择的标签匹配；未根据浏览记录推断身份，不自动认定报名资格。'}
    if route=='auth/session':
        return accounts.session(request)
    if route=='auth/github/start':
        return accounts.github_start(request)
    if route=='auth/github/callback':
        return accounts.github_callback(request)
    if route=='catalogue':
        items = public_entries().select_related('owner').order_by('-updated')
        for name in ('kind','slug'):
            if query.get(name):
                items = items.filter(**{name:query[name]})
        for name in ('course','year','difficulty'):
            if query.get(name):
                items = items.filter(**{'published__'+name:query[name]})
        if query.get('q'):
            for term in query['q'][:160].split()[:8]:
                items = items.filter(search_text__icontains=term)
        offset = max(0,min(int(query.get('offset',0)),100000))
        page = list(items[offset:offset+30])
        # Public catalogue exposes metadata only for attachments of this published page.
        identifiers = {uid for entry in page for uid in entry.published.get('uploads', [])}
        attachments = {str(u.pk): files.upload_data(u) for u in Upload.objects.filter(pk__in=identifiers).select_related('asset')}
        return {'total':items.count(),'items':[dict(entry_data(e,user), attachments=[
            attachments[uid] for uid in e.published.get('uploads', []) if uid in attachments]) for e in page]}
    if parts[0]=='entries' and len(parts)>=2:
        entry = entry_for(user,parts[1])
        if len(parts)==2:
            result = entry_data(entry,user,own=True)
            replies = Reply.objects.filter(entry=entry,state='published')
            if user.is_authenticated:
                replies = Reply.objects.filter(entry=entry).filter(Q(state='published')|Q(author=user))
                if user.is_staff:
                    replies = Reply.objects.filter(entry=entry)
            result['replies'] = [serialize_reply(r) for r in replies.select_related('author').order_by('created')[:200]]
            result['tasks'] = [serialize_task(t) for t in Task.objects.filter(entry=entry).select_related('assignee')[:100]]
            result['attachments'] = [files.upload_data(u) for u in Upload.objects.filter(pk__in=entry.published.get('uploads',[])).select_related('asset')]
            return result
        if parts[2]=='history':
            revisions = Revision.objects.filter(entry=entry,state='published')
            if user.is_authenticated and (entry.owner_id==user.pk or user.is_staff):
                revisions = Revision.objects.filter(entry=entry)
            return {'items':[{'revision':r.number,'data':r.data,'state':r.state,'note':r.note} for r in revisions.order_by('-number')[:30]]}
    if parts[0]=='uploads' and len(parts)>=2:
        if len(parts)==3 and parts[2]=='photo':
            return files.photo_preview(user,parts[1])
        if len(parts)==3 and parts[2]=='file':
            return files.download(user,parts[1])
        return files.upload_data(files.visible_upload(user,parts[1]))
    if route=='me':
        require(user)
        return {'profile':member_data(user,True),
                'entries':[entry_data(e,user,True) for e in Entry.objects.filter(owner=user).order_by('-updated')[:100]],
                'stars':[entry_data(s.entry,user) for s in Star.objects.filter(user=user,entry__public_revision__gt=0).exclude(entry__state='withdrawn').select_related('entry')[:200]],
                'workspaces':[serialize_workspace(w) for w in Workspace.objects.filter(owner=user).exclude(kind='building_name_vote').order_by('-updated')[:100]]}
    if parts[0]=='members' and len(parts)==2:
        member = Member.objects.filter(username__iexact=parts[1],is_active=True).first()
        if not member:
            raise Problem('成员不存在。',404)
        return {'profile':member_data(member),'entries':[entry_data(e,user) for e in public_entries().filter(owner=member)[:100]]}
    if route=='contributions':
        records = Contribution.objects.filter(active=True).select_related('user','entry')
        if query.get('username'):
            records = records.filter(user__username__iexact=query['username'])
        if query.get('date'):
            records = records.filter(created__date=query['date'])
        items = [{'id':c.key,'user':member_data(c.user),'category':c.category,'summary':c.summary,
                  'evidence':c.evidence,'entry':str(c.entry_id) if c.entry_id else None,
                  'date':timezone.localtime(c.created).date().isoformat()} for c in records.order_by('-created')[:1000]]
        totals = dict(records.values_list('category').annotate(n=Count('key')))
        return {'total':records.count(),'categories':totals,'items':items,'definition':'被采纳的公共贡献；不包含 Star 和外部刷题记录。'}
    if route=='notifications':
        require(user)
        from .notifications import inbox
        return inbox(user)
    if route=='moderation':
        require(user,staff=True)
        return {'entries':[entry_data(e,user,True) for e in Entry.objects.filter(state='pending').order_by('created')[:100]],
                'replies':[dict(serialize_reply(r),entry=str(r.entry_id)) for r in Reply.objects.filter(state='pending').select_related('author')[:100]],
                'reports':list(Report.objects.filter(state='open').values('id','entry_id','reason','created')[:100]),
                'sources':list(Source.objects.values()[:100]),
                'jobs':[serialize_job(j) for j in Job.objects.order_by('-updated')[:100]],
                'needsOCR':[files.upload_data(u) for u in Upload.objects.filter(asset__extraction='needs-ocr').select_related('asset')[:100]],
                'audit':list(Audit.objects.order_by('-created').values('action','target','detail','created')[:100])}
    if parts[0]=='jobs' and len(parts)==2:
        require(user)
        jobs = Job.objects.all() if user.is_staff else Job.objects.filter(owner=user)
        job = jobs.filter(pk=parts[1]).first()
        if not job:
            raise Problem('任务不存在。',404)
        return serialize_job(job)
    if route=='github/selected':
        items = []
        for cache in ExternalCache.objects.filter(key__startswith='github:'):
            selected = cache.data.get('selection') or {}
            if selected.get('shelf') in ('practical','creative','potential'):
                d = dict(cache.data,stale=bool(cache.error),lastSuccess=cache.success)
                d.pop('readme',None)
                items.append(d)
        return {'items':items,'ai':github_guides.ai_capabilities()}
    if route=='repositories':
        from .project_catalog import catalogue
        return catalogue(query,user)
    if route=='feed':
        from .feed import cards
        return cards(request)
    if route=='github/project':
        repo = github_guides.repository(query.get('repository',''))
        cache = ExternalCache.objects.filter(pk=github_guides.cache_key(repo)).first()
        if not cache or not cache.success:
            raise Problem('尚未收录这个仓库，请先请求解析。',404)
        data = dict(cache.data,stale=bool(cache.error),lastSuccess=cache.success,error=cache.error)
        if not (user.is_authenticated and user.is_staff) and (data.get('guide') or {}).get('reviewState') != 'reviewed':
            data['guide'] = {'state':'awaiting-review','message':'详细中文导读正在整理，核对后在此公开。'}
        return data
    if route=='search/external':
        from .discovery import external_search
        throttle('search',request.META.get('REMOTE_ADDR',''),60)
        return external_search(text(query.get('q',''),160,True),query.get('provider','github'))
    if parts[0]=='workspaces' and len(parts)>=2:
        require(user)
        w = Workspace.objects.filter(owner=user,pk=parts[1]).first()
        if not w:
            raise Problem('工作区不存在。',404)
        if len(parts)==3 and parts[2]=='bibliography':
            from .research import bibliography
            return HttpResponse(bibliography(user,w),content_type='application/x-bibtex; charset=utf-8')
        return serialize_workspace(w)
    if route=='backup':
        require(user)
        return {'schema':'luokixi-personal-v1','created':timezone.now().isoformat(),
                'workspaces':[serialize_workspace(w) for w in Workspace.objects.filter(owner=user).exclude(kind='campus-plan')],
                'notice':'校园计划请在计划页单独导出；此备份包含其余个人工作区与收藏。',
                'stars':list(Star.objects.filter(user=user).values('entry_id','collection'))}
    raise Problem('接口不存在。',404)


def post(request, route, body):
    if route == 'question-papers' or route.startswith('question-papers/'):
        from . import question_api
        return question_api.post(request, route, body)
    if route == 'learning/preview':
        from .learning_collect import preview
        return preview(request, body)
    if route == 'learning/questions':
        from .learning_discussion import submit_question
        return submit_question(request, body)
    if route.startswith('learning/'):
        from . import learning
        return learning.post(request, route, body)
    if route == 'club-schedule' or route.startswith('club-schedule/'):
        from . import club_schedule
        return club_schedule.post(request, route, body)
    if route == 'map/names':
        from . import building_names
        return building_names.post(request, body)
    user, parts = request.user, route.split('/')
    if parts[0] == 'planner':
        from . import planner
        return planner.post(request, route, body)
    if parts[0] == 'operations':
        from . import operations
        return operations.post(request, route, body)
    if route == 'bookings' or route.startswith('bookings/'):
        from . import bookings
        return bookings.post(request,route,body)
    if parts[0] == 'sync':
        from . import sync
        return sync.post(request, route, body)
    if parts[0] == 'beikuang':
        from . import beikuang
        return beikuang.post(request, route, body)
    if parts[0] == 'studio':
        from . import studio
        return studio.post(request, route, body)
    if parts[0] == 'circle':
        from . import circle
        return circle.post(request, route, body)
    if parts[0] == 'clips':
        from . import clips
        return clips.post(request, route, body)
    if parts[0] in {'teachers', 'courses', 'offerings', 'reviews', 'review-replies', 'review-cases', 'reputation'}:
        from . import reputation
        return reputation.post(request, route, body)
    if route=='maintenance/run':
        require(user, staff=True)
        from .maintenance import TASKS
        tasks = list(TASKS) if body.get('task')=='all' else [body.get('task')]
        if not all(t in TASKS for t in tasks):
            raise Problem('未知的维护任务。')
        if 'summaries' in tasks:
            from .project_summaries import authorize
            try: authorize(user)
            except Problem:
                if body.get('task')!='all': raise
                tasks.remove('summaries')
        jobs = [enqueue('maint-'+t,{},user) for t in tasks]
        Audit.objects.create(actor=user,action='maintenance-run',target=','.join(tasks))
        return {'jobs':[serialize_job(j) for j in jobs]}
    if route=='mirror/refresh':
        require(user, staff=True)
        from .mirror import repository_name
        repository = repository_name(body.get('repository',''))
        job = enqueue('mirror-repo',{'repository':repository},user)
        Audit.objects.create(actor=user,action='mirror-refresh',target=repository)
        return {'job':serialize_job(job)}
    if route=='supervisor/answer':
        from .supervisor import answer
        return answer(user,body)
    if route=='supervisor/discuss':
        from .supervisor import discuss
        return discuss(request,body)
    if route=='supervisor/announcement':
        from .project_summaries import authorize
        authorize(user)
        throttle('supervisor-announcement',str(user.pk),3)
        return serialize_job(enqueue('supervisor-draft',{},user))
    auth = {'auth/register':accounts.register,'auth/login':accounts.sign_in,'auth/reset-request':accounts.reset_request,
            'auth/reset-confirm':accounts.reset_confirm,'auth/verify':accounts.verify,'auth/profile':accounts.profile}
    if route in auth:
        return auth[route](request,body)
    if route=='digest/unsubscribe':
        from django.core import signing
        try:
            data = signing.loads(text(body.get('token',''),500,True),salt='hub.unsubscribe',max_age=90*86400)
            Member.objects.filter(pk=data['id'],email=data['email']).update(digest_enabled=False)
        except (signing.BadSignature,KeyError):
            raise Problem('退订链接无效或已过期，可在个人设置中退订。')
        return {'message':'已取消邮件摘要。'}
    if route=='auth/logout':
        logout(request)
        return accounts.session(request)
    if len(parts)==3 and parts[0]=='entries' and parts[2]=='view':
        # 浏览量不需要登录；按账号或浏览器会话、按天去重
        return {'views':record_view(request,entry_for(user,parts[1]))}
    require(user)
    if len(parts)==4 and parts[:2]==['map','places'] and parts[3]=='observe':
        from .places import observe
        return observe(user,parts[2],body)
    if route=='auth/send-verification':
        throttle('verification-email',str(user.pk),3)
        accounts.send_verification(user)
        return accounts.capabilities()
    if route=='entries':
        throttle('create',str(user.pk),30)
        return entry_data(save_entry(user,body),user,True)
    if parts[0]=='entries' and len(parts)==3:
        action = parts[2]
        entry = entry_for(user,parts[1],edit=action in {'save','submit','withdraw','release','tasks'})
        if action=='save':
            return entry_data(save_entry(user,body,entry),user,True)
        if action=='submit':
            return entry_data(submit_entry(user,entry,body.get('revision')),user,True)
        if action=='review':
            return entry_data(review_entry(user,entry,body),user,True)
        if action=='withdraw':
            withdraw_entry(user,entry,text(body.get('reason',''),1000,True))
            return {'ok':True}
        if action in {'star','watch'}:
            require(user,verified=True)
            if not entry.public_revision or entry.state=='withdrawn':
                raise Problem('只能收藏或关注已公开内容。')
            if action=='star':
                if body.get('enabled') is True:
                    Star.objects.update_or_create(user=user,entry=entry,defaults={'collection':text(body.get('collection','默认收藏'),80,True)})
                elif body.get('enabled') is False:
                    Star.objects.filter(user=user,entry=entry).delete()
                else:
                    raise Problem('请明确设置收藏状态。')
            else:
                events = string_list(body.get('events',[]),3,30)
                if not set(events).issubset(EVENTS):
                    raise Problem('关注类型无效。')
                if events:
                    Watch.objects.update_or_create(user=user,entry=entry,defaults={'events':events})
                else:
                    Watch.objects.filter(user=user,entry=entry).delete()
            return entry_data(entry,user)
        if action=='release':
            require(user,verified=True)
            if not entry.public_revision or entry.state=='withdrawn':
                raise Problem('请先发布项目。')
            version = text(body.get('version',''),100,True)
            link = url(body.get('url',''),True)
            note = text(body.get('note',''),1000,True)
            with transaction.atomic():
                audit, created = Audit.objects.get_or_create(actor=user,action='release',target=f'{entry.pk}:{version}',defaults={'detail':{'url':link,'note':note}})
                if created:
                    broadcast(entry,'release',f'release:{entry.pk}:{version}',f'{entry.published["title"]} 发布 {version}：{note}',user)
            return {'ok':True,'created':created}
        if action=='replies':
            require(user,verified=True)
            throttle('reply',str(user.pk),30)
            if not entry.public_revision or entry.state=='withdrawn':
                raise Problem('请等待内容公开后讨论。')
            with transaction.atomic():
                reply = Reply.objects.create(entry=entry,author=user,body=text(body.get('body',''),20000,True))
                if user.trusted or user.is_staff:
                    publish_reply(user,reply)
            return serialize_reply(reply)
        if action=='tasks':
            task = Task.objects.create(entry=entry,title=text(body.get('title',''),160,True),
                description=text(body.get('description',''),5000,True),beginner=body.get('beginner') is not False)
            return serialize_task(task)
        if action=='report':
            throttle('report',str(user.pk),10)
            report = Report.objects.create(reporter=user,entry=entry,reason=text(body.get('reason',''),2000,True))
            return {'id':report.pk,'state':report.state}
    if parts[0]=='replies' and len(parts)==3:
        reply = Reply.objects.filter(pk=parts[1]).select_related('entry','author').first()
        if not reply:
            raise Problem('回复不存在。',404)
        entry_for(user,reply.entry_id)
        if parts[2]=='review':
            require(user,staff=True)
            if body.get('approve') is True:
                publish_reply(user,reply)
            else:
                reply.state = 'rejected'
                reply.accepted = False
                reply.save(update_fields=['state','accepted'])
                Contribution.objects.filter(key='answer:'+str(reply.pk)).update(active=False,reason='回复被撤回')
                Audit.objects.create(actor=user,action='reply:reject',target=str(reply.pk),detail={'reason':text(body.get('reason',''),1000,True)})
            return serialize_reply(reply)
        if parts[2]=='accept':
            accept_reply(user,reply.entry,reply)
            return serialize_reply(reply)
    if parts[0]=='tasks' and len(parts)==3:
        require(user,verified=True)
        with transaction.atomic():
            task = Task.objects.select_for_update().filter(pk=parts[1]).first()
            if not task:
                raise Problem('任务不存在。',404)
            entry_for(user,task.entry_id)
            if not task.entry.public_revision or task.entry.state=='withdrawn':
                raise Problem('任务所属项目当前未公开。')
            action = parts[2]
            if action=='claim' and task.state=='open' and task.entry.owner_id!=user.pk:
                task.assignee, task.state = user, 'claimed'
            elif action=='submit' and task.assignee_id==user.pk and task.state in ('claimed','changes-requested'):
                task.evidence, task.state = url(body.get('evidence',''),True), 'submitted'
            elif action=='review' and (task.entry.owner_id==user.pk or user.is_staff) and task.state in ('submitted','accepted'):
                task.note = text(body.get('note',''),2000,True)
                task.state = 'accepted' if body.get('approve') is True else 'changes-requested'
                if task.state=='accepted':
                    contribute(task.assignee,task.entry,'task','task:'+str(task.pk),task.title,task.evidence)
                else:
                    Contribution.objects.filter(key='task:'+str(task.pk)).update(active=False,reason=task.note)
                notify(task.assignee,task.entry,'task',f'task:{task.pk}:{task.state}',task.note)
            else:
                raise Problem('当前状态或权限不允许此操作。',409)
            task.save()
            Audit.objects.create(actor=user,action='task:'+action,target=str(task.pk))
            return serialize_task(task)
    if route=='notifications/read':
        ids = body.get('ids',[])
        if not isinstance(ids,list) or len(ids)>100:
            raise Problem('通知列表无效。')
        return {'updated':Notification.objects.filter(user=user,id__in=ids).update(read=True)}
    if route=='github/inspect':
        require(user,verified=True)
        throttle('github-inspect',str(user.pk),12)
        return serialize_job(enqueue('github-inspect',{'repository':github_guides.repository(body.get('repository',''))},user))
    if route=='github/summarize':
        from .project_summaries import authorize
        authorize(user)
        throttle('github-summary',str(user.pk),6)
        if not github_guides.ai_capabilities()['configured']:
            raise Problem(github_guides.ai_capabilities()['message'],503)
        return serialize_job(enqueue('github-summary',{'repository':github_guides.repository(body.get('repository',''))},user))
    if route=='github/classify':
        require(user,staff=True)
        from .project_catalog import organize_repository
        return organize_repository(body.get('repository',''))
    if route=='github/guide/review':
        from .project_summaries import review
        return review(user,body)
    if route=='github/curate':
        return github_guides.curate(user,body)
    if route=='feed/feedback':
        from .feed import feedback
        return feedback(user,body)
    if route=='feed/workflow':
        from .feed import workflow
        return serialize_workspace(workflow(user,body))
    if route in ('workspaces','planning') or (parts[0]=='workspaces' and len(parts)==2):
        require(user)
        if parts[0] == 'workspaces' and len(parts) == 2 and Workspace.objects.filter(owner=user, pk=parts[1], kind__in=['campus-plan','building_name_vote']).exists():
            raise Problem('请在对应的课表或地图页面修改记录。')
        from .research import save_workspace, create_plan
        if route=='planning':
            return serialize_workspace(create_plan(user,body))
        return serialize_workspace(save_workspace(user,body,parts[1] if len(parts)==2 else None))
    if route=='restore':
        from .research import restore
        return restore(user,body)
    if route=='sources':
        require(user,staff=True)
        from .discovery import validate_source
        payload = validate_source(body)
        if body.get('id'):
            source = Source.objects.get(pk=body['id'])
            if 'metadata' not in body:
                payload.pop('metadata', None)
            if source.url != payload['url'] or source.kind != payload['kind']:
                source.etag = source.modified = source.fingerprint = source.error = ''
                source.last_success = source.last_attempt = None
                ExternalCache.objects.filter(pk='source-health:' + str(source.pk)).delete()
            for key,value in payload.items():
                setattr(source,key,value)
            source.save()
        else:
            source = Source.objects.create(**payload)
        Audit.objects.create(actor=user,action='source:save',target=str(source.pk))
        return {'id':str(source.pk)}
    if parts[0]=='sources' and len(parts)==3 and parts[2]=='refresh':
        require(user,staff=True)
        source = Source.objects.get(pk=parts[1])
        return serialize_job(enqueue('source',{'id':str(source.pk)},user))
    if parts[0]=='reports' and len(parts)==2:
        require(user,staff=True)
        report = Report.objects.get(pk=parts[1])
        report.resolution, report.state = text(body.get('resolution',''),2000,True), 'closed'
        report.save(update_fields=['resolution','state'])
        Audit.objects.create(actor=user,action='report:resolve',target=str(report.pk),detail={'resolution':report.resolution})
        return {'ok':True}
    raise Problem('操作不存在。',404)


def workbench(request):
    return render(request,'hub/workbench.html',{'localPreview':not settings.PRODUCTION})


def client_file(request, name):
    if name != 'hub-client.js':
        return HttpResponse(status=404)
    path = Path(__file__).resolve().parents[1]/name
    return FileResponse(path.open('rb'),content_type='text/css' if name.endswith('.css') else 'text/javascript')
