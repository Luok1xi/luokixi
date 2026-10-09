"""Regression tests for lossless university extraction; fixtures are synthetic.

Install in campus/tests and run python -m unittest discover -s campus/tests
-p test_university_question_bank.py -v. UNIVERSITY_BANK_STAGE, LUOKIXI_REPO and
UNIVERSITY_BANK_TEST_TMP may override the source and temporary locations.
Nothing writes to the repository's source or live database.
"""
from __future__ import annotations
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

CAMPUS = Path(__file__).resolve().parents[1]
REPO = Path(os.environ.get('LUOKIXI_REPO', str(CAMPUS.parent)))
for path in [REPO / 'campus' / '.data' / 'question-runtime', REPO / 'campus' / '.data' / 'hub-runtime', REPO / 'campus']:
    sys.path.insert(0, str(path))
if os.environ.get('UNIVERSITY_BANK_STAGE'):
    sys.path.insert(0, os.environ['UNIVERSITY_BANK_STAGE'])
import university_question_bank as bank

SIMPLE = '''---
时间: 2024-2025学年第一学期
科目: 数据结构
答案完成度: 完整
---
## 一、选择题
1. 下列哪种结构遵循先进先出？<Slot />
<Choices>
<Option>栈</Option>
<Option correct>队列</Option>
</Choices>
<Solution>按进入顺序处理元素。</Solution>
'''


