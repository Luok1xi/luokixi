"""Conservative, deterministic question segmentation and independent quality gates.

No language model is used to invent missing stems, solutions, or course identities.
OCR confidence describes recognition, never mathematical/subject correctness.
"""
import copy
import math
import re
import uuid

MAX_TEXT = 200_000
MAX_QUESTIONS = 200
NUMBER = re.compile(r'^\s*(?:第\s*)?([0-9０-９]{1,3})\s*[.．、)）题]\s*(.*)$')
BIG_NUMBER = re.compile(r'^\s*([一二三四五六七八九十]{1,3})[、.．]\s*(.*)$')
SECTION = re.compile(r'^\s*[一二三四五六七八九十]+[、.．]\s*(?:单项选择|多项选择|选择|填空|判断|简答|论述|计算|解答)题', re.M)
OPTION = re.compile(r'(?:^|\s)([A-HＡ-Ｈ])[.．、:：)）]\s*')
ANSWER = re.compile(r'^\s*(?:【|\[)?(?:参考答案|正确答案|答案|Answer)(?:】|\])?\s*[:：]?\s*(.*)$', re.I)
EXPLANATION = re.compile(r'^\s*(?:【|\[)?(?:解析|解答|说明|Explanation)(?:】|\])?\s*[:：]?\s*(.*)$', re.I)
KNOWLEDGE = re.compile(r'^\s*(?:【|\[)?(?:知识点|考点)(?:】|\])?\s*[:：]\s*(.+)$')
FORMULA = re.compile(r'[∫∑Σ√±≤≥≠∞∂∏²³⁴₀₁₂₃]|\\(?:frac|sqrt|int|sum)|\b\w\s*[=^]\s*\w|\b\d+\s*/\s*\d+\b')
HEADER = re.compile(r'^(?:[一二三四五六七八九十]+[、.．]|第.+[章节]|.*(?:试卷|考试|试题|姓名|学号|满分|得分)[：:]?\s*$)')


def issue(code, message, blocking=True):
    return {'code': code, 'message': message, 'blocking': blocking}


def parse_pages(pages):
    questions, current, preamble = [], None, []
    for page in pages:
        # Numbered exam instructions are not questions. Only discard that
        # prefix when BOTH an explicit instruction heading and a known question
        # section exist; all original text remains in extracted_pages/raw_text.
        page_text = page.get('text', '')
        started = not (re.search(r'注意\s*事\s*项', page_text) and SECTION.search(page_text))
        blocks = page.get('blocks') or [{'text': line, 'confidence': None, 'bbox': None}
                                       for line in page.get('text', '').splitlines()]
        for block in blocks:
            for value in block.get('text', '').splitlines():
                line = value.strip()
                if not line:
                    continue
                if SECTION.match(line):
                    started, current = True, None
                    continue
                if not started:
                    continue
                numbered = NUMBER.match(line) or BIG_NUMBER.match(line)
                if numbered:
                    if len(questions) >= MAX_QUESTIONS:
                        raise ValueError('题目超过 200 道，请分批整理。')
                    current = {'id': uuid.uuid4().hex, 'number': numbered.group(1), 'stem': '',
                               'options': [], 'answer': '', 'explanation': '', 'type': 'written',
                               'source': {'pages': [], 'regions': [], 'method': page.get('method', 'manual')},
                               'confidence': None, 'confirmed': False, 'allowUnknownAnswer': False,
                               'knowledgePoints': [], 'issues': [], '_scores': [], '_mode': 'stem'}
                    questions.append(current)
                    line = numbered.group(2)
                if current is None:
                    if not HEADER.match(line):
                        preamble.append(line)
                    continue
                source = current['source']
                if page['page'] not in source['pages']:
                    source['pages'].append(page['page'])
                if block.get('bbox') is not None:
                    region = {'page': page['page'], 'bbox': block['bbox']}
                    if region not in source['regions']:
                        source['regions'].append(region)
                score = block.get('confidence')
                if isinstance(score, (float, int)) and math.isfinite(score):
                    current['_scores'].append(float(score))
                knowledge = KNOWLEDGE.match(line)
                if knowledge:
                    points = [point.strip() for point in re.split(r'[,，、;；]', knowledge.group(1)) if point.strip()]
                    if 1 <= len(points) <= 12 and all(len(point) <= 80 for point in points):
                        current['knowledgePoints'] = list(dict.fromkeys(current['knowledgePoints'] + points))[:12]
                        continue
                answer, explanation = ANSWER.match(line), EXPLANATION.match(line)
                if answer:
                    current['answer'] = answer.group(1)
                    current['_mode'] = 'answer'
                    continue
                if explanation:
                    current['explanation'] = explanation.group(1)
                    current['_mode'] = 'explanation'
                    continue
                options = list(OPTION.finditer(line))
                if options and current['_mode'] == 'stem':
                    prefix = line[:options[0].start()].strip()
                    if prefix:
                        current['stem'] += ('\n' if current['stem'] else '') + prefix
                    for i, option in enumerate(options):
                        label = chr(ord('A') + (ord(option.group(1)) - (ord('Ａ') if option.group(1) >= 'Ａ' else ord('A'))))
                        end = options[i + 1].start() if i + 1 < len(options) else len(line)
                        current['options'].append({'label': label, 'text': line[option.end():end].strip()})
                    current['type'] = 'choice'
                elif current['_mode'] == 'stem' and current['options']:
                    current['options'][-1]['text'] += '\n' + line
                else:
                    field = current['_mode']
                    current[field] += ('\n' if current[field] else '') + line
    if not questions:
        raw = '\n'.join(page.get('text', '') for page in pages).strip()
        if raw:
            questions = [{'id': uuid.uuid4().hex, 'number': '1', 'stem': raw, 'options': [],
                          'answer': '', 'explanation': '', 'type': 'written',
                          'source': {'pages': [p['page'] for p in pages], 'regions': [],
                                     'method': pages[0].get('method', 'manual')},
                          'confidence': None, 'confirmed': False, 'allowUnknownAnswer': False,
                          'knowledgePoints': [], 'segmentationUncertain': True}]
        preamble = []
    for question in questions:
        scores = question.pop('_scores', [])
        question.pop('_mode', None)
        if scores:
            question['confidence'] = round(min(scores), 4)
        question['answerStatus'] = 'source_unverified' if question['answer'] else 'unknown'
    return questions, ([issue('unassigned_text', '有未归入题目的文字，请对照原文检查分题。')] if preamble else [])


