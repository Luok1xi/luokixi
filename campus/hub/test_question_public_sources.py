"""All source-bank import tests use private isolated users and cached fixtures."""
import copy
import json
from pathlib import Path
import tempfile
from django.contrib.auth.models import AnonymousUser
from django.test import TestCase, override_settings
from .core import Problem
from .models import Entry, GuideCourse, Job, Member
from .question_models import QuestionPaper, QuestionRevision
from .question_public_sources import BANK_ID, import_bank
from .question_robot import get_paper, list_papers, update_paper

COMMIT = 'a' * 40
REPOSITORY = 'https://github.com/openstax/osbooks-psychology'


def cache_data():
    bank = {'id': BANK_ID, 'title': 'Psychology 2e · Chapter 1', 'scope': 'general-topic',
            'schoolCourseId': '', 'language': 'en', 'license': 'CC BY-NC-SA 4.0',
            'licenseUrl': 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
            'attribution': 'OpenStax, Rice University, Psychology 2e.',
            'changes': 'Structured text extraction; whitespace normalized.',
            'sourceUrl': REPOSITORY, 'readerUrl': 'https://openstax.org/books/psychology-2e/pages/1-introduction',
            'commit': COMMIT, 'checkedAt': '2026-10-07T00:00:00Z',
            'questions': [{'id': 'fixture-source-id', 'type': 'single-choice', 'question': 'Which option appears in the source?',
                'options': [{'id': 'A', 'text': 'First option'}, {'id': 'B', 'text': 'Second option'}],
                'answer': 'B', 'answerStatus': 'source-provided', 'literalText': True, 'sourceUrl': REPOSITORY + '/blob/' + COMMIT + '/modules/m1/index.cnxml#q1',
                'sourceSection': 'Fixture section', 'sourceModule': 'm1'}],
            'keyTerms': [{'term': 'Test term', 'definition': 'Source definition', 'sourceUrl': REPOSITORY}]}
    return {'schemaVersion': 1, 'sources': [], 'questionBanks': [bank], 'report': {'state': 'ready'}}


class PublicSourceImportTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = Member.objects.create_user('source-owner', 'source-owner@example.invalid', email_verified=True)
        cls.other = Member.objects.create_user('source-other', 'source-other@example.invalid', email_verified=True, is_staff=True)
        cls.unverified = Member.objects.create_user('source-unverified', 'source-unverified@example.invalid')

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.setting = override_settings(LEARNING_SOURCES_DATA_DIR=Path(self.folder.name))
        self.setting.enable(); self.addCleanup(self.setting.disable)
        self.data = cache_data(); self.write_cache()

    def write_cache(self):
        (Path(self.folder.name) / 'learning-sources.json').write_text(json.dumps(self.data), encoding='utf-8')

    def test_source_keys_auto_shelf_privately_and_keep_license_and_terms(self):
        item = import_bank(self.owner, BANK_ID)
        self.assertEqual(item['state'], 'shelved'); self.assertEqual(item['visibility'], 'private')
        self.assertEqual(item['course'], '心理学（开放教材，非校内课程）')
        self.assertEqual(item['category'], '通识拓展')
        self.assertEqual(item['questions'][0]['answer'], 'B')
        self.assertEqual(item['questions'][0]['source']['method'], 'source-xml')
        self.assertEqual(item['questions'][0]['answerStatus'], 'source_unverified')
        self.assertFalse(item['review']['answerCorrectnessVerified'])
        self.assertEqual(item['sourceMeta']['license'], 'CC BY-NC-SA 4.0')
        self.assertIn('OpenStax', item['sourceMeta']['attribution'])
        self.assertEqual(item['sourceMeta']['commit'], COMMIT)
        self.assertEqual(item['sourceMeta']['keyTerms'][0]['definition'], 'Source definition')
        self.assertEqual(item['sourceMeta']['schoolCourseId'], '')
        self.assertIn('Which option appears in the source?', item['rawText'])
        self.assertIn('A. First option', item['rawText'])
        self.assertIn('Source answer: B', item['rawText'])
        self.assertIn(item['questions'][0]['source']['sourceUrl'], item['rawText'])
        self.assertEqual(item['extractedPages'][0]['method'], 'source-xml')
        self.assertEqual(item['extractedPages'][0]['pageKind'], 'structured-text')
        self.assertEqual(item['extractedPages'][0]['sourceCommit'], COMMIT)
        self.assertFalse(item['sourceMeta']['originalPageNumbers'])
        self.assertEqual(QuestionRevision.objects.get().snapshot['sourceMeta']['license'], 'CC BY-NC-SA 4.0')
        self.assertFalse(Entry.objects.exists()); self.assertFalse(GuideCourse.objects.exists()); self.assertFalse(Job.objects.exists())

    def test_import_is_idempotent_per_owner_and_pinned_commit(self):
        first = import_bank(self.owner, BANK_ID)
        again = import_bank(self.owner, BANK_ID)
        self.assertEqual(first['id'], again['id']); self.assertTrue(again['alreadyImported'])
        self.assertEqual(QuestionPaper.objects.count(), 1); self.assertEqual(QuestionRevision.objects.count(), 1)
        other = import_bank(self.other, BANK_ID)
        self.assertNotEqual(other['id'], first['id'])
        self.data['questionBanks'][0]['commit'] = 'b' * 40
        self.data['questionBanks'][0]['questions'][0]['sourceUrl'] = self.data['questionBanks'][0]['questions'][0]['sourceUrl'].replace(COMMIT, 'b' * 40)
        self.write_cache()
        self.assertNotEqual(import_bank(self.owner, BANK_ID)['id'], first['id'])

    def test_other_owner_or_staff_cannot_read_or_edit(self):
        paper = import_bank(self.owner, BANK_ID)
        self.assertEqual(list_papers(self.other)['papers'], [])
        for action in (lambda: get_paper(self.other, paper['id']), lambda: update_paper(self.other, paper['id'], {'revision': 1})):
            with self.assertRaises(Problem) as raised:
                action()
            self.assertEqual(raised.exception.status, 404)

    def test_missing_or_unverified_answers_remain_unknown_and_need_review(self):
        for answer, status in (('', 'missing'), ('B', 'model-generated'), ('Z', 'source-provided')):
            with self.subTest(answer=answer, status=status):
                QuestionPaper.objects.all().delete()
                self.data['questionBanks'][0]['questions'][0].update(answer=answer, answerStatus=status)
                self.write_cache()
                paper = import_bank(self.owner, BANK_ID)
                self.assertEqual(paper['state'], 'needs_review'); self.assertFalse(paper['review']['passed'])
                self.assertEqual(paper['questions'][0]['answer'], '')
                self.assertEqual(paper['questions'][0]['answerStatus'], 'unknown')

    def test_nonliteral_xml_requires_layout_review_even_if_flattened_text_looks_plain(self):
        self.data['questionBanks'][0]['questions'][0]['literalText'] = False
        self.write_cache()
        paper = import_bank(self.owner, BANK_ID)
        self.assertEqual(paper['state'], 'needs_review')
        self.assertIn('source_layout_review', [issue['code'] for issue in paper['review']['issues']])
        self.assertTrue(paper['questions'][0]['source']['requiresLayoutReview'])
        self.assertEqual(paper['questions'][0]['answer'], 'B')

    def test_source_provenance_and_license_fail_closed(self):
        for key, value in (('license', 'unknown'), ('sourceUrl', 'https://example.invalid'), ('commit', 'main'), ('schoolCourseId', 'invented-course')):
            self.data = cache_data(); self.data['questionBanks'][0][key] = value; self.write_cache()
            with self.subTest(key=key), self.assertRaises(Problem):
                import_bank(self.owner, BANK_ID)
        self.assertFalse(QuestionPaper.objects.exists())

    def test_unknown_bank_missing_cache_and_unverified_users_are_rejected(self):
        for user in (AnonymousUser(), self.unverified):
            with self.assertRaises(Problem): import_bank(user, BANK_ID)
        for identifier in ('unknown-bank', '../learning-sources.json', {'questions': []}):
            with self.assertRaises(Problem): import_bank(self.owner, identifier)
        self.data['questionBanks'] = []; self.write_cache()
        with self.assertRaises(Problem) as raised: import_bank(self.owner, BANK_ID)
        self.assertEqual(raised.exception.status, 404)
        self.assertFalse(QuestionPaper.objects.exists())

    def test_manual_edits_do_not_erase_licensed_provenance(self):
        paper = import_bank(self.owner, BANK_ID)
        questions = copy.deepcopy(paper['questions']); questions[0]['answer'] = 'A'
        changed = update_paper(self.owner, paper['id'], {'revision': 1, 'questions': questions})
        self.assertEqual(changed['sourceMeta']['license'], 'CC BY-NC-SA 4.0')
        self.assertEqual(changed['questions'][0]['answerStatus'], 'manual_unverified')
        self.assertIn('Source answer: B', changed['rawText'])
        self.assertNotIn('Source answer: A', changed['rawText'])
        self.assertEqual(changed['questions'][0]['source']['commit'], COMMIT)
        self.assertEqual(import_bank(self.owner, BANK_ID)['id'], paper['id'])
        self.assertEqual(QuestionPaper.objects.count(), 1)
