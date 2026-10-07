"""Public campus social content; explicit, inspectable recommendations, no hidden tracking."""
import hashlib
import json
import math
import re
import secrets
from collections import Counter
from datetime import timedelta
from urllib.parse import urlsplit, urlunsplit
from django.core import signing
from django.db import transaction
from django.db.models import Count, F, Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from .core import (Problem, require, text, url, string_list, public_entries, entry_data,
                   member_data, save_entry, throttle, notify, contribute)
from .models import (CampusBoard, BoardFollow, CreatorFollow, CirclePreference, CircleLike,
                     CircleFeedback, CircleSelection, Entry, ExternalCache, Member, Reply, ReplyLike,
                     Upload, Audit, Contribution)

VERSION = 'campus-explicit-v1'
PAGE_SIZE = 12
DEFAULT_BOARDS = [
    ('daily', '矿大日常', '校园生活、摄影与新发现'),
    ('courses', '选课与学习引导', '课程体验、资源入口与学长学姐经验'),
    ('makers', '创作与开源', '软件、机电、机器人、设计与创作过程'),
    ('teams', '组队与机会', '跨专业合作、竞赛与活动招募'),
    ('research', '科研与生涯', '论文、复现、研究方向与成长经历'),
    ('reading', '精选阅读', '值得读的站外文章与同学推荐理由'),
]


def validate(data, user, submit=False):
    info = data.get('circle')
    if not isinstance(info, dict):
        raise Problem('校圈字段格式不正确。')
    if info.get('visibility', 'public') != 'public' or info.get('anonymous', False) is not False:
        raise Problem('当前校圈为公开署名投稿；匿名课程评价请使用口碑入口。')
    fmt = info.get('format', 'moment')
    board = text(info.get('board', ''), 60, True)
    if fmt not in ('moment', 'thread', 'link') or not CampusBoard.objects.filter(pk=board, active=True).exists():
        raise Problem('请选择有效话题吧和内容类型。')
    campus = info.get('campus', 'all')
    if campus not in ('all', 'shahe', 'xueyuanlu'):
        raise Problem('校区无效。')
    result = {'board': board, 'format': fmt, 'campus': campus, 'visibility': 'public'}
    body = text(data.get('body', ''), 10000 if fmt == 'thread' else 3000)
    if not body and not data.get('uploads') and fmt != 'link':
        raise Problem('请写一点正文或添加照片。')
    ids = string_list(data.get('uploads', []), 9, 36)
    if Upload.objects.filter(pk__in=ids).exclude(asset__extension__in=['.png', '.jpg', '.jpeg', '.webp']).exists():
        raise Problem('动态附件只支持照片，其他资料请走资料投稿。')
    if fmt == 'link':
        ext = info.get('external')
        if not isinstance(ext, dict):
            raise Problem('请补充原文链接和推荐理由。')
        address = url(ext.get('url', ''), True)
        parsed = urlsplit(address)
        if parsed.scheme != 'https':
            raise Problem('精选阅读需要 HTTPS 原文链接。')
        platform = ext.get('platform', 'external')
        if platform not in ('zhihu', 'external'):
            raise Problem('外部平台无效。')
        if platform == 'zhihu':
            good = ((parsed.hostname in ('zhihu.com', 'www.zhihu.com') and
                     re.fullmatch(r'/question/\d+(?:/answer/\d+)?/?', parsed.path)) or
                    (parsed.hostname == 'zhuanlan.zhihu.com' and re.fullmatch(r'/p/\d+/?', parsed.path)))
            if not good or parsed.port is not None:
                raise Problem('请填写知乎问题、回答或专栏的原始链接。')
            address = urlunsplit(('https', parsed.hostname, parsed.path.rstrip('/'), '', ''))
        if ids:
            raise Problem('站外阅读卡只收链接和你自己的推荐文字。')
        result['external'] = {'platform': platform, 'url': address,
            'author': text(ext.get('author', ''), 120, True),
            'reason': text(ext.get('reason', ''), 1000, True),
            'audience': text(ext.get('audience', ''), 300, True),
            'mode': 'link-only'}
    return result