def minimal_pdf(lines=(), page_count=1):
    """Small standards-compliant searchable PDF without test dependencies."""
    objects = []
    objects.append(b'<< /Type /Catalog /Pages 2 0 R >>')
    kids = ' '.join(f'{4 + i * 2} 0 R' for i in range(page_count))
    objects.append(f'<< /Type /Pages /Kids [{kids}] /Count {page_count} >>'.encode())
    objects.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    for i in range(page_count):
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {5 + i * 2} 0 R >>'.encode())
        content = 'BT /F1 12 Tf 50 740 Td 18 TL\n' + '\n'.join('('+s.replace('\\','\\\\').replace('(','\\(').replace(')','\\)')+') Tj T*' for s in lines) + '\nET'
        stream = content.encode('ascii')
        objects.append(b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream')
    data = bytearray(b'%PDF-1.4\n')
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n')
    xref = len(data)
    data.extend(f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode())
    for pos in offsets[1:]:
        data.extend(f'{pos:010d} 00000 n \n'.encode())
    data.extend(f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF'.encode())
    return bytes(data)


class MdxTests(unittest.TestCase):
    def test_choices_keep_source_answer_and_explanation(self):
        questions, metadata = bank.parse_mdx(SIMPLE)
        self.assertEqual(len(questions), 1)
        q = questions[0]
        self.assertEqual([o['text'] for o in q['options']], ['栈', '队列'])
        self.assertEqual(q['answer'], 'B')
        self.assertEqual(q['answerStatus'], 'source_unverified')
        self.assertIn('进入顺序', q['explanation'])
        self.assertNotIn('<Solution', q['stem'])
        self.assertFalse(q['confirmed'])
        self.assertEqual(metadata['科目'], '数据结构')
        self.assertEqual(q['source']['line'], 7)

    def test_short_options_and_multiline_option_are_not_lost(self):
        raw = '''## 一、选择题
1. 哪些可以作为输入？
<Choices multiple>
+ 键盘
- 显示器
<Option correct>触摸屏

以及触控笔</Option>
</Choices>'''
        q = bank.parse_mdx(raw)[0][0]
        self.assertEqual(q['answer'], 'A、C')
        self.assertEqual(len(q['options']), 3)
        self.assertIn('触控笔', q['options'][2]['text'])

    def test_missing_answers_stay_unknown(self):
        q = bank.parse_mdx('## 一、选择题\n1. 选择适当答案。\n<Choices><Option>甲</Option><Option>乙</Option></Choices>')[0][0]
        self.assertEqual(q['answer'], '')
        self.assertEqual(q['answerStatus'], 'unknown')

    def test_blank_preserves_two_values_and_empty_blank(self):
        questions, _ = bank.parse_mdx('## 二、填空题\n1. 先进先出称为<Blank>队列</Blank>，后进先出称为<Blank>栈</Blank>。\n2. 这个答案未知：<Blank />。')
        self.assertEqual(len(questions), 2)
        self.assertEqual(questions[0]['answer'], '队列、栈')
        self.assertEqual(questions[0]['stem'].count('______'), 2)
        self.assertEqual(questions[1]['answerStatus'], 'unknown')

    def test_written_subparts_not_split(self):
        raw = '## 五（18分）\n请分析给定程序。\n1. 写出执行顺序。\n2. 分析复杂度。\n<Solution>先排序，再检索。</Solution>'
        questions, _ = bank.parse_mdx(raw)
        self.assertEqual(len(questions), 1)
        self.assertIn('1. 写出', questions[0]['stem'])
        self.assertIn('2. 分析', questions[0]['stem'])

    def test_h3_written_questions_keep_nested_list(self):
        raw = '## 二、简答题\n### 1.\n分析以下算法。\n1. 求空间复杂度。\n2. 求时间复杂度。\n### 2.\n解释稳定排序。'
        questions, _ = bank.parse_mdx(raw)
        self.assertEqual(len(questions), 2)
        self.assertIn('2. 求时间复杂度', questions[0]['stem'])
        self.assertEqual(questions[1]['number'], '2')

    def test_shared_choice_passage_kept_with_review_flag(self):
        raw = '## 六（10分）\n阅读短文并填入<Slot item="1"/>及<Slot item="2"/>。\n<Choices item="1"><Option correct>甲</Option><Option>乙</Option></Choices>\n<Choices item="2"><Option>丙</Option><Option correct>丁</Option></Choices>'
        questions, _ = bank.parse_mdx(raw)
        self.assertEqual(len(questions), 1)
        q = questions[0]
        self.assertEqual(q['stem'].count('<Choices'), 2)
        self.assertEqual(q['options'], [])
        self.assertTrue(q['source']['requiresLayoutReview'])
        self.assertIn('shared-choice-passage', q['source']['extractionFlags'])

    def test_mdx_js_is_inert_and_dynamic_correct_not_guessed(self):
        raw = 'import evil from "file:///not-a-module";\n## 一、选择题\n1. 请对照来源核验。\n<Choices><Option correct={dangerous()}>甲</Option><Option>乙</Option></Choices>\n<Figure src="图1.svg" />'
        q = bank.parse_mdx(raw)[0][0]
        self.assertEqual(q['answer'], '')
        self.assertIn('dynamic-option-answer', q['source']['extractionFlags'])
        self.assertIn('图1.svg', q['stem'])
        self.assertTrue(q['source']['requiresLayoutReview'])

    def test_description_only_mdx_does_not_become_question(self):
        questions, _ = bank.parse_mdx('## 课程介绍\n这门课程介绍计算机知识。\n## 联系方式\n请联系教学办公室。')
        self.assertEqual(questions, [], 'A course guide is not an exam question bank')

    def test_fenced_example_does_not_become_question(self):
        raw = '## 使用示例\n```mdx\n## 一、选择题\n1. 这是说明中的示范，不是真题。\n```'
        self.assertEqual(bank.parse_mdx(raw)[0], [])

    def test_code_inside_a_real_question_is_retained_not_split(self):
        raw = '## 二、简答题\n### 1.\n解释以下程序输出。\n```python\n## 一、选择题\n1. fake_boundary\nprint(123)\n```\n<Solution>123</Solution>\n### 2.\n说明代码作用。'
        questions, _ = bank.parse_mdx(raw)
        self.assertEqual(len(questions), 2)
        self.assertIn('print(123)', questions[0]['stem'])
        self.assertIn('1. fake_boundary', questions[0]['stem'])
        self.assertIn('```python', questions[0]['stem'])

    def test_frontmatter_college_lists_do_not_disappear(self):
        raw = SIMPLE.replace('科目: 数据结构','科目: 数据结构\n学院:\n- 计算机学院\n- 电子工程学院')
        metadata = bank.parse_mdx(raw)[1]
        self.assertEqual(metadata['学院'], ['计算机学院', '电子工程学院'])


class ExtractTests(unittest.TestCase):
    def setUp(self):
        directory = os.environ.get('UNIVERSITY_BANK_TEST_TMP')
        if directory:
            Path(directory).mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='university-bank-test-', dir=directory)
        self.folder = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def resource_file(self, content=SIMPLE, ext='mdx', **overrides):
        path = self.folder / ('index.' + ext)
        data = content.encode('utf-8') if isinstance(content, str) else content
        path.write_bytes(data)
        resource = dict(id='resource-one', sourceId='source-one', schoolId='bupt', schoolName='北京邮电大学',
                        path='exams/2024-data/index.' + ext, format=ext, kind='exam', title='index',
                        course='数据结构', url='https://example.edu/exam', sourceUrl='https://example.edu/exam',
                        sha256=hashlib.sha256(data).hexdigest(), rights={'mode':'private-study','license':'CC-BY-NC-SA-4.0'},
                        commit='abc123', indexedAt='2026-10-07')
        resource.update(overrides)
        return resource, path

    def test_content_hash_mismatch_fails_closed(self):
        resource, path = self.resource_file(sha256='0'*64)
        with self.assertRaisesRegex(ValueError, 'source-content-hash-mismatch'):
            bank.extract_bank(resource, path)

    def test_ids_stable_for_same_source_and_revision(self):
        resource, path = self.resource_file()
        one, two = bank.extract_bank(resource, path), bank.extract_bank(resource, path)
        self.assertEqual(one['id'], two['id'])
        self.assertEqual(one['questions'][0]['id'], two['questions'][0]['id'])
        self.assertEqual(one['questions'][0]['source']['sha256'], resource['sha256'])
        self.assertEqual(one['questions'][0]['source']['originalNumber'], '1')
        self.assertEqual(one['visibility'], 'private-study')
        self.assertEqual(one['title'], '2024-data')
        self.assertFalse(one['questions'][0]['confirmed'])

    def test_changed_revision_invalidates_question_ids_not_bank_id(self):
        resource, path = self.resource_file()
        before = bank.extract_bank(resource, path)
        resource, path = self.resource_file(SIMPLE.replace('先进先出','后进先出'))
        after = bank.extract_bank(resource, path)
        self.assertEqual(before['id'], after['id'])
        self.assertNotEqual(before['questions'][0]['id'], after['questions'][0]['id'])
        self.assertNotEqual(before['revision'], after['revision'])

    def test_distinct_resources_do_not_collapse_question_identity(self):
        resource, path = self.resource_file()
        before = bank.extract_bank(resource, path)
        resource['id'] = 'resource-two'
        after = bank.extract_bank(resource, path)
        self.assertNotEqual(before['id'], after['id'])
        self.assertNotEqual(before['questions'][0]['id'], after['questions'][0]['id'])

    def test_plain_unstructured_notes_do_not_become_questions(self):
        resource, path = self.resource_file('这是一段课程介绍，没有独立题目或可靠分题边界。', 'txt')
        self.assertIsNone(bank.extract_bank(resource, path))

    def test_nonquestion_mdx_document_is_not_bank(self):
        resource, path = self.resource_file('## 课程介绍\n这是一门面向大一学生的公共课程。')
        self.assertIsNone(bank.extract_bank(resource, path))

    def test_unsupported_word_is_preserved_as_resource_not_fake_bank(self):
        resource, path = self.resource_file(b'not real docx', 'docx')
        self.assertIsNone(bank.extract_bank(resource, path))

    def test_non_exam_material_kind_not_extracted(self):
        resource, path = self.resource_file(kind='slides')
        self.assertIsNone(bank.extract_bank(resource, path))

    def test_native_text_retains_unknown_answer_and_source(self):
        resource, path = self.resource_file('1. 简述队列的主要特点。\n2. 说明栈的应用场景。', 'txt')
        result = bank.extract_bank(resource, path)
        self.assertEqual(result['questionCount'], 2)
        self.assertEqual(result['questions'][0]['source']['method'], 'source-text')
        self.assertEqual(result['questions'][0]['answerStatus'], 'unknown')

    @unittest.skipUnless(importlib.util.find_spec('pypdfium2'), 'native PDF runtime unavailable')
    def test_native_pdf_text_extracted_and_layout_review_required(self):
        resource, path = self.resource_file(minimal_pdf(['1. Explain a queue.','Answer: First in first out.']), 'pdf')
        result = bank.extract_bank(resource, path)
        self.assertIsNotNone(result)
        self.assertEqual(result['questionCount'], 1)
        q = result['questions'][0]
        self.assertIn('queue', q['stem'])
        self.assertEqual(q['source']['pages'], [1])
        self.assertEqual(q['source']['method'], 'pdf-text')
        self.assertTrue(q['source']['requiresLayoutReview'])
        self.assertIn('source_layout_review', [i['code'] for i in result['extractionIssues']])

    @unittest.skipUnless(importlib.util.find_spec('pypdfium2'), 'native PDF runtime unavailable')
    def test_empty_pdf_is_not_a_question(self):
        resource, path = self.resource_file(minimal_pdf(), 'pdf')
        self.assertIsNone(bank.extract_bank(resource, path))

    @unittest.skipUnless(importlib.util.find_spec('pypdfium2'), 'native PDF runtime unavailable')
    def test_page_limit_does_not_partially_import_large_paper(self):
        resource, path = self.resource_file(minimal_pdf(['1. Explain a queue.'], page_count=25), 'pdf')
        self.assertIsNone(bank.extract_bank(resource, path))

    def catalogue(self):
        resource, path = self.resource_file()
        result = bank.extract_bank(resource, path)
        resource['bankId'] = result['id']
        source = {'id':'source-one','schoolId':'bupt','rights':{'mode':'private-study'}}
        data = {'sources':[source],'resources':[resource],'questionBanks':[result], 'schools':[{'id':'bupt','name':'北京邮电大学'}]}
        return data, result['id']

    def save_catalogue(self, data):
        (self.folder / 'university-sources.json').write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')

    def test_lookup_requires_matching_source_version(self):
        data, id = self.catalogue()
        self.save_catalogue(data)
        self.assertEqual(bank.get_bank(self.folder, id)['schoolName'], '北京邮电大学')
        data['resources'][0]['sha256'] = 'f'*64
        self.save_catalogue(data)
        with self.assertRaises(ValueError):
            bank.get_bank(self.folder, id)

    def test_lookup_rejects_revoked_resource_permission(self):
        data, id = self.catalogue()
        data['resources'][0]['rights']['mode'] = 'metadata-only'
        self.save_catalogue(data)
        with self.assertRaises(ValueError):
            bank.get_bank(self.folder, id)

    def test_lookup_rejects_revoked_source_permission(self):
        data, id = self.catalogue()
        data['sources'][0]['rights']['mode'] = 'metadata-only'
        self.save_catalogue(data)
        with self.assertRaises(ValueError):
            bank.get_bank(self.folder, id)

    def test_metadata_endpoint_omits_question_body_and_local_paths(self):
        data, id = self.catalogue()
        data['resources'][0].update(downloadedPath=r'C:\private\original.mdx',textPath=r'C:\private\ocr.txt',rawUrl='https://raw.example/anything',fetchedUrl='https://raw.example/anything')
        self.save_catalogue(data)
        result = bank.public_catalogue(self.folder)
        self.assertNotIn('questions', result['questionBanks'][0])
        self.assertNotIn('extractionIssues', result['questionBanks'][0])
        for key in ['downloadedPath','textPath','rawUrl','fetchedUrl']:
            self.assertNotIn(key, result['resources'][0])
        self.assertIn('questions', bank.load_catalogue(self.folder)['questionBanks'][0])


if __name__ == '__main__':
    unittest.main(verbosity=2)
