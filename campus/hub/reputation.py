"""Teaching reputation. Public serializers never expose anonymous account relations."""
from collections import Counter, defaultdict
from datetime import timedelta
from decimal import Decimal, ROUND_HALF_UP
from urllib.parse import urlsplit
from django.db import transaction
from django.db.models import Case, Count, IntegerField, Q, Value, When
from .search_matching import text_score
from django.utils import timezone
from django.utils.crypto import salted_hmac
from django.utils.dateparse import parse_date
from .core import Problem, require, text, url, throttle, notify
from .models import (Audit, Teacher, GuideCourse, CourseOffering, CourseReview, CourseReviewVersion,
                     CourseReviewLike, CourseReviewReply, CourseReviewCase, ExternalMention, Job, Member, Source)

# 印象标签（虎扑 / 豆瓣式）：只描述教学体验，正反两面都有；每条评价最多选 3 个，不计入星级
TAGS = ['讲解清楚', '有干货', '负责耐心', '互动多', '要求严格', '作业较多', '作业适中',
        '考核友好', '考核较难', '点名较多', '很少点名', '推荐旁听']
RANK_MIN = 5          # 评分榜至少 5 人评分；1–4 人只在对象页显示真实均分和“样本较少”
HOT_DAYS = 90         # 热议榜：近 90 天新公开的评价数
# 站外讨论只收链接和同学自己的一句话，标明来源站点；本站不抓取、不转载原帖
SITES = {
    'tieba': ('百度贴吧', ('tieba.baidu.com',)),
    'hupu': ('虎扑', ('bbs.hupu.com', 'm.hupu.com', 'www.hupu.com', 'hupu.com')),
    'zhihu': ('知乎', ('www.zhihu.com', 'zhihu.com', 'zhuanlan.zhihu.com')),
    'douban': ('豆瓣', ('www.douban.com', 'douban.com', 'm.douban.com')),
    'bilibili': ('哔哩哔哩', ('www.bilibili.com', 'bilibili.com', 'm.bilibili.com')),
    'xiaohongshu': ('小红书', ('www.xiaohongshu.com', 'xiaohongshu.com')),
    'weixin': ('微信公众号', ('mp.weixin.qq.com',)),
}


def one(model, identifier, **filters):
    try:
        obj = model.objects.filter(pk=identifier, **filters).first()
    except (ValueError, TypeError):
        obj = None
    if obj is None:
        raise Problem('记录不存在。', 404)
    return obj


def public_reviews():
    return CourseReview.objects.filter(public_revision__gt=0).exclude(state='withdrawn').filter(
        Q(teacher__active=True) | Q(offering__active=True))


def is_owner(user, review):
    return user.is_authenticated and user.pk == review.author_id


def anonymous_name(review, author_id):
    # Per-discussion pseudonym, not a cross-thread/account identifier.
    if author_id == review.author_id:
        return '匿名作者'
    digest = salted_hmac('reputation.reply', f'{review.pk}:{author_id}').hexdigest()[:6]
    return '匿名同学 ' + digest


def public_author(review, author, anonymous):
    if anonymous or (author.pk == review.author_id and review.force_anonymous):
        return {'name': anonymous_name(review, author.pk), 'anonymous': True}
    return {'name': author.display_name or author.username, 'username': author.username, 'anonymous': False}


def review_data(review, user, private=False):
    data = review.draft if private else review.published
    count = getattr(review, 'like_count', None)
    result = {
        'id': str(review.pk), 'subjectType': 'teacher' if review.teacher_id else 'offering',
        'subjectId': str(review.teacher_id or review.offering_id),
        'revision': review.revision if private else review.public_revision,
        'rating': data.get('rating'), 'body': data.get('body', ''),
        'courseId': data.get('courseId', ''), 'courseName': data.get('courseName', ''),
        'term': data.get('term', ''), 'tags': data.get('tags', []),
        'anonymous': data.get('anonymous', True) if private else (data.get('anonymous', True) or review.force_anonymous),
        'author': public_author(review, review.author, data.get('anonymous', True)),
        'likes': review.likes.count() if count is None else count,
        'liked': user.is_authenticated and review.likes.filter(user=user).exists(),
        'own': is_owner(user, review), 'publishedAt': review.published_at,
        'href': f'reputation.html?{"teacher" if review.teacher_id else "offering"}={review.teacher_id or review.offering_id}#review-{review.pk}',
    }
    if private:
        result.update(state=review.state, note=review.note, publicRevision=review.public_revision)
    return result


