import hashlib
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from library_organizer import get_library_collections, organize_documents, parse_exam_group


def document(docid, kind='试卷', key='cet6_2024_06_1', **extra):
    return dict(id=docid, title=docid, course='英语六级', year='2024', kind=kind,
                format='mp3' if kind == '听力音频' else 'pdf', status='ready', group_key=key, **extra)


class OrganizerTests(unittest.TestCase):
    def test_complete_and_partial_suites_keep_original_ids(self):
        result = organize_documents([document('paper'), document('answer', '答案解析'), document('audio', '听力音频'), document('next', key='cet6_2024_06_2')])
        self.assertEqual(result['report']['suiteCount'], 2)
        self.assertEqual(result['report']['completeSuites'], 1)
        complete = next(book for book in result['collections'] if book['complete'])
        self.assertEqual([item['id'] for item in complete['files']], ['paper', 'answer', 'audio'])
        self.assertEqual(result['report']['missingRoles'], {'paper': 0, 'answer': 1, 'audio': 1})

    def test_dates_sets_editions_and_subjects_stay_separate(self):
        rows = [document('base'), document('month', key='cet6_2024_12_1'), document('set', key='cet6_2024_06_2'), document('range', key='cet6_2024_06_2-3'), document('version', version='scan'), document('offering', offeringId='another')]
        rows += [dict(document('physics'), course='大学物理'), dict(document('year'), year='2023'), dict(document('four'), course='英语四级', group_key='cet4_2024_06_1')]
        result = organize_documents(rows)
        self.assertEqual(len(result['collections']), len(rows))
        self.assertEqual(len(result['report']['reviewItems']), 2)

    def test_unknown_keys_and_names_never_auto_merge(self):
        rows = [document('one', key=''), document('two', key=''), document('bad', key='cet6_2024_06_1_ans')]
        self.assertEqual(organize_documents(rows)['report']['individualFiles'], 3)
        for key in ('cet6_2020_07_1', 'cet6_2023_03_1', 'cet6_2024_06_2-3'):
            self.assertIsNotNone(parse_exam_group(key))
        for key in ('cet6_2024_13_1', 'cet6_2024_06_3-2', 'cet6_2024_06_unknown'):
            self.assertIsNone(parse_exam_group(key))

    def test_scan_and_combined_files_retain_versions(self):
        result = organize_documents([document('combined', '试卷与答案'), document('scan', extract_status='scan')])
        book = result['collections'][0]
        self.assertEqual(book['fileCount'], 2)
        self.assertEqual(len(book['roles']['paper']), 2)
        self.assertEqual(len(book['roles']['answer']), 1)
        self.assertEqual(book['missingRoles'], ['audio'])
        self.assertEqual(result['report']['scannedFiles'], 1)

    def test_pending_data_and_private_paths_are_absent(self):
        ready = document('paper', file_path='C:/private/original.pdf', body='PRIVATE BODY', secret='SECRET')
        pending = dict(document('pending'), status='pending', title='PRIVATE TITLE')
        result = organize_documents([ready, pending])
        raw = json.dumps(result)
        for content in ('C:/private', 'PRIVATE BODY', 'PRIVATE TITLE', 'SECRET', 'file_path'):
            self.assertNotIn(content, raw)
        self.assertEqual(result['report']['excludedDocuments'], 1)

    def test_manifest_requires_verified_exact_members_and_no_conflicts(self):
        rows = [document('chapter1', '讲义', '', sha256='a'), document('chapter2', '讲义', '', sha256='b')]
        entry = dict(id='book', title='已有教材', verified=True, source='owner-confirmed', members=[dict(id='chapter2', sha256='b', order=2), dict(id='chapter1', sha256='a', order=1)])
        manifest = dict(schemaVersion=1, collections=[entry])
        result = organize_documents(rows, manifest)
        self.assertEqual(len(result['collections']), 1)
        self.assertEqual(result['collections'][0]['files'][0]['id'], 'chapter1')
        manifest['collections'] = [entry, dict(entry, id='other')]
        self.assertEqual(organize_documents(rows, manifest)['report']['individualFiles'], 2)
        manifest['collections'] = [dict(entry, verified=False)]
        self.assertEqual(organize_documents(rows, manifest)['report']['individualFiles'], 2)
        manifest['collections'] = [dict(entry, members=[dict(id='chapter1', sha256='wrong'), dict(id='chapter2')])]
        result = organize_documents(rows, manifest)
        self.assertEqual(len(result['collections']), 2)
        self.assertEqual(result['report']['reviewItems'][0]['reason'], 'byte-hash-mismatch')
        manifest['collections'] = [entry]
        rows[1]['version'] = 'second'; rows[0]['version'] = 'first'
        self.assertEqual(organize_documents(rows, manifest)['report']['individualFiles'], 2)

    def test_revision_is_input_order_independent(self):
        rows = [document('one'), document('two', '答案解析')]
        self.assertEqual(organize_documents(rows)['revision'], organize_documents(list(reversed(rows)))['revision'])

    def test_database_is_readonly_and_cache_changes_with_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            db_path = Path(folder) / 'catalog.sqlite3'
            original = Path(folder) / 'original.pdf'; original.write_bytes(b'%PDF original bytes')
            with closing(sqlite3.connect(db_path)) as db, db:
                db.execute('CREATE TABLE documents(id TEXT, title TEXT, course TEXT, year TEXT, kind TEXT, status TEXT, group_key TEXT, file_path TEXT)')
                db.execute('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?)', ('one', 'one', '英语六级', '2024', '试卷', 'ready', 'cet6_2024_06_1', str(original)))
            before = hashlib.sha256(db_path.read_bytes()).hexdigest()
            pdf_before = original.read_bytes()
            first = get_library_collections(db_path)
            self.assertEqual(first['report']['readyFiles'], 1)
            first['report']['readyFiles'] = 999
            self.assertEqual(get_library_collections(db_path)['report']['readyFiles'], 1)
            self.assertEqual(hashlib.sha256(db_path.read_bytes()).hexdigest(), before)
            self.assertEqual(original.read_bytes(), pdf_before)
            with closing(sqlite3.connect(db_path)) as db, db:
                db.execute('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?)', ('two', 'two', '英语六级', '2024', '答案解析', 'ready', 'cet6_2024_06_1', 'missing.pdf'))
            second = get_library_collections(db_path)
            self.assertEqual(second['report']['readyFiles'], 2)
            self.assertEqual(second['report']['unavailableFiles'], 1)
            self.assertNotEqual(second['revision'], get_library_collections(db_path, course_resolver=lambda row: 'confirmed-course')['revision'])


if __name__ == '__main__':
    unittest.main()