def preference(user):
    if not user.is_authenticated:
        return {'personalized': False, 'interests': [], 'mutedCreators': [], 'mutedBoards': []}
    p = CirclePreference.objects.filter(user=user).first()
    return {'personalized': p.personalized if p else True, 'interests': p.interests if p else [],
            'mutedCreators': p.muted_creators if p else [], 'mutedBoards': p.muted_boards if p else []}


def visible(user, pref=None):
    pref = pref or preference(user)
    query = public_entries().filter(kind='topic', published__circle__board__in=
        CampusBoard.objects.filter(active=True).values_list('id', flat=True)).select_related('owner', 'circle_selection')
    return query.exclude(owner__username__in=pref['mutedCreators']).exclude(
        published__circle__board__in=pref['mutedBoards'])


def public_post(user, identifier):
    try:
        entry = visible(user).get(pk=identifier)
    except (Entry.DoesNotExist, ValueError, TypeError):
        raise Problem('校圈内容不存在或已被你隐藏。', 404)
    return entry


def selection(entry):
    try:
        chosen = entry.circle_selection
    except CircleSelection.DoesNotExist:
        return None
    return chosen if chosen.revision == entry.public_revision else None


def card(entry, user, reasons=None):
    result = entry_data(entry, user)
    chosen = selection(entry)
    result.update(likes=entry.circle_likes.filter(revision=entry.public_revision).count(),
        liked=user.is_authenticated and entry.circle_likes.filter(user=user, revision=entry.public_revision).exists(),
        replies=entry.reply_set.filter(state='published').count(),
        photos=[f'/api/hub/uploads/{uid}/photo' for uid in entry.published.get('uploads', [])],
        selection={'reason': chosen.reason, 'checkedAt': chosen.checked_at, 'revision': chosen.revision} if chosen else None,
        recommendationReasons=reasons or [])
    # Link authors and site submitters remain distinct.
    result['contentType'] = entry.published['circle']['format']
    return result


def on_publish(entry, first_publication):
    if not entry.published.get('circle'):
        return
    # A new version must earn selection again, not inherit a prior endorsement.
    Contribution.objects.filter(key__in=['circle-selected:' + str(entry.pk), 'entry:' + str(entry.pk)]).update(
        active=False, reason='校圈普通发布不计贡献；改版后精选待重新核对')
    if not first_publication:
        return
    board = entry.published['circle']['board']
    recipients = set(BoardFollow.objects.filter(board_id=board, notify=True).values_list('user_id', flat=True))
    recipients.update(CreatorFollow.objects.filter(creator_id=entry.owner_id, notify=True).values_list('user_id', flat=True))
    for follower in Member.objects.filter(pk__in=recipients, is_active=True).exclude(pk=entry.owner_id):
        p = preference(follower)
        if (entry.owner and entry.owner.username in p['mutedCreators']) or board in p['mutedBoards']:
            continue
        notify(follower, entry, 'circle-new', 'circle-new:' + str(entry.pk),
               '你订阅的校圈有新内容：' + entry.published['title'][:150], True)


def context(user):
    pref = preference(user)
    creators = list(CreatorFollow.objects.filter(user=user).values_list('creator_id', flat=True)) if user.is_authenticated else []
    boards = list(BoardFollow.objects.filter(user=user).values_list('board_id', flat=True)) if user.is_authenticated else []
    ignored = list(CircleFeedback.objects.filter(user=user, action='not-interested').values_list('entry_id', flat=True)) if user.is_authenticated else []
    return pref, creators, boards, ignored