def statistics(query):
    distribution = {str(i): 0 for i in range(1, 6)}
    tags = Counter()
    rows = query.values_list('published', flat=True)
    for data in rows:
        distribution[str(data['rating'])] += 1
        tags.update(t for t in data.get('tags', []) if t in TAGS)
    count = sum(distribution.values())
    total = sum(int(k) * v for k, v in distribution.items())
    average = float((Decimal(total) / count).quantize(Decimal('.1'), rounding=ROUND_HALF_UP)) if count else None
    return {'average': average, 'count': count, 'distribution': distribution,
            'smallSample': 0 < count < 5, 'label': '样本较少' if 0 < count < 5 else ('暂无评分' if not count else ''),
            'tags': [{'tag': t, 'count': n} for t, n in tags.most_common(8)]}


def highlight(query, user):
    item = query.annotate(like_count=Count('likes')).select_related('author').order_by(
        '-like_count', '-published_at', '-created', 'id').first()
    if not item:
        return None
    result = review_data(item, user)
    result['label'] = '高赞评论' if result['likes'] else '最新评价'
    # Entire original body is returned. CSS line clamp never rewrites the quotation.
    return result


def teacher_data(teacher, user):
    reviews = public_reviews().filter(teacher=teacher)
    prof = teacher.profile or {}
    # 机器人读到的公开资料；照片候选、被拒地址等内部字段不公开
    profile = {k: prof[k] for k in ('college', 'department', 'research', 'profileUrl', 'crawledAt') if prof.get(k)}
    if prof.get('origin') == 'faculty-bot':
        profile['bot'] = True
    return {'id': str(teacher.pk), 'name': teacher.name, 'faculty': teacher.faculty,
            'title': teacher.title, 'sourceUrl': teacher.source_url, 'checkedAt': teacher.checked_at,
            'photo': teacher.photo or None, 'teaching': teacher.teaching, 'ratingLabel': '教学体验',
            'profile': profile, 'stats': statistics(reviews), 'highlight': highlight(reviews, user)}


def offering_data(offering, user):
    reviews = public_reviews().filter(offering=offering)
    return {'id': str(offering.pk), 'courseId': offering.course_id, 'name': offering.course.name,
            'term': offering.term, 'campus': offering.campus, 'sourceUrl': offering.source_url,
            'teachers': [{'id': str(t.pk), 'name': t.name} for t in offering.teachers.filter(active=True)],
            'stats': statistics(reviews), 'highlight': highlight(reviews, user)}


def course_data(course, user, detail=False):
    reviews = public_reviews().filter(offering__course=course)
    result = {'id': course.pk, 'name': course.name, 'faculty': course.faculty, 'scope': course.scope,
              'sourceUrl': course.source_url, 'prerequisites': course.prerequisites,
              'resources': course.resources, 'stats': statistics(reviews),
              'highlight': highlight(reviews, user), 'ratingLabel': '课程体验 · 历次开课'}
    if detail:
        result['offerings'] = [offering_data(o, user) for o in course.offerings.filter(active=True).select_related('course').prefetch_related('teachers')]
    return result


def page(query, request, serializer):
    offset = max(0, min(int(request.GET.get('offset', 0)), 100000))
    total = query.count()
    return {'items': [serializer(x, request.user) for x in query[offset:offset + 24]],
            'total': total, 'nextOffset': offset + 24 if offset + 24 < total else None}


def reply_data(reply, review):
    return {'id': str(reply.pk), 'reviewId': str(review.pk), 'body': reply.body,
            'author': public_author(review, reply.author, reply.anonymous), 'created': reply.created}


def case_data(case):
    return {'id': str(case.pk), 'reviewId': str(case.review_id), 'kind': case.kind,
            'body': case.body, 'state': case.state, 'resolution': case.resolution, 'created': case.created}


def search_directory(query, term):
    # Public directory fields only. Exact matches beyond the bounded fuzzy pool
    # remain reachable; active/visibility predicates are applied by the caller.
    fields = ('pk', 'name', 'faculty')
    candidates = {str(row['pk']): row for row in query.values(*fields)[:2000]}
    for row in query.filter(Q(name__icontains=term) | Q(faculty__icontains=term)).values(*fields)[:2000]:
        candidates[str(row['pk'])] = row
    scored = [(text_score(term,row['name'],keywords=row['faculty']),row['pk']) for row in candidates.values()]
    matches = sorted(((score,key) for score,key in scored if score > 0),key=lambda row:(-row[0],str(row[1])))
    if not matches:
        return query.none()
    return query.filter(pk__in=[key for _,key in matches]).annotate(search_order=Case(
        *(When(pk=key,then=Value(i)) for i,(_,key) in enumerate(matches)),output_field=IntegerField())).order_by('search_order','name','pk')