def validate_questions(values, originals=None):
    """Only user-editable fields are accepted; provenance/confidence cannot be forged."""
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_QUESTIONS:
        raise ValueError('请保留 1–200 道题目。')
    original_map = {q['id']: q for q in originals or []}
    result, seen, total = [], set(), 0
    for index, value in enumerate(values):
        if not isinstance(value, dict):
            raise ValueError('题目格式不正确。')
        qid = value.get('id') or uuid.uuid4().hex
        if not isinstance(qid, str) or len(qid) > 64 or qid in seen:
            raise ValueError('题目标识重复或无效。')
        seen.add(qid)
        old = original_map.get(qid, {})
        q = {'id': qid, 'number': str(index + 1),
             'source': copy.deepcopy(old.get('source', {'pages': [], 'regions': [], 'method': 'manual-edit'})),
             'confidence': old.get('confidence'), 'segmentationUncertain': old.get('segmentationUncertain', False)}
        for field, limit in [('stem', 20000), ('answer', 5000), ('explanation', 10000)]:
            content = value.get(field, '')
            if not isinstance(content, str) or len(content) > limit or '\x00' in content:
                raise ValueError('题干、答案或解析长度或格式不正确。')
            q[field] = content.strip()
            total += len(content)
        options = value.get('options', [])
        if not isinstance(options, list) or len(options) > 8:
            raise ValueError('选项最多 8 个。')
        q['options'] = []
        for n, option in enumerate(options):
            if isinstance(option, str):
                option = {'text': option}
            if not isinstance(option, dict) or not isinstance(option.get('text'), str) or len(option['text']) > 5000:
                raise ValueError('选项格式不正确。')
            q['options'].append({'label': chr(65 + n), 'text': option['text'].strip()})
            total += len(option['text'])
        q['type'] = 'choice' if options else 'written'
        q['confirmed'] = value.get('confirmed') is True
        q['allowUnknownAnswer'] = value.get('allowUnknownAnswer') is True
        knowledge = value.get('knowledgePoints', [])
        if not isinstance(knowledge, list) or len(knowledge) > 12 or any(not isinstance(k, str) or len(k) > 80 for k in knowledge):
            raise ValueError('知识点最多 12 个，每个不超过 80 字。')
        q['knowledgePoints'] = list(dict.fromkeys(k.strip() for k in knowledge if k.strip()))
        q['sourceLiteralUnchanged'] = (old.get('sourceLiteralUnchanged', True)
            and q['stem'] == old.get('stem', '') and q['answer'] == old.get('answer', '')
            and q['explanation'] == old.get('explanation', '') and q['options'] == old.get('options', []))
        q['answerStatus'] = ('manual_unverified' if q['answer'] != old.get('answer', '') else old.get('answerStatus', 'manual_unverified')) if q['answer'] else 'unknown'
        result.append(q)
    if total > MAX_TEXT:
        raise ValueError('题目文字超过 20 万字，请分批整理。')
    return result