def rank(entries, pref, creators, boards):
    """Transparent launch policy, not a claim to reproduce Douyin model weights."""
    interests = set(pref['interests']) if pref['personalized'] else set()
    candidates = []
    for entry in entries:
        info = entry.published['circle']
        chosen = selection(entry)
        if info['format'] == 'link' and not chosen:
            continue
        reasons = []
        published = parse_datetime(info.get('publishedAt', '')) or entry.created
        age = max(0, (timezone.now() - published).total_seconds() / 86400)
        score = 2 / (1 + age / 7)
        if chosen:
            score += 3
            reasons.append('维护者精选：' + chosen.reason)
        if pref['personalized']:
            matches = interests.intersection(entry.published.get('tags', []))
            if matches:
                score += min(4, len(matches) * 2)
                reasons.append('符合你选择的兴趣：' + '、'.join(sorted(matches)))
            if entry.owner_id in creators:
                score += 3
                reasons.append('来自你关注的创作者')
            if info['board'] in boards:
                score += 2
                reasons.append('来自你订阅的话题吧')
        score += min(1, math.log1p(getattr(entry, 'useful_count', 0)) / 3)
        if not reasons:
            reasons.append('校园新内容')
        candidates.append((score, entry, reasons))
    candidates.sort(key=lambda x: (-x[0], -x[1].created.timestamp(), str(x[1].pk)))
    # Greedy re-ranking with fresh-author exploration. No author can fill a whole screen.
    result, reasons_by_id, authors, board_counts, seen_links = [], {}, Counter(), Counter(), set()
    while candidates and len(result) < 200:
        eligible = [(i, row) for i, row in enumerate(candidates) if
                    authors[row[1].owner_id] < 2 and board_counts[row[1].published['circle']['board']] < 4]
        if not eligible:
            authors.clear()
            board_counts.clear()
            eligible = list(enumerate(candidates))
        explore = len(result) % 5 == 4
        if explore:
            index, (_, item, reasons) = min(eligible, key=lambda pair: (
                getattr(pair[1][1], 'useful_count', 0), -pair[1][1].created.timestamp(), str(pair[1][1].pk)))
            reasons = reasons + ['探索：给新内容一次被发现的机会']
        else:
            index, (_, item, reasons) = eligible[0]
        candidates.pop(index)
        info = item.published['circle']
        address = info.get('external', {}).get('url')
        if address and address in seen_links:
            continue
        if address:
            seen_links.add(address)
        identifier = str(item.pk)
        result.append(identifier)
        reasons_by_id[identifier] = reasons
        authors[item.owner_id] += 1
        board_counts[info['board']] += 1
        if len(result) % PAGE_SIZE == 0:
            authors.clear()
            board_counts.clear()
    return result, reasons_by_id


def feed(request):
    lane = request.GET.get('lane', 'recommended')
    if lane not in ('recommended', 'latest', 'following', 'boards', 'reading'):
        raise Problem('校圈排序无效。')
    if lane in ('following', 'boards'):
        require(request.user)
    board = text(request.GET.get('board', ''), 60)
    campus = text(request.GET.get('campus', 'all'), 20)
    if campus not in ('all', 'shahe', 'xueyuanlu'):
        raise Problem('校区无效。')
    q = text(request.GET.get('q', ''), 100)
    pref, creators, boards, ignored = context(request.user)
    query = visible(request.user, pref).exclude(pk__in=ignored)
    if board:
        query = query.filter(published__circle__board=board)
    if campus != 'all':
        query = query.filter(published__circle__campus__in=[campus, 'all'])
    if q:
        query = query.filter(search_text__icontains=q)
    if lane == 'following':
        query = query.filter(owner_id__in=creators)
    if lane == 'boards':
        query = query.filter(published__circle__board__in=boards)
    if lane == 'reading':
        query = query.filter(published__circle__format='link', circle_selection__revision=F('public_revision'))
    mode = 'latest' if lane == 'recommended' and request.user.is_authenticated and not pref['personalized'] else lane
    stamp = hashlib.sha256(json.dumps([getattr(request.user, 'pk', None), lane, board, campus, q, pref,
        sorted(creators), sorted(boards), sorted(map(str, ignored))], sort_keys=True).encode()).hexdigest()
    cursor = request.GET.get('cursor')
    if cursor:
        try:
            info = signing.loads(cursor, salt='hub.circle', max_age=1800)
            snapshot = request.session.get('circle_snapshot', {})
            if snapshot['id'] != info['id'] or snapshot['stamp'] != stamp:
                raise ValueError()
            offset = info['offset']
        except (signing.BadSignature, KeyError, ValueError, TypeError):
            raise Problem('推荐条件已变化或浏览已过期，请刷新校圈。', 409)
    else:
        if mode == 'recommended':
            latest = list(query.order_by('-published__circle__publishedAt', 'id').values_list('pk', flat=True)[:200])
            curated = list(query.filter(circle_selection__revision=F('public_revision')).order_by(
                '-circle_selection__checked_at').values_list('pk', flat=True)[:100])
            followed = list(query.filter(Q(owner_id__in=creators) | Q(published__circle__board__in=boards)).order_by(
                '-published__circle__publishedAt').values_list('pk', flat=True)[:100])
            entries = list(query.filter(pk__in=set(latest + curated + followed)).annotate(useful_count=Count(
                'circle_feedback', filter=Q(circle_feedback__action='useful', circle_feedback__revision=F('public_revision')))))
            keys, reasons = rank(entries, pref, creators, boards)
        else:
            keys = list(map(str, query.order_by('-published__circle__publishedAt', 'id').values_list('pk', flat=True)[:200]))
            reasons = {}
        revisions = {str(key): version for key, version in query.filter(pk__in=keys).values_list('pk', 'public_revision')}
        snapshot = {'id': secrets.token_urlsafe(16), 'stamp': stamp, 'keys': keys, 'reasons': reasons, 'revisions': revisions}
        request.session['circle_snapshot'] = snapshot
        offset = 0
    keys, items = snapshot['keys'], []
    while offset < len(keys) and len(items) < PAGE_SIZE:
        identifier = keys[offset]
        offset += 1
        # Recheck live publication, selection, ignores and visibility on every page.
        entry = query.filter(pk=identifier).first()
        if not entry or (mode == 'recommended' and entry.published['circle']['format'] == 'link' and not selection(entry)):
            continue
        if snapshot.get('revisions', {}).get(identifier) != entry.public_revision:
            continue
        reasons = snapshot['reasons'].get(identifier, [])
        if mode == 'recommended':
            _, live_reasons = rank([entry], pref, creators, boards)
            reasons = live_reasons.get(identifier, []) + [r for r in reasons if r.startswith('探索：')]
        items.append(card(entry, request.user, reasons))
    next_cursor = signing.dumps({'id': snapshot['id'], 'offset': offset}, salt='hub.circle') if offset < len(keys) else None
    return {'items': items, 'nextCursor': next_cursor, 'mode': mode, 'algorithmVersion': VERSION,
            'hasMore': bool(next_cursor), 'notice': '本轮最多 200 条；最新为发布时间排序，推荐依据显式兴趣与核对记录。'}


