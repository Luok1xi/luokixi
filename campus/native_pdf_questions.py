"""Conservative PDF-text segmentation; never infer missing questions or answers.

Question numbers must form a consecutive sequence within explicit sections.
Parenthesized subparts remain in their parent question, and mathematics never
becomes a choice merely because it contains ``E)``. PDF layout needs review.
"""
from __future__ import annotations

import re
import uuid

_SECTION = re.compile(r'^([一二三四五六七八九十]+)[、.．]\s*(.+)$')
_KNOWN_SECTION = re.compile(r'单项选择|多项选择|单选|多选|选择题|填空|判断|问答|简答|论述|计算题|解答题|证明题|程序设计|综合设计')
_NUMBER = re.compile(r'^(\d{1,3})\s*[.．、)）题](?!\d)\s*(.*)$')
_SPACED_NUMBER = re.compile(r'^(\d{1,3})[ \t]+([\u3400-\u9fff].*)$')
_STAR_NUMBER = re.compile(r'^(\d{1,3})\s*[*∗＊]\s*(.*)$')
_OPTION = re.compile(r'(?:^|\s)([A-H])[.．、:：)）]\s*')
_FOOTER = re.compile(r'^第\s*\d+\s*页\s*(?:共\s*\d+\s*页)?$')
_ANSWER_TITLE = re.compile(r'^(?:(?:.*(?:考试卷|试卷|试题).*(?:答卷|答题纸|答题卡))|(?:参考答案|标准答案|答题纸|答题卡|答案与解析))$')
_ANSWER_GRID = re.compile(r'^1[、.．)）]\s*[A-H√×对错]\s*[;；,，、\s]+2[、.．)）]\s*[A-H√×对错](?:\W|$)')


def _issue(code, message, blocking=True, **details):
    return dict(code=code, message=message, blocking=blocking, **details)


def _page_lines(text, page_number):
    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    lines = [line.strip() for line in lines if line.strip()]
    # Only the last line is a bare-number footer. Interior numbers can be
    # superscripts, denominators, or the starred question number in PKU hw01.
    if lines and lines[-1] == str(page_number):
        lines.pop()
    return [line for line in lines
            if not _FOOTER.fullmatch(line) and not re.match(r'^座位号\s*[:：]', line)]


def _split_options(lines, section):
    """Extract only an A, B, ... sequence, starting at a line boundary.

    A bare mathematical tuple is not an option list. Outside a choice section,
    require at least two sequential options before accepting the interpretation.
    """
    stem, options = [], []
    for line in lines:
        if not options:
            first = re.match(r'^A[.．、:：)）]\s*', line)
            if not first:
                stem.append(line)
                continue
            options.append({'label': 'A', 'text': ''})
            value = line[first.end():]
        else:
            value = line
        cursor = 0
        for found in _OPTION.finditer(value):
            if ord(found[1]) != ord('A') + len(options):
                continue
            fragment = value[cursor:found.start()].strip()
            if fragment:
                options[-1]['text'] += ('\n' if options[-1]['text'] else '') + fragment
            options.append({'label': found[1], 'text': ''})
            cursor = found.end()
        tail = value[cursor:].strip()
        if tail:
            options[-1]['text'] += ('\n' if options[-1]['text'] else '') + tail
    if len(options) < 2 or any(not item['text'].strip() for item in options):
        return '\n'.join(lines).strip(), []
    # Do not treat examples in a written/programming question as its choices.
    if section and not re.search(r'选择|单选|多选', section):
        return '\n'.join(lines).strip(), []
    return '\n'.join(stem).strip(), options


