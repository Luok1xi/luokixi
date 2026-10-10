"""Shared validation, permissions and auditable community transitions."""
import hashlib
import hmac
import json
import re
from pathlib import Path
from datetime import timedelta
from urllib.parse import urlsplit, urlunsplit
from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from .models import (Audit, Contribution, Entry, EntryView, Member, Notification, RateBucket,
                     Reply, Revision, Upload, Watch)

KINDS = {'project', 'resource', 'paper', 'reproduction', 'topic', 'contest', 'news', 'announcement', 'collection', 'place'}
EVENTS = {'release', 'discussion', 'revision'}


def categories():
    path = Path(__file__).resolve().parents[2] / 'content' / 'categories.json'
    return json.loads(path.read_text(encoding='utf-8'))['categories']


class Problem(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status
        super().__init__(message)


def can_participate(user):
    """Server-granted developers may test without a real mailbox; never fake verification."""
    return bool(user.is_authenticated and user.is_active and (user.email_verified or user.is_superuser or
        (user.is_staff and not user.has_usable_password() and (
            (user.username == '北矿娘' and user.email == 'beikuang@agent.luokixi.invalid') or
            (user.username == 'Codex' and user.email == 'codex@system.invalid')))))


def require(user, staff=False, verified=False):
    if not user.is_authenticated:
        raise Problem('请先登录。', 401)
    if not user.is_active or (staff and not user.is_staff):
        raise Problem('没有此操作的权限。', 403)
    if verified and not can_participate(user):
        raise Problem('请先验证邮箱再参与共建。', 403)


def text(value, limit=160, required=False):
    if not isinstance(value, str):
        raise Problem('文本字段格式不正确。')
    value = value.strip()
    if (required and not value) or len(value) > limit or '\x00' in value:
        raise Problem(f'请填写有效内容，长度不超过 {limit} 字。')
    return value


def url(value, required=False):
    value = text(value, 1000, required)
    if not value:
        return ''
    p = urlsplit(value)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password or any(c.isspace() for c in value):
        raise Problem('请填写完整的 HTTP 或 HTTPS 链接。')
    return urlunsplit((p.scheme, p.netloc.lower(), p.path, p.query, p.fragment))


def string_list(value, max_items=12, max_length=80):
    if not isinstance(value, list) or len(value) > max_items:
        raise Problem('列表过长或格式不正确。')
    return list(dict.fromkeys(text(v, max_length, True) for v in value))


@transaction.atomic
def throttle(scope, identity, limit=20, seconds=3600):
    key = hashlib.sha256(f'{scope}:{identity}'.encode()).hexdigest()
    now = timezone.now()
    bucket, _ = RateBucket.objects.get_or_create(key=key, defaults={'reset': now + timedelta(seconds=seconds)})
    if bucket.reset <= now:
        bucket.count, bucket.reset = 0, now + timedelta(seconds=seconds)
    if bucket.count >= limit:
        raise Problem('操作较频繁，请稍后再试。', 429)
    bucket.count += 1
    bucket.save()


def public_entries():
    return Entry.objects.filter(public_revision__gt=0).exclude(state='withdrawn')


def entry_for(user, identifier, edit=False):
    try:
        entry = Entry.objects.get(id=identifier)
    except (Entry.DoesNotExist, ValueError, TypeError):
        raise Problem('内容不存在。', 404)
    owner = user.is_authenticated and (entry.owner_id == user.pk or user.is_staff)
    if edit and not owner:
        raise Problem('只有作者或维护者可以修改。', 403)
    if not owner and (entry.public_revision == 0 or entry.state == 'withdrawn'):
        raise Problem('内容不存在。', 404)
    return entry


def member_data(member, private=False):
    data = {'id': member.pk, 'username': member.username, 'name': member.display_name or member.username,
            'bio': member.bio, 'major': member.major, 'externalLinks': member.external_links,
            'campusVerified': member.campus_verified, 'githubVerified': bool(member.github_id)}
    # Owner-assigned to an exact account; never inferred from a display name.
    avatar = (member.preferences or {}).get('companionAvatar')
    if avatar in ('/art/beikuang/avatar.png', '/art/companions/beikuang-chibi.png', '/art/companions/codex-avatar-v1.png'):
        data['avatar'] = avatar
    if private:
        data.update(email=member.email, emailVerified=member.email_verified, moderator=member.is_staff,
                    developer=bool(member.is_active and member.is_superuser), canParticipate=can_participate(member),
                    digestEnabled=member.digest_enabled, preferences=member.preferences)
    return data


def record_view(request, entry):
    """记一次浏览并返回总浏览量。只统计已公开的内容；按账号或浏览器会话、按天去重。"""
    if not entry.public_revision or entry.state == 'withdrawn':
        return entry.entryview_set.count()
    user = request.user
    if user.is_authenticated:
        who = f'user:{user.pk}'
    else:
        if not request.session.session_key:
            request.session.save()
        who = f'session:{request.session.session_key}'
    throttle('view', who, 600)
    viewer = hmac.new(settings.SECRET_KEY.encode(), who.encode(), hashlib.sha256).hexdigest()
    EntryView.objects.get_or_create(entry=entry, viewer=viewer, day=timezone.localdate())
    return entry.entryview_set.count()


def entry_data(entry, user, own=False):
    editorial = user.is_authenticated and (entry.owner_id == user.pk or user.is_staff)
    data = {'id': str(entry.pk), 'slug': entry.slug, 'kind': entry.kind,
            'data': entry.published, 'revision': entry.public_revision,
            'owner': member_data(entry.owner) if entry.owner_id else None,
            'updated': entry.updated.isoformat(), 'created': entry.created.isoformat(),
            'canonical': str(entry.canonical_id) if entry.canonical_id else None,
            'siteStars': entry.star_set.count(), 'starred': False, 'watch': [],
            'views': entry.entryview_set.count(), 'replyCount': entry.reply_set.filter(state='published').count()}
    if user.is_authenticated:
        star = entry.star_set.filter(user=user).first()
        watch = entry.watch_set.filter(user=user).first()
        data.update(starred=bool(star), collection=star.collection if star else '', watch=watch.events if watch else [])
    if editorial and own:
        data.update(draft=entry.draft, editRevision=entry.revision, state=entry.state, reviewNote=entry.review_note)
    return data


def validate_payload(kind, data, user, submit=False):
    if kind not in KINDS or not isinstance(data, dict):
        raise Problem('不支持此内容类型。')
    result = {}
    limits = {'title':160, 'summary':1000, 'body':80000, 'course':80, 'year':30, 'difficulty':40,
              'license':120, 'credit':300, 'sourceNote':600, 'setup':12000, 'needs':5000,
              'hardware':12000, 'environment':12000, 'codeVersion':200, 'dataVersion':200,
              'steps':20000, 'results':20000, 'failures':12000, 'audience':300,
              'deadline':40, 'ruleVersion':100, 'category':80, 'doi':200}
    for key, limit in limits.items():
        result[key] = text(data.get(key, ''), limit, required=key=='title')
    if 'bodyFormat' in data:
        if data['bodyFormat'] not in ('plain', 'markdown'):
            raise Problem('正文格式只能为纯文本或 Markdown。')
        result['bodyFormat'] = data['bodyFormat']
    if result['category'] and result['category'] not in categories():
        raise Problem('请选择网站现有分类。')
    result['tags'] = string_list(data.get('tags', []))
    result['courses'] = string_list(data.get('courses', []))
    if 'learning' in data:
        from .learning import validate_learning
        result['learning'] = validate_learning(data['learning'])
    result['links'] = {}
    links = data.get('links', {})
    if not isinstance(links, dict) or len(links) > 12:
        raise Problem('链接格式不正确。')
    for key, value in links.items():
        if key in ('repo','demo','video','source','paper','dataset','hardware','registration','release','site'):
            result['links'][key] = url(value)
    result['uploads'] = string_list(data.get('uploads', []), 10, 36)
    for uid in result['uploads']:
        try:
            found = Upload.objects.filter(id=uid).exists() if user.is_staff else Upload.objects.filter(id=uid, owner=user).exists()
        except (ValueError, TypeError):
            found = False
        if not found:
            raise Problem('附件不存在或不属于当前账号。', 403)
    result['related'] = string_list(data.get('related', []), 20, 36)
    for rid in result['related']:
        entry_for(user, rid)
    result['rightsConfirmed'] = data.get('rightsConfirmed') is True
    result['aiDisclosure'] = text(data.get('aiDisclosure', ''), 1000)
    if 'media' in data:
        from .content_management import validate_media
        result['media'] = validate_media(data['media'], user)
    if kind == 'place':
        from .places import validate_place
        result.update(validate_place(data,user,submit))
    if 'circle' in data:
        if kind != 'topic':
            raise Problem('校圈内容需使用话题类型。')
        from .circle import validate
        result['circle'] = validate(data, user, submit)
        result['summary'] = result['summary'] or result['body'][:300] or result['title']
        result['license'] = result['license'] or '原作者保留权利；站外内容仅链接'
    if result['deadline']:
        from django.utils.dateparse import parse_datetime, parse_date
        if not (parse_datetime(result['deadline']) or parse_date(result['deadline'])):
            raise Problem('截止时间必须包含完整日期。')
    if submit:
        if not result['rightsConfirmed']:
            raise Problem('请确认有权分享并填写来源。')
        if not result['summary'] or not result['license']:
            raise Problem('提交前请填写简介和许可（未知可写“许可待核，仅链接”）。')
        if kind in {'resource','paper','contest','news'} and not (result['uploads'] or result['links'].get('source') or result['links'].get('paper')):
            raise Problem('请添加原始来源链接或附件。')
        if kind == 'project' and not (result['links'].get('repo') or result['links'].get('demo')):
            raise Problem('项目需要源码或功能展示链接。')
        if kind == 'reproduction' and not all(result[k] for k in ('environment','steps','results')):
            raise Problem('复现报告需要环境、步骤和结果。')
        if kind == 'reproduction' and not (result['related'] or result['links'].get('paper')):
            raise Problem('请关联原论文或原项目。')
    return result


def canonical_key(kind, data):
    base = _canonical_key(kind, data)
    meta = data.get('learning')
    if base and isinstance(meta, dict):
        scope = {key: meta.get(key, '') for key in ('school', 'courseId', 'offeringId', 'term', 'version', 'publicationStatus')}
        return 'learning:' + hashlib.sha256((base + json.dumps(scope, sort_keys=True)).encode()).hexdigest()
    return base


def _canonical_key(kind, data):
    if kind == 'topic' and data.get('circle', {}).get('external', {}).get('url'):
        return 'circle-link:' + hashlib.sha256(data['circle']['external']['url'].encode()).hexdigest()
    if kind == 'place' and data.get('location'):
        loc = data['location']
        identity = f"{data['campus']}:{round(loc['lat'],5)}:{round(loc['lng'],5)}:{data['title'].strip().lower()}"
        return 'place:'+hashlib.sha256(identity.encode()).hexdigest()
    if data.get('doi'):
        return 'doi:' + data['doi'].lower().removeprefix('https://doi.org/').strip()
    if data.get('uploads'):
        return 'file:' + Upload.objects.get(pk=data['uploads'][0]).asset_id
    if kind == 'reproduction':
        return ''
    links = data.get('links', {})
    value = links.get('repo') if kind == 'project' else links.get('source') or links.get('paper')
    if value:
        p = urlsplit(value)
        path = p.path.rstrip('/').removesuffix('.git') if kind == 'project' else p.path or '/'
        return kind + ':' + urlunsplit((p.scheme, p.netloc.lower(), path, p.query, ''))[:470]
    return ''


def notify(user, entry, event, key, message, subscription=False):
    Notification.objects.get_or_create(user=user, key=key, defaults={
        'entry':entry, 'event':event, 'text':message[:300], 'subscription':subscription})


def broadcast(entry, event, key, message, actor=None):
    for watch in Watch.objects.filter(entry=entry).select_related('user'):
        if event in watch.events and watch.user_id != getattr(actor, 'pk', None):
            notify(watch.user, entry, event, key, message, True)


def contribute(user, entry, category, key, summary, evidence):
    record, _ = Contribution.objects.get_or_create(key=key, defaults={
        'user':user, 'entry':entry, 'category':category, 'summary':summary[:200], 'evidence':evidence})
    if not record.active:
        record.active, record.reason = True, ''
        record.save(update_fields=['active','reason'])


@transaction.atomic
def save_entry(user, body, entry=None):
    require(user, verified=True)
    kind = body.get('kind', entry.kind if entry else '')
    if kind == 'announcement' and not user.is_staff:
        raise Problem('本站公告由维护者发布。', 403)
    if entry and (body.get('revision') != entry.revision or kind != entry.kind):
        raise Problem('内容已更新，请刷新后再修改。', 409)
    payload = validate_payload(kind, body.get('data'), user)
    if entry:
        entry = Entry.objects.select_for_update().get(pk=entry.pk)
        if body.get('revision') != entry.revision:
            raise Problem('内容已更新，请刷新。', 409)
        if entry.state == 'withdrawn':
            raise Problem('已撤回内容不能直接编辑。')
        entry.draft, entry.revision, entry.state = payload, entry.revision+1, 'draft'
        entry.review_note = ''
        entry.save()
    else:
        import uuid
        entry = Entry.objects.create(owner=user, kind=kind, slug=uuid.uuid4().hex, draft=payload)
    Revision.objects.create(entry=entry, number=entry.revision, data=payload)
    Audit.objects.create(actor=user, action='save', target=str(entry.pk), detail={'revision':entry.revision})
    return entry


@transaction.atomic
def submit_entry(user, entry, expected):
    require(user, verified=True)
    entry = Entry.objects.select_for_update().get(pk=entry.pk)
    if entry.revision != expected:
        raise Problem('内容已更新，请刷新后再提交。', 409)
    if entry.state not in ('draft','rejected'):
        raise Problem('当前版本已提交或已撤回。', 409)
    validate_payload(entry.kind, entry.draft, user, submit=True)
    entry.state = 'pending'
    entry.save(update_fields=['state','updated'])
    Revision.objects.filter(entry=entry, number=entry.revision).update(state='pending')
    return entry


@transaction.atomic
def review_entry(user, entry, body):
    require(user, staff=True)
    entry = Entry.objects.select_for_update().get(pk=entry.pk)
    if body.get('revision') != entry.revision or entry.state != 'pending':
        raise Problem('审核版本已变化。', 409)
    decision = body.get('decision')
    note = text(body.get('note', ''), 3000, True)
    if decision not in ('approve','reject'):
        raise Problem('审核决定无效。')
    if decision == 'approve':
        if entry.kind == 'announcement' and entry.slug.startswith('beikuang-') and entry.draft.get('supervisorQuestions') and body.get('supervisorQuestionsResolved') is not True:
            raise Problem('请先回答北矿娘列出的疑问，再确认公告。')
        if entry.draft.get('circle') and entry.owner_id == user.pk:
            from .content_management import manager
            if not manager(user): raise Problem('自己的校圈投稿需要其他维护者审核。', 403)
        if entry.owner_id:
            validate_payload(entry.kind, entry.draft, user, submit=True)
        if entry.kind == 'place' and body.get('locationChecked') is not True:
            raise Problem('发布地点前，维护者需要确认坐标、校区、公共区域和照片来源。')
        entry.canonical_key = canonical_key(entry.kind, entry.draft)
        duplicate = public_entries().filter(canonical_key=entry.canonical_key).exclude(pk=entry.pk).first() if entry.canonical_key else None
        entry.canonical = duplicate
        previous_circle = entry.published.get('circle', {})
        entry.published = dict(entry.draft)
        if entry.published.get('circle'):
            entry.published['circle'] = dict(entry.published['circle'])
            entry.published['circle']['publishedAt'] = previous_circle.get('publishedAt') or timezone.now().isoformat()
        if entry.kind == 'place':
            entry.published['locationReviewedAt'] = timezone.now().isoformat()
            entry.published['locationReviewer'] = user.username
        first_publication = entry.public_revision == 0
        entry.public_revision = entry.revision
        entry.state = 'published'
        asset_texts = [u.asset.text for u in Upload.objects.filter(id__in=entry.published.get('uploads',[])).select_related('asset')]
        entry.search_text = json.dumps(entry.published, ensure_ascii=False) + '\n' + '\n'.join(asset_texts)
        if entry.owner_id and not duplicate and not entry.published.get('circle'):
            contribute(entry.owner, entry, entry.kind, 'entry:'+str(entry.pk), entry.published['title'], '/hub/#entry/'+str(entry.pk))
        broadcast(entry, 'revision', f'entry:{entry.pk}:{entry.revision}', f'《{entry.published["title"]}》发布了新版本', user)
    else:
        entry.state = 'rejected'
    entry.review_note = note
    entry.save()
    if decision == 'approve':
        from .learning_follow import on_entry_publish
        on_entry_publish(entry)
    if decision == 'approve' and entry.published.get('circle'):
        from .circle import on_publish
        on_publish(entry, first_publication)
    Revision.objects.filter(entry=entry, number=entry.revision).update(state=entry.state, reviewer=user, note=note)
    Audit.objects.create(actor=user, action='review:'+decision, target=str(entry.pk), detail={'revision':entry.revision,'note':note})
    if entry.owner_id:
        notify(entry.owner, entry, 'review', f'review:{entry.pk}:{entry.revision}', '投稿审核通过。' if decision=='approve' else '投稿需要修改：'+note)
    return entry


@transaction.atomic
def withdraw_entry(user, entry, reason):
    entry = Entry.objects.select_for_update().get(pk=entry.pk)
    entry.state = 'withdrawn'
    entry.save(update_fields=['state','updated'])
    Contribution.objects.filter(entry=entry).update(active=False, reason=reason)
    Audit.objects.create(actor=user, action='withdraw', target=str(entry.pk), detail={'reason':reason})
    broadcast(entry, 'revision', f'withdraw:{entry.pk}', '关注的内容已撤回：'+reason, user)


@transaction.atomic
def publish_reply(reviewer, reply):
    if reply.state == 'published':
        return
    entry_for(reviewer, reply.entry_id)
    reply.state = 'published'
    reply.save(update_fields=['state'])
    Audit.objects.create(actor=reviewer, action='reply:approve', target=str(reply.pk))
    broadcast(reply.entry, 'discussion', 'reply:'+str(reply.pk), '关注的讨论有新回复。', reply.author)
    if reply.entry.owner_id and reply.entry.owner_id != reply.author_id:
        notify(reply.entry.owner, reply.entry, 'reply', 'reply:'+str(reply.pk), '你的内容收到新回复。')
    for handle in set(re.findall(r'(?<!\w)@([A-Za-z0-9_][A-Za-z0-9_.-]{1,29})', reply.body)):
        mentioned = Member.objects.filter(username__iexact=handle, is_active=True).first()
        if mentioned and mentioned.pk != reply.author_id:
            notify(mentioned, reply.entry, 'mention', 'mention:'+str(reply.pk), f'{reply.author.username} 在讨论中提到了你。')


@transaction.atomic
def accept_reply(user, entry, reply):
    if not entry.public_revision or entry.state=='withdrawn':
        raise Problem('只能采纳公开讨论中的回复。')
    if entry.owner_id != user.pk and not user.is_staff:
        raise Problem('只有提问者或维护者可以采纳。', 403)
    if reply.entry_id != entry.pk or reply.state != 'published' or reply.author_id == user.pk:
        raise Problem('只能采纳此讨论中其他人的公开回复。')
    for old in Reply.objects.filter(entry=entry, accepted=True).exclude(pk=reply.pk):
        old.accepted = False
        old.save(update_fields=['accepted'])
        Contribution.objects.filter(key='answer:'+str(old.pk)).update(active=False, reason='采纳答案已调整')
    reply.accepted = True
    reply.save(update_fields=['accepted'])
    contribute(reply.author, entry, 'answer', 'answer:'+str(reply.pk), '被采纳的答疑', '/hub/#entry/'+str(entry.pk))
    notify(reply.author, entry, 'accepted', 'accepted:'+str(reply.pk), '你的回复被采纳了。')
    Audit.objects.create(actor=user, action='answer:accept', target=str(reply.pk))
