"""Private, revision-pinned assembly from server-registered university banks."""
import copy
import hashlib
import json
import os
from pathlib import Path
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from .core import Problem, require, text
from .models import Member
from .question_models import QuestionPaper, QuestionRevision
from .question_pipeline import self_review, validate_questions
from .question_robot import paper_data


def _folder():
    return Path(getattr(settings, 'UNIVERSITY_SOURCES_DATA_DIR', os.environ.get('CAMPUS_DATA_DIR', Path(__file__).resolve().parents[1] / '.data')))


def _bank(identifier):
    from university_question_bank import get_bank
    try:
        return get_bank(_folder(), identifier)
    except LookupError as error:
        raise Problem(str(error), 404)
    except (ValueError, KeyError, TypeError):
        raise Problem('来源记录不完整，请先更新这份题目。', 409)


def _questions(bank):
    originals = copy.deepcopy(bank['questions'])
    for q in originals:
        source = q.get('source', {})
        if (source.get('bankId') != bank['id'] or source.get('sha256') != bank['sha256']
                or source.get('schoolId') != bank['schoolId'] or source.get('sourceUrl') != bank['sourceUrl']):
            raise Problem('题目来源与原卷不一致。', 409)
        # Collector material has never been independently academically verified.
        q['confirmed'] = False
        q['allowUnknownAnswer'] = False
        q['answerStatus'] = 'source_unverified' if q.get('answer') else 'unknown'
        source['schoolName'] = bank.get('schoolName', '')
    try:
        return validate_questions(originals, originals)
    except ValueError as error:
        raise Problem(str(error), 409)


def _create(user, title, banks, questions, identity, kind):
    with transaction.atomic():
        Member.objects.select_for_update().get(pk=user.pk)
        existing = QuestionPaper.objects.filter(owner=user, source_kind=kind, source_document_id=identity).first()
        if existing:
            return dict(paper_data(existing), alreadyImported=True)
        courses = list(dict.fromkeys(b.get('course', 'unknown') for b in banks))
        course = courses[0] if len(courses) == 1 else '跨课程组卷'
        issues = []
        if 'unknown' in courses:
            issues.append({'code': 'course_unknown', 'blocking': True, 'message': '部分资料的课程归类仍需核对。'})
        if any(q['source'].get('requiresLayoutReview') for q in questions):
            issues.append({'code': 'source_layout_review', 'blocking': True, 'message': '含公式、图表或复杂题组，请对照原件核对排版。'})
        # Preserve extraction-wide issues too: unassigned text may contain shared stems.
        for bank in banks:
            for issue in bank.get('extractionIssues', []):
                if issue not in issues:
                    issues.append(copy.deepcopy(issue))
        questions = validate_questions(questions, questions)
        questions, report = self_review(questions, issues, course, '跨校试题')
        sources = [{key: copy.deepcopy(b.get(key)) for key in ('id', 'resourceId', 'title', 'schoolId', 'schoolName',
                   'course', 'sourceUrl', 'commit', 'sha256', 'revision', 'license', 'licenseUrl', 'rights', 'attribution', 'changes', 'checkedAt')}
                   for b in banks]
        blocks = []
        for q in questions:
            lines = [q['number'] + '. ' + q['stem']]
            lines += [o['label'] + '. ' + o['text'] for o in q['options']]
            if q['answer']:
                lines.append('Source answer: ' + q['answer'])
            lines.append('Source: ' + q['source']['sourceUrl'])
            blocks.append('\n'.join(lines))
        raw_text = '\n\n'.join(blocks)
        meta = {'name': title, 'sources': sources, 'scope': 'cross-university', 'schoolCourseId': '',
                'visibility': 'private', 'originalPageNumbers': False, 'engine': 'registered-native-sources',
                'extractionIssues': issues, 'answerProvenance': 'source-provided where available; not independently solved'}
        paper = QuestionPaper.objects.create(owner=user, title=text(title, 160, True), course=course,
            category='跨校试题', source_kind=kind, source_document_id=identity, source_meta=meta,
            questions=questions, review=report, raw_text=raw_text,
            extracted_pages=[{'page': 1, 'text': raw_text, 'method': 'source-assembly', 'pageKind': 'structured-text', 'blocks': []}],
            state='shelved' if report['passed'] else 'needs_review', shelved=timezone.now() if report['passed'] else None)
        QuestionRevision.objects.create(paper=paper, number=1, snapshot={'title': paper.title, 'course': course,
            'category': paper.category, 'questions': questions, 'review': report, 'state': paper.state, 'sourceMeta': meta})
    return dict(paper_data(paper), alreadyImported=False)