def get(request, route):
    user, q = request.user, request.GET
    parts = route.split('/')
    if route == 'teachers':
        query = Teacher.objects.filter(active=True).order_by('name', 'id')
        term = text(q.get('q', ''), 100)
        if term:
            query = search_directory(query, term)
        return page(query, request, teacher_data)
    if parts[0] == 'teachers' and len(parts) == 2:
        t = one(Teacher, parts[1], active=True)
        return dict(teacher_data(t, user), offerings=[
            offering_data(o, user) for o in t.offerings.filter(active=True).select_related('course').prefetch_related('teachers')])
    if route == 'courses':
        query = GuideCourse.objects.order_by('name', 'id')
        term = text(q.get('q', ''), 100)
        if term:
            query = search_directory(query, term)
        return page(query, request, course_data)
    if parts[0] == 'courses' and len(parts) == 2:
        return course_data(one(GuideCourse, parts[1]), user, True)
    if parts[0] == 'offerings' and len(parts) == 2:
        o = one(CourseOffering, parts[1], active=True)
        return dict(offering_data(o, user), course=course_data(o.course, user))
    if route == 'reviews/mine':
        require(user)
        return {'items': [review_data(r, user, True) for r in CourseReview.objects.filter(author=user).select_related('author').order_by('-created')[:200]],
                'cases': [case_data(c) for c in CourseReviewCase.objects.filter(author=user).order_by('-created')[:100]]}
    if route == 'reviews/moderation':
        require(user, staff=True)
        return {'reviews': [review_data(r, user, True) for r in CourseReview.objects.filter(state='pending').select_related('author').order_by('created')[:100]],
                'replies': [reply_data(r, r.review) for r in CourseReviewReply.objects.filter(state='pending').select_related('author', 'review')[:100]],
                'cases': [case_data(c) for c in CourseReviewCase.objects.filter(state='open')[:100]],
                'canTrace': user.has_perm('hub.trace_review_author')}
    if route == 'reviews':
        query = public_reviews().select_related('author').annotate(like_count=Count('likes'))
        if q.get('teacher'):
            query = query.filter(teacher=one(Teacher, q['teacher'], active=True))
        if q.get('offering'):
            query = query.filter(offering=one(CourseOffering, q['offering'], active=True))
        if q.get('course'):
            query = query.filter(Q(offering__course_id=q['course']) | Q(published__courseId=q['course']))
        if q.get('term'):
            query = query.filter(published__term=text(q['term'], 80))
        if q.get('q'):
            query = query.filter(published__body__icontains=text(q['q'], 100))
        # “最热”就是虎扑的“亮了”：按点赞数，其次按时间
        order = ('-like_count', '-published_at', 'id') if q.get('sort') in ('likes', 'hot') else ('-published_at', 'id')
        return page(query.order_by(*order), request, review_data)
    if parts[0] == 'reputation':
        return board_get(request, parts[1:])
    if parts[0] == 'reviews' and len(parts) == 2:
        r = one(CourseReview, parts[1])
        if not public_reviews().filter(pk=r.pk).exists():
            raise Problem('评价不存在。', 404)
        return dict(review_data(r, user), replies=[
            reply_data(reply, r) for reply in r.discussion.filter(state='published').select_related('author').order_by('created')[:200]])
    raise Problem('页面不存在。', 404)


def validate_review(body, review=None):
    data = body.get('data')
    if not isinstance(data, dict):
        raise Problem('请填写评价内容。')
    rating = data.get('rating')
    if type(rating) is not int or not 1 <= rating <= 5:
        raise Problem('请选择一至五星。')
    if type(data.get('anonymous', True)) is not bool:
        raise Problem('匿名选项格式不正确。')
    course_id = text(data.get('courseId', ''), 100)
    course = one(GuideCourse, course_id) if course_id else None
    tags = data.get('tags', [])
    if not isinstance(tags, list) or len(tags) > 3 or any(t not in TAGS for t in tags):
        raise Problem('印象标签最多选 3 个。')
    result = {'rating': rating, 'body': text(data.get('body', ''), 5000, True),
              'anonymous': data.get('anonymous', True), 'courseId': course_id, 'tags': list(dict.fromkeys(tags)),
              'courseName': course.name if course else '', 'term': text(data.get('term', ''), 80)}
    if review and review.offering_id:
        result.update(courseId=review.offering.course_id, courseName=review.offering.course.name, term=review.offering.term)
    return result