# ---------- 校圈热榜（虎扑热榜）：近 7 天发布的公开帖，按回复、点赞、有帮助计热度，72 小时减半 ----------
HOT_DAYS = 7
HOT_HALF_LIFE_HOURS = 72
HOT_DEFINITION = '近 7 天发布的公开帖；热度 = 回复×3 + 点赞×2 + 有帮助×2（精选另加 3），每 72 小时减半。箭头和昨天的榜比。'


def hot_rows(campus):
    """全站同一份榜（按校区），5 分钟内复用；个人的屏蔽在读取时再去掉。"""
    key = f'circle:hot:{campus}'
    now = timezone.now()
    cache = ExternalCache.objects.filter(pk=key).first()
    data = dict(cache.data) if cache else {}
    if cache and cache.checked and (now - cache.checked).total_seconds() < 300 and 'rows' in data:
        return data
    since = now - timedelta(days=HOT_DAYS)
    query = public_entries().filter(kind='topic', created__gte=now - timedelta(days=HOT_DAYS + 30),
        published__circle__board__in=CampusBoard.objects.filter(active=True).values_list('id', flat=True))
    if campus != 'all':
        query = query.filter(published__circle__campus__in=[campus, 'all'])
    query = query.select_related('owner', 'circle_selection').annotate(
        like_n=Count('circle_likes', filter=Q(circle_likes__revision=F('public_revision')), distinct=True),
        reply_n=Count('reply', filter=Q(reply__state='published'), distinct=True),
        useful_n=Count('circle_feedback', filter=Q(circle_feedback__action='useful', circle_feedback__revision=F('public_revision')), distinct=True))
    rows = []
    for entry in query[:500]:
        info = entry.published.get('circle', {})
        published = parse_datetime(info.get('publishedAt', '')) or entry.created
        if timezone.is_naive(published) or published < since:
            continue
        chosen = selection(entry)
        if info.get('format') == 'link' and not chosen:
            continue
        base = entry.reply_n * 3 + entry.like_n * 2 + entry.useful_n * 2 + (3 if chosen else 0)
        age = max(0, (now - published).total_seconds() / 3600)
        heat = base * 0.5 ** (age / HOT_HALF_LIFE_HOURS)
        rows.append({'id': str(entry.pk), 'title': entry.published.get('title', ''), 'board': info.get('board', ''),
                     'campus': info.get('campus', 'all'), 'owner': entry.owner.username if entry.owner_id else '',
                     'likes': entry.like_n, 'replies': entry.reply_n, 'heat': round(heat * 10),
                     'publishedAt': published.isoformat(), '_sort': heat})
    rows.sort(key=lambda r: r['publishedAt'], reverse=True)
    rows.sort(key=lambda r: -r['_sort'])
    rows = [{k: v for k, v in r.items() if k != '_sort'} for r in rows if r['heat'] > 0][:30]
    # 变化箭头：每天第一次计算时，把昨天的名次存成 previous
    day = timezone.localtime(now).date().isoformat()
    if data.get('day') != day:
        data = {'day': day, 'previous': data.get('current', {})}
    data['current'] = {r['id']: i + 1 for i, r in enumerate(rows[:10])}
    data['rows'] = rows
    ExternalCache.objects.update_or_create(key=key, defaults={'data': data, 'checked': now, 'success': now, 'error': ''})
    return data


