"""Bounded text relevance for already-authorized public catalogue records.

No database access, persistence, identity merging, or correction of names/IDs.
Callers must apply publication/visibility filters before obtaining candidates.
"""
import re
import unicodedata
from functools import lru_cache

ALIASES = (
    ('线性代数', '线代', 'linear algebra', 'linalg'),
    ('高等数学', '高数', 'calculus'),
    ('大学物理', '大物', 'college physics'),
    ('概率论与数理统计', '概率论', '概率统计'),
    ('英语四级', '四级', 'cet4', 'cet 4', 'cet-4'),
    ('英语六级', '六级', 'cet6', 'cet 6', 'cet-6'),
    ('计算机科学', 'cs', 'computer science'),
    ('嵌入式', 'embedded', '单片机', 'mcu'),
    ('日常', 'daily', '生活'),
    ('数据结构', 'data structures', 'data structure'),
    ('机器学习', 'machine learning', 'ml'),
    ('人工智能', 'artificial intelligence', 'ai'),
    ('javascript', 'js'), ('typescript', 'ts'),
    ('图书馆', 'library'), ('开源', 'open source'),
)


def normalize_search(value):
    value = unicodedata.normalize('NFKC', str(value or '')).lower()
    return ' '.join(''.join(' ' if unicodedata.category(c)[0] in 'PS' and c not in '+#' else c
                           for c in value).split())


_ALIASES = {normalize_search(alias): group[0] for group in ALIASES for alias in group}
_ALIAS_RE = re.compile('|'.join(re.escape(key) for key in sorted(_ALIASES, key=len, reverse=True)))


@lru_cache(maxsize=512)
def _canonical(value):
    normalized = normalize_search(value)

    def replace(match):
        term = match.group()
        before = normalized[match.start() - 1:match.start()] if match.start() else ''
        after = normalized[match.end():match.end() + 1]
        if re.fullmatch(r'[a-z0-9 +#]+', term) and (
                re.fullmatch(r'[a-z0-9]', before) or re.fullmatch(r'[a-z0-9]', after)):
            return term
        if (term == '大物' and after == '理') or (term == '线代' and after == '数'):
            return term
        return _ALIASES[term]

    return _ALIAS_RE.sub(replace, normalized)


def _one_edit(a, b):
    if abs(len(a) - len(b)) > 1:
        return False
    i = j = edits = 0
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            i += 1
            j += 1
            continue
        edits += 1
        if edits > 1:
            return False
        if len(a) == len(b) and a[i:i + 2] == b[j:j + 2][::-1] and len(a[i:i + 2]) == 2:
            i += 2
            j += 2
        elif len(a) > len(b):
            i += 1
        elif len(a) < len(b):
            j += 1
        else:
            i += 1
            j += 1
    return edits + int(i < len(a) or j < len(b)) <= 1


def _near_word(token, value):
    return bool(re.fullmatch(r'[a-z]{4,32}', token)) and any(
        re.fullmatch(r'[a-z]{4,32}', word) and _one_edit(token, word) for word in value.split())


def _subsequence(token, value):
    if not 2 <= len(token) <= 24 or any(c.isdigit() for c in token):
        return False
    if re.fullmatch('[a-z]+', token) and len(token) < 3:
        return False
    for word in value.split():
        if len(word) > len(token) + 3:
            continue
        letters = iter(word)
        if all(any(c == expected for c in letters) for expected in token):
            return True
    return False


def text_score(query, title, body='', keywords=''):
    """Return positive relevance, or 0 for no match/empty query.

    Whole query tokens are required. Alias expansion, close title subsequences,
    and one edit/transposition in Latin words are allowed. Digits, short Latin
    aliases, Chinese names, course codes and version identifiers are not corrected.
    """
    raw_query = normalize_search(str(query or '')[:256])
    canonical_query = _canonical(raw_query)
    tokens = tuple(dict.fromkeys(canonical_query.split()))[:12]
    if not tokens:
        return 0
    raw_title = normalize_search(str(title or '')[:500])
    title = _canonical(raw_title)
    body = _canonical(str(body or '')[:20000])
    raw_keywords = normalize_search(str(keywords or '')[:2000])
    keywords = _canonical(raw_keywords)
    score = 1000 if raw_title == raw_query else 800 if title == canonical_query else 0
    for token in tokens:
        if title == token:
            score += 140
        elif title.startswith(token):
            score += 110
        elif token in title:
            score += 85
        elif token in keywords:
            score += 60
        elif token in body:
            score += 35
        elif _near_word(token, title) or _near_word(token, raw_title):
            score += 28
        elif _near_word(token, keywords) or _near_word(token, raw_keywords):
            score += 20
        elif _subsequence(token, title):
            score += 18
        else:
            return 0
    return score - min(len(raw_title), 200) / 1000