@transaction.atomic
def submit(user, body, identifier=None):
    require(user, verified=True)
    throttle('course-review-submit', str(user.pk), 30)
    if identifier:
        r = one(CourseReview, identifier)
        r = CourseReview.objects.select_for_update().get(pk=r.pk)
        if not is_owner(user, r):
            raise Problem('只能修改自己的评价。', 403)
        if body.get('revision') != r.revision:
            raise Problem('评价已更新，请刷新后重试。', 409)
        if ('subjectId' in body and body['subjectId'] != str(r.teacher_id or r.offering_id)):
            raise Problem('修改评价不能更换对象。')
        r.revision += 1
    else:
        kind = body.get('subjectType')
        target = one(Teacher if kind == 'teacher' else CourseOffering, body.get('subjectId'), active=True) if kind in ('teacher', 'offering') else None
        if target is None:
            raise Problem('请明确选择教师或具体开课记录。')
        args = {kind: target}
        if CourseReview.objects.filter(author=user, **args).exists():
            raise Problem('你已评价过此对象，请在“我的评价”中修改。', 409)
        r = CourseReview(author=user, **args)
    if (r.teacher_id and not r.teacher.active) or (r.offering_id and not r.offering.active):
        raise Problem('此评价对象已停止收录。', 409)
    r.draft = validate_review(body, r)
    # Switching to anonymous immediately hides even an older approved signature.
    r.force_anonymous = r.force_anonymous or r.draft['anonymous']
    r.state, r.note = 'pending', ''
    r.save()
    CourseReviewVersion.objects.create(review=r, number=r.revision, data=r.draft)
    Audit.objects.create(actor=user, action='review-submit', target=str(r.pk), detail={'revision': r.revision})
    return review_data(r, user, True)


def notification(review, event, version, message):
    notify(review.author, None, event, f'{event}:{review.pk}:{version}', message)


@transaction.atomic
def moderate(user, review, body):
    require(user, staff=True)
    r = CourseReview.objects.select_for_update().get(pk=review.pk)
    if r.author_id == user.pk:
        raise Problem('自己的评价需由另一位维护者审核。', 403)
    if r.revision != body.get('revision') or r.state != 'pending':
        raise Problem('待审版本已变化，请刷新。', 409)
    decision = body.get('decision')
    if decision not in ('approve', 'reject'):
        raise Problem('请选择通过或退回。')
    note = text(body.get('note', ''), 1000, True)
    if decision == 'approve':
        if (r.teacher_id and not r.teacher.active) or (r.offering_id and not r.offering.active):
            raise Problem('评价对象已停止收录。', 409)
        r.likes.all().delete()
        r.published, r.public_revision = r.draft.copy(), r.revision
        r.force_anonymous = r.published['anonymous']
        r.published_at = timezone.now()
        r.state = 'published'
    else:
        r.state = 'rejected'
    r.note = note
    r.save()
    CourseReviewVersion.objects.filter(review=r, number=r.revision).update(state=r.state, note=note)
    Audit.objects.create(actor=user, action='review-' + decision, target=str(r.pk), detail={'revision': r.revision, 'note': note})
    if decision == 'approve':
        from .learning_follow import on_review_publish
        on_review_publish(r)
    notification(r, 'review-result', r.revision, f'你的评价已{"通过" if decision == "approve" else "退回"}：{note}')
    return review_data(r, user, True)