def parse_native_pdf(pages):
    """Return ``(questions, issues)`` in the existing workshop question schema.

    The original page numbers are preserved. Once an explicit answer-sheet title
    appears in the first three nonempty lines, that page and its continuations
    are excluded; the original file remains available as the answer companion.
    """
    issues, usable, excluded = [], [], []
    answer_started = False
    for page in pages:
        raw_lines = [line.strip() for line in page.get('text', '').replace('\r', '').split('\n') if line.strip()]
        if any(_ANSWER_TITLE.fullmatch(re.sub(r'\s+', '', line)) for line in raw_lines[:3]):
            answer_started = True
        if answer_started:
            excluded.append(page['page'])
        else:
            usable.append((page, _page_lines(page.get('text', ''), page['page'])))
    if excluded:
        issues.append(_issue('answer_pages_excluded', '答题纸和答案页保留在原件中，不重复组题。', False,
                             excludedPageNumbers=excluded))
    # Answer-only worksheets can have a subject heading instead of an answer
    # heading. A first numbered row made of several option letters is not a stem.
    for _, lines in usable:
        for line in lines[:12]:
            if _ANSWER_GRID.match(line):
                return [], issues + [_issue('answer_only_document', '检测到答案表，保留为答案附件。')]
            if _NUMBER.match(line) or _SPACED_NUMBER.match(line):
                break

    questions, current = [], None
    section, last_number, number_style = '', 0, None
    section_start = True
    ambiguous = False
    for page, lines in usable:
        index = 0
        while index < len(lines):
            line = lines[index]
            # Starred questions may extract as two lines: "8" then "∗ 设...".
            if re.fullmatch(r'\d{1,3}', line) and index + 1 < len(lines) and re.match(r'^[*∗＊]\s*[\u3400-\u9fff]', lines[index + 1]):
                line += lines[index + 1]
                index += 1
            index += 1
            heading = _SECTION.match(line)
            if heading and (_KNOWN_SECTION.search(heading[2]) or re.fullmatch(r'[\u3400-\u9fff与及和 /]{2,24}', heading[2])):
                section = line
                current = None
                section_start = True
                number_style = None
                continue
            punctuated, spaced, starred = _NUMBER.match(line), _SPACED_NUMBER.match(line), _STAR_NUMBER.match(line)
            style = 'punctuated' if punctuated else 'spaced' if spaced else 'starred'
            numbered = punctuated or spaced or starred
            # A line-broken exponent followed by Chinese text ("2 成正比")
            # is not question 2 in a paper whose markers are "1.", "2.".
            if numbered and number_style and style not in (number_style, 'starred'):
                numbered = None
            if numbered:
                n, body = int(numbered[1]), numbered[2]
                # Closing punctuation after sqrt(2) is not a new question.
                meaningful = bool(re.search(r'[\w\u3400-\u9fff]', body))
                expected = n == last_number + 1 or (section_start and n == 1)
                if meaningful and expected:
                    if len(questions) >= 200:
                        raise ValueError('题目超过 200 道，请分批整理。')
                    current = {'id': uuid.uuid4().hex, 'number': str(n), '_lines': [body],
                               'source': {'pages': [page['page']], 'regions': [],
                                          'method': page.get('method', 'pdf-text'), 'section': section,
                                          'originalNumber': str(n), 'requiresLayoutReview': True},
                               'confidence': None, 'confirmed': False, 'allowUnknownAnswer': False,
                               'knowledgePoints': [], 'segmentationUncertain': False}
                    questions.append(current)
                    last_number, section_start = n, False
                    if style != 'starred':
                        number_style = style
                    continue
                # A forward jump can be a missing boundary, so never claim that
                # such a merged document is ready to become a question bank.
                if meaningful and n > last_number + 1:
                    ambiguous = True
            if current is not None:
                current['_lines'].append(line)
                if page['page'] not in current['source']['pages']:
                    current['source']['pages'].append(page['page'])
    for question in questions:
        stem, options = _split_options(question.pop('_lines'), question['source']['section'])
        question.update(stem=stem, options=options, type='choice' if options else 'written',
                        answer='', explanation='', answerStatus='unknown')
        if ambiguous:
            question['segmentationUncertain'] = True
    if ambiguous:
        issues.append(_issue('native_numbering_uncertain', '题号存在不连续处，请对照原件确认分题。'))
    if not questions:
        issues.append(_issue('native_no_reliable_questions', '没有识别到可靠的连续题号，保留原件。'))
    return questions, issues