def self_review(questions, extraction_issues=None, course='', category=''):
    result = copy.deepcopy(questions)
    issues = list(extraction_issues or [])
    if not result:
        issues.append(issue('no_questions', '未识别出题目，请补充清晰原件或粘贴题目文字。'))
    fingerprints = set()
    for q in result:
        checks, confirmed = [], q.get('confirmed') is True
        stem = q.get('stem', '').strip()
        if len(stem) < 3:
            checks.append(issue('missing_stem', '题干太短或缺失。'))
        fingerprint = re.sub(r'\s+', '', stem)
        if fingerprint and fingerprint in fingerprints:
            checks.append(issue('duplicate_stem', '发现相同题干，请确认是否重复。'))
        fingerprints.add(fingerprint)
        options = q.get('options', [])
        if options and (len(options) < 2 or any(not o.get('text', '').strip() for o in options)):
            checks.append(issue('incomplete_options', '选择题至少需要两个非空选项。'))
        labels = [o.get('label') for o in options]
        if len(set(labels)) != len(labels):
            checks.append(issue('duplicate_option_labels', '选项标号重复。'))
        answer = q.get('answer', '').strip()
        if not answer:
            checks.append(issue('unknown_answer', '原件未提供答案；当前答案未知。', not (confirmed and q.get('allowUnknownAnswer'))))
        elif options and re.fullmatch(r'[A-H\s,，、]+', answer.upper()):
            selected = set(re.findall(r'[A-H]', answer.upper()))
            if not selected.issubset(set(labels)):
                checks.append(issue('answer_option_mismatch', '答案含有不存在的选项。'))
        if not confirmed:
            if q.get('source', {}).get('method') == 'manual-edit':
                checks.append(issue('manual_confirmation', '新增题目请核对后确认。'))
            confidence = q.get('confidence')
            if confidence is not None and confidence < .90:
                checks.append(issue('low_confidence', '部分文字识别置信度低于 90%，请对照原件。'))
            combined = '\n'.join([stem, answer, q.get('explanation', '')] + [o.get('text', '') for o in options])
            formula_text = combined
            if (q.get('source', {}).get('method') == 'source-xml'
                    and q.get('source', {}).get('literalText') is True
                    and q.get('sourceLiteralUnchanged', True)):
                # Native XML plain-text fractions were not OCR'd or flattened;
                # the trusted importer excludes MathML, media and table nodes.
                formula_text = re.sub(r'\b\d+/\d+\b', '', formula_text)
            if FORMULA.search(formula_text) or re.search(r'矩阵|行列式|向量|方程|多项式', combined):
                checks.append(issue('formula_review', '含公式或数学符号，请核对上下标、分式与排版。'))
            if re.search(r'如图|下图|图示|右图|左图|上图|下表|下列表格', combined):
                checks.append(issue('figure_review', '题目引用图表，文字重排未重建图表；请保留原件并补充核对。'))
            if '\ufffd' in combined or '□' in combined or re.search(r'[\ue000-\uf8ff]', combined):
                checks.append(issue('damaged_text', '含缺字或乱码，请对照原件。'))
            if q.get('segmentationUncertain'):
                checks.append(issue('segmentation_uncertain', '未找到可靠题号，暂保留为整段；请确认分题。'))
            if q.get('source', {}).get('method') == 'ocr' and confidence is None:
                checks.append(issue('unknown_confidence', '识别器没有提供置信度，请对照原件。'))
        q['issues'] = checks
        q['reviewState'] = 'needs_review' if any(c['blocking'] for c in checks) else 'passed'
    if not course.strip() or not category.strip() or category == '未分类':
        issues.append(issue('classification_missing', '请明确课程和资料分类后上架到私人题架。'))
    blocking = sum(bool(i.get('blocking', True)) for i in issues) + sum(c['blocking'] for q in result for c in q['issues'])
    return result, {'version': 1, 'passed': blocking == 0, 'blockingCount': blocking,
                    'issues': issues, 'questionCount': len(result),
                    'scope': '结构、完整性与识别质量检查；不证明答案的学科正确性。',
                    'answerCorrectnessVerified': False, 'visibility': 'private'}
