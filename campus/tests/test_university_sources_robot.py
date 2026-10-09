"""Isolated crawler fixtures: no real website, database or credentials are touched."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import university_sources_robot as robot
from source_classification import classify, link_suites

COMMIT = 'a' * 40
TREE = 'b' * 40


def source(identifier='test-university', school='test'):
    return {'id': identifier, 'name': 'Fixture public course sharing', 'type': 'github',
            'repo': 'fixture/' + identifier, 'branch': 'main',
            'school': {'id': school, 'name': school, 'tier': '211'}, 'groups': ['211'],
            'rights': {'mode': 'private-study', 'access': 'public', 'reuse': 'needs-review'}}


def entry(path='高等数学/2024/期末A卷.txt', raw=None):
    raw = raw or '1. 计算题：求定积分。\n2. 证明题：证明数列极限存在。'.encode()
    return {'path': path, 'type': 'blob', 'size': len(raw),
            'sha': hashlib.sha1(('blob ' + str(len(raw)) + '\0').encode() + raw).hexdigest()}, raw


class FakeWeb:
    def __init__(self, sources, entries=None):
        self.calls, self.routes = [], {}
        self.routes['https://api.github.com/robots.txt'] = (200, b'User-agent: *\nAllow: /')
        self.routes['https://raw.githubusercontent.com/robots.txt'] = (200, b'User-agent: *\nAllow: /')
        for item in sources:
            if item['type'] != 'github':
                continue
            api = 'https://api.github.com/repos/' + item['repo']
            files = entries or [entry()]
            self.routes[api + '/commits/main'] = (200, json.dumps({'sha': COMMIT, 'commit': {'tree': {'sha': TREE}}}).encode())
            self.routes[api + '/git/trees/' + TREE + '?recursive=1'] = (200, json.dumps({'tree': [row for row, raw in files], 'truncated': False}, ensure_ascii=False).encode())
            for row, raw in files:
                url = 'https://raw.githubusercontent.com/' + item['repo'] + '/' + COMMIT + '/' + robot.quote(row['path'], safe='/')
                self.routes[url] = (200, raw)

    def __call__(self, target, *, policy, limit, headers, deadline=None):
        policy.validate(target)
        self.calls.append((target, headers))
        status, raw = self.routes.get(target, (404, b''))
        if len(raw) > limit:
            raise robot.CollectorError('response-too-large')
        if headers.get('If-None-Match') == '"fixture"' and status == 200:
            return b'', {'etag': '"fixture"'}, target, 304
        return raw, {'etag': '"fixture"'}, target, status


class ClassificationTests(unittest.TestCase):
    def setUp(self):
        self.source = source()

    def test_school_identity_is_only_registered_source(self):
        result = classify('清华大学/北京大学/高数/2024期末A卷.pdf', self.source)
        self.assertEqual(result['schoolId'], 'test')
        self.assertEqual(result['course'], '高等数学')
        self.assertEqual(result['classificationEvidence'][0]['origin'], 'registered-source')

    def test_ambiguous_course_is_not_guessed(self):
        result = classify('高等数学与线性代数/综合试题.pdf', self.source)
        self.assertEqual(result['course'], 'unknown')
        self.assertIn('course-ambiguous', result['classificationIssues'])

    def test_english_alias_has_word_boundaries(self):
        self.assertEqual(classify('notes/statistical-learning.md', self.source)['course'], 'unknown')
        self.assertEqual(classify('Linear Algebra/Exam.pdf', self.source)['course'], '线性代数')

    def test_explicit_course_and_college_aliases(self):
        self.source['courseAliases'] = {'高等数学A': ['MA101']}
        self.source['collegeAliases'] = {'数学学院': ['School of Math']}
        result = classify('School of Math/MA101/2023fall/exam.pdf', self.source)
        self.assertEqual(result['course'], '高等数学A')
        self.assertEqual(result['college'], '数学学院')

    def test_course_hints_only_match_actual_file_path(self):
        self.source['courseHints'] = ['电磁场理论']
        self.assertEqual(classify('电磁场理论/期末.pdf', self.source)['course'], '电磁场理论')
        self.assertEqual(classify('unrelated/期末.pdf', self.source)['course'], 'unknown')

    def test_registered_course_directory_recognizes_specific_courses(self):
        self.source['coursePathTemplates'] = ['课程目录/{course}/**']
        result = classify('课程目录/半导体物理/历年试卷/2024期末A卷.pdf', self.source)
        self.assertEqual(result['course'], '半导体物理')
        self.assertTrue(any(item['origin'] == 'registered-course-directory' for item in result['classificationEvidence']))
        self.assertEqual(classify('somewhere/半导体物理/期末.pdf', self.source)['course'], 'unknown')

    def test_directory_keeps_laboratory_and_theory_courses_separate(self):
        self.source['coursePathTemplates'] = ['{course}/**']
        theory = classify('大学物理/2024期末A卷.pdf', self.source)
        laboratory = classify('大学物理实验/2024期末A卷答案.pdf', self.source)
        self.assertNotEqual(theory['course'], laboratory['course'])
        self.assertNotEqual(theory['suiteKey'], laboratory['suiteKey'])

    def test_templates_do_not_make_assets_into_a_course(self):
        self.source['coursePathTemplates'] = ['{course}/**']
        self.assertEqual(classify('assets/random.png', self.source)['course'], 'unknown')

    def test_registered_academic_exam_directory_strips_year_and_paper_annotation(self):
        self.source.update(coursePathTemplates=['exams/{course}/**'], courseDirectoryFormat='academic-exam')
        result = classify('exams/25-26-2-现代密码学-期末（A卷）/index.mdx', self.source)
        self.assertEqual(result['course'], '现代密码学')
        self.assertEqual(result['year'], 2025)

    def test_body_mentions_do_not_assign_course(self):
        result = classify('anonymous.pdf', self.source, '我们使用高等数学和概率论。填空题：TCP 协议。')
        self.assertEqual(result['course'], 'unknown')
        self.assertIn('fill', result['questionTypes'])
        self.assertIn('网络协议', result['knowledgePoints'])

    def test_academic_year_mdx_convention(self):
        result = classify('exams/24-25-1-高等数学A（上）-期末/index.mdx', self.source)
        self.assertEqual(result['academicYear'], '2024-2025')
        self.assertEqual(result['year'], 2024)
        self.assertEqual(result['term'], '第一学期')

    def test_multiple_unrelated_years_remain_unknown(self):
        result = classify('高数/2018与2024考试.pdf', self.source)
        self.assertIsNone(result['year'])
        self.assertIn('year-ambiguous', result['classificationIssues'])

    def test_suite_requires_explicit_paper_code_and_school(self):
        exam = dict(classify('高等数学/2024/期末A卷.pdf', self.source), id='exam')
        answer = dict(classify('高等数学/2024/期末A卷答案.pdf', self.source), id='answer')
        other_school = dict(classify('高等数学/2024/期末A卷答案.pdf', source('another-source', 'other')), id='other')
        self.assertEqual(exam['suiteKey'], answer['suiteKey'])
        self.assertNotEqual(exam['suiteKey'], other_school['suiteKey'])
        linked = link_suites([exam, answer, other_school])
        self.assertEqual(linked[0]['relatedResourceIds'], ['answer'])
        self.assertEqual(linked[2]['relatedResourceIds'], [])
        self.assertIsNone(classify('高等数学/2024期末答案.pdf', self.source)['suiteKey'])

    def test_course_variants_never_merge_into_one_suite(self):
        upper = classify('高等数学A（上）/2024/期末A卷.pdf', self.source)
        lower = classify('高等数学A（下）/2024/期末A卷答案.pdf', self.source)
        self.assertEqual(upper['courseVariant'], 'A上')
        self.assertNotEqual(upper['suiteKey'], lower['suiteKey'])

    def test_spring_autumn_papers_and_no_answer_do_not_merge(self):
        spring = classify('课程目录/信号与系统/2020年春-期末考试-无答案-A卷.pdf', self.source)
        autumn = classify('课程目录/信号与系统/2020年秋-期末考试-有答案-A卷.pdf', self.source)
        self.assertEqual(spring['kind'], 'exam')
        self.assertEqual(autumn['kind'], 'answer')
        self.assertEqual(spring['term'], '第二学期')
        self.assertEqual(autumn['term'], '第一学期')
        self.assertNotEqual(spring['suiteKey'], autumn['suiteKey'])

    def test_multiple_same_paper_candidates_require_review(self):
        first = dict(classify('高等数学/2024/期末A卷.pdf', self.source), id='exam-1')
        second = dict(first, id='exam-2')
        answer = dict(classify('高等数学/2024/期末A卷答案.pdf', self.source), id='answer')
        linked = link_suites([first, second, answer])
        self.assertTrue(all(not resource['relatedResourceIds'] for resource in linked))
        self.assertTrue(all('suite-ambiguous' in resource['classificationIssues'] for resource in linked))


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.source = source()
        self.policy = robot.RegisteredTargets([self.source])

    def test_deny_unregistered_hosts_repos_and_mutating_paths(self):
        for target in ['https://localhost/a', 'https://127.0.0.1/a', 'http://api.github.com/repos/fixture/test-university',
                       'https://api.github.com/repos/other/repo/commits/main',
                       'https://api.github.com/repos/fixture/test-university/issues',
                       'https://api.github.com/repos/fixture/test-university/commits/main?token=secret',
                       'https://api.github.com/repos/fixture/test-university/commits/../other']:
            with self.subTest(target=target), self.assertRaises(robot.CollectorError):
                self.policy.validate(target)

    def test_deny_private_dns_before_connection(self):
        target = 'https://api.github.com/repos/fixture/test-university/commits/main'
        with patch.object(robot.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))]), patch.object(robot.socket, 'create_connection') as connect:
            with self.assertRaisesRegex(robot.CollectorError, 'non-public-address'):
                robot.fetch_public(target, policy=self.policy, limit=100)
            connect.assert_not_called()

    def test_raw_files_require_pinned_commit_and_safe_path(self):
        for suffix in ['main/file.pdf', COMMIT + '/../escape.pdf', COMMIT + '/folder%2ffile.pdf']:
            with self.assertRaises(robot.CollectorError):
                self.policy.validate('https://raw.githubusercontent.com/fixture/test-university/' + suffix)

    def test_disallowed_robots_stops_before_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = FakeWeb([self.source])
            web.routes['https://api.github.com/robots.txt'] = (200, b'User-agent: *\nDisallow: /')
            collector = robot.Collector([self.source], tmp, fetcher=web, delay=0)
            with self.assertRaisesRegex(robot.CollectorError, 'robots-disallowed'):
                collector.json('https://api.github.com/repos/fixture/test-university/commits/main')
            self.assertEqual(len(web.calls), 1)

    def test_etag_304_returns_verified_cached_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = FakeWeb([self.source])
            collector = robot.Collector([self.source], tmp, fetcher=web, delay=0)
            target = 'https://api.github.com/repos/fixture/test-university/commits/main'
            first = collector.json(target)
            second = collector.json(target)
            self.assertEqual(first, second)
            self.assertEqual(collector.cache_hits, 1)
            self.assertEqual(web.calls[-1][1]['If-None-Match'], '"fixture"')

    def test_retry_and_budget_counts_actual_requests(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = FakeWeb([self.source])
            target = 'https://api.github.com/repos/fixture/test-university/commits/main'
            web.routes[target] = (503, b'Busy')
            waits = []
            collector = robot.Collector([self.source], tmp, fetcher=web, delay=0, max_requests=3, sleep=waits.append)
            with self.assertRaisesRegex(robot.CollectorError, 'request-budget-exhausted'):
                collector.json(target)
            self.assertEqual(collector.count, 3)
            self.assertEqual(collector.retries, 2)
            self.assertTrue(waits)

    def test_official_allowlist_only_exact_registered_urls(self):
        official = {'type': 'official-page', 'url': 'https://math.example.edu/course/index.html',
                    'sampleFiles': [{'url': 'https://math.example.edu/course/hw01.pdf'}]}
        policy = robot.RegisteredTargets([official])
        policy.validate('https://math.example.edu/course/hw01.pdf')
        policy.validate('https://math.example.edu/robots.txt')
        with self.assertRaises(robot.CollectorError):
            policy.validate('https://math.example.edu/course/hw02.pdf')

    def test_slow_drip_response_observes_absolute_deadline(self):
        elapsed = [0.0]
        class Response:
            def read1(self, size):
                elapsed[0] += 0.75
                return b'x'
        connection = types.SimpleNamespace(sock=types.SimpleNamespace(settimeout=lambda value: None))
        with self.assertRaisesRegex(robot.CollectorError, 'response-time-budget-exhausted'):
            robot.read_response(Response(), connection, 1000, 2.0, clock=lambda: elapsed[0])
        self.assertLess(elapsed[0], 3)

    def test_streaming_byte_limit_remains_enforced(self):
        connection = types.SimpleNamespace(sock=None)
        response = types.SimpleNamespace(read1=lambda size: b'x' * size)
        with self.assertRaisesRegex(robot.CollectorError, 'response-too-large'):
            robot.read_response(response, connection, 9, 9999, clock=lambda: 0)


class RobotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.source = source()
        self.hook_patch = patch.dict(sys.modules, {'university_question_bank': None})
        self.hook_patch.start()

    def tearDown(self):
        self.hook_patch.stop()
        self.tmp.cleanup()

    def run_robot(self, sources=None, web=None, **kwargs):
        sources = sources or [self.source]
        web = web or FakeWeb(sources)
        collector = robot.Collector(sources, self.folder / 'state', fetcher=web, delay=0, sleep=lambda _: None,
                                    max_requests=kwargs.pop('max_requests', 30))
        instance = robot.UniversityRobot({'version': 1, 'sources': sources}, self.folder / 'catalogue.json',
                                         self.folder / 'state', collector=collector, **kwargs)
        return instance.run(), web

    def test_first_index_is_not_a_fake_download_or_question_bank(self):
        result, web = self.run_robot()
        self.assertEqual(len(result['resources']), 1)
        resource = result['resources'][0]
        self.assertEqual(resource['state'], 'indexed')
        self.assertIsNone(resource['sha256'])
        self.assertEqual(resource['questionCount'], 0)
        self.assertEqual(result['questionBanks'], [])
        self.assertEqual(result['runStats']['requests'], 3)

    def test_unchanged_commit_skips_tree_and_content(self):
        result, web = self.run_robot()
        web.calls.clear()
        second, _ = self.run_robot(web=web)
        self.assertEqual(second['runStats']['unchangedSources'], 1)
        self.assertEqual(len(web.calls), 2)
        self.assertFalse(any('/git/trees/' in call[0] for call in web.calls))

    def test_incremental_cursor_finishes_next_run_without_dropping_previous(self):
        files = [entry('高等数学/2024期末A卷.txt'), entry('线性代数/2024期末B卷.txt')]
        web = FakeWeb([self.source], files)
        first, _ = self.run_robot(web=web, max_resources=1)
        self.assertEqual(len(first['resources']), 1)
        self.assertEqual(first['sources'][0]['status'], 'partial')
        second, _ = self.run_robot(web=web, max_resources=1)
        self.assertEqual(len(second['resources']), 2)
        self.assertEqual(second['sources'][0]['status'], 'indexed')

    def test_classification_registry_change_reindexes_unchanged_commit(self):
        web = FakeWeb([self.source], [entry('CUSTOM101/2024期末A卷.txt')])
        first, _ = self.run_robot(web=web)
        self.assertEqual(first['resources'][0]['course'], 'unknown')
        self.source['courseAliases'] = {'自定义课程': ['CUSTOM101']}
        second, _ = self.run_robot(web=web)
        self.assertEqual(second['resources'][0]['course'], '自定义课程')
        self.assertEqual(second['runStats']['unchangedSources'], 0)

    def test_public_private_study_download_keeps_restricted_publication(self):
        result, _ = self.run_robot(download=True)
        resource = result['resources'][0]
        self.assertTrue(resource['hasOriginal'])
        self.assertTrue(resource['sha256'])
        self.assertEqual(resource['publication'], 'restricted')
        self.assertTrue((self.folder / 'state' / resource['downloadedPath']).is_file())
        self.assertEqual(resource['state'], 'extracted')

    def test_explicit_metadata_only_does_not_fetch_original(self):
        self.source['rights']['mode'] = 'metadata-only'
        result, web = self.run_robot(download=True)
        self.assertEqual(result['resources'][0]['state'], 'indexed')
        self.assertFalse(any('raw.githubusercontent' in call[0] for call in web.calls))

    def test_blob_hash_mismatch_is_never_accepted(self):
        row, raw = entry()
        row['sha'] = 'c' * 40
        result, _ = self.run_robot(web=FakeWeb([self.source], [(row, raw)]), download=True)
        self.assertEqual(result['failures'][0]['code'], 'git-blob-hash-mismatch')
        self.assertIsNone(result['resources'][0]['sha256'])

    def test_identical_blob_dedup_keeps_school_attribution(self):
        sources = [self.source, source('second-university', 'second')]
        result, web = self.run_robot(sources=sources, download=True)
        self.assertEqual(len(result['resources']), 2)
        self.assertEqual({r['schoolId'] for r in result['resources']}, {'test', 'second'})
        self.assertEqual(len({r['sha256'] for r in result['resources']}), 1)
        file_calls = [call for call in web.calls if 'raw.githubusercontent' in call[0] and not call[0].endswith('robots.txt')]
        self.assertEqual(len(file_calls), 1)

    def test_downloads_round_robin_sources_instead_of_small_file_flood(self):
        sources = [self.source, source('second-university', 'second')]
        files = [entry('高等数学/2024期末A卷.txt', b'1. First question'), entry('高等数学/2024期末B卷.txt', b'1. Another question')]
        result, _ = self.run_robot(sources=sources, web=FakeWeb(sources, files), download=True, max_downloads=2)
        originals = [r for r in result['resources'] if r.get('sha256')]
        self.assertEqual({r['schoolId'] for r in originals}, {'test', 'second'})

    def test_failure_queue_defers_immediate_retry(self):
        web = FakeWeb([self.source])
        raw_url = next(url for url in web.routes if 'raw.githubusercontent' in url and not url.endswith('robots.txt'))
        web.routes[raw_url] = (503, b'Busy')
        result, _ = self.run_robot(web=web, download=True)
        self.assertEqual(result['failures'][0]['attempts'], 1)
        web.calls.clear()
        second, _ = self.run_robot(web=web, download=True)
        self.assertFalse(any(call[0] == raw_url for call in web.calls))
        self.assertEqual(second['failures'][0]['attempts'], 1)

    def test_budget_stop_persists_and_resumes_next_source(self):
        sources = [self.source, source('second-university', 'second')]
        web = FakeWeb(sources)
        first, _ = self.run_robot(sources=sources, web=web, max_requests=3)
        self.assertTrue(first['runStats']['budgetStopped'])
        self.assertEqual(len(first['resources']), 1)
        second, _ = self.run_robot(sources=sources, web=web, max_requests=6)
        self.assertEqual(len(second['resources']), 2)

    def test_optional_bank_hook_retries_downloaded_original_after_install(self):
        result, web = self.run_robot(download=True)
        self.assertEqual(result['resources'][0]['extractorVersion'], 0)
        fake = types.SimpleNamespace(extract_bank=lambda resource, path: {'id': 'bank-fixture', 'questions': [{'stem': 'real fixture'}], 'extractorVersion': 1})
        web.calls.clear()
        with patch.dict(sys.modules, {'university_question_bank': fake}):
            second, _ = self.run_robot(web=web, download=True)
        self.assertEqual(second['resources'][0]['questionCount'], 1)
        self.assertEqual(second['resources'][0]['extractorVersion'], 1)
        self.assertEqual(len(second['questionBanks']), 1)
        self.assertFalse(any('raw.githubusercontent' in call[0] for call in web.calls))

    def test_new_extractor_version_reprocesses_without_redownload(self):
        fake = types.SimpleNamespace(EXTRACTOR_VERSION=1, extract_bank=lambda resource, path: None)
        with patch.dict(sys.modules, {'university_question_bank': fake}):
            first, web = self.run_robot(download=True)
        self.assertEqual(first['resources'][0]['extractorVersion'], 1)
        fake.EXTRACTOR_VERSION = 2
        web.calls.clear()
        with patch.dict(sys.modules, {'university_question_bank': fake}):
            second, _ = self.run_robot(web=web, download=True)
        self.assertEqual(second['resources'][0]['extractorVersion'], 2)
        self.assertFalse(any('raw.githubusercontent' in call[0] for call in web.calls))

    def test_official_registered_file_download_and_evidence(self):
        official = {'id': 'official-example', 'name': 'Official course', 'type': 'official-page',
                    'school': {'id': 'official', 'name': 'Official University'},
                    'url': 'https://math.example.edu/course/', 'rights': {'mode': 'private-study', 'access': 'public'},
                    'sampleFiles': [{'path': 'hw01.txt', 'url': 'https://math.example.edu/course/hw01.txt',
                                     'title': '高等数学2024作业', 'course': '高等数学A', 'format': 'txt'}]}
        web = FakeWeb([official])
        web.routes['https://math.example.edu/robots.txt'] = (200, b'User-agent: *\nAllow: /')
        web.routes[official['sampleFiles'][0]['url']] = (200, b'1. Calculate 1+1.')
        result, _ = self.run_robot(sources=[official], web=web, download=True)
        self.assertEqual(result['resources'][0]['course'], '高等数学A')
        self.assertEqual(result['resources'][0]['schoolId'], 'official')
        self.assertTrue(result['resources'][0]['hasOriginal'])
        self.assertIsNone(result['resources'][0]['gitBlobSha'])

    def test_unknown_source_id_fails_instead_of_silent_empty_run(self):
        with self.assertRaisesRegex(robot.CollectorError, 'unknown-source-id:typo-id'):
            self.run_robot(source_ids=['typo-id'])

    def test_new_exclusion_removes_previously_indexed_resource(self):
        first, web = self.run_robot()
        self.assertEqual(len(first['resources']), 1)
        self.source['exclude'] = ['**/*.txt']
        second, _ = self.run_robot(web=web)
        self.assertEqual(second['resources'], [])

    def test_bundled_training_images_and_framework_docs_are_not_exam_resources(self):
        files = [entry('多媒体技术/作业/DataSet/flowers/619.jpg'),
                 entry('Week_3-Python/exam/2016/docs/releases/1.4.5.txt'),
                 entry('计算机网络/2024期末A卷.txt')]
        result, _ = self.run_robot(web=FakeWeb([self.source], files))
        self.assertEqual(len(result['resources']), 1)
        self.assertEqual(result['resources'][0]['course'], '计算机网络')

    def test_verified_sample_material_kind_is_preserved(self):
        row, raw = entry('qualifying-sample.txt')
        self.source['sampleFiles'] = [{'path': row['path'], 'title': '博士资格试样题', 'course': '组合数学', 'materialType': 'sample-exam'}]
        result, _ = self.run_robot(web=FakeWeb([self.source], [(row, raw)]), download=True)
        resource = result['resources'][0]
        self.assertEqual(resource['kind'], 'exam')
        self.assertEqual(resource['course'], '组合数学')

    def test_offline_reclassification_changes_metadata_without_any_http(self):
        web = FakeWeb([self.source], [entry('CUSTOM101/2024期末A卷.txt')])
        first, _ = self.run_robot(web=web)
        self.assertEqual(first['resources'][0]['course'], 'unknown')
        self.source['courseAliases'] = {'新归类课程': ['CUSTOM101']}
        web.calls.clear()
        second, _ = self.run_robot(web=web, reclassify_only=True)
        self.assertEqual(second['resources'][0]['course'], '新归类课程')
        self.assertEqual(second['runStats']['reclassified'], 1)
        self.assertEqual(second['runStats']['requests'], 0)
        self.assertEqual(web.calls, [])

    def test_offline_reclassification_purges_now_excluded_records(self):
        first, web = self.run_robot()
        self.source['exclude'] = ['**/*.txt']
        web.calls.clear()
        second, _ = self.run_robot(web=web, reclassify_only=True)
        self.assertEqual(second['resources'], [])
        self.assertEqual(second['runStats']['removedByRules'], 1)
        self.assertEqual(web.calls, [])

    def test_offline_new_parser_rejecting_old_bank_removes_bank_and_counts(self):
        fake = types.SimpleNamespace(EXTRACTOR_VERSION=1, extract_bank=lambda resource, path: {'id': 'old-bank', 'questions': [{'stem': 'previous extraction'}]})
        with patch.dict(sys.modules, {'university_question_bank': fake}):
            first, web = self.run_robot(download=True)
        self.assertEqual(first['resources'][0]['bankId'], 'old-bank')
        fake.EXTRACTOR_VERSION = 3
        fake.extract_bank = lambda resource, path: None
        web.calls.clear()
        with patch.dict(sys.modules, {'university_question_bank': fake}):
            second, _ = self.run_robot(web=web, reextract=True)
        self.assertEqual(second['questionBanks'], [])
        self.assertIsNone(second['resources'][0]['bankId'])
        self.assertEqual(second['resources'][0]['questionCount'], 0)
        self.assertEqual(second['resources'][0]['extractorVersion'], 3)
        self.assertEqual(second['runStats']['requests'], 0)
        self.assertEqual(web.calls, [])

    def test_combined_offline_modes_pass_updated_course_to_extractor(self):
        web = FakeWeb([self.source], [entry('CUSTOM101/2024期末A卷.txt')])
        first, _ = self.run_robot(web=web, download=True)
        self.source['courseAliases'] = {'新归类课程': ['CUSTOM101']}
        seen = []
        fake = types.SimpleNamespace(EXTRACTOR_VERSION=3, extract_bank=lambda resource, path: seen.append(resource['course']))
        web.calls.clear()
        with patch.dict(sys.modules, {'university_question_bank': fake}):
            second, _ = self.run_robot(web=web, reclassify_only=True, reextract=True)
        self.assertEqual(seen, ['新归类课程'])
        self.assertEqual(second['runStats']['mode'], 'offline')
        self.assertEqual(second['runStats']['extractionAttempts'], 1)
        self.assertEqual(web.calls, [])

    def test_offline_extraction_limit_is_independent_of_download_limit_and_resumes(self):
        files = [entry('高数/2024期末A卷.txt'), entry('高数/2024期末B卷.txt'), entry('高数/2024期末C卷.txt')]
        web = FakeWeb([self.source], files)
        self.run_robot(web=web, download=True)
        seen = []
        fake = types.SimpleNamespace(EXTRACTOR_VERSION=3, extract_bank=lambda resource, path: seen.append(resource['id']))
        web.calls.clear()
        with patch.dict(sys.modules, {'university_question_bank': fake}):
            second, _ = self.run_robot(web=web, reextract=True, max_downloads=0, max_extractions=2)
            third, _ = self.run_robot(web=web, reextract=True, max_downloads=0, max_extractions=1)
        self.assertEqual(len(seen), 3)
        self.assertEqual(len(set(seen)), 3)
        self.assertEqual(second['runStats']['extractionAttempts'], 2)
        self.assertEqual(third['runStats']['extractionAttempts'], 1)
        self.assertEqual(web.calls, [])

    def test_offline_missing_original_is_reported_without_redownload(self):
        first, web = self.run_robot(download=True)
        original = (self.folder / 'state' / first['resources'][0]['downloadedPath']).resolve()
        self.assertTrue(original.is_relative_to(self.folder.resolve()))
        original.unlink()
        web.calls.clear()
        second, _ = self.run_robot(web=web, reextract=True)
        self.assertTrue(any(f['code'] == 'stored-original-missing' for f in second['failures']))
        self.assertEqual(web.calls, [])

    def test_offline_flags_cannot_accidentally_allow_downloads(self):
        with self.assertRaisesRegex(robot.CollectorError, 'offline-mode-cannot-download'):
            self.run_robot(download=True, reextract=True)


if __name__ == '__main__':
    unittest.main()
