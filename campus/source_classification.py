"""Deterministic, evidence-bearing classification; filenames never set school identity."""
from __future__ import annotations

import hashlib
from pathlib import PurePosixPath
import re
import unicodedata

VERSION = 3
COURSES = {
    '高等数学': ['高等数学', '高数', 'advanced mathematics', 'calculus'],
    '数学分析': ['数学分析', 'mathematical analysis'],
    '线性代数': ['线性代数', '线代', 'linear algebra'],
    '概率论与数理统计': ['概率论与数理统计', '概率统计', '概率论', 'probability', 'statistics'],
    '大学物理': ['大学物理', '大物', 'college physics', 'general physics'],
    '离散数学': ['离散数学', 'discrete mathematics', 'discrete math'],
    '数据结构': ['数据结构', 'data structures', 'data structure'],
    '算法设计与分析': ['算法设计与分析', '算法分析', 'algorithm design'],
    '计算机组成原理': ['计算机组成原理', '计算机组成', 'computer organization'],
    '操作系统': ['操作系统', 'operating systems', 'operating system'],
    '计算机网络': ['计算机网络', 'computer networks', 'computer network'],
    '数据库': ['数据库', 'database systems', 'database'],
    '编译原理': ['编译原理', 'compiler principles', 'compilers'],
    '数字逻辑': ['数字逻辑', '数字电路', 'digital logic'],
    '模拟电子技术': ['模拟电子技术', '模拟电路', 'analog electronics'],
    '电路分析': ['电路分析', '电路原理', 'circuit analysis'],
    '信号与系统': ['信号与系统', 'signals and systems'],
    '自动控制原理': ['自动控制原理', '自动控制理论', 'control theory'],
    '程序设计': ['程序设计', 'programming'],
    '机器学习': ['机器学习', 'machine learning'],
    '人工智能': ['人工智能', 'artificial intelligence'],
    '大学英语': ['大学英语', 'college english'],
    '马克思主义基本原理': ['马克思主义基本原理', '马原'],
    '中国近现代史纲要': ['中国近现代史纲要', '近代史纲要'],
    '思想道德与法治': ['思想道德与法治', '思想道德修养', '思修'],
}
KINDS = {
    'answer': ['参考答案', '标准答案', '答案', '解答', '题解', 'solutions', 'solution', 'answers', 'answer'],
    'exam': ['期末', '期中', '试卷', '真题', '考试', 'final exam', 'midterm', 'examination', 'exam'],
    'exercise': ['习题', '练习', '作业', '题库', 'problem set', 'exercises', 'exercise', 'homework', 'quiz'],
    'notes': ['笔记', '讲义', '复习提纲', '知识点', '课件', 'lecture', 'notes', 'slides'],
}
QUESTION_TYPES = {'choice': ['选择题', '单选题', '多选题'], 'fill': ['填空题'],
                  'true-false': ['判断题'], 'proof': ['证明题'], 'calculation': ['计算题'],
                  'short-answer': ['简答题', '问答题'], 'programming': ['编程题', '程序设计题']}
KNOWLEDGE = {
    '极限': ['数列极限', '函数极限', '极限计算'], '导数': ['求导', '导数', '微分'],
    '积分': ['定积分', '不定积分', '重积分'], '矩阵': ['矩阵', 'matrix'],
    '特征值': ['特征值', 'eigenvalue'], '概率分布': ['概率分布', '正态分布'],
    '链表': ['链表', 'linked list'], '二叉树': ['二叉树', 'binary tree'],
    '图论': ['图论', '最短路径'], '排序': ['快速排序', '归并排序'],
    '进程与线程': ['进程', '线程'], '内存管理': ['虚拟内存', '分页管理'],
    '网络协议': ['TCP', 'UDP', 'IP协议'], '数据库查询': ['SQL', '关系代数'],
}


def normalized(value):
    return unicodedata.normalize('NFKC', str(value or '')).casefold().replace('_', ' ')


def match_alias(value, alias):
    text, needle = normalized(value), normalized(alias)
    if not needle:
        return False
    if re.fullmatch(r'[a-z0-9 .+\-]+', needle):
        return re.search(r'(?<![a-z0-9])' + re.escape(needle) + r'(?![a-z0-9])', text) is not None
    return needle in text


def _aliases(defaults, configured):
    merged = {key: list(value) for key, value in defaults.items()}
    for name, aliases in (configured or {}).items():
        if isinstance(name, str) and isinstance(aliases, list):
            merged[name] = list(dict.fromkeys([name] + aliases + merged.get(name, [])))
    return merged


