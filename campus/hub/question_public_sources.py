"""Import a registered licensed bank into one owner's private question shelf.

Only the server's bounded collector cache is accepted. Client requests contain a
bank ID, never replacement questions, answers, filesystem paths or course claims.
"""
import copy
import hashlib
import os
from pathlib import Path
import re
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from .core import Problem, require, text
from .models import Member
from .question_models import QuestionPaper, QuestionRevision
from .question_pipeline import self_review, validate_questions
from .question_robot import paper_data

BANK_ID = 'openstax-psychology2e-ch1'
COURSE = '心理学（开放教材，非校内课程）'
CATEGORY = '通识拓展'
SOURCE_KIND = 'open-source'
REPOSITORY = 'https://github.com/openstax/osbooks-psychology'
LICENSE = 'CC BY-NC-SA 4.0'
LICENSE_URL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/'


def _cached_bank(bank_id):
    from learning_sources_robot import get_learning_sources
    identifier = text(bank_id, 100, True)
    if identifier != BANK_ID:
        raise Problem('该开放题库尚未收录。', 404)
    default = Path(__file__).resolve().parents[1] / '.data'
    folder = Path(getattr(settings, 'LEARNING_SOURCES_DATA_DIR', os.environ.get('CAMPUS_DATA_DIR', default)))
    cache = get_learning_sources(folder)
    matching = [bank for bank in cache.get('questionBanks', []) if isinstance(bank, dict) and bank.get('id') == identifier]
    if len(matching) != 1:
        raise Problem('开放题库尚未完成采集，请稍后再试。', 404)
    bank = matching[0]
    if bank.get('sourceUrl') != REPOSITORY or bank.get('license') != LICENSE or bank.get('licenseUrl') != LICENSE_URL or not re.fullmatch(r'[a-f0-9]{40}', str(bank.get('commit', ''))):
        raise Problem('来源或许可凭据不完整，暂不能导入。', 409)
    if not bank.get('attribution') or not bank.get('changes') or not bank.get('checkedAt'):
        raise Problem('来源署名或核对记录不完整，暂不能导入。', 409)
    if bank.get('schoolCourseId') or bank.get('scope') != 'general-topic':
        raise Problem('该通识材料不能自动认定为校内课程。', 409)
    if not isinstance(bank.get('questions'), list) or not 1 <= len(bank['questions']) <= 24:
        raise Problem('开放题库题目数量不正确。', 409)
    return bank


def _source_questions(bank):
    originals = []
    source_ids = set()
    prefix = REPOSITORY + '/blob/' + bank['commit'] + '/modules/'
    for index, question in enumerate(bank['questions']):
        if not isinstance(question, dict):
            raise Problem('开放题库题目结构不完整。', 409)
        source_id = question.get('id')
        source_url = question.get('sourceUrl')
        if not isinstance(source_id, str) or not source_id or source_id in source_ids or not isinstance(source_url, str) or not source_url.startswith(prefix):
            raise Problem('题目来源标识不完整或重复。', 409)
        source_ids.add(source_id)
        if question.get('type') != 'single-choice' or not isinstance(question.get('options'), list) or not 2 <= len(question['options']) <= 8:
            raise Problem('开放题库选项结构不完整。', 409)
        options = []
        for number, option in enumerate(question['options']):
            label = chr(65 + number)
            if not isinstance(option, dict) or option.get('id') != label or not isinstance(option.get('text'), str):
                raise Problem('开放题库选项标号不完整。', 409)
            options.append({'label': label, 'text': option['text']})
        answer = question.get('answer', '')
        has_key = question.get('answerStatus') == 'source-provided' and isinstance(answer, str) and answer in {option['label'] for option in options}
        originals.append({'id': hashlib.sha256(source_id.encode()).hexdigest()[:32], 'number': str(index + 1),
            'stem': question.get('question', ''), 'options': options, 'type': 'choice',
            'answer': answer if has_key else '', 'answerStatus': 'source_unverified' if has_key else 'unknown',
            'explanation': '', 'confirmed': False, 'allowUnknownAnswer': False, 'confidence': None,
            'knowledgePoints': [], 'segmentationUncertain': False,
            'source': {'method': 'source-xml', 'pages': [], 'regions': [], 'sourceUrl': source_url,
                       'literalText': question.get('literalText') is True,
                       'requiresLayoutReview': question.get('literalText') is not True,
                       'questionId': source_id, 'section': question.get('sourceSection', ''),
                       'module': question.get('sourceModule', ''), 'answerStatus': 'source-provided' if has_key else 'missing',
                       'bankId': bank['id'], 'commit': bank['commit'], 'license': LICENSE}})
    try:
        return validate_questions(originals, originals)
    except ValueError as exc:
        raise Problem(str(exc), 409)


