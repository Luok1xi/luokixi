from datetime import date
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import learning_sources_robot as robot

COMMIT = 'a' * 40
BOOK = b'''<col:collection xmlns:col="http://cnx.rice.edu/collxml" xmlns:md="http://cnx.rice.edu/mdml"><col:metadata><md:license url="https://creativecommons.org/licenses/by-nc-sa/4.0/"/></col:metadata><col:content><col:subcollection><md:title>Introduction to Psychology</md:title><col:content><col:module document="m1"/></col:content></col:subcollection></col:content></col:collection>'''
MODULE = b'''<document xmlns="http://cnx.rice.edu/cnxml"><title>Fixture section</title><content><section class="review-questions"><exercise id="q1"><problem><para>Which value is in the source?</para><list><item>First</item><item>Second</item></list></problem><solution><para>B</para></solution></exercise><exercise id="q2"><problem><para>Unprovided answer?</para><list><item>One</item><item>Two</item></list></problem></exercise></section><section class="critical-thinking"><exercise id="not-mcq"><problem><para>Explain this.</para></problem></exercise></section></content><glossary><definition id="term1"><term>Test term</term><meaning>Source definition</meaning></definition></glossary></document>'''
SCHOOL_NOTICE = '<html><title>关于2026-2027学年第一学期通识教育选修课选课安排的通知-中国矿业大学（北京）教务处</title><body>日期：2026-09-10</body></html>'.encode()
SCHOOL_INDEX = '<a href="/info/1011/6375.htm" title="关于2026-2027学年第一学期通识教育选修课选课安排的通知">通知</a><a href="https://outside.example/notice">通识教育选修课</a><script><a href="/info/1011/1111.htm">通识教育选修课伪造</a></script>'.encode()


def fixture_fetch(target, limit=1024 * 1024):
    if target.endswith('/robots.txt'):
        raise robot.SourceError('http-404', 404)
    if target == robot.SCHOOL_INDEX:
        return SCHOOL_INDEX, target
    if target == robot.SCHOOL_ROOT + '/info/1011/6375.htm':
        return SCHOOL_NOTICE, target
    if target == robot.COMMIT_URL:
        return json.dumps({'sha': COMMIT}).encode(), target
    if target.endswith('/LICENSE'):
        return b'Attribution-NonCommercial-ShareAlike 4.0 International', target
    if target.endswith('.collection.xml'):
        return BOOK, target
    if target.endswith('/modules/m1/index.cnxml'):
        return MODULE, target
    raise AssertionError(target)