def course_directory(path, source):
    """Only maintained source templates can interpret a folder as a course name."""
    parts = str(path).split('/')
    for template in source.get('coursePathTemplates', []):
        if not isinstance(template, str):
            continue
        tokens = template.split('/')
        if tokens.count('{course}') != 1 or tokens[-1] != '**' or '**' in tokens[:-1] or len(parts) < len(tokens):
            continue
        capture = None
        for index, token in enumerate(tokens[:-1]):
            if token == '{course}':
                capture = parts[index].strip()
            elif token != '*' and token != parts[index]:
                break
        else:
            if capture and 2 <= len(capture) <= 100 and normalized(capture) not in {
                'images', 'image', 'assets', 'misc', 'docs', 'scripts', 'public', 'exam', 'exams',
                'notes', '试卷', '答案', '参考答案', '笔记', '课件', '资料', '其他', '0-模板', '0-电子科技大学 ppt 模板'}:
                if source.get('courseCodePrefix'):
                    capture = re.sub(r'^[A-Za-z]{1,4}\d{2,7}\s+', '', capture)
                if source.get('courseDirectoryFormat') == 'academic-exam':
                    matched = re.fullmatch(r'\d{2}-\d{2}-[12]-(.+?)-(?:期末|期中)(?:[（(][^）)]*[）)])?(?:-.+)?', capture)
                    if not matched:
                        continue
                    capture = matched[1]
                return capture, template
    return None, None


