"""Bounded native extraction. MDX is parsed as inert data, never evaluated."""
from __future__ import annotations
import copy
import hashlib
import json
import gzip
from pathlib import Path
import re
from functools import lru_cache

EXTRACTOR_VERSION = 3
MAX_PAGES = 24
MAX_BYTES = 12 * 1024 * 1024


def _hash(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:32]


def _plain(value):
    # Keep LaTeX and image references visible for manual layout review.
    value = re.sub(r'<Slot\b[^>]*/>', '（　）', value)
    value = re.sub(r'<Blank\s*/>', '______', value)
    value = re.sub(r'</?(?:p|div|span|br)\b[^>]*>', '\n', value)
    return value.strip()


def _question(body, section, number, line):
    answers, options, flags = [], [], []
    solutions = re.findall(r'<Solution\b[^>]*>(.*?)</Solution>', body, re.S)
    body = re.sub(r'<Solution\b[^>]*>.*?</Solution>', '', body, flags=re.S)
    choices = list(re.finditer(r'<Choices\b([^>]*)>(.*?)</Choices>', body, re.S))
    if len(choices) == 1:
        option_source = choices[0].group(2)
        token = re.compile(r'<Option\b([^>]*)>(.*?)</Option>|^[ \t]*([+\-])\s+([^\n]+)', re.S | re.M)
        for found in token.finditer(option_source):
            if len(options) >= 8:
                flags.append('too-many-options'); break
            label = chr(65 + len(options))
            options.append({'label': label, 'text': _plain(found.group(2) if found.group(1) is not None else found.group(4))})
            attrs = found.group(1) or ''
            correct = bool(re.search(r'(?:^|\s)correct(?:\s|$)', attrs)) or found.group(3) == '+'
            if correct:
                answers.append(label)
            if re.search(r'correct\s*=', attrs):
                flags.append('dynamic-option-answer')
        body = body[:choices[0].start()] + body[choices[0].end():]
    elif choices:
        # Shared passages / several answer groups must remain a single source block.
        flags.append('shared-choice-passage')
    blanks = re.findall(r'<Blank\b[^>]*>(.*?)</Blank>', body, re.S)
    body = re.sub(r'<Blank\b[^>]*>.*?</Blank>', '______', body, flags=re.S)
    if blanks:
        answers.extend(_plain(value) for value in blanks)
    explanation = '\n\n'.join(_plain(value) for value in solutions)
    if not answers and explanation and not options:
        answers = [explanation]
    stem = _plain(body)
    if re.search(r'<[A-Za-z]|!\[|\$|\\(?:frac|sqrt|begin)|\{[^}]*\}', stem + explanation + ''.join(o['text'] for o in options)):
        flags.append('source-layout-review')
    return {'number': str(number), 'stem': stem, 'options': options, 'type': 'choice' if options else 'written',
            'answer': '、'.join(answers), 'answerStatus': 'source_unverified' if answers else 'unknown',
            'explanation': explanation, 'confirmed': False, 'allowUnknownAnswer': False,
            'confidence': None, 'knowledgePoints': [], 'segmentationUncertain': False,
            'source': {'method': 'source-mdx', 'pages': [], 'regions': [], 'section': section,
                       'line': line, 'originalNumber': str(number), 'requiresLayoutReview': bool(flags),
                       'extractionFlags': flags}}


