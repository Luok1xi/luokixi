"""Community campus places: reviewed coordinates, expiring discoveries and evidence."""
import math
import re
from datetime import timedelta
from urllib.parse import urlencode, urlsplit
from django.db import transaction
from django.db.models import Count, Max
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from .core import Problem, entry_data, public_entries, require, text, throttle, url
from .models import Entry, PlaceObservation, Upload

CAMPUS = {'xueyuanlu':'学院路校区','shahe':'沙河校区'}
TYPES = {'facility':'校园设施','study':'学习空间','food':'饮食','sports':'运动',
         'scenery':'风景','event':'活动','discovery':'同学发现'}
IMAGE_EXTENSIONS = {'.jpg','.jpeg','.png','.webp'}
EVENT_FIELDS = {'startsAt','endsAt','building','registrationURL','reminderMinutes'}
EVENT_TIMESTAMP = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$')


def number(value,low,high):
    if isinstance(value,bool) or not isinstance(value,(float,int)) or not math.isfinite(value) or not low<=value<=high:
        raise Problem('地点坐标或精度无效。')
    return float(value)


def timestamp(value,required=False):
    value = text(value or '',60,required)
    if not value:
        return None
    dt = parse_datetime(value)
    if not dt or timezone.is_naive(dt):
        raise Problem('请提供带时区的完整观察/到期时间。')
    return dt


def event_timestamp(value):
    if not isinstance(value,str) or not EVENT_TIMESTAMP.fullmatch(value):
        raise Problem('活动起止时间需包含完整日期、时分秒和时区。')
    if value[-1]!='Z' and (int(value[-5:-3])>23 or int(value[-2:])>59):
        raise Problem('活动时间的时区格式无效。')
    try:
        dt = parse_datetime(value)
    except (ValueError,OverflowError):
        dt = None
    if not dt or timezone.is_naive(dt):
        raise Problem('活动起止时间不是有效的带时区时间。')
    return dt


def event_fields(data,campus,kind,now):
    present = EVENT_FIELDS.intersection(data)
    if kind!='event':
        if present:
            raise Problem('活动时间、关联建筑、报名链接和提醒仅适用于活动分类。')
        return {}
    result = {}
    if 'startsAt' in present or 'endsAt' in present:
        if not {'startsAt','endsAt'}.issubset(present):
            raise Problem('活动开始和结束时间需成对填写，不能以观察时间或到期时间代替。')
        start,end = event_timestamp(data['startsAt']),event_timestamp(data['endsAt'])
        if end<=start:
            raise Problem('活动结束时间必须晚于开始时间。')
        if start>now+timedelta(days=730) or end>now+timedelta(days=730):
            raise Problem('活动时间不能超过未来 730 天。')
        result.update(startsAt=start.isoformat(),endsAt=end.isoformat())
    if 'building' in present:
        from .planner import building
        result['building'] = building(data['building'])
        if result['building'] is not None and result['building']['campus']!=campus:
            raise Problem('活动关联建筑需属于所选校区。')
    if 'registrationURL' in present:
        value = text(data['registrationURL'],1000)
        try:
            parsed = urlsplit(value)
            # Empty userinfo is still userinfo; controls must not be removed by URL parsing.
            if parsed.username is not None or parsed.password is not None or any(ord(ch)<32 or 127<=ord(ch)<=159 for ch in value) or '\\' in value:
                raise ValueError()
            if value:
                parsed.port
            result['registrationURL'] = url(value)
        except ValueError:
            raise Problem('请提供不含账号密码的完整 HTTP 或 HTTPS 报名链接。')
    if 'reminderMinutes' in present:
        reminder = data['reminderMinutes']
        if type(reminder) is not int or not 0<=reminder<=120:
            raise Problem('活动提醒应为 0–120 分钟的整数。')
        result['reminderMinutes'] = reminder
    return result


def validate_place(data,user,submit=False):
    campus = data.get('campus','')
    kind = data.get('placeType','discovery')
    duration = data.get('duration','temporary')
    if campus not in CAMPUS or kind not in TYPES or duration not in ('permanent','temporary'):
        raise Problem('请选择校区、地点分类和长期/临时类型。')
    location = data.get('location')
    clean_location = None
    if location is not None:
        if not isinstance(location,dict) or location.get('coordinateSystem')!='wgs84':
            raise Problem('地图目前接收 WGS84 坐标，请勿混入其他底图的坐标。')
        clean_location = {'lat':number(location.get('lat'),-85,85),'lng':number(location.get('lng'),-180,180),
                          'coordinateSystem':'wgs84'}
        if location.get('accuracyMeters') is not None:
            clean_location['accuracyMeters'] = number(location['accuracyMeters'],0,10000)
    observed = timestamp(data.get('observedAt'))
    expires = timestamp(data.get('expiresAt'))
    now = timezone.now()
    if observed and observed>now+timedelta(minutes=5):
        raise Problem('观察时间不能在未来。')
    if duration=='temporary':
        if expires and (not observed or not observed<expires<=observed+timedelta(days=7)):
            raise Problem('临时发现的有效期需晚于观察时间，且不超过七天。')
        if submit and (not observed or not expires or expires<=now):
            raise Problem('请为临时发现填写观察时间及尚未过期的有效期。')
    elif expires:
        raise Problem('长期地点不使用临时有效期。')
    images = data.get('uploads',[])
    for upload in Upload.objects.filter(pk__in=images):
        if upload.asset.extension not in IMAGE_EXTENSIONS:
            raise Problem('地点附件仅支持照片；资料请发布到资料库。')
    hint = text(data.get('addressHint',''),600)
    if submit and (not clean_location or not hint or not images):
        raise Problem('发布地点需要地图选点、详细位置说明以及至少一张本人有权分享的照片。')
    if submit and data.get('publicLocationConfirmed') is not True:
        raise Problem('请确认分享的是可以公开访问或说明的地点，不是个人行踪。')
    result = {'campus':campus,'placeType':kind,'duration':duration,'location':clean_location,
            'addressHint':hint,'observedAt':observed.isoformat() if observed else None,
            'expiresAt':expires.isoformat() if expires else None,
            'accessNotes':text(data.get('accessNotes',''),1000),
            'photoCredit':text(data.get('photoCredit',''),300),
            'publicLocationConfirmed':data.get('publicLocationConfirmed') is True}
    result.update(event_fields(data,campus,kind,now))
    return result