def collected_bank(bank_id):
    """Resolve only registered, revision-checked sources."""
    from .question_public_sources import _cached_bank, _source_questions
    if str(bank_id).startswith('ub-'):
        bank = _bank(bank_id)
        questions = _questions(bank)
    else:
        bank = _cached_bank(bank_id)
        questions = _source_questions(bank)
    return bank, questions


def collected_catalogue(user):
    require(user)
    from types import SimpleNamespace
    from university_question_bank import load_catalogue
    from learning_sources_robot import get_learning_sources
    from .question_robot import material_profile
    import_ids = [b.get('id') for b in load_catalogue(_folder()).get('questionBanks', [])]
    general_folder = Path(getattr(settings, 'LEARNING_SOURCES_DATA_DIR', os.environ.get('CAMPUS_DATA_DIR', Path(__file__).resolve().parents[1] / '.data')))
    import_ids += [b.get('id') for b in get_learning_sources(general_folder).get('questionBanks', [])]
    items, errors = [], []
    for identifier in dict.fromkeys(import_ids):
        try:
            bank, questions = collected_bank(identifier)
            course = bank.get('course') or ('心理学（开放教材，非校内课程）' if bank.get('scope') == 'general-topic' else '待归类')
            profile = material_profile(SimpleNamespace(source_meta={'sources': [bank]}, course=course,
                state='needs_review', review=bank.get('review') or {}, questions=questions))
            items.append({'id': bank['id'], 'title': bank['title'], 'course': course,
                'questionCount': len(questions), 'classification': profile,
                'sourceUrl': bank.get('sourceUrl', ''), 'license': bank.get('license', ''),
                'checkedAt': bank.get('checkedAt'), 'revision': bank.get('revision') or bank.get('commit'),
                'state': 'needs_review', 'private': True})
        except Problem as error:
            errors.append({'id': identifier, 'reason': error.message})
    return {'banks': items, 'errors': errors, 'scope': '本机已采集题库，未进行人工学科复核；不需要先导入题目工坊才能浏览下载。'}


def collected_export(user, bank_id, format):
    require(user, verified=True)
    from types import SimpleNamespace
    from .question_robot import render_text
    bank, questions = collected_bank(bank_id)
    if format == 'json':
        return json.dumps({'title': bank['title'], 'questions': questions, 'source': bank,
            'reviewState': 'needs_review', 'answerCorrectnessVerified': False}, ensure_ascii=False, indent=2)
    paper = SimpleNamespace(title=bank['title'], course=bank.get('course') or '通识拓展',
        state='needs_review', revision=bank.get('revision') or bank.get('commit', ''),
        source_meta={'sources': [bank]}, questions=questions, review=bank.get('review') or {})
    return render_text(paper)


def import_bank(user, bank_id):
    require(user, verified=True)
    bank = _bank(bank_id)
    questions = _questions(bank)
    return _create(user, bank['title'], [bank], questions, bank['id'] + '@' + bank.get('revision', bank['sha256']), 'university')


def compose(user, body):
    require(user, verified=True)
    identifiers = body.get('bankIds')
    if not isinstance(identifiers, list) or not 1 <= len(identifiers) <= 20 or any(not isinstance(b, str) for b in identifiers) or len(set(identifiers)) != len(identifiers):
        raise Problem('请选择 1–20 份不同的来源资料。')
    banks = [_bank(identifier) for identifier in identifiers]
    indexed = {b['id']: {q['id']: q for q in _questions(b)} for b in banks}
    selection = body.get('questionIds')
    if selection is None:
        selection = [{'bankId': b['id'], 'questionId': qid} for b in banks for qid in indexed[b['id']]]
    if not isinstance(selection, list) or not 1 <= len(selection) <= 200:
        raise Problem('每份试卷请选择 1–200 道题目。')
    questions, seen, used = [], set(), set()
    for item in selection:
        if not isinstance(item, dict) or not isinstance(item.get('bankId'), str) or not isinstance(item.get('questionId'), str):
            raise Problem('选题格式不正确。')
        bank_id, question_id = item['bankId'], item['questionId']
        question = indexed.get(bank_id, {}).get(question_id)
        if not question:
            raise Problem('选中的题目已变化，请刷新来源后重新选择。', 409)
        identity = (bank_id, question_id)
        if identity in seen:
            raise Problem('同一道题不能重复加入。')
        seen.add(identity); used.add(bank_id)
        questions.append(question)
    banks = [b for b in banks if b['id'] in used]
    title = text(body.get('title') or '我的跨校练习', 160, True)
    identity = 'mix-' + hashlib.sha256(json.dumps({'title': title, 'selection': selection,
        'revisions': [(b['id'], b.get('revision', b['sha256'])) for b in banks]}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return _create(user, title, banks, questions, identity, 'assembled')
