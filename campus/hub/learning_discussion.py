"""An explicit public-help submission; private search drafts never reach this module."""
from django.db import transaction
from .core import Problem, require, text, throttle, save_entry, submit_entry, entry_data
from .models import Watch


@transaction.atomic
def submit_question(request, body):
    require(request.user, verified=True)
    if body.get('confirmPublic') is not True:
        raise Problem('请确认公开后再提交求助。')
    throttle('learning-question', str(request.user.pk), 12)
    from .learning import validate_learning
    learning = validate_learning({'school': 'cumtb', 'courseId': body.get('courseId', ''),
                                 'term': body.get('term', ''), 'materialType': 'question', 'access': 'public'})
    question = text(body.get('body', ''), 20000, True)
    entry = save_entry(request.user, {'kind': 'topic', 'data': {
        'title': text(body.get('title', ''), 160, True), 'body': question,
        'summary': question[:1000], 'learning': learning,
        'courses': [learning['courseId']] if learning.get('courseId') else [],
        'license': '作者保留权利；允许本站展示与答疑', 'rightsConfirmed': True,
        'sourceNote': '同学主动发布的学习求助',
    }})
    entry = submit_entry(request.user, entry, entry.revision)
    Watch.objects.update_or_create(user=request.user, entry=entry, defaults={'events': ['discussion', 'revision']})
    return entry_data(entry, request.user, own=True)
