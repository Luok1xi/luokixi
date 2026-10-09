"""Private intake, provenance and self-review tests; all users/files are isolated fixtures."""
import hashlib
import json
import tempfile
import uuid
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
from django.test import Client, TestCase, SimpleTestCase, override_settings
from django.utils import timezone
from .core import Problem
from .models import Asset, Entry, Job, Member, Upload
from .question_models import QuestionPaper, QuestionRevision
from . import question_robot as robot, question_pipeline as pipeline, question_ocr as ocr


TEXT = '1. Which city is the capital of France?\nA. Paris\nB. Lyon\n答案：A\n解析：Paris is the capital.\n2. Name a prime number.\n答案：7'


class QuestionExportTests(TestCase):
    def setUp(self):
        self.owner = Member.objects.create_user('export-owner', 'export-owner@example.test', 'Isolated-export-521', email_verified=True)
        self.other = Member.objects.create_user('export-other', 'export-other@example.test', 'Isolated-export-522', email_verified=True)
        self.paper = QuestionPaper.objects.create(owner=self.owner, title='数据结构练习', course='数据结构',
            questions=[{'stem': '比较队列和栈', 'options': [], 'answer': '先进先出与后进先出',
                        'explanation': '', 'confirmed': False, 'knowledgePoints': ['栈'],
                        'source': {'sourceUrl': 'https://example.test/source'}}],
            raw_text='这是过时的识别文本', state='needs_review',
            source_meta={'sources': [{'schoolName': '示例大学', 'sourceUrl': 'https://example.test/source'}]})
        self.client.force_login(self.owner)

    def test_collected_bank_exports_directly_with_review_and_sources(self):
        bank = {'id': 'ub-' + 'a' * 24, 'title': '示例大学数据结构', 'course': '数据结构',
                'schoolName': '示例大学', 'sourceUrl': 'https://example.test/registered', 'license': '公开课程资料'}
        questions = self.paper.questions
        with patch('hub.question_university_sources.collected_bank', return_value=(bank, questions)):
            text_response = self.client.get('/api/hub/question-papers/collected/' + bank['id'] + '/text')
            json_response = self.client.get('/api/hub/question-papers/collected/' + bank['id'] + '/json')
        self.assertEqual(text_response.status_code, 200, text_response.content)
        text = text_response.content.decode('utf-8')
        self.assertIn('比较队列和栈', text)
        self.assertIn('示例大学', text)
        self.assertIn('https://example.test/registered', text)
        self.assertIn('needs_review', text)
        self.assertIn('private', text_response['Cache-Control'])
        self.assertEqual(json_response.status_code, 200)
        data = json.loads(json_response.content)
        self.assertFalse(data['answerCorrectnessVerified'])
        self.assertEqual(data['questions'], questions)

    def test_collected_export_requires_verified_account(self):
        visitor = Client()
        route = '/api/hub/question-papers/collected/ub-' + 'a' * 24 + '/text'
        self.assertEqual(visitor.get(route).status_code, 401)
        unverified = Member.objects.create_user('unverified-bank', 'unverified-bank@example.test', 'Isolated-export-599')
        visitor.force_login(unverified)
        with patch('hub.question_university_sources.collected_bank') as resolver:
            self.assertEqual(visitor.get(route).status_code, 403)
        resolver.assert_not_called()

    def test_text_export_uses_current_questions_and_keeps_chinese_and_citations(self):
        response = self.client.get(f'/api/hub/question-papers/{self.paper.pk}/text')
        self.assertEqual(response.status_code, 200)
        content = response.content.decode('utf-8')
        self.assertIn('比较队列和栈', content)
        self.assertIn('https://example.test/source', content)
        self.assertNotIn('过时的识别文本', content)
        self.assertEqual(response['Cache-Control'], 'private, no-store')

    def test_export_does_not_cross_owner_boundary(self):
        self.client.force_login(self.other)
        self.assertEqual(self.client.get(f'/api/hub/question-papers/{self.paper.pk}/text').status_code, 404)
        self.assertEqual(self.client.get(f'/api/hub/question-papers/{self.paper.pk}/json').status_code, 404)

    def test_classification_keeps_school_evidence_and_review_priority(self):
        profile = robot.paper_data(self.paper)['classification']
        self.assertEqual((profile['schools'], profile['discipline'], profile['priority']),
                         (['示例大学'], '计算机', '待核对'))
        self.paper.source_meta = {}
        self.assertEqual(robot.material_profile(self.paper)['schools'], [])