def import_bank(user, bank_id):
    require(user, verified=True)
    bank = _cached_bank(bank_id)
    identity = bank['id'] + '@' + bank['commit']
    with transaction.atomic():
        # The owner row serializes same-owner imports on databases supporting row locks;
        # this app's SQLite configuration uses IMMEDIATE transactions as well.
        Member.objects.select_for_update().get(pk=user.pk)
        existing = QuestionPaper.objects.filter(owner=user, source_kind=SOURCE_KIND, source_document_id=identity).first()
        if existing:
            return dict(paper_data(existing), alreadyImported=True)
        source_questions = _source_questions(bank)
        extraction_issues = [{'code': 'source_layout_review', 'blocking': True,
            'message': '第 ' + question['number'] + ' 题的原始 XML 含公式、图表或未核对结构，请对照来源核对。'}
            for question in source_questions if question['source']['requiresLayoutReview']]
        questions, report = self_review(source_questions, extraction_issues, COURSE, CATEGORY)
        source_blocks = [bank['title'], bank['attribution'], LICENSE + ' · ' + LICENSE_URL, bank['sourceUrl']]
        for question in questions:
            lines = [question['number'] + '. ' + question['stem']]
            lines.extend(option['label'] + '. ' + option['text'] for option in question['options'])
            if question['answer']:
                lines.append('Source answer: ' + question['answer'])
            lines.append('Source: ' + question['source']['sourceUrl'])
            source_blocks.append('\n'.join(lines))
        raw_text = '\n\n'.join(source_blocks)
        extracted_pages = [{'page': 1, 'text': raw_text, 'method': 'source-xml',
                            'pageKind': 'structured-text', 'sourceUrl': bank['sourceUrl'],
                            'sourceCommit': bank['commit'], 'blocks': []}]
        meta = {key: copy.deepcopy(bank.get(key)) for key in ('title', 'license', 'licenseUrl', 'attribution', 'changes', 'sourceUrl', 'readerUrl', 'commit', 'checkedAt', 'keyTerms', 'language', 'notice')}
        meta.update(name=bank['title'], bankId=bank['id'], schoolCourseId='', scope='general-topic',
                    engine='official-cnxml', offline=True, extractionIssues=extraction_issues, originalPageNumbers=False,
                    sourceStale=bool(bank.get('stale')), answerProvenance='source-provided where available; not independently solved')
        paper = QuestionPaper.objects.create(owner=user, title=text(bank.get('title', ''), 160, True),
            course=COURSE, category=CATEGORY, source_kind=SOURCE_KIND, source_document_id=identity,
            source_meta=meta, questions=questions, review=report, raw_text=raw_text, extracted_pages=extracted_pages,
            state='shelved' if report['passed'] else 'needs_review',
            shelved=timezone.now() if report['passed'] else None)
        QuestionRevision.objects.create(paper=paper, number=paper.revision,
            snapshot={'title': paper.title, 'course': paper.course, 'category': paper.category,
                      'questions': paper.questions, 'review': paper.review, 'state': paper.state,
                      'sourceMeta': paper.source_meta})
    return dict(paper_data(paper), alreadyImported=False)