def expired(data):
    end = timestamp(data.get('expiresAt'))
    return bool(end and end<=timezone.now())


def observation_stats(entry):
    recent = PlaceObservation.objects.filter(entry=entry,updated__gte=timezone.now()-timedelta(hours=24))
    counts = dict(recent.values_list('status').annotate(n=Count('id')))
    last = recent.aggregate(last=Max('updated'))['last']
    return {'stillThere':counts.get('still-there',0),'gone':counts.get('gone',0),
            'lastReportAt':last.isoformat() if last else None,
            'notice':'最近24小时的同学反馈，非自动定位或官方实时状态。'}


def feature(entry,user):
    data = entry.published
    loc = data['location']
    ended = expired(data)
    marker = 'https://api.map.baidu.com/marker?'+urlencode({'location':f"{loc['lat']},{loc['lng']}",
        'title':data['title'],'content':data.get('addressHint',''),'coord_type':'wgs84',
        'output':'html','src':'webapp.luokixi.campus'})
    properties = dict(entry_data(entry,user),campus=data['campus'],placeType=data['placeType'],
        expired=ended,observations=observation_stats(entry),
        photos=[{'id':uid,'previewUrl':f'/api/hub/uploads/{uid}/photo'} for uid in data.get('uploads',[])],
        navigation={'url':None if ended else marker,'label':'在百度地图中查看并导航',
                    'notice':'外部地图提供路线；校内通行情况以现场为准。'},
        sourceLabel='同学共建地点；坐标经维护者核对，不代表官方实时确认')
    return {'type':'Feature','id':str(entry.pk),'geometry':{'type':'Point','coordinates':[loc['lng'],loc['lat']]},
            'properties':properties}


def collection(request):
    q = request.GET
    rows = public_entries().filter(kind='place').select_related('owner').order_by('-updated','id')
    if q.get('campus'):
        if q['campus'] not in CAMPUS:
            raise Problem('未知校区。')
        rows = rows.filter(published__campus=q['campus'])
    if q.get('type'):
        if q['type'] not in TYPES:
            raise Problem('未知地点分类。')
        rows = rows.filter(published__placeType=q['type'])
    if q.get('q'):
        rows = rows.filter(search_text__icontains=text(q['q'],100,True))
    bbox = None
    if q.get('bbox'):
        try:
            west,south,east,north = [float(v) for v in q['bbox'].split(',')]
            for val in (west,east): number(val,-180,180)
            for val in (south,north): number(val,-85,85)
            if west>=east or south>=north: raise ValueError()
            bbox = (west,south,east,north)
        except (ValueError,TypeError):
            raise Problem('地图范围应为 west,south,east,north。')
    offset = max(0,min(int(q.get('offset','0')),100000))
    valid = []
    for entry in rows:
        data = entry.published
        loc = data.get('location')
        if not loc or not data.get('locationReviewedAt'):
            continue
        if expired(data) and q.get('includeExpired')!='1':
            continue
        if bbox and not (bbox[0]<=loc['lng']<=bbox[2] and bbox[1]<=loc['lat']<=bbox[3]):
            continue
        valid.append(entry)
    return {'type':'FeatureCollection','features':[feature(e,request.user) for e in valid[offset:offset+200]],
            'total':len(valid),'offset':offset,'nextOffset':offset+200 if offset+200<len(valid) else None,
            'campuses':CAMPUS,'placeTypes':TYPES,'generatedAt':timezone.now().isoformat(),
            'coordinateSystem':'wgs84','notice':'只显示已审核地点；临时发现默认到期下线。没有数据时不生成虚构地标。'}


@transaction.atomic
def observe(user,identifier,body):
    require(user,verified=True)
    throttle('place-report',str(user.pk),20)
    entry = public_entries().filter(pk=identifier,kind='place').first()
    if not entry:
        raise Problem('地点不存在。',404)
    if expired(entry.published):
        raise Problem('地点已过期，请通过新的投稿补充最新发现。',409)
    status = body.get('status')
    if status not in ('still-there','gone','clear'):
        raise Problem('请选择仍在、已不在或撤销反馈。')
    if status=='clear':
        PlaceObservation.objects.filter(user=user,entry=entry).delete()
    else:
        if entry.owner_id==user.pk:
            raise Problem('作者请更新自己的地点记录，现场反馈留给其他同学。')
        PlaceObservation.objects.update_or_create(user=user,entry=entry,defaults={
            'status':status,'note':text(body.get('note',''),300)})
    return {'ok':True,'observations':observation_stats(entry),'contributionAwarded':False}
