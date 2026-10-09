"""Private, manually entered campus plans; no school account or provider requests."""
import json
import math
import re
import uuid
from datetime import date
from urllib.parse import quote, unquote

from django.db import transaction
from django.utils.dateparse import parse_datetime

from .core import Problem, require
from .models import Audit, Member, Workspace

KIND = 'campus-plan'
MAX_BYTES = 512 * 1024
MAX_VERSION = 2147483646
CREDENTIAL_KEY = re.compile(r'pass(?:word|wd)?$|^pwd$|secret|token|cookie|sessionid|credential|密码|口令', re.I)
CONTROLS = re.compile(r'[\x00-\x1f\x7f]')
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
TIME = re.compile(r'^(?:[01]\d|2[0-3]):[0-5]\d$')
COLOR = re.compile(r'^#[0-9a-fA-F]{6}$')
ISO_TIME = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$')


def singleton_id(owner_id):
    """The primary key also prevents duplicate first writes on every DB backend."""
    return uuid.uuid5(uuid.NAMESPACE_URL, f'luokixi:campus-plan:member:{owner_id}')


def scan(value, depth=0):
    """Reject credential-shaped keys before dropping unknown fields."""
    if depth > 12:
        raise Problem('计划数据层级太深。')
    if isinstance(value, dict):
        if len(value) > 10000:
            raise Problem('计划字段太多。')
        for key, child in value.items():
            if not isinstance(key, str) or len(key) > 320:
                raise Problem('计划字段名无效。')
            if CREDENTIAL_KEY.search(key):
                raise Problem('计划不能包含账号密码、令牌或 Cookie。')
            scan(child, depth + 1)
    elif isinstance(value, list):
        if len(value) > 10000:
            raise Problem('计划条目太多。')
        for child in value:
            scan(child, depth + 1)
    elif isinstance(value, float) and not math.isfinite(value):
        raise Problem('计划不能包含无效数值。')
    elif not (value is None or isinstance(value, (str, bool, int, float))):
        raise Problem('计划必须是 JSON 数据。')


def obj(value, label):
    if not isinstance(value, dict):
        raise Problem(f'{label}应为对象。')
    return value


def string(value, limit, label, required=False, multiline=False):
    if not isinstance(value, str) or len(value) > limit or '\x00' in value:
        raise Problem(f'{label}格式无效或超过 {limit} 字。')
    if required and not value.strip():
        raise Problem(f'{label}内容无效。')
    return value


def identifier(value, label):
    value = string(value, 40, label, True)
    if CONTROLS.search(value):
        raise Problem(f'{label}不能含控制字符。')
    return value


def integer(value, minimum, maximum, label):
    if type(value) is not int or not minimum <= value <= maximum:
        raise Problem(f'{label}应为 {minimum}–{maximum} 的整数。')
    return value


def boolean(value, label):
    if type(value) is not bool:
        raise Problem(f'{label}应为开关值。')
    return value


def choice(value, choices, label):
    if not isinstance(value, str) or value not in choices:
        raise Problem(f'{label}选项无效。')
    return value


def array(value, maximum, label):
    if not isinstance(value, list) or len(value) > maximum:
        raise Problem(f'{label}格式无效或超过 {maximum} 条。')
    return value


def calendar_date(value, label, optional=False):
    if optional and value == '':
        return ''
    if not isinstance(value, str) or not DATE.fullmatch(value):
        raise Problem(f'{label}应为有效的 YYYY-MM-DD 日期。')
    try:
        date.fromisoformat(value)
    except ValueError:
        raise Problem(f'{label}不是有效日期。')
    return value


def times(raw):
    start, end = raw.get('start'), raw.get('end')
    if not isinstance(start, str) or not TIME.fullmatch(start) or not isinstance(end, str) or not TIME.fullmatch(end) or end <= start:
        raise Problem('开始和结束应为有效 HH:mm 时间，结束必须晚于开始。')
    return {'start': start, 'end': end}


def color(value):
    if not isinstance(value, str) or (value != '' and not COLOR.fullmatch(value)):
        raise Problem('颜色应为空或 #RRGGBB。')
    return value


def unique(values, label):
    if len(values) != len(set(values)):
        raise Problem(f'{label}不能重复。')
    return values


def building(raw):
    if raw is None:
        return None
    raw = obj(raw, '教学楼')
    center = raw.get('center')
    if center is not None:
        if not isinstance(center, list) or len(center) != 2 or any(type(x) not in (int, float) or not math.isfinite(x) for x in center):
            raise Problem('教学楼坐标无效。')
        if not -180 <= center[0] <= 180 or not -90 <= center[1] <= 90:
            raise Problem('教学楼坐标超出范围。')
    return {'campus': string(raw.get('campus', ''), 20, '教学楼校区'),
            'osm': identifier(raw.get('osm', ''), '教学楼标识'),
            'name': string(raw.get('name', ''), 80, '教学楼名称'), 'center': center}