def parse_mdx(raw):
    """Follow BYR's H2 sections / H3 written questions / top-level choice lists.

    Nested numbered steps in a written question remain together. Imported JS,
    components, mathematical text and images are never rendered or executed.
    """
    header = re.match(r'\A---\s*\n(.*?)\n---\s*\n', raw, re.S)
    metadata = {}
    if header:
        last_key = None
        for line in header.group(1).splitlines():
            item = re.match(r'^([^:\n]+):[ \t]*(.*)$', line)
            if item:
                last_key = item[1].strip()
                metadata[last_key] = item[2].strip()
            elif last_key and re.match(r'^\s*-\s+', line):
                if not isinstance(metadata[last_key], list):
                    metadata[last_key] = []
                metadata[last_key].append(re.sub(r'^\s*-\s+', '', line).strip())
        raw = '\n' * raw[:header.end()].count('\n') + raw[header.end():]
    raw = re.sub(r'^import .*$', '', raw, flags=re.M)
    # Fenced code can contain fake headings/list markers. Mask only for boundary
    # discovery, preserving byte positions and the original code inside a question.
    masked, fence, width = [], None, 0
    for line in raw.splitlines(keepends=True):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        hidden = bool(fence)
        if marker and not fence:
            fence, width, hidden = marker[1][0], len(marker[1]), True
        elif marker and marker[1][0] == fence and len(marker[1]) >= width:
            fence = None
        masked.append(re.sub(r'[^\n\r]', ' ', line) if hidden else line)
    structural = ''.join(masked)
    sections = list(re.finditer(r'^##\s+(.+)$', structural, re.M))
    questions = []
    for index, marker in enumerate(sections):
        section = marker.group(1)
        end = sections[index + 1].start() if index + 1 < len(sections) else len(raw)
        start = marker.end()
        body = raw[start:end]
        markers = structural[start:end]
        boundaries = list(re.finditer(r'^###\s+(\d+)[.．、)]?[ \t]*\n?', markers, re.M))
        if not boundaries and re.search(r'选择|单选|多选|填空|判断', section):
            boundaries = list(re.finditer(r'^(\d+)[.．、)][ \t]+', markers, re.M))
        if boundaries:
            preamble = body[:boundaries[0].start()].strip()
            for i, boundary in enumerate(boundaries):
                block_end = boundaries[i + 1].start() if i + 1 < len(boundaries) else len(body)
                block = body[boundary.end():block_end]
                q = _question((preamble + '\n\n' if preamble else '') + block, section, boundary.group(1),
                              raw[:start + boundary.start()].count('\n') + 1)
                questions.append(q)
        elif (body.strip() and re.match(r'(?:[一二三四五六七八九十]+|\d+)[、.．（(\s]', section)
              and not re.search(r'注意|说明|附录|参考文献', section)):
            questions.append(_question(body, section, section.split('、')[0], raw[:start].count('\n') + 1))
    return questions, metadata


