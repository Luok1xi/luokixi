"""Single versioned publication boundary for the owner, admin and AI content tools."""
import copy
import json
import re
import uuid
from pathlib import Path
from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from .core import Problem, require, text, url
from .models import Audit, Entry, Revision, EditorialOverride, EditorialRevision, ExternalCache, ContentTask, Upload


def manager(user):
    # A nickname, email domain or frontend flag alone never grants these powers.
    return bool(user.is_authenticated and user.is_active and (user.is_superuser or (
        user.is_staff and not user.has_usable_password() and (
            (user.username == '北矿娘' and user.email == 'beikuang@agent.luokixi.invalid') or
            (user.username == 'Codex' and user.email == 'codex@system.invalid')))))


def authorize(user):
    require(user)
    if not manager(user):
        raise Problem('只有站主和已授权的系统角色可以直接管理公开内容。', 403)


def validate_media(media, user):
    if not isinstance(media, dict): raise Problem('配图格式不正确。')
    src = text(media.get('src', ''), 1500, True)
    if src.startswith('/api/hub/uploads/'):
        try: uid = src.split('/')[4]; upload = Upload.objects.get(pk=uid)
        except (ValueError, IndexError, Upload.DoesNotExist): raise Problem('配图原件不存在。')
        if not user.is_staff and upload.owner_id != user.pk: raise Problem('没有此图片的权限。', 403)
        if upload.asset.extension not in ('.png', '.jpg', '.jpeg', '.webp'): raise Problem('请选择图片附件。')
    elif src.startswith(('/art/', '/api/hub/illustration/', '/api/hub/news/')):
        if '..' in src or '\\' in src: raise Problem('图片路径无效。')
    else: url(src, True)
    focal = text(media.get('focal', '50% 50%'), 30)
    if not re.fullmatch(r'\d{1,3}(?:\.\d+)?% \d{1,3}(?:\.\d+)?%', focal) or any(float(v.rstrip('%')) > 100 for v in focal.split()):
        raise Problem('焦点使用两个 0–100% 的坐标。')
    fit = media.get('fit', 'cover')
    if fit not in ('cover', 'contain'): raise Problem('显示方式无效。')
    return {**{k: media[k] for k in ('width', 'height', 'usage', 'originalSrc') if k in media},
        'src': src, 'focal': focal, 'fit': fit, 'alt': text(media.get('alt', ''), 600),
        'credit': text(media.get('credit', ''), 600), 'sourceUrl': url(media.get('sourceUrl', ''))}


def entry_view(e):
    return {'key': 'entry/'+str(e.pk), 'id': str(e.pk), 'kind': e.kind, 'state': e.state,
        'revision': e.revision, 'publicRevision': e.public_revision, 'data': e.draft,
        'published': e.published, 'updated': e.updated.isoformat(), 'reviewNote': e.review_note,
        'source': e.draft.get('links', {}), 'duplicate': str(e.canonical_id) if e.canonical_id else None}


def base(key):
    if key.startswith('featured/'):
        rows = json.loads((settings.BASE.parent/'public/data/featured.json').read_text(encoding='utf-8'))['items']
        row = next((r for r in rows if r['id'] == key.removeprefix('featured/')), None)
    elif key.startswith('github/'):
        cache = ExternalCache.objects.filter(pk='github:'+key.removeprefix('github/')).first()
        row = cache.data if cache else None
        if row is None:
            catalogue = json.loads((settings.BASE.parent/'public/data/community.json').read_text(encoding='utf-8'))
            row = next((p for p in catalogue.get('projects',[]) if p.get('repo',{}).get('fullName') == key.removeprefix('github/')), None)
    elif key.startswith('page/'):
        name = key.removeprefix('page/')
        if not re.fullmatch(r'[a-z0-9_-]+', name): raise Problem('页面编号无效。')
        path = settings.BASE.parent/'public/data'/f'{name}.json'
        row = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else None
    else: raise Problem('内容编号无效。')
    if row is None: raise Problem('内容不存在。', 404)
    return copy.deepcopy(row)