def course(raw, index, week_count):
    raw = obj(raw, '课程')
    slots = []
    for n, item in enumerate(array(raw.get('slots', []), 14, '课程时间段')):
        item = obj(item, '课程时间段')
        slots.append({'id': identifier(item.get('id', f'slot-{n}'), '时间段标识'),
                      'day': integer(item.get('day'), 1, 7, '星期'), **times(item)})
    unique([slot['id'] for slot in slots], '同一课程的时间段标识')
    result = {'id': identifier(raw.get('id', f'course-{index}'), '课程标识'),
              'name': string(raw.get('name', ''), 80, '课程名称', True),
              'courseId': string(raw.get('courseId', ''), 60, '课程编号'),
              'room': string(raw.get('room', ''), 60, '教室'), 'building': building(raw.get('building')),
              'slots': slots, 'weekMode': choice(raw.get('weekMode', 'all'), ('all', 'odd', 'even'), '单双周'),
              'teacher': string(raw.get('teacher', ''), 100, '教师'), 'color': color(raw.get('color', '')),
              'hidden': boolean(raw.get('hidden', False), '课程隐藏')}
    if 'cancelled' in raw:
        result['cancelled'] = boolean(raw['cancelled'], '课程取消')
    if 'weeks' in raw:
        weeks = [integer(w, 1, week_count, '课程周次') for w in array(raw['weeks'], 30, '课程周次')]
        if not weeks:
            raise Problem('指定课程周次不能为空。')
        result['weeks'] = sorted(unique(weeks, '课程周次'))
    return result


def event(raw, index):
    raw = obj(raw, '日程')
    event_date = calendar_date(raw.get('date'), '日程日期')
    repeat = choice(raw.get('repeat', 'none'), ('none', 'weekly'), '重复方式')
    until = calendar_date(raw.get('until', ''), '重复结束日期', optional=True)
    if until and until < event_date:
        raise Problem('重复结束日期不能早于日程日期。')
    if (repeat == 'weekly' and not until) or (until and (date.fromisoformat(until) - date.fromisoformat(event_date)).days > 730):
        raise Problem('每周重复应设置结束日期，范围不能超过 730 天。')
    result = {'id': identifier(raw.get('id', f'event-{index}'), '日程标识'),
              'title': string(raw.get('title', ''), 160, '日程名称', True),
              'kind': choice(raw.get('kind', 'personal'), ('personal', 'exam', 'activity'), '日程类型'),
              'date': event_date, **times(raw), 'location': string(raw.get('location', ''), 160, '日程地点'),
              'notes': string(raw.get('notes', ''), 4000, '日程备注', multiline=True),
              'repeat': repeat, 'until': until, 'color': color(raw.get('color', '')),
              'hidden': boolean(raw.get('hidden', False), '日程隐藏')}
    if 'cancelled' in raw:
        result['cancelled'] = boolean(raw['cancelled'], '日程取消')
    return result


