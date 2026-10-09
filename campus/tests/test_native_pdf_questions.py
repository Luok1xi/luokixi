"""Run from the repository with python -m unittest discover -s campus/tests.

Tests of real downloaded public papers run when their originals are available;
the always-on fixtures capture the exact extraction shapes that caused errors.
"""
import os
from pathlib import Path
import sys
import unittest

CAMPUS = Path(__file__).resolve().parents[1]
REPO = Path(os.environ.get('LUOKIXI_REPO', str(CAMPUS.parent)))
sys.path.insert(0, str(REPO/'campus/.data/question-runtime'))
sys.path.insert(0, os.environ.get('UNIVERSITY_BANK_STAGE', str(CAMPUS)))
from native_pdf_questions import parse_native_pdf


def page(number, text):
    return {'page': number, 'text': text, 'method': 'pdf-text', 'blocks': []}


class NativePdfSegmentationTests(unittest.TestCase):
    def parse(self, text):
        return parse_native_pdf([page(1, text)])

    def test_math_tuples_do_not_become_options(self):
        questions, _ = self.parse('1 设 G=(V, E) 是图，证明性质。\n2 设 H=(X, Y)，计算阶数。')
        self.assertEqual(len(questions), 2)
        self.assertEqual(questions[0]['options'], [])
        self.assertIn('E)', questions[0]['stem'])
        self.assertIn('证明性质', questions[0]['stem'])

    def test_sqrt_and_starred_question_are_not_wrong_boundaries(self):
        questions, _ = self.parse('1. 设函数。\n(a) 求 f(\n√\n2)。\n(b) 证明。\n2\n∗ 设集合，证明结论。')
        self.assertEqual([q['number'] for q in questions], ['1', '2'])
        self.assertIn('2)。\n(b) 证明', questions[0]['stem'])
        self.assertIn('设集合', questions[1]['stem'])

    def test_decimal_is_not_a_question_number(self):
        questions, _ = self.parse('下载体积\n1.25 MB\n2.50 MB')
        self.assertEqual(questions, [])

    def test_subject_sections_preserve_global_sequence(self):
        questions, _ = self.parse('一、组合数学\n1 把球装入盒子，计算种数。\n2 若数列满足条件，求通项。\n二、图论\n3 设图 G，证明结论。')
        self.assertEqual([q['number'] for q in questions], ['1', '2', '3'])
        self.assertEqual(questions[2]['source']['section'], '二、图论')

    def test_type_sections_reset_sequence_and_choices(self):
        questions, _ = self.parse('一．判断题\n1. 一个判断。（ ）\n二．单选题\n1. 哪项正确？\nA. 甲 B. 乙\nC. 丙 D. 丁\n三．填空题\n1. 请填空。')
        self.assertEqual(len(questions), 3)
        self.assertEqual([item['text'] for item in questions[1]['options']], ['甲', '乙', '丙', '丁'])
        self.assertEqual(questions[0]['options'], [])
        self.assertEqual(questions[2]['options'], [])

    def test_programming_subparts_and_code_stay_together(self):
        questions, _ = self.parse('五．程序设计题（10 分）\n1. 设二叉树，完成算法。\n（1）补充代码：\nvoid f(Node* b) {\nreturn;\n}\n（2）求最大值。')
        self.assertEqual(len(questions), 1)
        self.assertIn('void f', questions[0]['stem'])
        self.assertIn('（2）求最大值', questions[0]['stem'])

    def test_choice_exponent_followed_by_text_is_not_spaced_question(self):
        questions, _ = self.parse('一、单选题\n1. 算法的时间复杂度说明什么？\nA. 规模为 n\n2\nB. 时间等于 n\n2\nC. 时间与 n\n2 成正比 D. 规模与 n\n2 成正比\n2. 链表有什么特点？\nA. 随机访问 B. 插入移动\nC. 预估空间 D. 空间随长度增长')
        self.assertEqual(len(questions), 2)
        self.assertTrue(questions[1]['stem'].startswith('链表'))
        self.assertEqual([item['label'] for item in questions[0]['options']], ['A', 'B', 'C', 'D'])
        self.assertIn('2 成正比', questions[0]['options'][2]['text'])
        self.assertNotIn('链表', questions[0]['options'][-1]['text'])

    def test_page_continuation_and_original_page_numbers(self):
        questions, _ = parse_native_pdf([page(4, '1. 设有一棵树。\n4'), page(5, '座位号：\n第 5 页 共 6 页\n（1）回答树的问题。\n2. 第二题。\n5')])
        self.assertEqual(len(questions), 2)
        self.assertEqual(questions[0]['source']['pages'], [4, 5])
        self.assertNotIn('座位号', questions[0]['stem'])
        self.assertNotIn('共 6 页', questions[0]['stem'])
        self.assertNotEqual(questions[-1]['stem'][-1:], '5')

    def test_explicit_answer_heading_excludes_continuation_pages(self):
        questions, issues = parse_native_pdf([
            page(1, '特别提醒：答案一律写在答题纸上。\n一．判断题\n1. 完整题目。'),
            page(3, '座位号：\n第 3 页 共 6 页\n杭州电子科技大学学生考试卷（A）卷答卷\n1. 2. 3.'),
            page(4, '1.（1）\n①\n②\n1.（2）'),
            page(5, '1. 完整题目重复和答案。')])
        self.assertEqual(len(questions), 1)
        exclusion = next(i for i in issues if i['code'] == 'answer_pages_excluded')
        self.assertEqual(exclusion['excludedPageNumbers'], [3, 4, 5])
        self.assertFalse(exclusion['blocking'])

    def test_answer_word_inside_question_does_not_exclude_page(self):
        questions, _ = self.parse('试卷\n1. 请解释参考答案为何错误。\n2. 作答时使用答题纸。')
        self.assertEqual(len(questions), 2)

    def test_answer_grid_is_not_a_question(self):
        questions, issues = self.parse('第二节 电通量 高斯定律\n1、C；2、A；3、B；4、数值\n5、解：以球心建立高斯面。')
        self.assertEqual(questions, [])
        self.assertTrue(any(i['code'] == 'answer_only_document' for i in issues))

    def test_outline_does_not_become_a_question(self):
        questions, _ = self.parse('2022 复习\n第一章概论\n计算机的主要组成部分\n第二章 运算方法\n掌握概念')
        self.assertEqual(questions, [])

    def test_forward_gap_marks_segmentation_uncertain(self):
        questions, issues = self.parse('1. 完整题目。\n3. 缺少第二题的片段。')
        self.assertTrue(all(q['segmentationUncertain'] for q in questions))
        self.assertTrue(any(i['code'] == 'native_numbering_uncertain' for i in issues))

    def test_unverified_pdf_answers_are_not_invented(self):
        questions, _ = self.parse('1. 计算一个结果。')
        self.assertEqual(questions[0]['answer'], '')
        self.assertFalse(questions[0]['confirmed'])
        self.assertTrue(questions[0]['source']['requiresLayoutReview'])


