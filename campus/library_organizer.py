"""Read-only, deterministic library organizer; never rewrites files or the catalog.

python campus/library_organizer.py --report work/library-organizer/report.json
A verified optional manifest may group chapters by exact document ID/byte hash.
No title similarity, network collection, OCR or inferred official course identity.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from urllib.parse import quote

SCHEMA_VERSION = 1
ROLES = ('paper', 'answer', 'audio', 'other')
CET_KEY = re.compile(r'^(cet[46])_(\d{4})_(0[1-9]|1[0-2])_([123](?:-[123])?)$')
ROLE_KINDS = {'试卷': ['paper'], '原卷': ['paper'], '试卷与答案': ['paper', 'answer'],
              '答案解析': ['answer'], '答案': ['answer'], '听力音频': ['audio'], '听力': ['audio']}
PUBLIC_FIELDS = ('id', 'title', 'course', 'year', 'kind', 'scope', 'source_url', 'origin',
                 'status', 'rights', 'sha256', 'pages', 'format', 'created', 'extract_status',
                 'group_key', 'course_id', 'courseId', 'version', 'offering_id', 'offeringId',
                 'role', 'attachmentRole', 'fileAvailable')
_CACHE = {}
_CACHE_LOCK = threading.RLock()


def _text(value):
    return '' if value is None else str(value).strip()


def parse_exam_group(value):
    match = CET_KEY.fullmatch(_text(value))
    if not match:
        return None
    bounds = [int(value) for value in match[4].split('-')]
    if len(bounds) == 2 and bounds[1] <= bounds[0]:
        return None
    return {'key': match[0], 'exam': match[1], 'year': int(match[2]),
            'month': int(match[3]), 'set': match[4]}


def material_roles(item):
    role = _text(item.get('role') or item.get('attachmentRole'))
    if role == 'paper-answer':
        return ['paper', 'answer']
    if role in ROLES:
        return [role]
    return ROLE_KINDS.get(_text(item.get('kind')), ['other'])


def _compatible_exam(item, exam):
    level = '六' if exam['exam'] == 'cet6' else '四'
    names = {f'英语{level}级', f'大学英语{level}级', exam['exam'], exam['exam'].upper(), f"CET-{exam['exam'][-1]}"}
    return (not _text(item.get('course')) or item['course'] in names) and (
        not _text(item.get('year')) or _text(item['year']) == str(exam['year']))


def _safe_item(row):
    item = {key: row[key] for key in PUBLIC_FIELDS if key in row}
    item['courseId'] = item.get('course_id') or item.get('courseId') or ''
    item['offeringId'] = item.get('offering_id') or item.get('offeringId') or ''
    item['url'] = '/api/file/' + quote(_text(item.get('id')), safe='')
    item['source'] = item.get('source_url', '')
    item['note'] = item.get('extract_status', '')
    return item


def _manifest_assignments(items, manifest):
    claims, issues = defaultdict(list), []
    if not manifest:
        return {}, issues
    if not isinstance(manifest, dict) or manifest.get('schemaVersion') != SCHEMA_VERSION or not isinstance(manifest.get('collections'), list):
        return {}, [{'reason': 'unsupported-manifest'}]
    by_id = {str(item['id']): item for item in items}
    seen, duplicates = set(), set()
    for entry in manifest['collections']:
        if not isinstance(entry, dict) or entry.get('verified') is not True or not all(_text(entry.get(key)) for key in ('id', 'title', 'source')) or not isinstance(entry.get('members'), list):
            issues.append({'reason': 'unverified-collection'})
            continue
        eid = _text(entry['id'])
        if eid in seen:
            duplicates.add(eid)
        seen.add(eid)
        matched = []
        for member in entry['members']:
            if not isinstance(member, dict):
                issues.append({'collectionId': eid, 'reason': 'invalid-member'})
                continue
            item = by_id.get(str(member.get('id')))
            if not item:
                issues.append({'collectionId': eid, 'documentId': _text(member.get('id')), 'reason': 'missing-or-unpublished-member'})
            elif member.get('sha256') and member['sha256'] != item.get('sha256'):
                issues.append({'collectionId': eid, 'documentId': item['id'], 'reason': 'byte-hash-mismatch'})
            else:
                matched.append((item, member))
        conflict = any(len({_text(item.get(key)) for item, _ in matched if _text(item.get(key))}) > 1 for key in ('course', 'courseId', 'year', 'version', 'offeringId'))
        conflict = conflict or any(entry.get(key) and any(_text(item.get(key)) and _text(item.get(key)) != _text(entry[key]) for item, _ in matched) for key in ('course', 'courseId'))
        if conflict:
            issues.append({'collectionId': eid, 'reason': 'conflicting-course-or-edition'})
            continue
        for item, member in matched:
            claims[item['id']].append((entry, member))
    assignments = {}
    for docid, claim in claims.items():
        if len(claim) != 1 or _text(claim[0][0]['id']) in duplicates:
            issues.append({'documentId': docid, 'reason': 'ambiguous-collection-membership'})
        else:
            assignments[docid] = claim[0]
    return assignments, issues


def organize_documents(rows, manifest=None):
    """Return a sanitized manifest/report from a stable metadata snapshot."""
    rows = [dict(row) for row in rows]
    eligible = [row for row in rows if row.get('status', 'ready') == 'ready']
    items = sorted((_safe_item(row) for row in eligible), key=lambda item: _text(item.get('id')))
    assignments, issues = _manifest_assignments(items, manifest)
    groups = {}
    for item in items:
        assignment = assignments.get(item['id'])
        exam = parse_exam_group(item.get('group_key'))
        if exam and not _compatible_exam(item, exam):
            issues.append({'documentId': item['id'], 'reason': 'conflicting-exam-metadata'})
            exam = None
        elif item.get('group_key') and not exam:
            issues.append({'documentId': item['id'], 'reason': 'unrecognized-group-key'})
        partition = json.dumps([_text(item.get('courseId') or item.get('course')), _text(item.get('version')), _text(item.get('offeringId'))], ensure_ascii=False, separators=(',', ':'))
        key = 'collection:' + _text(assignment[0]['id']) if assignment else 'suite:' + exam['key'] + ':' + partition if exam else 'file:' + item['url']
        if key not in groups:
            groups[key] = {'exam': exam, 'manifest': assignment[0] if assignment else None, 'files': []}
        if assignment:
            member = assignment[1]
            item = dict(item, role=member.get('role', ''), chapter=member.get('chapter', ''), order=member.get('order', 0))
        groups[key]['files'].append(item)
    collections = []
    for key, group in groups.items():
        entry, exam = group['manifest'], group['exam']
        def part_order(item):
            try:
                order = float(item.get('order') or 0) if entry else ROLES.index(material_roles(item)[0])
            except (ValueError, TypeError):
                order = 0
            return order, _text(item.get('id'))
        files = sorted(group['files'], key=part_order)
        roles = {role: [item for item in files if role in material_roles(item)] for role in ROLES}
        missing = [role for role in ROLES[:3] if not roles[role]] if exam else []
        primary = (roles['paper'] or files)[0]
        title = entry['title'] if entry else f"{'英语六级' if exam['exam'] == 'cet6' else '英语四级'} {exam['year']}年{exam['month']}月 · 第{exam['set']}套{'合集' if '-' in exam['set'] else ''}" if exam else primary['title']
        collections.append(dict(primary, id=key, title=title,
            course=entry.get('course') or primary.get('course', '') if entry else primary.get('course', ''),
            courseId=entry.get('courseId') or primary.get('courseId', '') if entry else primary.get('courseId', ''),
            year=str(exam['year']) if exam else primary.get('year', ''),
            kind='套卷' if exam else '资料合集' if entry else primary.get('kind', '资料'),
            files=files, roles=roles, fileCount=len(files), missingRoles=missing,
            groupKey=exam['key'] if exam else '', isSuite=bool(exam), isCollection=bool(exam or entry),
            complete=not missing if exam else None,
            grouping='verified-manifest' if entry else 'exact-group-key' if exam else 'individual',
            collectionId=entry['id'] if entry else '',
            pages=sum(int(item.get('pages') or 0) for item in files if item.get('format') == 'pdf')))
    collections.sort(key=lambda item: (0 if item.get('scope') == '本校资料' else 1, item.get('course', ''), -int(parse_exam_group(item['groupKey'])['year']) if item['groupKey'] else 0, item['id']))
    suites = [entry for entry in collections if entry['isSuite']]
    singles = [entry for entry in collections if not entry['isCollection']]
    by_exam = {}
    for exam in ('cet4', 'cet6'):
        chosen = [entry for entry in suites if entry['groupKey'].startswith(exam + '_')]
        by_exam[exam] = {'suites': len(chosen), 'files': sum(entry['fileCount'] for entry in chosen), 'complete': sum(entry['complete'] for entry in chosen), 'partial': sum(not entry['complete'] for entry in chosen)}
    report = {'totalDocuments': len(rows), 'readyFiles': len(items), 'excludedDocuments': len(rows)-len(items),
              'collectionCount': len(collections), 'suiteCount': len(suites),
              'completeSuites': sum(entry['complete'] for entry in suites), 'partialSuites': sum(not entry['complete'] for entry in suites),
              'individualFiles': len(singles), 'explicitCollections': sum(entry['grouping'] == 'verified-manifest' for entry in collections),
              'scannedFiles': sum(item.get('extract_status') == 'scan' for item in items),
              'unavailableFiles': sum(item.get('fileAvailable') is False for item in items),
              'roleCounts': {role: sum(role in material_roles(item) for item in items) for role in ROLES},
              'missingRoles': {role: sum(role in entry['missingRoles'] for entry in suites) for role in ROLES[:3]},
              'byExam': by_exam, 'byCourse': dict(sorted(Counter(item.get('course', '') for item in items).items())),
              'reviewItems': issues,
              'unmatched': [{'id': entry['files'][0]['id'], 'title': entry['title'], 'reason': 'no-verified-collection'} for entry in singles],
              'notes': ['缺件仅表示当前目录尚未收录，不代表原考试没有该部分。', '按准确套卷编号或已核对清单组织；扫描版、答案版与原文件均保留。']}
    canonical = json.dumps({'collections': collections, 'report': report}, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return {'schemaVersion': SCHEMA_VERSION, 'revision': hashlib.sha256(canonical.encode()).hexdigest(),
            'collections': collections, 'report': report,
            'bot': {'name': '资料整理助手', 'state': 'needs-review' if issues else 'ready',
                    'mode': 'deterministic-read-only', 'priorities': ['整理现有资料', '通识选修课'],
                    'actions': ['套卷归组', '附件角色与缺件检查', '课程与版本冲突检查'],
                    'originalFilesChanged': False, 'scheduled': False}}


def _fingerprint(path):
    try:
        stat = path.stat()
        return stat.st_mtime_ns, stat.st_size
    except FileNotFoundError:
        return None


def get_library_collections(db_path, manifest_path=None, course_resolver=None):
    """Low-cost cache refreshed on DB/WAL/manifest changes and at least every 30s."""
    db_path = Path(db_path).resolve()
    manifest_path = Path(manifest_path).resolve() if manifest_path else db_path.parent / 'library-collections.json'
    if not db_path.is_file():
        raise FileNotFoundError('Local library catalog is not available.')
    cache_key = str(db_path), str(manifest_path), id(course_resolver)
    stamp = (_fingerprint(db_path), _fingerprint(Path(str(db_path) + '-wal')), _fingerprint(manifest_path))
    with _CACHE_LOCK:
        previous = _CACHE.get(cache_key)
        if previous and previous[0] == stamp and time.monotonic() - previous[1] < 30:
            return json.loads(previous[2])
        with closing(sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True, timeout=10)) as db:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA query_only=ON')
            rows = [dict(row) for row in db.execute('SELECT * FROM documents ORDER BY id')]
        manifest = None
        if manifest_path.is_file():
            try:
                manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
            except (OSError, ValueError):
                manifest = {'schemaVersion': 'unreadable'}
        for row in rows:
            if row.get('status') != 'ready':
                continue
            raw_path = row.get('file_path')
            if raw_path:
                try:
                    row['fileAvailable'] = Path(raw_path).is_file()
                except OSError:
                    row['fileAvailable'] = False
            if course_resolver:
                row['course_id'] = course_resolver(row)
        result = organize_documents(rows, manifest)
        result['generatedAt'] = datetime.now(timezone.utc).isoformat()
        serialized = json.dumps(result, ensure_ascii=False)
        if len(_CACHE) >= 8:
            _CACHE.clear()
        _CACHE[cache_key] = stamp, time.monotonic(), serialized
        return json.loads(serialized)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    default_data = Path(os.environ.get('CAMPUS_DATA_DIR', Path(__file__).resolve().parent / '.data'))
    parser.add_argument('--db', type=Path, default=default_data / 'library.sqlite3')
    parser.add_argument('--manifest', type=Path, help='Verified grouping metadata; never guessed from filenames')
    parser.add_argument('--report', type=Path, help='Write a sanitized JSON report to this explicit path')
    parser.add_argument('--index', type=Path, help='Write a sanitized collection index to this explicit path')
    args = parser.parse_args(argv)
    for destination in (args.report, args.index):
        if destination and destination.resolve() in {args.db.resolve(), (args.manifest or args.db.parent / 'library-collections.json').resolve()}:
            parser.error('Output cannot overwrite the source catalog or manifest.')
    try:
        result = get_library_collections(args.db, args.manifest)
    except (OSError, sqlite3.Error, ValueError) as exc:
        parser.exit(1, f'Organizer could not read the catalog ({type(exc).__name__}).\n')
    for destination, payload in ((args.report, {key: result[key] for key in ('schemaVersion', 'revision', 'generatedAt', 'report', 'bot')}), (args.index, result)):
        if destination:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    summary = {key: value for key, value in result['report'].items() if key not in ('unmatched', 'reviewItems', 'notes')}
    print(json.dumps(summary, ensure_ascii=True, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