def classify(path, source, text=''):
    """Use path evidence for course; body words only refine question/knowledge types."""
    evidence, confidence, issues = [], {}, []
    result = {'schoolId': source['school']['id'], 'college': 'unknown', 'course': 'unknown',
              'courseVariant': None, 'year': None, 'academicYear': None, 'term': None, 'kind': 'unknown',
              'questionTypes': [], 'knowledgePoints': [], 'suiteKey': None,
              'classificationVersion': VERSION}
    evidence.append({'field': 'schoolId', 'value': result['schoolId'], 'matched': source['id'],
                     'origin': 'registered-source', 'confidence': 1.0})
    confidence['schoolId'] = 1.0
    configured_courses = {hint: [hint] for hint in source.get('courseHints', []) if isinstance(hint, str) and hint.strip()}
    configured_courses.update(source.get('courseAliases') or {})
    course_aliases = _aliases(COURSES, configured_courses)
    for field, mapping in [('course', course_aliases),
                           ('college', _aliases({}, source.get('collegeAliases')))]:
        matches = [(name, alias) for name, aliases in mapping.items() for alias in aliases if match_alias(path, alias)]
        # Longest alias wins only if all shorter evidence is nested in it; unrelated courses remain unknown.
        matches.sort(key=lambda pair: len(pair[1]), reverse=True)
        if matches:
            name, alias = matches[0]
            conflicts = [(n, a) for n, a in matches[1:] if n != name and normalized(a) not in normalized(alias)]
            if conflicts:
                issues.append(field + '-ambiguous')
                confidence[field] = 0.0
                for n, a in matches:
                    evidence.append({'field': field, 'value': n, 'matched': a, 'origin': 'path-conflict', 'confidence': 0.0})
            else:
                result[field], confidence[field] = name, 0.95
                evidence.append({'field': field, 'value': name, 'matched': alias, 'origin': 'path-alias', 'confidence': 0.95})
        else:
            confidence[field] = 0.0
    directory, template = course_directory(path, source)
    if directory:
        canonical = next((name for name, aliases in course_aliases.items() if any(normalized(alias) == normalized(directory) for alias in aliases)), directory)
        result['courseCanonical'] = result['course'] if result['course'] != 'unknown' else canonical
        result['course'] = canonical
        confidence['course'] = 0.92
        issues[:] = [issue for issue in issues if issue != 'course-ambiguous']
        evidence.append({'field': 'course', 'value': canonical, 'matched': directory,
                         'origin': 'registered-course-directory', 'template': template, 'confidence': 0.92})
    clean = normalized(path)
    variant = re.search(r'(?:高等数学|线性代数|大学物理|数学分析)\s*([a-d])?(?:\s*\(?([上下一二三])\)?)?', clean)
    if variant and any(variant.groups()):
        result['courseVariant'] = ''.join(group.upper() for group in variant.groups() if group)
        evidence.append({'field': 'courseVariant', 'value': result['courseVariant'], 'matched': variant[0], 'origin': 'path', 'confidence': 0.95})
    academic = re.search(r'(?<!\d)((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2})(?!\d)', clean)
    short_academic = re.search(r'(?<!\d)(\d{2})-(\d{2})-([12])(?:\D|$)', clean)
    if academic and int(academic[2]) == int(academic[1]) + 1:
        result['academicYear'] = academic[1] + '-' + academic[2]
        result['year'] = int(academic[1])
    elif short_academic and int(short_academic[2]) == int(short_academic[1]) + 1:
        result['academicYear'] = '20' + short_academic[1] + '-20' + short_academic[2]
        result['year'] = 2000 + int(short_academic[1])
        result['term'] = '第一学期' if short_academic[3] == '1' else '第二学期'
    else:
        years = set(re.findall(r'(?<!\d)(?:19\d{2}|20\d{2})(?!\d)', clean))
        if len(years) == 1:
            result['year'] = int(next(iter(years)))
        elif len(years) > 1:
            issues.append('year-ambiguous')
    if result['year']:
        confidence['year'] = 0.9
        evidence.append({'field': 'year', 'value': result['year'], 'matched': result['academicYear'] or str(result['year']), 'origin': 'path', 'confidence': 0.9})
    terms = [('第一学期', r'第一学期|第1学期|秋季|秋冬|(?:19|20)?\d{2}年?秋|autumn|fall|[12]\d{3}[-_ ]1(?:\D|$)'),
             ('第二学期', r'第二学期|第2学期|春季|春夏|(?:19|20)?\d{2}年?春|spring|[12]\d{3}[-_ ]2(?:\D|$)')]
    for term, pattern in terms:
        matched = re.search(pattern, clean)
        if matched:
            result['term'] = term
            evidence.append({'field': 'term', 'value': term, 'matched': matched[0], 'origin': 'path', 'confidence': 0.9})
            break
    for kind, aliases in KINDS.items():
        candidate = re.sub(r'(?:无|没有|不含|不包含|未含|未附|不附)\s*(?:参考|标准)?(?:答案|解答)|(?:without|no)[ _-]*(?:answers?|solutions?)', '', path, flags=re.I) if kind == 'answer' else path
        matched = next((alias for alias in aliases if match_alias(candidate, alias)), None)
        if matched:
            result['kind'], confidence['kind'] = kind, 0.92
            evidence.append({'field': 'kind', 'value': kind, 'matched': matched, 'origin': 'path-alias', 'confidence': 0.92})
            break
    for field, mapping in [('questionTypes', QUESTION_TYPES), ('knowledgePoints', KNOWLEDGE)]:
        for name, aliases in mapping.items():
            matched = next((alias for alias in aliases if match_alias(path + '\n' + text[:200000], alias)), None)
            if matched:
                result[field].append(name)
                evidence.append({'field': field, 'value': name, 'matched': matched,
                                 'origin': 'path' if match_alias(path, matched) else 'extracted-text', 'confidence': 0.8})
    # Pair only explicit paper identifiers, never same course/year alone or cross-school.
    paper = re.search(r'(?:试卷\s*([a-d])|([a-d])\s*卷|第\s*([一二三四五六七八九十\d]+)\s*套)', clean)
    exam = '期中' if '期中' in clean else '期末' if '期末' in clean else None
    if paper and exam and result['year'] and result['course'] != 'unknown':
        token = next(group for group in paper.groups() if group)
        identity = '|'.join(str(v or '') for v in (source['school']['id'], source['id'], result['course'], result['courseVariant'], result['year'], result['term'], exam, token))
        result['suiteKey'] = hashlib.sha256(identity.encode()).hexdigest()[:24]
        evidence.append({'field': 'suiteKey', 'value': result['suiteKey'], 'matched': paper[0], 'origin': 'explicit-paper-id', 'confidence': 0.95})
    result.update(classificationEvidence=evidence, confidence=confidence, classificationIssues=issues)
    return result


def link_suites(resources):
    groups = {}
    for resource in resources:
        resource['relatedResourceIds'] = []
        if resource.get('suiteKey'):
            groups.setdefault(resource['suiteKey'], []).append(resource)
    for group in groups.values():
        exams = [item for item in group if item['kind'] == 'exam']
        answers = [item for item in group if item['kind'] == 'answer']
        if len(exams) == 1 and len(answers) == 1:
            for resource in group:
                if resource in exams + answers:
                    resource['relatedResourceIds'] = [item['id'] for item in exams + answers if item['id'] != resource['id']]
        elif exams and answers:
            for resource in group:
                issues = resource.setdefault('classificationIssues', [])
                if 'suite-ambiguous' not in issues:
                    issues.append('suite-ambiguous')
    return resources
