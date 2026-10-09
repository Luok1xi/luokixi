"""One authenticated account's choice per real OSM building; public aggregate only."""
import json
import unicodedata
import uuid
from functools import lru_cache
from pathlib import Path
from django.db import transaction
from django.db.models import Count
from .core import Problem, require, text, throttle
from .models import Workspace, Audit

KIND = 'building_name_vote'

@lru_cache(maxsize=2)
def buildings(campus):
    if campus not in {'xueyuanlu', 'shahe'}:
        raise Problem('请选择有效校区。')
    path = Path(__file__).resolve().parents[2] / 'public' / 'data' / 'campus-map' / f'{campus}.json'
    data = json.loads(path.read_text(encoding='utf-8'))
    return {f['properties']['osm']: f['properties'] for f in data['features'] if f.get('geometry', {}).get('type') in {'Polygon', 'MultiPolygon'} and f.get('properties', {}).get('osm') and not f['properties'].get('context') and f['properties'].get('kind') == 'building'}

def get(request):
    campus = request.GET.get('campus', 'xueyuanlu')
    known = buildings(campus)
    records = Workspace.objects.filter(kind=KIND, data__campus=campus)
    counts = records.values('data__osm', 'data__name').annotate(votes=Count('id')).order_by('-votes', 'data__name')
    result = {}
    for row in counts:
        osm, name = row['data__osm'], row['data__name']
        if osm not in known:
            continue
        item = result.setdefault(osm, {'names': [], 'preferred': name, 'total': 0})
        item['names'].append({'name': name, 'votes': row['votes']})
        item['total'] += row['votes']
    if request.user.is_authenticated:
        for row in records.filter(owner=request.user):
            if row.data['osm'] in result:
                result[row.data['osm']]['mine'] = row.data['name']
    return {'campus': campus, 'buildings': result}

@transaction.atomic
def post(request, body):
    require(request.user, verified=True)
    if set(body) - {'campus', 'osm', 'name'}:
        raise Problem('名称投稿包含未知字段。')
    campus, osm = body.get('campus'), text(body.get('osm', ''), 100, True)
    known = buildings(campus)
    if osm not in known:
        raise Problem('请先选择地图中已有的建筑。')
    name = unicodedata.normalize('NFKC', text(body.get('name', ''), 40))
    if any(unicodedata.category(c).startswith('C') for c in name) or any(c in name for c in '<>\\/\n\r') or '://' in name:
        raise Problem('请填写建筑名称，不要包含链接或控制字符。')
    throttle('building-name', str(request.user.pk), limit=30, seconds=3600)
    key = uuid.uuid5(uuid.NAMESPACE_URL, f'luokixi:building-name:{request.user.pk}:{campus}:{osm}')
    if name:
        Workspace.objects.update_or_create(id=key, owner=request.user, kind=KIND, defaults={'title': name, 'data': {'campus': campus, 'osm': osm, 'name': name}})
    else:
        Workspace.objects.filter(id=key, owner=request.user, kind=KIND).delete()
    Audit.objects.create(actor=request.user, action='building:name', target=f'{campus}:{osm}', detail={'action': 'vote' if name else 'withdraw'})
    return {'ok': True}