def merged(key, source=None):
    row = EditorialOverride.objects.filter(pk=key).first()
    source = copy.deepcopy(source if source is not None else base(key))
    if row: source.update(copy.deepcopy(row.data))
    return source


def read(user, key):
    authorize(user)
    if key.startswith('entry/'):
        try: e = Entry.objects.get(pk=key.removeprefix('entry/'))
        except (ValueError, Entry.DoesNotExist): raise Problem('内容不存在。', 404)
        return entry_view(e)
    source = base(key)
    row = EditorialOverride.objects.filter(pk=key).first()
    return {'key': key, 'kind': key.split('/')[0], 'state': 'published', 'revision': row.revision if row else 0,
        'data': merged(key, source), 'sourceData': source, 'updated': row.updated.isoformat() if row else None}


def search(user, query='', state='', kind=''):
    authorize(user)
    query = text(query, 200)
    qs = Entry.objects.order_by('-updated').select_related('canonical')
    if query: qs = qs.filter(Q(draft__title__icontains=query)|Q(search_text__icontains=query)|Q(slug__icontains=query))
    if state: qs = qs.filter(state=state)
    if kind: qs = qs.filter(kind=kind)
    items = [entry_view(e) for e in qs[:60]]
    if not state and not kind:
        featured = json.loads((settings.BASE.parent/'public/data/featured.json').read_text(encoding='utf-8'))['items']
        keys = ['featured/'+r['id'] for r in featured if not query or query.lower() in json.dumps(r, ensure_ascii=False).lower()]
        repositories = ExternalCache.objects.filter(key__startswith='github:').order_by('-checked')
        if query: repositories = repositories.filter(Q(key__icontains=query)|Q(data__icontains=query))
        keys += ['github/'+r.key.removeprefix('github:') for r in repositories[:40]]
        catalogue = json.loads((settings.BASE.parent/'public/data/community.json').read_text(encoding='utf-8'))
        keys += ['github/'+p['repo']['fullName'] for p in catalogue.get('projects',[]) if p.get('repo',{}).get('fullName') and (not query or query.lower() in json.dumps(p,ensure_ascii=False).lower())]
        keys += ['page/site'] if not query or query in '页面说明站点' else []
        items += [read(user, key) for key in dict.fromkeys(keys)]
    total = qs.count()
    return {'items': items, 'total': total+len(items)-min(total, 60)}


def history(user, key):
    authorize(user)
    if key.startswith('entry/'):
        rows = Revision.objects.filter(entry_id=key.removeprefix('entry/')).select_related('reviewer').order_by('-number')
        items = [{'revision': r.number, 'data': r.data, 'state': r.state, 'actor': r.reviewer.username if r.reviewer else '',
                  'reason': r.note, 'created': r.created.isoformat()} for r in rows[:100]]
    else:
        rows = EditorialRevision.objects.filter(override_id=key).select_related('editor').order_by('-number')
        items = [{'revision': r.number, 'data': r.data, 'actor': r.editor.username if r.editor else '',
                  'reason': r.reason, 'created': r.created.isoformat()} for r in rows[:100]]
    return {'items': items}


