import copy
import json
from pathlib import Path
import tempfile
from django.contrib.auth.models import AnonymousUser
from django.test import TestCase, override_settings
from .core import Problem
from .models import Member, Entry, Job
from .question_models import QuestionPaper
from .question_university_sources import compose, import_bank
from .question_robot import get_paper, update_paper


def catalogue():
    banks, resources, sources, schools = [], [], [], []
    for index, school in enumerate(('fixture-a', 'fixture-b')):
        bid = 'ub-' + str(index + 1) * 24
        sha = str(index + 1) * 64
        url = 'https://example.invalid/' + school + '/exam'
        rights = {'mode': 'private-study', 'access': 'public', 'license': 'file-level-review'}
        source = {'bankId': bid, 'sourceId': school, 'sha256': sha, 'schoolId': school, 'sourceUrl': url,
                  'method': 'source-mdx', 'originalNumber': '7', 'pages': [], 'regions': []}
        questions = [{'id': school + '-q', 'number': '1', 'stem': 'Fixture question ' + school,
                      'options': [], 'answer': '', 'answerStatus': 'unknown', 'source': source}]
        banks.append({'id': bid, 'sourceId': school, 'resourceId': school + '-r', 'schoolId': school,
            'title': school + ' exam', 'sourceUrl': url, 'sha256': sha, 'revision': sha, 'rights': rights,
            'course': '线性代数', 'license': 'file-level-review', 'questions': questions, 'questionCount': 1})
        resources.append({'id': school + '-r', 'sourceId': school, 'bankId': bid, 'sha256': sha, 'sourceUrl': url, 'rights': rights})
        sources.append({'id': school, 'schoolId': school, 'rights': rights})
        schools.append({'id': school, 'name': school})
    return dict(banks=banks, sources=sources, resources=resources, schools=schools)


class UniversityAssemblyTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = Member.objects.create_user('uni-owner', 'uni-owner@example.invalid', email_verified=True)
        cls.other = Member.objects.create_user('uni-other', 'uni-other@example.invalid', email_verified=True, is_staff=True)
        cls.unverified = Member.objects.create_user('uni-new', 'uni-new@example.invalid')

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.addCleanup(self.folder.cleanup)
        self.settings = override_settings(UNIVERSITY_SOURCES_DATA_DIR=self.folder.name)
        self.settings.enable(); self.addCleanup(self.settings.disable)
        self.data = catalogue(); self.write()

    def write(self):
        data = dict(self.data, questionBanks=self.data['banks'])
        (Path(self.folder.name) / 'university-sources.json').write_text(json.dumps(data), encoding='utf-8')

    def request(self):
        return {'bankIds': [b['id'] for b in self.data['banks']], 'title': '联合练习'}

    def test_compose_retains_per_question_source_and_unknown_answer(self):
        paper = compose(self.owner, self.request())
        self.assertEqual(paper['sourceKind'], 'assembled')
        self.assertEqual(paper['visibility'], 'private')
        self.assertEqual(paper['state'], 'needs_review')
        self.assertEqual(len(paper['questions']), 2)
        self.assertEqual(len(paper['sourceMeta']['sources']), 2)
        self.assertEqual(paper['questions'][1]['source']['schoolId'], 'fixture-b')
        self.assertEqual(paper['questions'][1]['source']['originalNumber'], '7')
        self.assertEqual(paper['questions'][1]['answerStatus'], 'unknown')
        self.assertFalse(paper['review']['answerCorrectnessVerified'])
        self.assertFalse(Entry.objects.exists()); self.assertFalse(Job.objects.exists())

    def test_source_selection_comes_only_from_cache_and_is_ordered(self):
        body = self.request()
        body['questionIds'] = [{'bankId': b['id'], 'questionId': b['questions'][0]['id'], 'stem': 'forged'} for b in reversed(self.data['banks'])]
        paper = compose(self.owner, body)
        self.assertEqual(paper['questions'][0]['source']['schoolId'], 'fixture-b')
        self.assertNotIn('forged', paper['rawText'])
        self.assertEqual(paper['questions'][0]['number'], '1')

    def test_repeat_import_and_compose_are_idempotent_per_owner(self):
        bid = self.data['banks'][0]['id']
        first = import_bank(self.owner, bid)
        self.assertEqual(first['id'], import_bank(self.owner, bid)['id'])
        self.assertNotEqual(first['id'], import_bank(self.other, bid)['id'])
        first = compose(self.owner, self.request())
        self.assertEqual(first['id'], compose(self.owner, self.request())['id'])

    def test_private_owner_boundary(self):
        paper = compose(self.owner, self.request())
        for action in (lambda: get_paper(self.other, paper['id']), lambda: update_paper(self.other, paper['id'], {'revision': 1})):
            with self.assertRaises(Problem) as caught: action()
            self.assertEqual(caught.exception.status, 404)
        for user in (AnonymousUser(), self.unverified):
            with self.assertRaises(Problem): compose(user, self.request())

    def test_reject_missing_duplicate_unknown_and_oversized_selection(self):
        body = self.request(); bank = self.data['banks'][0]
        item = {'bankId': bank['id'], 'questionId': bank['questions'][0]['id']}
        for selection in ([], [item, item], [item] * 201, [{'bankId': bank['id'], 'questionId': 'missing'}], ['bad']):
            with self.subTest(selection=str(selection)[:80]), self.assertRaises(Problem): compose(self.owner, dict(body, questionIds=selection))
        self.assertFalse(QuestionPaper.objects.exists())

    def test_refuse_stale_or_forged_provenance(self):
        original = copy.deepcopy(self.data)
        for target, key, value in [('banks', 'sha256', 'changed'), ('banks', 'sourceUrl', 'https://evil.invalid'), ('resources', 'bankId', 'wrong')]:
            self.data = copy.deepcopy(original); self.data[target][0][key] = value; self.write()
            with self.assertRaises(Problem): import_bank(self.owner, self.data['banks'][0]['id'])
        self.data = copy.deepcopy(original)
        self.data['banks'][0]['questions'][0]['source']['schoolId'] = 'wrong'; self.write()
        with self.assertRaises(Problem): compose(self.owner, self.request())

    def test_edit_cannot_overwrite_provenance(self):
        paper = import_bank(self.owner, self.data['banks'][0]['id'])
        questions = copy.deepcopy(paper['questions']); questions[0]['source']['schoolId'] = 'forged'
        questions[0]['answer'] = 'My draft'
        saved = update_paper(self.owner, paper['id'], {'revision': 1, 'questions': questions})
        self.assertEqual(saved['questions'][0]['source']['schoolId'], 'fixture-a')
        self.assertEqual(saved['questions'][0]['answerStatus'], 'manual_unverified')

    def test_catalogue_does_not_serialize_questions_or_filesystem_paths(self):
        from university_question_bank import public_catalogue
        self.data['resources'][0]['downloadedPath'] = 'private/original.pdf'; self.write()
        data = public_catalogue(self.folder.name)
        self.assertNotIn('questions', data['questionBanks'][0])
        self.assertNotIn('downloadedPath', data['resources'][0])

    def test_parser_upgrade_creates_new_draft_without_overwriting_old(self):
        bank = self.data['banks'][0]
        old = import_bank(self.owner, bank['id'])
        bank['revision'] += '-v4'; self.write()
        new = import_bank(self.owner, bank['id'])
        self.assertNotEqual(new['id'], old['id'])
        self.assertEqual(get_paper(self.owner, old['id'])['revision'], 1)

    def test_compressed_catalogue_is_cached_and_invalidated_by_file_change(self):
        import gzip
        from university_question_bank import catalogue_response
        first, tag = catalogue_response(self.folder.name, True)
        self.assertNotIn('questions', json.loads(gzip.decompress(first))['questionBanks'][0])
        self.assertEqual((first, tag), catalogue_response(self.folder.name, True))
        self.data['banks'][0]['title'] = 'Changed source title'; self.write()
        changed, new_tag = catalogue_response(self.folder.name, True)
        self.assertNotEqual(tag, new_tag)
        self.assertIn('Changed source title', gzip.decompress(changed).decode())
