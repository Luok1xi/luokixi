"""Teaching reputation. Public serializers never expose anonymous account relations."""
from decimal import Decimal, ROUND_HALF_UP
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from django.utils.crypto import salted_hmac
from django.utils.dateparse import parse_date
from .core import Problem, require, text, url, throttle, notify
from .models import (Audit, Teacher, GuideCourse, CourseOffering, CourseReview,
                     CourseReviewVersion, CourseReviewLike, CourseReviewReply, CourseReviewCase)


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
        'term': data.get('term', ''), 'anonymous': data.get('anonymous', True) if private else (data.get('anonymous', True) or review.force_anonymous),
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
    rows = query.values_list('published', flat=True)
    for data in rows:
        distribution[str(data['rating'])] += 1
    count = sum(distribution.values())
    total = sum(int(k) * v for k, v in distribution.items())
    average = float((Decimal(total) / count).quantize(Decimal('.1'), rounding=ROUND_HALF_UP)) if count else None
    return {'average': average, 'count': count, 'distribution': distribution,
            'smallSample': 0 < count < 5, 'label': '样本较少' if 0 < count < 5 else ('暂无评分' if not count else '')}


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
    return {'id': str(teacher.pk), 'name': teacher.name, 'faculty': teacher.faculty,
            'title': teacher.title, 'sourceUrl': teacher.source_url, 'checkedAt': teacher.checked_at,
            'photo': teacher.photo or None, 'teaching': teacher.teaching, 'ratingLabel': '教学体验',
            'stats': statistics(reviews), 'highlight': highlight(reviews, user)}


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


def get(request, route):
    user, q = request.user, request.GET
    parts = route.split('/')
    if route == 'teachers':
        query = Teacher.objects.filter(active=True).order_by('name', 'id')
        term = text(q.get('q', ''), 100)
        if term:
            query = query.filter(Q(name__icontains=term) | Q(faculty__icontains=term))
        return page(query, request, teacher_data)
    if parts[0] == 'teachers' and len(parts) == 2:
        t = one(Teacher, parts[1], active=True)
        return dict(teacher_data(t, user), offerings=[
            offering_data(o, user) for o in t.offerings.filter(active=True).select_related('course').prefetch_related('teachers')])
    if route == 'courses':
        query = GuideCourse.objects.order_by('name', 'id')
        term = text(q.get('q', ''), 100)
        if term:
            query = query.filter(Q(name__icontains=term) | Q(faculty__icontains=term))
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
        order = ('-like_count', '-published_at', 'id') if q.get('sort') == 'likes' else ('-published_at', 'id')
        return page(query.order_by(*order), request, review_data)
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
    result = {'rating': rating, 'body': text(data.get('body', ''), 5000, True),
              'anonymous': data.get('anonymous', True), 'courseId': course_id,
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
    require(user, verified=True)
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