def extract_bank(resource, path):
    """Return existing workshop question schema, with immutable per-question source.

    Inputs come only from the registered collector. Return None for unsupported
    files, empty/scanned PDFs or documents without reliable question boundaries.
    """
    from hub.question_pipeline import parse_pages, self_review, validate_questions
    original = Path(path)
    if original.stat().st_size > MAX_BYTES or resource.get('kind') not in ('exam', 'exercise', 'answer'):
        return None
    if resource.get('kind') == 'answer' and not re.search(r'(?:卷|题)(?:及|与|和)答案|(?:含|附|带)答案', resource.get('title', '') + resource.get('path', '')):
        # An answer key without stems is an attachment, not an independent bank.
        return None
    raw_bytes = original.read_bytes()
    digest = hashlib.sha256(raw_bytes).hexdigest()
    if resource.get('sha256') != digest:
        raise ValueError('source-content-hash-mismatch')
    extension = resource.get('format', original.suffix.lstrip('.')).lower()
    pages, issues, metadata = [], [], {}
    if extension == 'mdx':
        raw = raw_bytes.decode('utf-8-sig')
        if len(raw) > 200000:
            return None
        questions, metadata = parse_mdx(raw)
        if isinstance(metadata.get('科目'), str) and 0 < len(metadata['科目']) <= 160:
            resource['sourceCourseName'] = metadata['科目']
            if resource.get('course') == 'unknown':
                resource['course'] = metadata['科目']
                resource.setdefault('classificationEvidence', []).append({'field': 'course', 'value': metadata['科目'], 'origin': 'source-frontmatter', 'confidence': 0.95})
        colleges = metadata.get('学院', [])
        if isinstance(colleges, list) and 0 < len(colleges) <= 8 and all(isinstance(c,str) and len(c)<=80 for c in colleges):
            resource['college'] = ' / '.join(colleges)
            resource.setdefault('classificationEvidence', []).append({'field': 'college', 'value': resource['college'], 'origin': 'source-frontmatter', 'confidence': 0.95})
    elif extension in ('md', 'txt', 'markdown', 'pdf'):
        if extension == 'pdf':
            try:
                import pypdfium2 as pdfium
            except ImportError:
                return None
            doc = pdfium.PdfDocument(str(original))
            try:
                if len(doc) > MAX_PAGES:
                    return None
                for i in range(len(doc)):
                    page = doc[i]
                    textpage = page.get_textpage()
                    try:
                        text = textpage.get_text_range()
                    finally:
                        textpage.close(); page.close()
                    pages.append({'page': i + 1, 'text': text, 'method': 'pdf-text', 'blocks': []})
            finally:
                doc.close()
        else:
            raw = raw_bytes.decode('utf-8-sig')
            pages = [{'page': 1, 'text': raw, 'method': 'source-text', 'blocks': []}]
        if sum(len(p['text']) for p in pages) > 200000:
            return None
        if extension == 'pdf':
            from native_pdf_questions import parse_native_pdf
            questions, issues = parse_native_pdf(pages)
        else:
            questions, issues = parse_pages(pages)
        if any(q.get('segmentationUncertain') for q in questions):
            return None
        # Native PDF extraction may move columns/superscripts even at high text quality.
        for q in questions:
            q['source'].update(originalNumber=q['number'], requiresLayoutReview=extension == 'pdf')
    else:
        return None
    if not 1 <= len(questions) <= 200:
        return None
    bank_id = 'ub-' + _hash(resource['id'])[:24]
    rights = copy.deepcopy(resource.get('rights', {}))
    title = resource.get('title') or resource['path']
    if title == 'index':
        title = Path(resource['path']).parent.name
    for index, q in enumerate(questions):
        q['id'] = _hash(bank_id + '\0' + digest + '\0v' + str(EXTRACTOR_VERSION) + '\0' + str(index))
        q['source'].update(bankId=bank_id, resourceId=resource['id'], sourceId=resource['sourceId'],
            sourceUrl=resource.get('sourceUrl') or resource['url'], title=title,
            schoolId=resource['schoolId'], course=resource.get('course', 'unknown'),
            commit=resource.get('commit'), sha256=digest, license=rights.get('license', '待核对'),
            licenseUrl=rights.get('licenseUrl', ''), rights=rights)
        from source_classification import classify
        item_class = classify('', {'id':resource['sourceId'], 'school':{'id':resource['schoolId']}},
                              q['stem'] + '\n' + q.get('explanation', ''))
        q['knowledgePoints'] = item_class['knowledgePoints'][:12]
        q['source']['knowledgeEvidence'] = [e for e in item_class['classificationEvidence'] if e['field']=='knowledgePoints']
    questions = validate_questions(questions, questions)
    course = resource.get('course', 'unknown')
    layout = [{'code': 'source_layout_review', 'blocking': True,
               'message': '部分公式、图表或复杂题目结构需对照原件核对。'}] if any(q['source'].get('requiresLayoutReview') for q in questions) else []
    if course == 'unknown':
        issues.append({'code': 'course_unknown', 'blocking': True, 'message': '课程归类待核对。'})
    questions, review = self_review(questions, issues + layout, course, '跨校试题')
    return {'schemaVersion': 1, 'extractorVersion': EXTRACTOR_VERSION, 'id': bank_id, 'sourceId': resource['sourceId'],
            'resourceId': resource['id'], 'title': title, 'schoolId': resource['schoolId'],
            'schoolName': resource.get('schoolName', ''), 'course': course,
            'sourceUrl': resource.get('sourceUrl') or resource['url'], 'commit': resource.get('commit'),
            'sha256': digest, 'revision': digest + '-v' + str(EXTRACTOR_VERSION), 'license': rights.get('license', '待核对'),
            'licenseUrl': rights.get('licenseUrl', ''), 'rights': rights,
            'attribution': resource.get('attribution') or resource['sourceId'],
            'changes': 'Native text extraction and editable question segmentation; source answers are unverified.',
            'sourceMetadata': metadata, 'questionCount': len(questions), 'questions': questions,
            'review': review, 'extractionIssues': issues + layout,
            'visibility': 'private-study', 'checkedAt': resource.get('downloadedAt') or resource.get('indexedAt')}