def validate_plan(raw):
    raw = obj(raw, '计划')
    scan(raw)
    if type(raw.get('version')) is not int or raw['version'] != 1:
        raise Problem('计划备份版本不受支持。')
    profile = obj(raw.get('profile', {}), '个人校园资料')
    term = obj(raw.get('term', {}), '学期')
    starts = calendar_date(term.get('starts', ''), '学期开始', optional=True)
    if starts and date.fromisoformat(starts).weekday() != 0:
        raise Problem('学期开始应为第 1 周的周一。')
    week_count = integer(term.get('weeks', 20), 1, 30, '教学周数')
    courses = [course(v, i, week_count) for i, v in enumerate(array(raw.get('courses', []), 60, '课程'))]
    events = [event(v, i) for i, v in enumerate(array(raw.get('events', []), 500, '日程'))]
    unique([v['id'] for v in courses], '课程标识')
    unique([v['id'] for v in events], '日程标识')
    visited = obj(raw.get('visited', {}), '到访地点')
    if len(visited) > 100:
        raise Problem('到访校区超过 100 个。')
    cleaned_visited = {}
    for campus, items in visited.items():
        campus = string(campus, 20, '到访校区', True)
        cleaned_visited[campus] = [string(v, 200, '到访地点标识', True) for v in array(items, 500, '到访地点')]
    hidden = []
    for value in array(raw.get('hiddenOccurrences', []), 10000, '隐藏安排'):
        value = string(value, 1100, '隐藏安排标识', True)
        parts = value.split(':')
        if not ((len(parts) == 4 and parts[0] == 'course' and parts[1] and parts[2]) or (len(parts) == 3 and parts[0] == 'event' and parts[1])):
            raise Problem('隐藏安排标识无效。')
        for encoded in parts[1:-1]:
            try:
                decoded = unquote(encoded, encoding='utf-8', errors='strict')
            except UnicodeError:
                raise Problem('隐藏安排标识编码无效。')
            identifier(decoded, '隐藏安排来源标识')
            if quote(decoded, safe="-_.!~*'()") != encoded:
                raise Problem('隐藏安排标识编码不一致。')
        calendar_date(parts[-1], '隐藏安排日期')
        hidden.append(value)
    unique(hidden, '隐藏安排')
    settings = obj(raw.get('settings', {}), '计划设置')
    updated = raw.get('updated')
    if updated is not None:
        string(updated, 80, '修改时间', True)
        try:
            valid_updated = ISO_TIME.fullmatch(updated) and parse_datetime(updated) is not None
        except ValueError:
            valid_updated = False
        if not valid_updated:
            raise Problem('修改时间应为有效 ISO 时间。')
    return {'version': 1,
            'profile': {k: string(profile.get(k, ''), limit, '校园资料') for k, limit in (('faculty', 80), ('major', 80), ('year', 10), ('campus', 20))},
            'courses': courses, 'visited': cleaned_visited, 'updated': updated,
            'term': {'label': string(term.get('label', ''), 120, '学期名称'), 'starts': starts, 'weeks': week_count},
            'events': events, 'hiddenOccurrences': hidden,
            'settings': {'view': choice(settings.get('view', 'week'), ('week', 'day'), '计划视图'),
                         **{k: boolean(settings.get(k, default), '计划设置') for k, default in (('hideWeekend', False), ('showCourses', True), ('showEvents', True), ('compact', False))},
                         'reminderMinutes': integer(settings.get('reminderMinutes', 0), 0, 120, '提前提醒分钟数')}}


def serialize(row):
    return {'version': row.version if row else 0, 'data': (row.data or None) if row else None,
            'updated': row.updated.isoformat() if row else None}


def get(request, route):
    require(request.user)
    if route != 'planner':
        raise Problem('计划接口不存在。', 404)
    if request.GET:
        raise Problem('计划接口只读取当前账号，不接受其他账号参数。')
    row = Workspace.objects.filter(pk=singleton_id(request.user.pk), owner=request.user, kind=KIND).first()
    return serialize(row)


@transaction.atomic
def post(request, route, body):
    require(request.user)
    if route not in ('planner', 'planner/clear'):
        raise Problem('计划接口不存在。', 404)
    allowed = {'version', 'data'} if route == 'planner' else {'version'}
    if set(body) - allowed:
        raise Problem('计划接口包含不支持的字段。')
    scan(body)
    try:
        encoded = json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8')
    except (ValueError, TypeError, UnicodeError):
        raise Problem('计划应为有效 JSON。')
    if len(encoded) > MAX_BYTES or len(request.body) > MAX_BYTES:
        raise Problem('计划 JSON 不能超过 512 KB。')
    expected = integer(body.get('version'), 0, MAX_VERSION, '保存版本')
    data = validate_plan(body.get('data')) if route == 'planner' else {}
    # Lock the owner even before a workspace exists. PostgreSQL locks its row;
    # the configured SQLite backend starts writes with an IMMEDIATE transaction.
    owner = Member.objects.select_for_update().get(pk=request.user.pk)
    require(owner)
    key = singleton_id(owner.pk)
    row = Workspace.objects.select_for_update().filter(pk=key, owner=owner).first()
    if row and row.kind != KIND:
        raise Problem('计划记录已改变，请刷新后重试。', 409)
    actual = row.version if row else 0
    if expected != actual:
        raise Problem('计划已在另一台设备修改。请先读取最新版本，当前内容没有被覆盖。', 409)
    if actual >= MAX_VERSION:
        raise Problem('计划版本已达到上限。', 409)
    if row:
        row.data, row.version = data, actual + 1
        row.save(update_fields=['data', 'version', 'updated'])
    else:
        row = Workspace.objects.create(id=key, owner=owner, kind=KIND, title='校园计划', data=data, version=1)
    Audit.objects.create(actor=owner, action='planner:clear' if route.endswith('/clear') else 'planner:save', target=str(key))
    return serialize(row)