class SourceRobotTests(unittest.TestCase):
    def test_scope_allowlist_rejects_auth_unknown_paths_and_nonhttps(self):
        robot.validate_target(robot.SCHOOL_INDEX)
        robot.validate_target(robot.RAW_ROOT + COMMIT + '/modules/m82162/index.cnxml')
        for target in ('http://jwc.cumtb.edu.cn/index.htm', 'https://user:pass@jwc.cumtb.edu.cn/index.htm', 'https://jwc.cumtb.edu.cn/index.htm#fragment', 'https://jwc.cumtb.edu.cn/login', 'https://raw.githubusercontent.com/someone/book/main/file', 'https://raw.githubusercontent.com/openstax/osbooks-psychology/main/LICENSE', 'https://127.0.0.1/', 'https://z-library.example/book'):
            with self.subTest(target=target), self.assertRaises(robot.SourceError):
                robot.validate_target(target)

    def test_school_notice_dates_and_terms_are_explicit(self):
        links = robot.parse_school_links(SCHOOL_INDEX)
        self.assertEqual(len(links), 1)
        notice = robot.parse_school_notice(SCHOOL_NOTICE, links[0]['url'], today=date(2026, 10, 7))
        self.assertEqual(notice['publishedAt'], '2026-09-10')
        self.assertTrue(notice['currentTerm'])
        self.assertEqual(notice['courseId'], '')
        old = SCHOOL_NOTICE.decode().replace('2026-2027', '2025-2026').replace('第一学期', '第二学期').encode()
        self.assertFalse(robot.parse_school_notice(old, links[0]['url'], today=date(2026, 10, 7))['currentTerm'])

    def test_school_candidates_require_explicit_code_and_never_infer_teacher_or_course_id(self):
        raw = SCHOOL_NOTICE.replace(b'</body>', '本学期《大国兵器》（课程代码：UT610070）；王老师负责咨询。普通《相似课程》没有代码。</body>'.encode())
        result = robot.parse_school_notice(raw, robot.SCHOOL_ROOT + '/info/1133/6585.htm')
        self.assertEqual(len(result['schoolCourseCandidates']), 1)
        candidate = result['schoolCourseCandidates'][0]
        self.assertEqual(candidate['name'], '大国兵器')
        self.assertEqual(candidate['officialCode'], 'UT610070')
        self.assertEqual(candidate['teacher'], '')
        self.assertEqual(candidate['courseId'], '')
        self.assertEqual(candidate['intro'], '')

    def test_extracts_source_answers_and_never_generates_missing_ones(self):
        questions, terms = robot.parse_psychology_module(MODULE, robot.REPOSITORY, 'm1')
        self.assertEqual(len(questions), 2)
        self.assertEqual(questions[0]['answer'], 'B')
        self.assertTrue(questions[0]['literalText'])
        self.assertEqual(questions[0]['answerStatus'], 'source-provided')
        self.assertEqual(questions[1]['answer'], '')
        self.assertEqual(questions[1]['answerStatus'], 'missing')
        self.assertEqual(terms[0]['definition'], 'Source definition')
        self.assertEqual(questions[0]['schoolCourseId'], '')

    def test_mathml_or_media_never_get_literal_text_evidence(self):
        for markup in (b'<m:math xmlns:m="http://www.w3.org/1998/Math/MathML"><m:mi>x</m:mi></m:math>', b'<media src="figure.png"/>', b'<table/>'):
            changed = MODULE.replace(b'Which value is in the source?', b'Which value is in the source?' + markup)
            questions, _ = robot.parse_psychology_module(changed, robot.REPOSITORY, 'm1')
            self.assertFalse(questions[0]['literalText'])

    def test_unverified_license_and_xml_entities_fail_closed(self):
        self.assertEqual(robot.parse_chapter_modules(BOOK)[1], ['m1'])
        with self.assertRaises(robot.SourceError):
            robot.parse_chapter_modules(BOOK.replace(b'by-nc-sa/4.0', b'unknown/1.0'))
        with self.assertRaises(robot.SourceError):
            robot.safe_xml(b'<!DOCTYPE doc [<!ENTITY xx "private">]><doc/>')

    def test_robots_disallow_and_request_bounds_stop_collection(self):
        calls = []
        def blocked(url, limit):
            calls.append(url)
            return b'User-agent: *\nDisallow: /', url
        with self.assertRaises(robot.SourceError):
            robot.PublicCollector(blocked, delay=0).get(robot.SCHOOL_INDEX)
        self.assertEqual(calls, [robot.SCHOOL_ROOT + '/robots.txt'])
        collector = robot.PublicCollector(fixture_fetch, delay=0)
        collector.count = robot.MAX_REQUESTS
        with self.assertRaises(robot.SourceError):
            collector.get(robot.SCHOOL_INDEX)

    def test_dns_private_address_is_rejected_before_connect(self):
        with patch.object(robot.socket, 'getaddrinfo', return_value=[(None, None, None, None, ('127.0.0.1', 443))]), patch.object(robot.socket, 'create_connection') as connect:
            with self.assertRaises(robot.SourceError):
                robot.fetch_public(robot.SCHOOL_INDEX)
            connect.assert_not_called()

    def test_bounded_refresh_preserves_attribution_and_read_endpoint_does_no_network(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(robot.get_learning_sources(folder)['report']['state'], 'not-collected')
            result = robot.refresh_learning_sources(folder, fetcher=fixture_fetch, delay=0)
            self.assertEqual(result['report']['state'], 'ready')
            self.assertEqual(result['report']['questionCount'], 2)
            bank = result['questionBanks'][0]
            self.assertEqual(bank['commit'], COMMIT)
            self.assertEqual(bank['license'], 'CC BY-NC-SA 4.0')
            self.assertIn('OpenStax', bank['attribution'])
            self.assertIn('whitespace normalized', bank['changes'])
            self.assertEqual(result['sources'][-1]['status'], 'link-only')
            with patch.object(robot, 'fetch_public', side_effect=AssertionError('reader must not fetch')):
                self.assertEqual(robot.get_learning_sources(folder)['report']['questionCount'], 2)

    def test_corrupt_cache_never_returns_unverified_questions(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder) / 'learning-sources.json'
            for raw in ('{broken', '{"schemaVersion": 2, "sources": [], "questionBanks": []}', '[]'):
                cache.write_text(raw, encoding='utf-8')
                result = robot.get_learning_sources(folder)
                self.assertEqual(result['report']['state'], 'not-collected')
                self.assertEqual(result['questionBanks'], [])

    def test_failed_refresh_keeps_prior_data_and_marks_stale(self):
        with tempfile.TemporaryDirectory() as folder:
            robot.refresh_learning_sources(folder, fetcher=fixture_fetch, delay=0)
            def failed(target, limit):
                raise robot.SourceError('http-503', 503)
            result = robot.refresh_learning_sources(folder, fetcher=failed, delay=0)
            self.assertEqual(result['report']['state'], 'partial')
            self.assertEqual(result['sources'][0]['status'], 'stale')
            self.assertTrue(result['questionBanks'][0]['stale'])
            self.assertEqual(result['report']['questionCount'], 2)


if __name__ == '__main__':
    unittest.main()