@transaction.atomic
def save_catalogue(user, kind, body):
    require(user, staff=True)
    if body.get('sourceChecked') is not True:
        raise Problem('请先核对资料来源。')
    source = url(body.get('sourceUrl', ''), kind != 'courses')
    if kind == 'teachers':
        obj = one(Teacher, body['id']) if body.get('id') else Teacher()
        obj.name, obj.faculty = text(body.get('name', ''), 80, True), text(body.get('faculty', ''), 120)
        obj.title, obj.source_url = text(body.get('title', ''), 80), source
        photo = body.get('photo') or {}
        if photo:
            if photo.get('rightsConfirmed') is not True:
                raise Problem('照片需要确认可使用，并记录出处。')
            photo = {'url': url(photo.get('url', ''), True), 'sourceUrl': url(photo.get('sourceUrl', ''), True),
                     'credit': text(photo.get('credit', ''), 160, True)}
            if not photo['url'].startswith('https://'):
                raise Problem('照片需使用 HTTPS 地址。')
        obj.photo = photo
        teaching = body.get('teaching', [])
        if not isinstance(teaching, list) or len(teaching) > 40:
            raise Problem('授课信息格式不正确。')
        obj.teaching = [{'name': text(t.get('name', ''), 160, True), 'sourceUrl': url(t.get('sourceUrl', ''), True)} for t in teaching]
        obj.active = body.get('active', True) is True
    elif kind == 'courses':
        import re
        key = text(body.get('id', ''), 100, True)
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', key):
            raise Problem('课程编号使用小写字母、数字和短横线。')
        obj, _ = GuideCourse.objects.get_or_create(pk=key, defaults={'name': text(body.get('name', ''), 160, True)})
        obj.name, obj.faculty = text(body.get('name', ''), 160, True), text(body.get('faculty', ''), 120)
        obj.source_url, obj.prerequisites = source, text(body.get('prerequisites', ''), 3000)
        obj.scope = body.get('scope', 'campus-catalogue')
        if obj.scope not in ('campus-catalogue', 'general-topic'):
            raise Problem('课程范围格式不正确。')
        resources = body.get('resources', [])
        if not isinstance(resources, list) or len(resources) > 30:
            raise Problem('资源列表格式不正确。')
        obj.resources = []
        for item in resources:
            cost = item.get('cost', 'unknown')
            checked = text(item.get('checkedAt', ''), 10, True)
            if cost not in ('free', 'paid', 'mixed', 'unknown') or not parse_date(checked):
                raise Problem('请填写资源收费状态与核对日期。')
            obj.resources.append({'title': text(item.get('title', ''), 120, True), 'url': url(item.get('url', ''), True),
                                  'type': text(item.get('type', ''), 60, True), 'audience': text(item.get('audience', ''), 200, True),
                                  'cost': cost, 'checkedAt': checked})
    else:
        obj = one(CourseOffering, body['id']) if body.get('id') else CourseOffering()
        course = one(GuideCourse, body.get('courseId'))
        if course.scope != 'campus-catalogue':
            raise Problem('通用学习专题不能作为正式开课记录。')
        if obj.pk and CourseOffering.objects.filter(pk=obj.pk).exists() and obj.course_id != course.pk:
            raise Problem('已有开课记录不能更换课程。')
        obj.course = course
        obj.term = text(body.get('term', ''), 80, True)
        obj.campus, obj.source_url = body.get('campus'), source
        if obj.campus not in ('shahe', 'xueyuanlu'):
            raise Problem('请选择校区。')
        ids = body.get('teachers', [])
        if not isinstance(ids, list) or not 1 <= len(ids) <= 20:
            raise Problem('请选择已核对的授课教师。')
        teachers = [one(Teacher, key, active=True) for key in ids]
        obj.active = body.get('active', True) is True
    obj.full_clean()
    obj.save()
    if kind == 'offerings':
        obj.teachers.set(teachers)
    Audit.objects.create(actor=user, action='reputation-catalogue', target=f'{kind}:{obj.pk}')
    return {'id': str(obj.pk)}