class QuestionPipelineTests(SimpleTestCase):
    def test_preserves_source_answers_and_multiline_choices(self):
        questions, issues = pipeline.parse_pages([{'page': 3, 'text': TEXT, 'method': 'pdf-text'}])
        self.assertEqual(len(questions), 2)
        self.assertEqual(questions[0]['options'][1], {'label': 'B', 'text': 'Lyon'})
        self.assertEqual(questions[0]['answer'], 'A')
        self.assertEqual(questions[0]['source']['pages'], [3])
        self.assertEqual(questions[0]['knowledgePoints'], [])
        checked, report = pipeline.self_review(questions, issues, 'English', '练习')
        self.assertTrue(report['passed'])
        self.assertFalse(report['answerCorrectnessVerified'])
        self.assertEqual(checked[0]['answerStatus'], 'source_unverified')

    def test_missing_answer_is_unknown_until_explicitly_allowed(self):
        questions, issues = pipeline.parse_pages([{'page': 1, 'text': '1. Explain photosynthesis.', 'method': 'manual'}])
        checked, report = pipeline.self_review(questions, issues, 'Biology', '练习')
        self.assertFalse(report['passed'])
        self.assertEqual(checked[0]['answerStatus'], 'unknown')
        questions[0].update(confirmed=True, allowUnknownAnswer=True)
        checked, report = pipeline.self_review(questions, issues, 'Biology', '练习')
        self.assertTrue(report['passed'])
        self.assertEqual(checked[0]['answer'], '')
        self.assertEqual(checked[0]['issues'][0]['code'], 'unknown_answer')

    def test_low_confidence_formula_and_broken_text_cannot_auto_shelf(self):
        questions, _ = pipeline.parse_pages([{'page': 2, 'text': '', 'method': 'ocr', 'blocks': [
            {'text': '1. Compute ∫ x² dx.', 'confidence': .63, 'bbox': [1, 2, 3, 4]},
            {'text': '答案：□', 'confidence': .98, 'bbox': [1, 5, 3, 8]}]}])
        checked, report = pipeline.self_review(questions, [], '数学', '练习')
        self.assertFalse(report['passed'])
        self.assertEqual(checked[0]['confidence'], .63)
        self.assertEqual({i['code'] for i in checked[0]['issues']}, {'low_confidence', 'formula_review', 'damaged_text'})

    def test_manual_edit_cannot_forge_provenance_confidence_or_review(self):
        questions, _ = pipeline.parse_pages([{'page': 8, 'text': TEXT, 'method': 'ocr'}])
        edited = [dict(questions[0], confidence=1, source={'method': 'manual'}, issues=[], knowledgePoints=['地理'])]
        checked = pipeline.validate_questions(edited, questions)
        self.assertEqual(checked[0]['source']['pages'], [8])
        self.assertEqual(checked[0]['source']['method'], 'ocr')
        self.assertIsNone(checked[0]['confidence'])
        self.assertEqual(checked[0]['knowledgePoints'], ['地理'])

    def test_delete_add_and_reorder_are_explicit_edits(self):
        questions, _ = pipeline.parse_pages([{'page': 1, 'text': TEXT, 'method': 'manual'}])
        edited = pipeline.validate_questions([questions[1], {'id': 'user-added', 'stem': 'Name a color.', 'answer': 'red'}], questions)
        self.assertEqual(edited[0]['number'], '1')
        self.assertEqual(edited[1]['source']['method'], 'manual-edit')
        _, report = pipeline.self_review(edited, [], 'English', '练习')
        self.assertFalse(report['passed'])

    def test_option_answer_mismatch_and_unclassified_block_shelving(self):
        questions, _ = pipeline.parse_pages([{'page': 1, 'text': TEXT.replace('答案：A', '答案：C'), 'method': 'manual'}])
        checked, report = pipeline.self_review(questions)
        self.assertFalse(report['passed'])
        self.assertIn('answer_option_mismatch', [i['code'] for i in checked[0]['issues']])
        self.assertIn('classification_missing', [i['code'] for i in report['issues']])

    def test_page_and_question_resource_caps(self):
        for pages in ([True], [-1], list(range(1, 14)), '1-5'):
            with self.assertRaises(ocr.ExtractionError):
                ocr.page_selection(pages)
        with self.assertRaises(ValueError):
            pipeline.validate_questions([{'stem': 'x'}] * 201)

    def test_exam_instructions_and_section_headings_are_not_questions(self):
        raw = '数学试卷\n注意事项\n1. 请填写姓名。\n2. 请按要求作答。\n一、单项选择题\n1. Which color is red?\nA. Red\nB. Blue\n答案：A\n二、填空题\n1. Name a prime.\n答案：7\n三、（10分）计算这个行列式。'
        questions, issues = pipeline.parse_pages([{'page': 1, 'text': raw, 'method': 'pdf-text'}])
        self.assertEqual(len(questions), 3)
        self.assertNotIn('请填写姓名', questions[0]['stem'])
        self.assertEqual(questions[-1]['number'], '三')
        self.assertIn('行列式', questions[-1]['stem'])
        self.assertEqual(issues, [])

    def test_verified_literal_xml_fraction_is_not_an_ocr_formula_error(self):
        questions, _ = pipeline.parse_pages([{'page': 1, 'text': '1. Select a proportion.\nA. 1/3\nB. 2/3\n答案：B', 'method': 'source-xml'}])
        _, original = pipeline.self_review(questions, [], 'General studies', '练习')
        self.assertFalse(original['passed'])
        questions[0]['source']['literalText'] = True
        _, native = pipeline.self_review(questions, [], 'General studies', '练习')
        self.assertTrue(native['passed'])
        modified = [dict(questions[0], stem='Select a new proportion.')]
        modified = pipeline.validate_questions(modified, questions)
        _, edited = pipeline.self_review(modified, [], 'General studies', '练习')
        self.assertFalse(edited['passed'])

    def test_only_explicit_source_knowledge_points_are_preserved(self):
        questions, _ = pipeline.parse_pages([{'page': 1, 'text': '1. 什么是条件反射？\n考点：经典条件作用、消退\n答案：后天建立的反射。\n2. 什么是记忆？', 'method': 'manual'}])
        self.assertEqual(questions[0]['knowledgePoints'], ['经典条件作用', '消退'])
        self.assertNotIn('考点', questions[0]['stem'])
        self.assertEqual(questions[1]['knowledgePoints'], [])


class QuestionWorkshopTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = Member.objects.create_user('question-owner', 'question-owner@example.invalid', is_staff=True, email_verified=True)
        cls.other = Member.objects.create_user('question-other', 'question-other@example.invalid', is_staff=True, email_verified=True)

    def make(self, **kwargs):
        return robot.create_paper(self.owner, dict(sourceKind='text', text=TEXT, title='Private fixture', course='English', category='练习', **kwargs))

    def test_private_job_runs_and_shelves_without_public_entry(self):
        paper = self.make()
        self.assertEqual(paper['state'], 'queued')
        self.assertEqual(Job.objects.get(kind='question-process').payload, {'paperId': paper['id']})
        result = robot.run_paper(paper['id'])
        self.assertEqual(result['state'], 'shelved')
        detail = robot.get_paper(self.owner, paper['id'])
        self.assertEqual(detail['revision'], 2)
        self.assertEqual(detail['visibility'], 'private')
        self.assertFalse(detail['review']['answerCorrectnessVerified'])
        self.assertEqual(QuestionRevision.objects.count(), 2)
        self.assertFalse(Entry.objects.exists())

    def test_other_owner_and_staff_cannot_read_or_edit(self):
        paper = self.make()
        for action in (lambda: robot.get_paper(self.other, paper['id']),
                       lambda: robot.update_paper(self.other, paper['id'], {'revision': 1}),
                       lambda: robot.source_preview(self.other, paper['id'])):
            with self.assertRaises(Problem) as raised:
                action()
            self.assertEqual(raised.exception.status, 404)
        self.assertEqual(robot.list_papers(self.other)['papers'], [])

    def test_version_conflict_and_edits_recheck(self):
        paper = self.make()
        robot.run_paper(paper['id'])
        detail = robot.get_paper(self.owner, paper['id'])
        detail['questions'][0]['stem'] = ''
        updated = robot.update_paper(self.owner, paper['id'], {'revision': 2, 'questions': detail['questions']})
        self.assertEqual(updated['state'], 'needs_review')
        with self.assertRaises(Problem) as raised:
            robot.update_paper(self.owner, paper['id'], {'revision': 2, 'questions': detail['questions']})
        self.assertEqual(raised.exception.status, 409)

    def test_intake_limits_three_active_jobs(self):
        for _ in range(3):
            self.make()
        with self.assertRaises(Problem) as raised:
            self.make()
        self.assertEqual(raised.exception.status, 429)

    def test_upload_must_belong_to_requesting_owner(self):
        asset = Asset.objects.create(sha256='0' * 64, size=1, extension='.png', path='test.png')
        upload = Upload.objects.create(owner=self.other, asset=asset, name='fixture.png')
        with self.assertRaises(Problem) as raised:
            robot.create_paper(self.owner, {'sourceKind': 'upload', 'uploadId': str(upload.pk), 'title': 'Fixture'})
        self.assertEqual(raised.exception.status, 404)

    def test_upload_traversal_and_changed_source_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder, override_settings(MEDIA_ROOT=Path(folder)):
            source = Path(folder) / 'sample.txt'
            source.write_text(TEXT, encoding='utf-8')
            asset = Asset.objects.create(sha256=hashlib.sha256(source.read_bytes()).hexdigest(), size=source.stat().st_size, extension='.txt', path='sample.txt')
            upload = Upload.objects.create(owner=self.owner, asset=asset, name='fixture.txt')
            paper = robot.create_paper(self.owner, {'sourceKind': 'upload', 'uploadId': str(upload.pk), 'title': 'Fixture'})
            asset.path = '../outside.txt'
            asset.save()
            self.assertEqual(robot.run_paper(paper['id'])['state'], 'failed')
            self.assertFalse(QuestionPaper.objects.get(pk=paper['id']).questions)

    def test_ocr_failure_is_explicit_and_never_fabricates_results(self):
        with tempfile.TemporaryDirectory() as folder, override_settings(MEDIA_ROOT=Path(folder)):
            source = Path(folder) / 'sample.png'
            source.write_bytes(b'fixture')
            asset = Asset.objects.create(sha256=hashlib.sha256(source.read_bytes()).hexdigest(), size=7, extension='.png', path='sample.png')
            upload = Upload.objects.create(owner=self.owner, asset=asset, name='fixture.png')
            paper = robot.create_paper(self.owner, {'sourceKind': 'upload', 'uploadId': str(upload.pk), 'title': 'Fixture'})
            with patch.object(ocr, 'extract_file', side_effect=ocr.ExtractionError('OCR unavailable')):
                result = robot.run_paper(paper['id'])
            self.assertEqual(result['state'], 'failed')
            self.assertEqual(robot.get_paper(self.owner, paper['id'])['questions'], [])
            fixed = robot.update_paper(self.owner, paper['id'], {'revision': 1, 'course': 'English', 'category': '练习',
                'questions': [{'stem': 'Name a color.', 'answer': 'red', 'confirmed': True}]})
            self.assertEqual(fixed['state'], 'shelved')

    def test_local_source_only_staff_with_trusted_resolver(self):
        self.owner.is_staff = False
        try:
            with self.assertRaises(Problem) as raised:
                robot.create_paper(self.owner, {'sourceKind': 'local', 'documentId': '123', 'title': 'Fixture'})
            self.assertEqual(raised.exception.status, 403)
        finally:
            self.owner.is_staff = True

    def test_stale_question_jobs_recover_without_touching_other_jobs(self):
        made = self.make()
        old = timezone.now() - timedelta(minutes=6)
        QuestionPaper.objects.filter(pk=made['id']).update(state='extracting', updated=old)
        job = Job.objects.get(kind='question-process')
        Job.objects.filter(pk=job.pk).update(state='running', attempts=1, updated=old)
        other = Job.objects.create(kind='source', key='untouched-source', state='running', due=old)
        Job.objects.filter(pk=other.pk).update(updated=old)
        self.assertEqual(robot.recover_stale_jobs(), 1)
        job.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual(job.state, 'queued')
        self.assertEqual(QuestionPaper.objects.get(pk=made['id']).state, 'queued')
        self.assertEqual(other.state, 'running')
        self.assertEqual(robot.run_paper(made['id'])['state'], 'shelved')

    def test_late_worker_result_cannot_overwrite_recovered_claim(self):
        made = self.make()
        original = pipeline.parse_pages
        def lose_claim(pages):
            QuestionPaper.objects.filter(pk=made['id']).update(state='queued', updated=timezone.now())
            return original(pages)
        with patch.object(pipeline, 'parse_pages', side_effect=lose_claim):
            result = robot.run_paper(made['id'])
        self.assertTrue(result['superseded'])
        self.assertEqual(QuestionPaper.objects.get(pk=made['id']).state, 'queued')
        self.assertEqual(QuestionPaper.objects.get(pk=made['id']).questions, [])

    def test_recovery_stops_after_three_interruptions_and_spares_active_jobs(self):
        made = self.make()
        job = Job.objects.get(kind='question-process')
        old = timezone.now() - timedelta(minutes=6)
        QuestionPaper.objects.filter(pk=made['id']).update(state='extracting', updated=old)
        Job.objects.filter(pk=job.pk).update(state='running', attempts=3, updated=old)
        self.assertEqual(robot.recover_stale_jobs(), 0)
        self.assertEqual(QuestionPaper.objects.get(pk=made['id']).state, 'failed')
        self.assertEqual(Job.objects.get(pk=job.pk).state, 'failed')
        fresh = self.make()
        QuestionPaper.objects.filter(pk=fresh['id']).update(state='extracting')
        current = Job.objects.get(payload__paperId=fresh['id'])
        Job.objects.filter(pk=current.pk).update(state='running')
        robot.recover_stale_jobs()
        self.assertEqual(QuestionPaper.objects.get(pk=fresh['id']).state, 'extracting')

    def test_worker_dispatch_recovers_question_job_and_finishes_it(self):
        from .worker import run_one
        made = self.make()
        old = timezone.now() - timedelta(minutes=6)
        QuestionPaper.objects.filter(pk=made['id']).update(state='extracting', updated=old)
        job = Job.objects.get(kind='question-process')
        Job.objects.filter(pk=job.pk).update(state='running', attempts=1, updated=old)
        self.assertTrue(run_one(('question-process',)))
        job.refresh_from_db()
        self.assertEqual(job.state, 'done')
        self.assertEqual(job.attempts, 2)
        self.assertEqual(QuestionPaper.objects.get(pk=made['id']).state, 'shelved')

    def test_worker_does_not_finalize_superseded_job_or_report_failed_ocr_done(self):
        from .worker import run_one
        made = self.make()
        job = Job.objects.get(kind='question-process')
        original = pipeline.parse_pages
        def lose_claim(pages):
            QuestionPaper.objects.filter(pk=made['id']).update(state='queued', updated=timezone.now())
            Job.objects.filter(pk=job.pk).update(state='queued', updated=timezone.now())
            return original(pages)
        with patch.object(pipeline, 'parse_pages', side_effect=lose_claim):
            self.assertTrue(run_one(('question-process',)))
        job.refresh_from_db()
        self.assertEqual(job.state, 'queued')
        with patch.object(robot, 'run_paper', return_value={'paperId': made['id'], 'state': 'failed', 'error': 'OCR unavailable'}):
            self.assertTrue(run_one(('question-process',)))
        job.refresh_from_db()
        self.assertEqual(job.state, 'failed')
        self.assertEqual(job.error, 'OCR unavailable')

    def test_question_endpoints_auth_unknown_id_and_owner_isolation(self):
        self.assertEqual(self.client.get('/api/hub/question-papers').status_code, 401)
        self.assertEqual(self.client.get('/api/hub/question-papers/capabilities').status_code, 200)
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get('/api/hub/question-papers/not-a-uuid').status_code, 404)
        self.assertEqual(self.client.get('/api/hub/question-papers/' + str(uuid.uuid4())).status_code, 404)
        created = self.client.post('/api/hub/question-papers', json.dumps({'sourceKind': 'text', 'title': 'API fixture',
            'course': 'English', 'category': '练习', 'text': TEXT}), content_type='application/json')
        self.assertEqual(created.status_code, 200, created.content)
        paper_id = created.json()['id']
        robot.run_paper(paper_id)
        self.client.force_login(self.other)
        for route in (f'/api/hub/question-papers/{paper_id}', f'/api/hub/question-papers/{paper_id}/source?page=1'):
            self.assertEqual(self.client.get(route).status_code, 404)
        self.assertEqual(self.client.post(f'/api/hub/question-papers/{paper_id}', '{}', content_type='application/json').status_code, 404)

    def test_question_endpoint_csrf_and_source_preview(self):
        guarded = Client(enforce_csrf_checks=True)
        guarded.force_login(self.owner)
        self.assertEqual(guarded.post('/api/hub/question-papers', '{}', content_type='application/json').status_code, 403)
        token = guarded.get('/api/hub/auth/session').json()['csrfToken']
        response = guarded.post('/api/hub/question-papers', json.dumps({'sourceKind': 'text', 'text': TEXT, 'title': 'CSRF fixture'}),
            content_type='application/json', HTTP_X_CSRFTOKEN=token)
        self.assertEqual(response.status_code, 200, response.content)
        with tempfile.TemporaryDirectory() as folder, override_settings(MEDIA_ROOT=Path(folder)):
            from PIL import Image
            source = Path(folder) / 'preview.png'
            Image.new('RGB', (30, 20), 'white').save(source)
            asset = Asset.objects.create(sha256=hashlib.sha256(source.read_bytes()).hexdigest(), size=source.stat().st_size,
                                         extension='.png', path='preview.png')
            upload = Upload.objects.create(owner=self.owner, asset=asset, name='preview.png')
            paper = robot.create_paper(self.owner, {'sourceKind': 'upload', 'uploadId': str(upload.pk), 'title': 'Preview fixture'})
            with patch.object(ocr, 'preview_file', return_value=b'\x89PNG\r\n\x1a\nfixture') as render:
                response = guarded.get(f'/api/hub/question-papers/{paper["id"]}/source?page=1')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response['Content-Type'], 'image/png')
                self.assertEqual(response['Cache-Control'], 'private, no-store')
                render.assert_called_once()

    def test_explicit_false_revokes_source_coverage_and_omission_preserves_it(self):
        paper = robot.create_paper(self.owner, {'sourceKind': 'text', 'title': 'Coverage fixture',
            'text': 'Unassigned source passage\n' + TEXT, 'course': 'English', 'category': '练习'})
        robot.run_paper(paper['id'])
        self.client.force_login(self.owner)
        current = robot.get_paper(self.owner, paper['id'])
        self.assertEqual(current['state'], 'needs_review')
        for confirmation, expected in ((True, 'shelved'), (None, 'shelved'), (False, 'needs_review'), (None, 'needs_review')):
            payload = {'revision': current['revision'], 'questions': current['questions']}
            if confirmation is not None:
                payload['confirmSourceCoverage'] = confirmation
            response = self.client.post(f'/api/hub/question-papers/{paper["id"]}', json.dumps(payload), content_type='application/json')
            self.assertEqual(response.status_code, 200, response.content)
            current = response.json()
            self.assertEqual(current['state'], expected)
            self.assertEqual(current['sourceMeta']['sourceCoverageConfirmed'], expected == 'shelved')
            original = current['sourceMeta']['extractionIssues']
            self.assertTrue(original[0]['blocking'])
        refreshed = self.client.get(f'/api/hub/question-papers/{paper["id"]}').json()
        self.assertFalse(refreshed['sourceMeta']['sourceCoverageConfirmed'])
        self.assertTrue(refreshed['review']['issues'][0]['blocking'])