def hot(request):
    campus = text(request.GET.get('campus', 'all'), 20)
    if campus not in ('all', 'shahe', 'xueyuanlu'):
        raise Problem('校区无效。')
    data = hot_rows(campus)
    pref, _, _, ignored = context(request.user)
    ignored = set(map(str, ignored))
    boards = {b.pk: b.name for b in CampusBoard.objects.filter(active=True)}
    items = []
    for row in data.get('rows', []):
        if row['id'] in ignored or row['owner'] in pref['mutedCreators'] or row['board'] in pref['mutedBoards']:
            continue
        rank = len(items) + 1
        before = data.get('previous', {}).get(row['id'])
        change = {'kind': 'new'} if before is None else {'kind': 'up' if before > rank else 'down' if before < rank else 'flat', 'by': abs(before - rank)}
        items.append(dict({k: v for k, v in row.items() if k != 'owner'}, rank=rank, change=change,
                          boardName=boards.get(row['board'], '校园话题')))
        if len(items) == 10:
            break
    return {'items': items, 'window': f'近 {HOT_DAYS} 天', 'definition': HOT_DEFINITION,
            'previousDay': bool(data.get('previous')), 'updatedAt': timezone.now().isoformat()}


# ---------- 帖子详情：楼层 + 亮回复（获赞最多的回复先放在上面） ----------
LIT_MAX = 3


def thread(request, entry):
    user = request.user
    query = Reply.objects.filter(entry=entry, state='published')
    if user.is_authenticated:
        query = Reply.objects.filter(entry=entry).filter(Q(state='published') | Q(author=user))
    replies = list(query.select_related('author').annotate(like_n=Count('likes')).order_by('created', 'id')[:300])
    liked = set(ReplyLike.objects.filter(user=user, reply__in=replies).values_list('reply_id', flat=True)) if user.is_authenticated else set()
    floor, items = 1, []
    for r in replies:
        published = r.state == 'published'
        if published:
            floor += 1
        items.append({'id': str(r.pk), 'body': r.body, 'author': member_data(r.author), 'state': r.state,
                      'floor': floor if published else None, 'likes': r.like_n, 'liked': r.pk in liked,
                      'own': user.is_authenticated and r.author_id == user.pk, 'isOwner': r.author_id == entry.owner_id,
                      'created': r.created.isoformat()})
    lit = sorted((i for i in items if i['state'] == 'published' and i['likes'] >= 1), key=lambda i: (-i['likes'], i['floor']))[:LIT_MAX]
    return {'post': card(entry, user), 'replies': items, 'lit': [i['id'] for i in lit],
            'litRule': '获赞最多的回复先放在上面（亮了），其余按楼层时间排列。'}


def board_proposals():
    pending = list(CampusBoard.objects.filter(active=False, pk__startswith='u-'))
    audits = {a.target: a for a in Audit.objects.filter(action='circle-board-proposal', target__in=[b.pk for b in pending]).select_related('actor')}
    return [{'id': b.pk, 'name': b.name, 'description': b.description, 'rules': b.rules,
             'proposer': member_data(audits[b.pk].actor) if b.pk in audits and audits[b.pk].actor_id else None,
             'created': audits[b.pk].created.isoformat() if b.pk in audits else None} for b in pending]