@transaction.atomic
def post(request, route, body):
    user, parts = request.user, route.split('/')
    if route in ('teachers', 'courses', 'offerings'):
        return save_catalogue(user, route, body)
    if route == 'reviews':
        return submit(user, body)
    if parts[0] == 'reputation':
        return board_post(request, parts[1:], body)
    require(user, verified=True)
    if parts[0] == 'teachers' and len(parts) == 3 and parts[2] == 'request':
        return teacher_request(user, one(Teacher, parts[1]), body)
    if parts[0] == 'review-replies' and len(parts) == 3:
        reply = one(CourseReviewReply, parts[1])
        if parts[2] == 'withdraw':
            if user.pk != reply.author_id and not user.is_staff:
                raise Problem('只能撤回自己的回复。', 403)
            reply.state = 'withdrawn'
        elif parts[2] == 'moderate':
            require(user, staff=True)
            if reply.author_id == user.pk:
                raise Problem('自己的回复需由另一位维护者审核。', 403)
            if reply.state != 'pending' or body.get('decision') not in ('approve', 'reject'):
                raise Problem('待审回复已变化。', 409)
            reply.state = 'published' if body['decision'] == 'approve' else 'rejected'
            text(body.get('note', ''), 1000, True)
        else:
            raise Problem('操作不存在。', 404)
        reply.save()
        Audit.objects.create(actor=user, action='review-reply-' + reply.state, target=str(reply.pk))
        return {'id': str(reply.pk), 'state': reply.state}
    if parts[0] == 'review-cases' and len(parts) == 3 and parts[2] == 'resolve':
        require(user, staff=True)
        case = one(CourseReviewCase, parts[1])
        case.resolution = text(body.get('resolution', ''), 1000, True)
        case.state = 'resolved'
        case.save()
        Audit.objects.create(actor=user, action='review-case-resolve', target=str(case.pk), detail={'resolution': case.resolution})
        notify(case.author, None, 'review-case', str(case.pk), '评价反馈处理结果：' + case.resolution)
        return case_data(case)
    if parts[0] != 'reviews' or len(parts) != 3:
        raise Problem('操作不存在。', 404)
    r = one(CourseReview, parts[1])
    action = parts[2]
    if action == 'save':
        return submit(user, body, r.pk)
    if action == 'moderate':
        return moderate(user, r, body)
    if action == 'trace':
        require(user, staff=True)
        if not user.has_perm('hub.trace_review_author'):
            raise Problem('没有匿名身份追溯权限。', 403)
        reason = text(body.get('reason', ''), 1000, True)
        Audit.objects.create(actor=user, action='review-identity-access', target=str(r.pk), detail={'reason': reason})
        return {'username': r.author.username, 'userId': r.author_id}
    if action == 'withdraw':
        if not is_owner(user, r) and not user.is_staff:
            raise Problem('只能撤回自己的评价。', 403)
        note = text(body.get('reason', ''), 1000, True)
        r.state, r.public_revision, r.published, r.note = 'withdrawn', 0, {}, note
        r.save()
        r.likes.all().delete()
        Audit.objects.create(actor=user, action='review-withdraw', target=str(r.pk), detail={'reason': note})
        notification(r, 'review-withdraw', r.revision, '你的评价已撤回：' + note)
        return {'id': str(r.pk), 'state': 'withdrawn'}
    if action == 'appeal':
        if not is_owner(user, r):
            raise Problem('只能对自己的评价提交申诉。', 403)
        if r.state not in ('rejected', 'withdrawn'):
            raise Problem('此评价没有退回或撤回记录。')
    elif not public_reviews().filter(pk=r.pk).exists():
        raise Problem('评价不存在。', 404)
    if action == 'like':
        if type(body.get('enabled')) is not bool:
            raise Problem('点赞状态格式不正确。')
        if body['enabled']:
            if is_owner(user, r):
                raise Problem('不能为自己的评价点赞。')
            CourseReviewLike.objects.get_or_create(review=r, user=user)
        else:
            r.likes.filter(user=user).delete()
        return review_data(r, user)
    if action == 'replies':
        throttle('course-review-reply', str(user.pk), 30)
        if type(body.get('anonymous', True)) is not bool:
            raise Problem('匿名选项格式不正确。')
        reply = CourseReviewReply.objects.create(review=r, author=user,
            body=text(body.get('body', ''), 3000, True), anonymous=body.get('anonymous', True))
        return {'id': str(reply.pk), 'state': 'pending'}
    if action in ('report', 'appeal'):
        throttle('course-review-case', str(user.pk), 15)
        case = CourseReviewCase.objects.create(review=r, author=user, kind=action, body=text(body.get('reason', ''), 2000, True))
        return case_data(case)
    raise Problem('操作不存在。', 404)


# ==========================================================================
# 虎扑式评分墙、评分榜、热议榜、弹幕墙；站外讨论；教师资料机器人的维护入口
# ==========================================================================

def subject_rows(kind):
    """每个对象的评分汇总：总分、人数、近 HOT_DAYS 天新增。教师按教师整体评价，课程按历次开课汇总。"""
    since = timezone.now() - timedelta(days=HOT_DAYS)
    reviews = public_reviews()
    rows = (reviews.filter(teacher__isnull=False).values_list('teacher_id', 'published', 'published_at') if kind == 'teachers'
            else reviews.filter(offering__isnull=False).values_list('offering__course_id', 'published', 'published_at'))
    agg = defaultdict(lambda: {'sum': 0, 'count': 0, 'recent': 0})
    for key, data, at in rows:
        a = agg[str(key)]
        a['sum'] += data['rating']
        a['count'] += 1
        if at and at >= since:
            a['recent'] += 1
    return agg


def rankings(kind, user):
    if kind not in ('teachers', 'courses'):
        raise Problem('榜单类型无效。')
    agg = subject_rows(kind)
    top = sorted((k for k, a in agg.items() if a['count'] >= RANK_MIN),
                 key=lambda k: (-agg[k]['sum'] / agg[k]['count'], -agg[k]['count'], k))[:10]
    hot = sorted((k for k, a in agg.items() if a['recent']), key=lambda k: (-agg[k]['recent'], -agg[k]['count'], k))[:10]
    if kind == 'teachers':
        objects = {str(t.pk): t for t in Teacher.objects.filter(pk__in=set(top + hot), active=True)}
        serialize = teacher_data
    else:
        objects = {str(c.pk): c for c in GuideCourse.objects.filter(pk__in=set(top + hot))}
        serialize = course_data
    def items(keys, extra):
        out = []
        for key in keys:
            if key in objects:
                data = serialize(objects[key], user)
                data['rank'] = len(out) + 1
                data.update(extra(agg[key]))
                out.append(data)
        return out
    return {'kind': kind,
            'top': items(top, lambda a: {}),
            'hot': items(hot, lambda a: {'recent': a['recent']}),
            'topRule': f'至少 {RANK_MIN} 人评分，按平均分排序，同分时评分人数多的在前；只列前 10，不设“最差榜”。',
            'hotRule': f'近 {HOT_DAYS} 天新公开评价最多的对象；统计的是评价数，不是浏览量。',
            'updatedAt': timezone.now().isoformat()}


