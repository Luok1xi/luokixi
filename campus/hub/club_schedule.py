"""Shared club schedules. Personal courses and imported reservations never become club data."""
import hashlib
import json
import re
import secrets
import uuid
from datetime import date as Date, timedelta
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .core import Problem, require, text, throttle
from .models import Audit, Club, ClubEvent, ClubMembership, ClubMutationReceipt, DeviceSync, SeatPlan

TIMEZONE = 'Asia/Shanghai'


def identifier(value):
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        raise Problem('社团或活动标识无效。')


def label(value, limit=120):
    result = text(value, limit, True)
    if any(ord(char) < 32 for char in result):
        raise Problem('名称不能包含换行或控制字符。')
    return result


def minutes(value, end=False):
    if end and value == '24:00':
        return 1440
    if not isinstance(value, str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', value):
        raise Problem('时间应为 HH:MM。')
    hour, minute = map(int, value.split(':'))
    return hour * 60 + minute


def calendar_date(value):
    try:
        day = Date.fromisoformat(value)
    except (ValueError, TypeError):
        raise Problem('请选择有效日期。')
    if day.isoformat() != value or not 2000 <= day.year <= 2100:
        raise Problem('请选择有效日期。')
    return day


def visible_clubs(user):
    return Club.objects.filter(Q(owner=user) | Q(memberships__user=user)).distinct().order_by('created', 'id')


def club_data(club, user):
    owner = club.owner_id == user.pk
    return {'id': str(club.pk), 'name': club.name, 'role': 'owner' if owner else 'member',
            'canManage': owner, 'revision': club.revision,
            'memberCount': club.memberships.count(), 'affiliationVerified': False}


def event_data(event, user):
    return {'id': str(event.pk), 'clubId': str(event.club_id), 'clubName': event.club.name,
            'title': event.title, 'location': event.location, 'status': event.status,
            'pending': event.status == 'pending', 'date': event.date.isoformat() if event.date else None,
            'start': event.start or None, 'end': event.end or None, 'duration': event.duration,
            'canManage': event.club.owner_id == user.pk, 'revision': event.club.revision}


def event_list(clubs, user):
    return [event_data(event, user) for event in ClubEvent.objects.filter(
        club__in=clubs).exclude(status='cancelled').select_related('club').order_by('date', 'start', 'created', 'id')]


def imported_reservations(user):
    """Only normalized, already imported owner data. A reminder plan is not a reservation."""
    row = DeviceSync.objects.filter(user=user, kind='seat').first()
    result = {'items': [], 'providerConnected': False, 'providerConfirmed': False,
              'status': 'not-connected', 'source': row.source if row else '',
              'syncedAt': row.synced_at.isoformat() if row else None, 'unmappedCount': 0}
    for plan in SeatPlan.objects.filter(owner=user, state__in=['reported_reserved', 'checked_in']).order_by('starts'):
        starts, ends = plan.starts.astimezone(ZoneInfo(TIMEZONE)), plan.ends.astimezone(ZoneInfo(TIMEZONE))
        if starts.date() != ends.date():
            result['unmappedCount'] += 1
            continue
        result['items'].append({'id': f'booking:{plan.pk}', 'title': '图书馆预约',
            'date': starts.date().isoformat(), 'start': starts.strftime('%H:%M'), 'end': ends.strftime('%H:%M'),
            'location': plan.preference, 'fixed': True, 'canManage': False, 'state': plan.state,
            'source': 'owner-report', 'sourceURL': 'reservations.html', 'providerConfirmed': False,
            'status': plan.state, 'statusLabel': '本人已预约 · 未向学校核验'})
    if result['items']:
        result['status'] = 'owner-reported'
    if not row:
        return result
    result['status'] = 'imported'
    raw = row.data if isinstance(row.data, list) else row.data.get('items', [])
    if not isinstance(raw, list):
        raw = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            result['unmappedCount'] += 1
            continue
        # Do not label requested, cancelled, or unknown records as held reservations.
        status = str(item.get('status', item.get('state', '')))
        if status in ('cancelled', 'canceled', 'expired', '已取消', '已过期'):
            continue
        if status not in ('reserved', 'confirmed', 'checked_in', 'reported_reserved', '已预约', '已签到'):
            result['unmappedCount'] += 1
            continue
        try:
            day, start, end = item.get('date'), item.get('start'), item.get('end')
            if not day and item.get('starts') and item.get('ends'):
                starts, ends = parse_datetime(item['starts']), parse_datetime(item['ends'])
                if not starts or not ends or timezone.is_naive(starts) or timezone.is_naive(ends):
                    raise ValueError('missing timezone')
                starts, ends = starts.astimezone(ZoneInfo(TIMEZONE)), ends.astimezone(ZoneInfo(TIMEZONE))
                if starts.date() != ends.date():
                    raise ValueError('overnight reservation')
                day, start, end = starts.date().isoformat(), starts.strftime('%H:%M'), ends.strftime('%H:%M')
            calendar_date(day)
            if not 0 < minutes(end, True) - minutes(start) <= 960:
                raise ValueError('duration')
            location = ' · '.join(str(item.get(key, ''))[:80] for key in ('area', 'seat') if item.get(key))
            result['items'].append({'id': f'imported-seat:{index}', 'title': '图书馆预约',
                'date': day, 'start': start, 'end': end, 'location': location[:160], 'fixed': True,
                'canManage': False, 'source': 'device-sync', 'providerConfirmed': False,
                'status': status, 'statusLabel': '已导入 · 未实时核验'})
        except (Problem, ValueError, TypeError, AttributeError):
            result['unmappedCount'] += 1
    return result


def get(request, route):
    require(request.user)
    parts = route.split('/')
    if len(parts) == 4 and parts[:2] == ['club-schedule', 'clubs'] and parts[3] == 'members':
        club = owned_club(request.user, parts[2], lock=False)
        return {'members': [{'id': member.user_id, 'name': member.user.display_name or member.user.username,
                             'role': 'owner' if member.user_id == club.owner_id else 'member'}
                            for member in club.memberships.select_related('user').order_by('joined')]}
    if route != 'club-schedule':
        raise Problem('社团排期接口不存在。', 404)
    clubs = list(visible_clubs(request.user))
    return {'clubs': [club_data(club, request.user) for club in clubs],
            'events': event_list(clubs, request.user),
            'reservations': imported_reservations(request.user), 'timezone': TIMEZONE}


def owned_club(user, key, lock=True):
    query = Club.objects.select_for_update() if lock else Club.objects
    club = query.filter(pk=identifier(key)).first()
    if not club or not ClubMembership.objects.filter(club=club, user=user).exists():
        raise Problem('社团不存在或你尚未加入。', 404)
    if club.owner_id != user.pk:
        raise Problem('只有该社团的创建者可以安排活动。', 403)
    return club


def check_revision(club, expected):
    if type(expected) is not int or expected != club.revision:
        raise Problem('社团日程已更新，请刷新后重新安排。', 409)


def validate_event(row, change):
    allowed = {'id', 'clubId', 'title', 'location', 'status', 'date', 'start', 'end', 'duration'}
    if set(change) - allowed:
        raise Problem('活动包含不支持的字段。')
    row.title = label(change.get('title', row.title))
    row.location = text(change.get('location', row.location), 160)
    row.status = change.get('status', row.status)
    if row.status not in ('pending', 'scheduled', 'cancelled'):
        raise Problem('活动状态无效。')
    if row.status == 'scheduled':
        row.date = calendar_date(change.get('date', row.date.isoformat() if row.date else None))
        row.start, row.end = change.get('start', row.start), change.get('end', row.end)
        row.duration = minutes(row.end, True) - minutes(row.start)
        if not 15 <= row.duration <= 960:
            raise Problem('活动时长应为 15 分钟到 16 小时，且在同一天内。')
    elif row.status == 'pending':
        duration = change.get('duration', row.duration)
        if type(duration) is not int or not 15 <= duration <= 960:
            raise Problem('活动时长应为 15 分钟到 16 小时。')
        row.duration, row.date, row.start, row.end = duration, None, '', ''
    return row


def batch(user, body):
    changes, revisions = body.get('changes'), body.get('revisions')
    if not isinstance(changes, list) or not 1 <= len(changes) <= 100 or not all(isinstance(x, dict) for x in changes):
        raise Problem('请提交 1 到 100 项活动变更。')
    if not isinstance(revisions, dict):
        raise Problem('请带上当前社团日程版本。')
    club_ids = {str(identifier(change.get('clubId'))) for change in changes}
    if set(revisions) != club_ids:
        raise Problem('日程版本与修改的社团不一致。')
    clubs = {}
    for key in sorted(club_ids):
        club = owned_club(user, key)
        check_revision(club, revisions[key])
        # Conditional update makes stale writes fail on SQLite as well as row-locking databases.
        updated = Club.objects.filter(pk=club.pk, revision=club.revision).update(
            revision=F('revision') + 1, updated=timezone.now())
        if not updated:
            raise Problem('社团日程已更新，请刷新后重新安排。', 409)
        club.revision += 1
        clubs[key] = club
    touched = set()
    for change in changes:
        club = clubs[str(identifier(change['clubId']))]
        event_id = identifier(change['id']) if change.get('id') else uuid.uuid4()
        if event_id in touched:
            raise Problem('同一活动不能在一次保存中修改两次。')
        touched.add(event_id)
        row = ClubEvent.objects.filter(pk=event_id).first()
        if row and row.club_id != club.pk:
            raise Problem('不能修改其他社团的活动。', 403)
        if row and row.status == 'cancelled':
            raise Problem('该活动已经取消，请刷新日程。', 409)
        if not row:
            if change.get('status') == 'cancelled':
                raise Problem('活动不存在。', 404)
            row = ClubEvent(id=event_id, club=club)
        validate_event(row, change).save()
    for club in clubs.values():
        if club.events.exclude(status='cancelled').count() > 1000:
            raise Problem('一个社团最多保留 1000 项进行中的活动。')
        previous = None
        for event in club.events.filter(status='scheduled').order_by('date', 'start', 'id'):
            if previous and previous.date == event.date and minutes(previous.end, True) > minutes(event.start):
                raise Problem(f'“{previous.title}”与“{event.title}”时间冲突，请一起调整。', 409)
            previous = event
        Audit.objects.create(actor=user, action='club-schedule', target=str(club.pk),
                             detail={'revision': club.revision, 'changed': sum(1 for x in changes if str(identifier(x['clubId'])) == str(club.pk))})
    return {'clubs': [club_data(club, user) for club in clubs.values()],
            'events': event_list(clubs.values(), user)}


def mutate(request, route, body):
    user = request.user
    require(user)
    if route == 'club-schedule/clubs':
        throttle('club-create', str(user.pk), 10)
        if Club.objects.filter(owner=user).count() >= 20:
            raise Problem('最多创建 20 个社团。')
        club = Club.objects.create(owner=user, name=label(body.get('name'), 80))
        ClubMembership.objects.create(club=club, user=user)
        Audit.objects.create(actor=user, action='club-create', target=str(club.pk))
        return {'club': club_data(club, user), 'events': []}
    if route == 'club-schedule/batch':
        throttle('club-schedule', str(user.pk), 300)
        return batch(user, body)
    if route == 'club-schedule/join':
        throttle('club-join', str(user.pk), 60)
        code = text(body.get('code'), 100, True)
        digest = hashlib.sha256(code.encode()).hexdigest()
        club = Club.objects.select_for_update().filter(invite_hash=digest, invite_expires__gt=timezone.now()).first()
        if not club:
            raise Problem('邀请码无效或已过期，请向社团创建者获取新码。', 404)
        if not ClubMembership.objects.filter(club=club, user=user).exists():
            if club.memberships.count() >= 1000:
                raise Problem('该社团成员已达上限。')
            ClubMembership.objects.create(club=club, user=user)
            Audit.objects.create(actor=user, action='club-join', target=str(club.pk))
        return {'club': club_data(club, user), 'events': event_list([club], user)}
    parts = route.split('/')
    if len(parts) == 4 and parts[:2] == ['club-schedule', 'clubs'] and parts[3] == 'leave':
        club = Club.objects.select_for_update().filter(pk=identifier(parts[2])).first()
        if not club:
            raise Problem('社团不存在。', 404)
        if club.owner_id == user.pk:
            raise Problem('创建者需要保留社团管理权限，不能直接退出。', 409)
        removed, _ = ClubMembership.objects.filter(club=club, user=user).delete()
        if removed:
            Audit.objects.create(actor=user, action='club-leave', target=str(club.pk))
        return {'left': True}
    if len(parts) == 5 and parts[:2] == ['club-schedule', 'clubs'] and parts[3:] == ['members', 'remove']:
        club = owned_club(user, parts[2])
        check_revision(club, body.get('revision'))
        member_id = body.get('memberId')
        if type(member_id) is not int:
            raise Problem('成员标识无效。')
        if member_id == club.owner_id:
            raise Problem('不能移除社团创建者。', 409)
        removed, _ = ClubMembership.objects.filter(club=club, user_id=member_id).delete()
        if removed:
            Audit.objects.create(actor=user, action='club-member-remove', target=str(club.pk), detail={'memberId': member_id})
        # Invalidate the old shared invite too; removed members cannot reuse it.
        club.invite_hash, club.invite_expires = '', None
        club.save(update_fields=['invite_hash', 'invite_expires', 'updated'])
        return {'removed': bool(removed), 'club': club_data(club, user)}
    if len(parts) == 5 and parts[:2] == ['club-schedule', 'clubs'] and parts[3:] == ['invite', 'revoke']:
        club = owned_club(user, parts[2])
        check_revision(club, body.get('revision'))
        club.invite_hash, club.invite_expires = '', None
        club.save(update_fields=['invite_hash', 'invite_expires', 'updated'])
        Audit.objects.create(actor=user, action='club-invite-revoke', target=str(club.pk))
        return {'revoked': True}
    if len(parts) == 4 and parts[:2] == ['club-schedule', 'clubs'] and parts[3] == 'invite':
        club = owned_club(user, parts[2])
        check_revision(club, body.get('revision'))
        throttle('club-invite', str(user.pk), 60)
        code = secrets.token_urlsafe(24)
        club.invite_hash = hashlib.sha256(code.encode()).hexdigest()
        club.invite_expires = timezone.now() + timedelta(days=7)
        club.save(update_fields=['invite_hash', 'invite_expires', 'updated'])
        Audit.objects.create(actor=user, action='club-invite-rotate', target=str(club.pk))
        return {'code': code, 'expiresAt': club.invite_expires.isoformat()}
    raise Problem('社团排期接口不存在。', 404)


@transaction.atomic
def post(request, route, body):
    """Optional requestKey protects retryable creations/batches from duplicate effects."""
    require(request.user)
    key, digest = None, ''
    if 'requestKey' in body:
        key = identifier(body['requestKey'])
        # Invitation secrets never enter a replay store. Rotating a code always returns a fresh value.
        if route not in ('club-schedule/clubs', 'club-schedule/batch'):
            raise Problem('此操作不支持 requestKey。')
        digest = hashlib.sha256(json.dumps([route, body], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        previous = ClubMutationReceipt.objects.filter(user=request.user, request_key=key).first()
        if previous:
            if previous.digest != digest:
                raise Problem('同一请求标识不能用于不同的修改。', 409)
            return previous.response
    result = mutate(request, route, body)
    if key:
        ClubMutationReceipt.objects.create(user=request.user, request_key=key, digest=digest, response=result)
    return result