def get(request, route):
    user = request.user
    if route == 'circle/trends':
        campus=text(request.GET.get('campus','all'),20)
        if campus not in ('all','shahe','xueyuanlu'):raise Problem('校区无效。')
        pref, _, _, ignored = context(user)
        query=visible(user,pref).exclude(pk__in=ignored)
        if campus!='all':query=query.filter(published__circle__campus__in=[campus,'all'])
        now=timezone.now();cutoff=now-timedelta(days=7);terms=Counter();sample=0
        # Bound the work per request; counts describe this visible sample, never fake search traffic.
        for entry in query.order_by('-published__circle__publishedAt')[:500]:
            published=parse_datetime(entry.published.get('circle',{}).get('publishedAt',''))
            if not published or timezone.is_naive(published) or not cutoff<=published<=now:continue
            sample+=1
            for tag in set(entry.published.get('tags',[])):
                if isinstance(tag,str) and 1<len(tag)<=30:terms[tag]+=1
        return {'items':[{'term':term,'posts':count} for term,count in terms.most_common(6)],
            'samplePosts':sample,'updatedAt':now.isoformat(),
            'definition':'近 7 天最新 500 篇可见公开帖中的标签出现次数；不是搜索次数。'}
    if route == 'circle/feed':
        return feed(request)
    if route == 'circle/hot':
        return hot(request)
    if route == 'circle/boards':
        follows = dict(BoardFollow.objects.filter(user=user).values_list('board_id', 'notify')) if user.is_authenticated else {}
        return {'items': [{'id': b.pk, 'name': b.name, 'description': b.description, 'rules': b.rules,
                'followed': b.pk in follows, 'notify': follows.get(b.pk, False),
                'posts': visible(user).filter(published__circle__board=b.pk).count()} for b in CampusBoard.objects.filter(active=True)]}
    if route == 'circle/board-proposals':
        require(user, staff=True)
        return {'items': board_proposals()}
    if route == 'circle/preferences':
        require(user)
        return preference(user)
    if route == 'circle/following':
        require(user)
        return {'creators': [{'creator': member_data(f.creator), 'notify': f.notify} for f in
                CreatorFollow.objects.filter(user=user).select_related('creator')],
                'boards': list(BoardFollow.objects.filter(user=user).values('board_id', 'notify'))}
    if route == 'circle/capabilities':
        return {'formats': ['moment', 'thread', 'link'], 'visibility': ['public'], 'anonymousPosts': False,
                'imageLimit': 9, 'personalizedRanking': 'explicit-preferences', 'algorithmVersion': VERSION,
                'webPush': False, 'automaticZhihuImport': False}
    parts = route.split('/')
    if len(parts) == 3 and parts[1] == 'posts':
        return card(public_post(user, parts[2]), user)
    if len(parts) == 4 and parts[1] == 'posts' and parts[3] == 'thread':
        return thread(request, public_post(user, parts[2]))
    raise Problem('校圈接口不存在。', 404)