def wall(user):
    """弹幕墙：已公开评价里点赞最多的原话。点开定位到原评论；原评论修改或撤回后这里同步变化。"""
    query = public_reviews().select_related('author', 'teacher', 'offering__course').annotate(
        like_count=Count('likes')).order_by('-like_count', '-published_at', 'id')[:40]
    items = []
    for r in query:
        data = review_data(r, user)
        data['subject'] = r.teacher.name if r.teacher_id else f'{r.offering.course.name} · {r.offering.term}'
        items.append(data)
    return {'items': items, 'rule': '按点赞数选取已公开评价的原话；点击跳到原评论。'}


def site_of(address):
    host = (urlsplit(address).hostname or '').lower()
    for key, (label, hosts) in SITES.items():
        if host in hosts:
            return key, label
    return 'other', host


def mention_data(m, user, private=False):
    key, label = site_of(m.url)
    result = {'id': str(m.pk), 'site': key, 'siteLabel': label, 'url': m.url, 'title': m.title, 'summary': m.summary,
              'created': m.created, 'own': user.is_authenticated and m.author_id == user.pk,
              'subjectType': 'teacher' if m.teacher_id else 'course', 'subjectId': str(m.teacher_id or m.course_id)}
    if private:
        result.update(state=m.state, note=m.note)
    return result


def submit_mention(user, body):
    require(user, verified=True)
    throttle('reputation-mention', str(user.pk), 10)
    kind = body.get('subjectType')
    if kind == 'teacher':
        target = {'teacher': one(Teacher, body.get('subjectId'), active=True)}
    elif kind == 'course':
        target = {'course': one(GuideCourse, body.get('subjectId'))}
    else:
        raise Problem('请选择教师或课程。')
    address = url(body.get('url', ''), True)
    if urlsplit(address).scheme != 'https':
        raise Problem('请填写 https 开头的原帖链接。')
    if ExternalMention.objects.filter(url=address, **target).exists():
        raise Problem('这条讨论已经有同学提交过了。', 409)
    m = ExternalMention.objects.create(author=user, url=address, site=site_of(address)[0],
        title=text(body.get('title', ''), 160, True), summary=text(body.get('summary', ''), 300, True), **target)
    Audit.objects.create(actor=user, action='mention-submit', target=str(m.pk), detail={'url': address})
    for staff in Member.objects.filter(is_staff=True, is_active=True).exclude(pk=user.pk):
        notify(staff, None, 'mention', f'mention:{m.pk}:{staff.pk}', f'有同学提交了一条站外讨论链接（{site_of(address)[1]}），等你核对。')
    return mention_data(m, user, True)


def teacher_request(user, teacher, body):
    """老师本人或同学申请更正资料、撤下照片：记录并通知维护者处理。"""
    throttle('teacher-request', str(user.pk), 5)
    kind = body.get('kind')
    if kind not in ('correction', 'photo', 'removal'):
        raise Problem('请选择更正资料、撤下照片或其他请求。')
    detail = {'kind': kind, 'body': text(body.get('body', ''), 2000, True), 'name': teacher.name}
    Audit.objects.create(actor=user, action='teacher-request', target=f'teacher:{teacher.pk}', detail=detail)
    label = {'correction': '更正资料', 'photo': '撤下照片', 'removal': '其他请求'}[kind]
    for staff in Member.objects.filter(is_staff=True, is_active=True):
        notify(staff, None, 'teacher-request', f'teacher-request:{teacher.pk}:{staff.pk}:{timezone.now():%Y%m%d%H%M}',
               f'关于「{teacher.name}」的{label}申请，请到口碑审核页处理。')
    return {'ok': True, 'message': '已收到，维护者核对后处理。撤下照片的申请会优先处理。'}