@transaction.atomic
def publish(user, body):
    authorize(user)
    key = text(body.get('key', ''), 240, True)
    reason = text(body.get('reason', '站内编辑并发布'), 1500, True)
    current = read(user, key)
    if body.get('revision') != current['revision']: raise Problem('内容版本已变化，请重新读取。', 409)
    patch = body.get('patch', {})
    if not isinstance(patch, dict) or len(json.dumps(patch, ensure_ascii=False)) > 90000: raise Problem('修改内容过大或格式无效。')
    if body.get('restoreRevision') is not None:
        target = next((r for r in history(user, key)['items'] if r['revision'] == body['restoreRevision']), None)
        if target is None: raise Problem('历史版本不存在。', 404)
        patch = target['data']
    before = current['data']
    data = dict(before, **patch)
    if 'media' in patch: data['media'] = validate_media(patch['media'], user)
    if key.startswith('entry/'):
        from .core import save_entry, submit_entry, review_entry
        e = Entry.objects.select_for_update().get(pk=current['id'])
        e = save_entry(user, {'revision': e.revision, 'data': data}, e)
        # Keep collector provenance and timestamps which are outside the submission form.
        preserved = {k: v for k, v in before.items() if k not in e.draft}
        if preserved:
            e.draft.update(preserved); e.save(update_fields=['draft'])
            Revision.objects.filter(entry=e, number=e.revision).update(data=e.draft)
        e = submit_entry(user, e, e.revision)
        e = review_entry(user, e, {'revision': e.revision, 'decision': 'approve', 'note': reason,
            'locationChecked': body.get('locationChecked') is True,
            'supervisorQuestionsResolved': body.get('supervisorQuestionsResolved') is True})
        result = entry_view(e)
    else:
        # Save only explicitly changed fields: collector statistics and downloads stay fresh.
        row, _ = EditorialOverride.objects.select_for_update().get_or_create(key=key)
        if row.revision != body['revision']: raise Problem('内容版本已变化，请重新读取。', 409)
        if not row.revision: EditorialRevision.objects.create(override=row, number=0, data=before, editor=user, reason='编辑前原始版本')
        row.data = ({} if body['restoreRevision'] == 0 else copy.deepcopy(patch)) if body.get('restoreRevision') is not None else dict(row.data, **patch)
        if 'media' in patch and body.get('restoreRevision') != 0: row.data['media'] = data['media']
        row.revision += 1; row.editor = user; row.save()
        EditorialRevision.objects.create(override=row, number=row.revision, data=row.data, editor=user, reason=reason)
        result = read(user, key)
    Audit.objects.create(actor=user, action='content.publish', target=key, detail={
        'revision': result['revision'], 'reason': reason, 'before': before, 'after': result['data'],
        'changed': [k for k in set(before)|set(result['data']) if before.get(k) != result['data'].get(k)]})
    return dict(result, completed=True)


@transaction.atomic
def review(user, body):
    authorize(user)
    from .core import review_entry, submit_entry
    key = body['key']; current = read(user, key)
    if not key.startswith('entry/'): raise Problem('此内容没有待审投稿。')
    if body.get('revision') != current['revision']: raise Problem('审核版本已变化。', 409)
    e = Entry.objects.select_for_update().get(pk=current['id'])
    if e.state in ('draft', 'rejected'): e = submit_entry(user, e, e.revision)
    e = review_entry(user, e, {'revision': e.revision, 'decision': body.get('decision'),
        'note': body.get('reason', ''), 'locationChecked': body.get('locationChecked') is True,
        'supervisorQuestionsResolved': body.get('supervisorQuestionsResolved') is True})
    from .models import BeikuangTask
    BeikuangTask.objects.filter(target=str(e.pk), state__in=('queued','escalated')).update(
        state='published' if e.state == 'published' else 'dismissed', decided=timezone.now(),
        decided_by=user.username, note=body.get('reason', ''))
    return dict(entry_view(e), completed=True)


def overlays():
    return {'items': {r.key: r.data for r in EditorialOverride.objects.all()}}


def explicit_work(words):
    return bool(re.search(r'(?:请|帮|把|给|你|现在|直接|审核|发布|修改|编辑|替换|换图|上架|下架|退回|恢复).{0,100}(?:审核|发布|修改|编辑|替换|换图|上架|下架|退回|恢复)|^(?:审核|发布|修改|编辑|换图|上架|下架|退回|恢复)', words, re.S))


def ensure_task(owner, seat, origin, words):
    if not explicit_work(words): return None
    authorize(owner)
    task, _ = ContentTask.objects.get_or_create(origin=origin, defaults={'owner': owner, 'seat': seat, 'goal': words})
    return task


def task_data(t):
    return {'id': str(t.pk), 'seat': t.seat, 'origin': t.origin, 'state': t.state, 'progress': t.progress,
        'result': t.result, 'error': t.error, 'updated': t.updated.isoformat()}


