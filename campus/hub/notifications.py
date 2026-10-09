"""Resolve trusted actions for existing robot notices; reading is never approval."""
import re
from urllib.parse import quote
from .models import (CourseReview, CourseReviewCase, Entry, ExternalCache,
                     Notification, Reply)
from .core import Problem

UUID = r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}'


def content_action(notice, user):
    """Resolve only stored relations and known keys, never links from notification text."""
    if notice.event in ('learning', 'learning-review'):
        from .learning_follow import notification_action
        return notification_action(notice, user)
    if notice.event == 'operations':
        return {'kind': 'operations', 'href': 'me.html#maintenance', 'label': '查看维护状态', 'status': 'available'} if user.is_staff else None
    entry = notice.entry
    if entry is not None:
        editorial = entry.owner_id == user.pk or user.is_staff
        if entry.state == 'withdrawn':
            return {'kind': 'content', 'status': 'withdrawn', 'href': None, 'label': '原内容已撤回'}
        if not entry.public_revision and not editorial:
            return {'kind': 'content', 'status': 'unavailable', 'href': None, 'label': '原内容暂不可查看'}
        is_circle = entry.kind == 'topic' and bool(entry.published.get('circle')) and bool(entry.public_revision)
        if is_circle:
            from .circle import public_post
            try:
                public_post(user, str(entry.pk))
            except Problem:
                return {'kind': 'content', 'status': 'unavailable', 'href': None, 'label': '原内容暂不可查看'}
        payload = entry.published if entry.public_revision else entry.draft
        learning = payload.get('learning', {})
        is_learning_question = entry.kind == 'topic' and isinstance(learning, dict) and learning.get('materialType') == 'question'
        if is_circle:
            address = f'circle.html?post={entry.pk}'
        elif is_learning_question:
            from .models import GuideCourse
            course_id = learning.get('courseId', '')
            verified_id = course_id if isinstance(course_id, str) and GuideCourse.objects.filter(pk=course_id).exists() else ''
            address = ('course.html?id=' + quote(verified_id) + '&' if verified_id else 'course.html?') + f'question={entry.pk}'
        else:
            address = f'project.html?id={entry.pk}'
        result = {'kind': 'content', 'status': 'available', 'href': address, 'label': '查看原内容'}
        match = re.fullmatch(r'(reply|mention|accepted):(' + UUID + r')', notice.key)
        if match and notice.event in ('reply', 'mention', 'accepted', 'discussion'):
            reply = Reply.objects.filter(pk=match[2], entry=entry).first()
            allowed = reply and (reply.state == 'published' or (reply.state == 'pending' and (reply.author_id == user.pk or user.is_staff)))
            if allowed:
                result.update(reply=str(reply.pk), label='查看对应回复',
                              href=address + (f'&reply={reply.pk}' if is_circle else f'#reply-{reply.pk}'))
            else:
                result.update(status='reply-unavailable', label='查看原帖（该回复已不可查看）')
        return result
    # Teaching reputation uses a separate model. Only the recipient's own records
    # are linked; public pseudonyms and raw text must never reveal account relations.
    match = re.fullmatch(r'(review-result|review-withdraw):(' + UUID + r'):\d+', notice.key)
    if match and notice.event == match[1]:
        review = CourseReview.objects.filter(pk=match[2], author=user).first()
        if review:
            return {'kind': 'content', 'status': 'available', 'href': f'reputation.html?view=mine#review-{review.pk}', 'label': '查看我的评价与审核结果'}
    if notice.event == 'review-case' and re.fullmatch(UUID, notice.key):
        case = CourseReviewCase.objects.filter(pk=notice.key, author=user).first()
        if case:
            return {'kind': 'content', 'status': 'available', 'href': 'reputation.html?view=mine', 'label': '查看我的评价反馈'}
    return None


def inbox(user):
    records = Notification.objects.filter(user=user).select_related('entry').order_by('-created', '-pk')
    notices = list(records[:100])
    actions = {}
    if user.is_staff:
        keys = {n.key.split(':', 1)[0] for n in notices if n.event == 'maintenance'}
        if 'github-candidates' in keys:
            pending = sum(1 for data in ExternalCache.objects.filter(key__startswith='github:').values_list('data', flat=True)
                          if data.get('discovery') and not data.get('selection'))
            actions['github-candidates'] = {'kind': 'review-github', 'label': '查看并审核项目', 'pending': pending}
        if 'maint-news' in keys:
            pending = Entry.objects.filter(kind='news', state='pending', slug__startswith='news-').count()
            actions['maint-news'] = {'kind': 'review-news', 'label': '查看并审核新闻', 'pending': pending}
        actions['maint-links'] = {'kind': 'maintenance', 'label': '查看链接巡检'}
        if 'github-guides' in keys:
            pending = sum(1 for d in ExternalCache.objects.filter(key__startswith='github:').values_list('data',flat=True)
                          if (d.get('guide') or {}).get('reviewState')=='pending')
            actions['github-guides']={'kind':'review-guides','label':'查看并审核中文导读','pending':pending}
        if 'supervisor' in keys:
            from .supervisor import status
            s=status()
            actions['supervisor']={'kind':'review-supervisor','label':'回复北矿娘 / 核对公告','pending':len(s['cases'])+len(s['announcements'])}
    items = []
    for notice in notices:
        action = actions.get(notice.key.split(':', 1)[0]) if notice.event == 'maintenance' else content_action(notice, user)
        unavailable = action and action.get('status') in ('withdrawn', 'unavailable')
        text = action['label'] + '。' if unavailable else notice.text
        if action and action.get('status') == 'reply-unavailable':
            text = '讨论有更新，但对应回复已撤回或暂不可查看。'
        items.append({'id': notice.pk, 'entry': str(notice.entry_id) if notice.entry_id and not unavailable else None,
                      'event': notice.event, 'text': text, 'read': notice.read,
                      'created': notice.created.isoformat(), 'action': action})
    return {'unread': records.filter(read=False).count(), 'items': items}
