"""Course follow notifications; publication hooks, no background scraping/email."""
import re
from urllib.parse import quote
from django.db import transaction

from .core import Problem, notify, require, text, throttle
from .learning_models import CourseFollow
from .models import CampusBoard, CourseOffering, GuideCourse


def course_for(identifier):
    course = GuideCourse.objects.filter(pk=text(identifier, 100, True)).first()
    if not course:
        raise Problem('课程不存在。', 404)
    return course


def get(request, identifier):
    course = course_for(identifier)
    following = bool(request.user.is_authenticated and CourseFollow.objects.filter(user=request.user, course=course).exists())
    return {'courseId': course.pk, 'following': following, 'requiresLogin': not request.user.is_authenticated}


@transaction.atomic
def set_follow(request, identifier, body):
    require(request.user, verified=True)
    course = course_for(identifier)
    if type(body.get('enabled')) is not bool:
        raise Problem('请明确选择关注或取消关注。')
    throttle('learning-follow', str(request.user.pk), 60)
    if body['enabled']:
        CourseFollow.objects.get_or_create(user=request.user, course=course)
    else:
        CourseFollow.objects.filter(user=request.user, course=course).delete()
    return get(request, identifier)


def entry_course_ids(entry):
    if not entry.public_revision or entry.state == 'withdrawn' or not isinstance(entry.published, dict):
        return []
    data = entry.published
    meta = data.get('learning') if isinstance(data.get('learning'), dict) else {}
    if meta.get('school', 'cumtb') not in ('', 'cumtb'):
        return []
    if data.get('visibility', 'public') != 'public' or meta.get('visibility', 'public') != 'public':
        return []
    circle = data.get('circle') if isinstance(data.get('circle'), dict) else {}
    if circle.get('visibility', 'public') != 'public':
        return []
    if circle and not CampusBoard.objects.filter(pk=circle.get('board'), active=True).exists():
        return []
    values = data.get('courses') if isinstance(data.get('courses'), list) else []
    primary = meta.get('courseId') if isinstance(meta.get('courseId'), str) else ''
    ids = {i for i in [primary, *values] if isinstance(i, str) and i}
    if meta.get('offeringId'):
        # Bad historical metadata is ignored. Validation prevents new bad IDs.
        from django.core.exceptions import ValidationError
        try:
            offering = CourseOffering.objects.filter(pk=meta['offeringId'], active=True).first()
        except (ValidationError, ValueError, TypeError):
            offering = None
        if offering and (not primary or offering.course_id == primary):
            ids.add(offering.course_id)
    return list(GuideCourse.objects.filter(pk__in=ids).values_list('pk', flat=True))


def on_entry_publish(entry):
    if entry.kind not in ('resource', 'paper', 'reproduction', 'project', 'topic'):
        return
    ids = entry_course_ids(entry)
    if not ids:
        return
    title = str(entry.published.get('title', '新内容'))[:120]
    for following in CourseFollow.objects.filter(course_id__in=ids).exclude(user_id=entry.owner_id).select_related('user', 'course'):
        # Existing notify is idempotent; repeated hooks cannot repeat alerts.
        notify(following.user, entry, 'learning', f'learning:entry:{entry.pk}:{entry.public_revision}:{following.course_id}',
               f'你关注的「{following.course.name}」有新内容：{title}', subscription=True)


def on_review_publish(review):
    # Only concrete course-offering reviews notify course subscribers. A teacher
    # review's optional course context does not make it a course review.
    if not review.offering_id or not review.public_revision or review.state == 'withdrawn' or not review.offering.active:
        return
    course = review.offering.course
    for following in CourseFollow.objects.filter(course=course).exclude(user_id=review.author_id).select_related('user'):
        # Do not carry account IDs, the unpublished body or author identity.
        notify(following.user, None, 'learning-review', f'learning:review:{review.pk}:{review.public_revision}:{course.pk}',
               f'你关注的「{course.name}」有新的公开课程体验（{review.offering.term}）。', subscription=True)


def notification_action(notice, user):
    """Resolve a stored subscription event without trusting its display text."""
    unavailable = {'kind': 'content', 'status': 'unavailable', 'href': None, 'label': '课程更新已不可查看'}
    if notice.user_id != user.pk:
        return unavailable
    match = re.fullmatch(r'learning:(entry|review):([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}):(\d+):([a-z0-9][a-z0-9-]{0,99})', notice.key)
    if not match:
        return unavailable
    kind, target, revision, course_id = match.groups()
    if (kind == 'entry' and notice.event != 'learning') or (kind == 'review' and notice.event != 'learning-review'):
        return unavailable
    if kind == 'entry':
        entry = notice.entry
        if not entry or str(entry.pk) != target or entry.public_revision < int(revision) or course_id not in entry_course_ids(entry):
            return unavailable
        if entry.kind == 'topic' and entry.published.get('circle'):
            href = f'circle.html?post={entry.pk}'
        elif entry.kind == 'topic':
            href = f'course.html?id={quote(course_id)}&question={entry.pk}'
        else:
            href = f'project.html?id={entry.pk}'
    else:
        from .reputation import public_reviews
        review = public_reviews().filter(pk=target, offering__course_id=course_id,
                                         public_revision__gte=int(revision)).first()
        if not review:
            return unavailable
        href = f'reputation.html?offering={review.offering_id}#review-{review.pk}'
    return {'kind': 'content', 'status': 'available', 'href': href,
            'label': '查看课程更新', 'courseId': course_id}


def subscription_active(notice, user):
    action = notification_action(notice, user)
    return action['status'] == 'available' and CourseFollow.objects.filter(user=user, course_id=action['courseId']).exists()