def verified_receipts(task, ids):
    try: keys = ['robot-action:'+str(uuid.UUID(i)) for i in ids]
    except (ValueError, TypeError, AttributeError): return []
    receipts = list(ExternalCache.objects.filter(key__in=keys))
    if len(receipts) != len(set(ids)) or not receipts or not all(r.data.get('task') == str(task.pk) and r.data.get('seat') == task.seat and r.data.get('state') == 'done' and r.data.get('result', {}).get('completed') is True for r in receipts): return []
    requested=set(re.findall(r'(?:entry/[a-f0-9-]{36}|featured/[a-zA-Z0-9_-]+|github/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)',task.goal))
    changed=set(r.data['result'].get('key') or 'entry/'+str(r.data['result'].get('id','')) for r in receipts)
    if not requested.issubset(changed): return []
    return receipts


def reconcile_tasks():
    """After restart, recover successful writes from bound receipts, never repeat a tool."""
    for t in ContentTask.objects.filter(state__in=('failed','running')).order_by('-created')[:100]:
        ids=t.result.get('actionIds',[])
        if not ids: continue
        if verified_receipts(t,ids):
            previous=t.error
            t.result={**t.result,'reportWarnings':t.result.get('reportWarnings',t.result.get('gaps',[])), 'reconciled':True}
            t.state='completed';t.error='';t.progress='已核验本次成功发布或审核回执，原告警保留在执行记录中';t.save()
            Audit.objects.create(actor=t.owner,action='content.task.reconciled',target=str(t.pk),detail={'actionIds':ids,'previousError':previous})


@transaction.atomic
def update_task(owner, seat, args):
    t = ContentTask.objects.select_for_update().filter(pk=args['id'], owner=owner, seat=seat).first()
    if not t: raise Problem('任务不存在。', 404)
    if t.state in ('completed', 'failed'): return task_data(t)
    state = args.get('state', 'running')
    if state not in ('running', 'completed', 'failed'): raise Problem('任务状态无效。')
    result = args.get('result', {})
    if state == 'completed':
        # Completion must point to this seat's successful, persisted mutation receipt.
        ids = result.get('actionIds', [])
        if not verified_receipts(t,ids):
            state = 'failed'; args = dict(args, error='没有本次成功发布或审核的回执；未标记完成。')
    t.state = state; t.progress = text(args.get('progress', ''), 600); t.result = result
    t.error = text(args.get('error', ''), 2000); t.save()
    return task_data(t)


def apply_public(result):
    """Overlay only presentation fields; upstream collection and hashes remain original."""
    overrides = {r.key.removeprefix('github/'): r.data for r in EditorialOverride.objects.filter(key__startswith='github/')}
    def walk(value):
        if isinstance(value, list): return [walk(v) for v in value]
        if not isinstance(value, dict): return value
        out = {k: walk(v) for k, v in value.items()}
        repo = value.get('repository') or value.get('fullName') or value.get('full_name')
        if not repo and isinstance(value.get('url'), str) and value['url'].startswith('https://github.com/'):
            repo = value['url'].removeprefix('https://github.com/').strip('/')
        if repo in overrides:
            patch = copy.deepcopy(overrides[repo]); out.update(patch)
            if 'idea' in value and ('description' in patch or 'summary' in patch): out['idea'] = patch.get('summary',patch.get('description')); out['ideaLanguage'] = 'zh'
            if patch.get('media',{}).get('src'): out['cover'] = patch['media']['src']; out['coverCredit'] = patch['media'].get('credit','')
        return out
    return walk(result)


def get(request, route):
    if route == 'management/overlays': return overlays()
    authorize(request.user)
    if route == 'management': return search(request.user, request.GET.get('q', ''), request.GET.get('state', ''), request.GET.get('kind', ''))
    if route == 'management/read': return read(request.user, request.GET.get('key', ''))
    if route == 'management/history': return history(request.user, request.GET.get('key', ''))
    if route == 'management/tasks': return {'items': [task_data(t) for t in ContentTask.objects.filter(owner=request.user).order_by('-created')[:50]]}
    raise Problem('管理入口不存在。', 404)


def post(request, route, body):
    if route == 'management/publish': return publish(request.user, body)
    if route == 'management/review': return review(request.user, body)
    raise Problem('管理入口不存在。', 404)