@lru_cache(maxsize=2)
def _read_catalogue(path, modified_ns, size):
    result = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(result, dict):
        raise ValueError('跨校目录格式不正确。')
    return result


def load_catalogue(folder):
    path = Path(folder) / 'university-sources.json'
    if not path.exists():
        return {'version': 1, 'schools': [], 'sources': [], 'resources': [], 'questionBanks': [], 'runStats': {}}
    stat = path.stat()
    if stat.st_size > 80 * 1024 * 1024:
        raise ValueError('跨校目录超过读取上限。')
    return _read_catalogue(str(path.resolve()), stat.st_mtime_ns, stat.st_size)


def public_catalogue(folder):
    data = dict(load_catalogue(folder))
    # Read-only metadata endpoint never ships every question or local filesystem paths.
    data['questionBanks'] = [{k: v for k, v in bank.items() if k not in ('questions', 'extractionIssues')}
                             for bank in data.get('questionBanks', [])]
    fields = {'id','sourceId','schoolId','title','path','url','course','courseCanonical','courseVariant','sourceCourseName','college','year','academicYear','term','kind',
              'questionTypes','knowledgePoints','classificationEvidence','classificationIssues','confidence',
              'relatedResourceIds','format','state','questionCount','bankId','indexedAt','downloadedAt','sha256'}
    data['resources'] = [{k: v for k, v in item.items() if k in fields}
                         for item in data.get('resources', [])]
    return data


@lru_cache(maxsize=2)
def _encoded_catalogue(folder, modified_ns, size, compressed):
    raw = json.dumps(public_catalogue(folder), ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return gzip.compress(raw, compresslevel=3, mtime=0) if compressed else raw


def catalogue_response(folder, compressed=False):
    path = Path(folder) / 'university-sources.json'
    stat = path.stat() if path.exists() else None
    modified, size = (stat.st_mtime_ns, stat.st_size) if stat else (0, 0)
    tag = '"university-' + str(modified) + '-' + str(size) + ('-gz' if compressed else '') + '"'
    return _encoded_catalogue(str(Path(folder).resolve()), modified, size, compressed), tag


def get_bank(folder, bank_id):
    if not isinstance(bank_id, str) or not re.fullmatch(r'ub-[a-f0-9]{24}', bank_id):
        raise LookupError('尚未收录这份题目。')
    data = load_catalogue(folder)
    matching = [b for b in data.get('questionBanks', []) if b.get('id') == bank_id]
    if len(matching) != 1:
        raise LookupError('这份资料尚未识别成题目。')
    bank = copy.deepcopy(matching[0])
    source = next((s for s in data.get('sources', []) if s.get('id') == bank.get('sourceId')), None)
    resource = next((r for r in data.get('resources', []) if r.get('id') == bank.get('resourceId')), None)
    if not source or not resource or bank.get('sha256') != resource.get('sha256') or resource.get('bankId') != bank_id:
        raise ValueError('题目来源或版本已变化，请重新采集。')
    if any(item.get('rights', {}).get('mode') not in ('private-study', 'download-allowed') for item in (bank, source, resource)):
        raise ValueError('这份来源仅提供原文链接。')
    if (bank.get('sourceUrl') != resource.get('sourceUrl', resource.get('url'))
            or bank.get('schoolId') != source.get('schoolId') or resource.get('sourceId') != source.get('id')):
        raise ValueError('题目来源凭据不一致。')
    if not isinstance(bank.get('questions'), list) or not 1 <= len(bank['questions']) <= 200:
        raise ValueError('题目结构不完整。')
    bank['schoolName'] = next((s.get('name', '') for s in data.get('schools', []) if s['id'] == bank['schoolId']), '')
    return bank