@transaction.atomic
def post(request, route, body):
    user = request.user
    require(user, verified=True)
    parts = route.split('/')
    if route == 'circle/posts':
        throttle('circle-post', str(user.pk), 12)
        data = body.get('data')
        if not isinstance(data, dict):
            raise Problem('请填写校圈内容。')
        if not isinstance(data.get('circle'), dict):
            raise Problem('请选择校圈内容类型与话题吧。')
        data = dict(data)
        data.setdefault('title', text(data.get('body', ''), 10000)[:60] or '校园分享')
        data.setdefault('summary', data.get('body', '')[:300] or data['title'])
        data.setdefault('license', '原作者保留权利；站外内容仅链接')
        entry = save_entry(user, {'kind': 'topic', 'data': data})
        return entry_data(entry, user, True)
    if route == 'circle/preferences':
        p, _ = CirclePreference.objects.get_or_create(user=user)
        if 'personalized' in body:
            if type(body['personalized']) is not bool:
                raise Problem('请明确是否启用个性化。')
            p.personalized = body['personalized']
        for field, attr, count, limit in [('interests', 'interests', 20, 80),
                ('mutedCreators', 'muted_creators', 100, 30), ('mutedBoards', 'muted_boards', 50, 60)]:
            if field in body:
                values = string_list(body[field], count, limit)
                if field == 'mutedCreators' and Member.objects.filter(username__in=values, is_active=True).count() != len(values):
                    raise Problem('包含不存在的用户。')
                if field == 'mutedBoards' and CampusBoard.objects.filter(pk__in=values).count() != len(values):
                    raise Problem('包含不存在的话题吧。')
                setattr(p, attr, values)
        p.save()
        request.session.pop('circle_snapshot', None)
        return preference(user)
    if route == 'circle/reset':
        # Clear algorithm state only; keep deliberate subscriptions and mute choices.
        CirclePreference.objects.filter(user=user).update(interests=[])
        CircleFeedback.objects.filter(user=user).delete()
        request.session.pop('circle_snapshot', None)
        return {'ok': True, 'preserved': ['follows', 'mutes', 'personalized']}
    if route in ('circle/follow-creator', 'circle/follow-board'):
        if type(body.get('enabled')) is not bool or type(body.get('notify', False)) is not bool:
            raise Problem('请明确关注及通知状态。')
        if route.endswith('creator'):
            target = Member.objects.filter(username=body.get('username'), is_active=True).first()
            if not target:
                raise Problem('用户不存在。', 404)
            if target.pk == user.pk:
                raise Problem('不需要关注自己。')
            model, lookup = CreatorFollow, {'user': user, 'creator': target}
        else:
            target = CampusBoard.objects.filter(pk=body.get('board'), active=True).first()
            if not target:
                raise Problem('话题吧不存在。', 404)
            model, lookup = BoardFollow, {'user': user, 'board': target}
        if body['enabled']:
            model.objects.update_or_create(**lookup, defaults={'notify': body.get('notify', False)})
        else:
            model.objects.filter(**lookup).delete()
        return {'enabled': body['enabled'], 'notify': body.get('notify', False) if body['enabled'] else False}
    if route == 'circle/board-proposals':
        # 同学申请开一个吧：先建成未开通的吧，维护者开通（circle/boards，active=true）或驳回
        throttle('board-proposal', str(user.pk), 3)
        name = text(body.get('name', ''), 20, True).removesuffix('吧').strip()
        description = text(body.get('description', ''), 300, True)
        rules = text(body.get('rules', ''), 2000)
        if len(name) < 2:
            raise Problem('吧名至少两个字。')
        if CampusBoard.objects.filter(name__in=[name, name + '吧']).exists():
            raise Problem('已经有同名的吧，或者正在审核中。', 409)
        if CampusBoard.objects.filter(active=False, pk__startswith='u-').count() >= 50:
            raise Problem('待审核的开吧申请太多了，请稍后再提交。', 429)
        identifier = 'u-' + secrets.token_hex(4)
        board = CampusBoard.objects.create(pk=identifier, name=name, description=description, rules=rules, active=False)
        Audit.objects.create(actor=user, action='circle-board-proposal', target=board.pk,
                             detail={'name': name, 'description': description, 'rules': rules})
        for staff in Member.objects.filter(is_staff=True, is_active=True).exclude(pk=user.pk):
            notify(staff, None, 'board-proposal', f'board-proposal:{board.pk}:{staff.pk}', f'有同学申请开「{name}吧」，等你审核。')
        return {'id': board.pk, 'state': 'pending', 'message': '已提交，维护者审核后开通。'}
    if len(parts) == 4 and parts[1] == 'board-proposals' and parts[3] == 'reject':
        require(user, staff=True)
        board = CampusBoard.objects.filter(pk=parts[2], active=False).first()
        if not board:
            raise Problem('这条申请不存在或已经处理。', 404)
        reason = text(body.get('reason', ''), 300, True)
        proposal = Audit.objects.filter(action='circle-board-proposal', target=board.pk).first()
        if proposal and proposal.actor_id:
            notify(proposal.actor, None, 'board-proposal', f'board-rejected:{board.pk}', f'「{board.name}吧」没有开通：{reason}')
        Audit.objects.create(actor=user, action='circle-board-reject', target=board.pk, detail={'reason': reason, 'name': board.name})
        board.delete()
        return {'ok': True}
    if route == 'circle/boards':
        require(user, staff=True)
        identifier = text(body.get('id', ''), 60, True)
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', identifier) or type(body.get('active', True)) is not bool:
            raise Problem('话题吧编号或状态无效。')
        was_pending = CampusBoard.objects.filter(pk=identifier, active=False).exists()
        item, _ = CampusBoard.objects.update_or_create(pk=identifier, defaults={'name': text(body.get('name', ''), 80, True),
            'description': text(body.get('description', ''), 500), 'rules': text(body.get('rules', ''), 5000),
            'active': body.get('active', True)})
        Audit.objects.create(actor=user, action='circle-board', target=item.pk)
        if was_pending and item.active:
            proposal = Audit.objects.filter(action='circle-board-proposal', target=item.pk).first()
            if proposal and proposal.actor_id:
                notify(proposal.actor, None, 'board-proposal', f'board-approved:{item.pk}', f'你申请的「{item.name}吧」开通了，去发第一帖吧。')
        return {'id': item.pk}
    if len(parts) == 4 and parts[1] == 'replies' and parts[3] == 'like':
        reply = Reply.objects.filter(pk=parts[2], state='published').select_related('entry').first() if re.fullmatch(r'[0-9a-f-]{36}', parts[2]) else None
        if not reply:
            raise Problem('回复不存在。', 404)
        public_post(user, str(reply.entry_id))
        if type(body.get('enabled')) is not bool:
            raise Problem('请明确点赞状态。')
        if body['enabled'] and reply.author_id == user.pk:
            raise Problem('不能给自己的回复点亮。')
        if body['enabled']:
            ReplyLike.objects.get_or_create(reply=reply, user=user)
        else:
            ReplyLike.objects.filter(reply=reply, user=user).delete()
        return {'id': str(reply.pk), 'likes': reply.likes.count(), 'liked': body['enabled']}
    if len(parts) == 4 and parts[1] == 'posts':
        entry = public_post(user, parts[2])
        action = parts[3]
        if action == 'like':
            if type(body.get('enabled')) is not bool:
                raise Problem('请明确点赞状态。')
            if body['enabled'] and entry.owner_id == user.pk:
                raise Problem('不能给自己点赞。')
            if body['enabled']:
                CircleLike.objects.update_or_create(user=user, entry=entry, defaults={'revision': entry.public_revision})
            else:
                CircleLike.objects.filter(user=user, entry=entry).delete()
            return card(entry, user)
        if action == 'feedback':
            value = body.get('action')
            if value not in ('useful', 'not-interested', 'clear'):
                raise Problem('反馈类型无效。')
            if value == 'useful' and entry.owner_id == user.pk:
                raise Problem('不能给自己标记有帮助。')
            if value == 'clear':
                CircleFeedback.objects.filter(user=user, entry=entry).delete()
            else:
                CircleFeedback.objects.update_or_create(user=user, entry=entry,
                    defaults={'action': value, 'revision': entry.public_revision})
            return {'ok': True}
        if action == 'select':
            require(user, staff=True)
            if entry.owner_id == user.pk:
                raise Problem('自己的投稿需要其他维护者评选。')
            if body.get('revision') != entry.public_revision:
                raise Problem('公开版本已变化，请重新核对。', 409)
            if type(body.get('enabled')) is not bool:
                raise Problem('请明确精选状态。')
            reason = text(body.get('reason', ''), 1000, True)
            if body['enabled']:
                if body.get('sourceChecked') is not True:
                    raise Problem('请核对内容、原作者及原文入口后再精选。')
                CircleSelection.objects.update_or_create(entry=entry, defaults={
                    'revision': entry.public_revision, 'reason': reason, 'reviewer': user})
                if entry.owner_id and not entry.canonical_id:
                    contribute(entry.owner, entry, 'curation', 'circle-selected:' + str(entry.pk),
                        entry.published['title'], '/hub/#entry/' + str(entry.pk))
            else:
                CircleSelection.objects.filter(entry=entry).delete()
                Contribution.objects.filter(key='circle-selected:' + str(entry.pk)).update(active=False, reason=reason)
            Audit.objects.create(actor=user, action='circle-selection', target=str(entry.pk),
                detail={'enabled': body['enabled'], 'revision': entry.public_revision, 'reason': reason})
            return card(entry, user)
    raise Problem('校圈操作不存在。', 404)