class RealPublicPdfRegressionTests(unittest.TestCase):
    def read(self, digest):
        path = REPO/'campus/.data/university-crawler/originals'/(digest+'.pdf')
        if not path.exists():
            self.skipTest('Public source original is not downloaded locally')
        try:
            import pypdfium2 as pdfium
        except ImportError:
            self.skipTest('pypdfium2 runtime is unavailable')
        doc, pages = pdfium.PdfDocument(str(path)), []
        try:
            for index in range(len(doc)):
                current = doc[index]
                text = current.get_textpage()
                try:
                    pages.append(page(index + 1, text.get_text_range()))
                finally:
                    text.close(); current.close()
        finally:
            doc.close()
        return parse_native_pdf(pages)

    def test_hdu_29_questions_with_15_choices_and_answers_excluded(self):
        questions, issues = self.read('23d7b8c70b73a197b5d0622e889aed319f9833dce9ffd95252ef78157a8323bf')
        self.assertEqual(len(questions), 29)
        self.assertEqual(sum(bool(q['options']) for q in questions), 15)
        self.assertEqual([len(q['options']) for q in questions if q['options']], [4]*15)
        self.assertIn('（1）假设', questions[-1]['stem'])
        self.assertIn('（2）假设', questions[-1]['stem'])
        self.assertEqual(questions[-1]['source']['pages'], [2])
        self.assertFalse(any(q['segmentationUncertain'] for q in questions))
        self.assertEqual(next(i['excludedPageNumbers'] for i in issues if i['code'] == 'answer_pages_excluded'), [3,4,5,6])

    def test_pku_8_questions_with_sqrt_compound_and_star_preserved(self):
        questions, _ = self.read('cca16d3fe0ea6bec7542f788cc188b41cf8bd05438d07098fb003b7860f0ce67')
        self.assertEqual([q['number'] for q in questions], [str(i) for i in range(1,9)])
        self.assertIn('(c) 求证', questions[3]['stem'])
        self.assertIn('戴德金分划', questions[7]['stem'])
        self.assertTrue(all(not q['options'] and not q['segmentationUncertain'] for q in questions))

    def test_ustc_10_questions_preserve_graph_math_and_page_break(self):
        questions, _ = self.read('39588630f244eab7b4ef83460392dc5a0aec25a8b8c51d0351291e5388fb9972')
        self.assertEqual([q['number'] for q in questions], [str(i) for i in range(1,11)])
        self.assertIn('E)', questions[6]['stem'])
        self.assertIn('Hamilton', questions[6]['stem'])
        self.assertIn('复杂性', questions[-1]['stem'])
        self.assertEqual(questions[7]['source']['pages'], [2])
        self.assertTrue(all(not q['options'] and not q['segmentationUncertain'] for q in questions))

    def test_njupt_answer_only_worksheet_is_not_a_bank(self):
        questions, _ = self.read('8d30e5a06c4dd81839545db78f597c7be85c3c3d88dccf0bb65a98956f17dbde')
        self.assertEqual(questions, [])


if __name__ == '__main__':
    unittest.main()
