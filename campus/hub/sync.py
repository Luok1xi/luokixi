"""手机 App → 本人 Luokixi 账号的数据同步（docs/MOBILE_SYNC.md）。

学校统一认证的密码只存在同学手机的系统钥匙串里，App 直接连学校系统取数据。
这里只接收 App 已经取到、同学选择同步的数据，存在本人账号下，只有本人能读、能删。
服务器不接收、不保存、不转发任何学校账号、密码、令牌或 Cookie，也不代为登录学校系统。
"""
import json
import re
from datetime import datetime
from django.utils import timezone
from .core import Problem, require, text, throttle
from .models import DeviceSync

KINDS = {
    'seat': '图书馆座位',
    'timetable': '课表',
    'exam': '考试安排',
    'library': '借阅',
    'card': '校园卡',
    'grades': '成绩',
}
# 成绩、校园卡属于更敏感的个人信息：电脑端默认折叠，点开才显示
SENSITIVE = {'grades', 'card'}
MAX_BYTES = 256 * 1024
# 同步数据里出现这类字段名就整条拒绝：防止 App 某个版本出错，把登录凭据当成数据传上来
CREDENTIAL_KEY = re.compile(r'pass(?:word|wd)?$|^pwd$|secret|token|cookie|sessionid|credential|密码|口令', re.I)


def scan(value, path='data', depth=0):
    if depth > 12:
        raise Problem('同步数据层级太深。')
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str) or len(key) > 80:
                raise Problem('同步数据的字段名不合法。')
            if CREDENTIAL_KEY.search(key):
                raise Problem(f'同步数据里不能包含登录凭据（{path}.{key}）。服务器不保存学校账号和密码。')
            scan(child, f'{path}.{key}', depth + 1)
    elif isinstance(value, list):
        if len(value) > 2000:
            raise Problem('同步数据条目太多。')
        for i, child in enumerate(value):
            scan(child, f'{path}[{i}]', depth + 1)
    elif isinstance(value, str):
        if len(value) > 4000:
            raise Problem('同步数据里有过长的文本。')
    elif not (value is None or isinstance(value, (bool, int, float))):
        raise Problem('同步数据只能是 JSON。')


def serialize(row):
    return {'kind': row.kind, 'label': KINDS.get(row.kind, row.kind), 'sensitive': row.kind in SENSITIVE,
            'data': row.data, 'source': row.source, 'bytes': row.bytes,
            'fetchedAt': row.fetched_at.isoformat() if row.fetched_at else None,
            'syncedAt': row.synced_at.isoformat()}


def get(request, route):
    user = request.user
    require(user)
    if route == 'sync':
        rows = DeviceSync.objects.filter(user=user).order_by('kind')
        return {'items': {r.kind: serialize(r) for r in rows}, 'kinds': KINDS,
                'notice': '这些数据由你的手机 App 同步上来，只有你自己能看到。网站不保存学校账号和密码，也不代为登录学校系统。'}
    raise Problem('同步接口不存在。', 404)


def post(request, route, body):
    user = request.user
    require(user)
    if route == 'sync/push':
        throttle('device-sync', str(user.pk), 240)
        kind = body.get('kind')
        if kind not in KINDS:
            raise Problem('不支持的同步类型。')
        data = body.get('data')
        if not isinstance(data, (dict, list)):
            raise Problem('同步数据应为 JSON 对象或数组。')
        scan(data)
        raw = json.dumps(data, ensure_ascii=False)
        if len(raw.encode()) > MAX_BYTES:
            raise Problem('同步数据超过 256 KB，请分批同步。')
        fetched = None
        if body.get('fetchedAt'):
            try:
                fetched = datetime.fromisoformat(str(body['fetchedAt']).replace('Z', '+00:00'))
            except ValueError:
                raise Problem('fetchedAt 应为 ISO 时间。')
            if timezone.is_naive(fetched):
                raise Problem('fetchedAt 需要带时区。')
        row, _ = DeviceSync.objects.update_or_create(user=user, kind=kind, defaults={
            'data': data, 'source': text(body.get('source', ''), 80), 'fetched_at': fetched, 'bytes': len(raw.encode())})
        return serialize(row)
    if route == 'sync/clear':
        kind = body.get('kind')
        if kind == 'all':
            n, _ = DeviceSync.objects.filter(user=user).delete()
        elif kind in KINDS:
            n, _ = DeviceSync.objects.filter(user=user, kind=kind).delete()
        else:
            raise Problem('不支持的同步类型。')
        return {'deleted': n}
    raise Problem('同步接口不存在。', 404)