def board_get(request, parts):
    user, q = request.user, request.GET
    route = '/'.join(parts)
    if route == 'rankings':
        return rankings(q.get('kind', 'teachers'), user)
    if route == 'wall':
        return wall(user)
    if route == 'tags':
        return {'items': TAGS, 'limit': 3}
    if route == 'mentions':
        query = ExternalMention.objects.filter(state='published')
        if q.get('teacher'):
            query = query.filter(teacher=one(Teacher, q['teacher'], active=True))
        elif q.get('course'):
            query = query.filter(course=one(GuideCourse, q['course']))
        else:
            raise Problem('请指定教师或课程。')
        return {'items': [mention_data(m, user) for m in query.order_by('-decided_at', '-created')[:50]],
                'rule': '站外讨论只收链接和同学自己的一句话概括，标明来源站点；本站不抓取、不转载原帖，也不计入评分。'}
    if route == 'mentions/mine':
        require(user)
        return {'items': [mention_data(m, user, True) for m in ExternalMention.objects.filter(author=user).order_by('-created')[:100]]}
    if route == 'mentions/pending':
        require(user, staff=True)
        items = []
        for m in ExternalMention.objects.filter(state='pending').select_related('teacher', 'course').order_by('created')[:100]:
            data = mention_data(m, user, True)
            data['subjectName'] = m.teacher.name if m.teacher_id else m.course.name
            items.append(data)
        return {'items': items}
    if route == 'faculty':
        require(user, staff=True)
        from .faculty import status
        return status()
    raise Problem('页面不存在。', 404)


def board_post(request, parts, body):
    user = request.user
    route = '/'.join(parts)
    if route == 'mentions':
        return submit_mention(user, body)
    if len(parts) == 3 and parts[0] == 'mentions':
        m = one(ExternalMention, parts[1])
        require(user, verified=True)
        if parts[2] == 'withdraw':
            if m.author_id != user.pk and not user.is_staff:
                raise Problem('只能撤回自己提交的链接。', 403)
            m.state = 'withdrawn'
        elif parts[2] == 'moderate':
            require(user, staff=True)
            if m.author_id == user.pk:
                raise Problem('自己提交的链接需由另一位维护者核对。', 403)
            if m.state != 'pending' or body.get('decision') not in ('approve', 'reject'):
                raise Problem('这条链接的状态已变化。', 409)
            m.state = 'published' if body['decision'] == 'approve' else 'rejected'
            m.note = text(body.get('note', ''), 300)
            notify(m.author, None, 'mention', f'mention-result:{m.pk}',
                   f'你提交的站外讨论链接{"已通过" if m.state == "published" else "没有通过"}' + (f'：{m.note}' if m.note else '。'))
        else:
            raise Problem('操作不存在。', 404)
        m.decided_at = timezone.now()
        m.save()
        Audit.objects.create(actor=user, action='mention-' + m.state, target=str(m.pk))
        return mention_data(m, user, True)
    if parts and parts[0] == 'faculty':
        require(user, staff=True)
        from . import faculty
        if route == 'faculty/setup':
            if type(body.get('enabled', True)) is not bool:
                raise Problem('请明确是否启用。')
            sources = faculty.ensure_sources(body.get('enabled', True))
            Audit.objects.create(actor=user, action='faculty-setup', target='faculty', detail={'enabled': body.get('enabled', True)})
            return {'sources': sources.count(), 'enabled': body.get('enabled', True)}
        if route == 'faculty/run':
            if not Source.objects.filter(kind='faculty').exists():
                faculty.ensure_sources(True)
            now = timezone.now()
            sources = Source.objects.filter(kind='faculty', enabled=True)
            if body.get('college'):
                sources = sources.filter(name=text(body['college'], 60))
            jobs = []
            for source in sources:
                job, _ = Job.objects.get_or_create(key=f'source:{source.pk}:manual:{int(now.timestamp()) // 600}',
                    defaults={'kind': 'source', 'payload': {'id': str(source.pk)}, 'due': now})
                jobs.append({'id': str(job.pk), 'college': source.name, 'state': job.state})
            Audit.objects.create(actor=user, action='faculty-run', target='faculty', detail={'jobs': len(jobs)})
            return {'jobs': jobs}
        if route == 'faculty/photos':
            decision = body.get('decision')
            if body.get('college') and decision == 'approve-all':
                done = 0
                for teacher in Teacher.objects.filter(faculty=text(body['college'], 120)):
                    if (teacher.profile or {}).get('photoCandidate'):
                        faculty.decide_photo(user, teacher, 'approve')
                        done += 1
                return {'approved': done}
            return faculty.decide_photo(user, one(Teacher, body.get('teacher')), decision)
    raise Problem('操作不存在。', 404)
