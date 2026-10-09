"""Match existing local files to the school catalogue by bytes, never by name."""
import hashlib
import json
from functools import lru_cache
from pathlib import Path

PUBLIC = Path(__file__).resolve().parents[1] / 'public'


@lru_cache(maxsize=1)
def catalogue_links():
    result = {}
    try:
        data = json.loads((PUBLIC / 'data' / 'school.json').read_text(encoding='utf-8'))
        courses = {course['id'] for course in data['courses']}
        for item in data['papers']:
            if item.get('course') not in courses or not item.get('file'):
                continue
            path = (PUBLIC / item['file']).resolve()
            if not path.is_relative_to(PUBLIC.resolve()) or not path.is_file():
                continue
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            result.setdefault(digest, set()).add(item['course'])
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    # Identical bytes assigned to different courses remain ambiguous.
    return {digest: next(iter(ids)) for digest, ids in result.items() if len(ids) == 1}


def course_for_document(row):
    if row['origin'] != '本地导入':
        return ''
    return catalogue_links().get(row['sha256'], '')
