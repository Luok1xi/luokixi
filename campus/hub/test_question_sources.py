import hashlib,os,sqlite3,tempfile
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from django.test import SimpleTestCase,override_settings
from .core import Problem
from question_sources import resolve_document_source

class LocalQuestionSourceTests(SimpleTestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup)
        self.root=Path(self.folder.name);self.file=self.root/'source.pdf';self.file.write_bytes(b'%PDF-1.4 test original')
        self.db=self.root/'library.sqlite3'
        with closing(sqlite3.connect(self.db)) as conn:
            conn.execute('CREATE TABLE documents(id TEXT,status TEXT,format TEXT,file_path TEXT,sha256 TEXT,title TEXT,course TEXT,source_url TEXT,rights TEXT,scope TEXT,pages INTEGER)')
            conn.execute('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?)',('known','ready','pdf',str(self.file),hashlib.sha256(self.file.read_bytes()).hexdigest(),'Original','Math','','Private','本校',1))
            conn.commit()
        self.env=patch.dict(os.environ,{'QUESTION_LIBRARY_DB':str(self.db)});self.env.start();self.addCleanup(self.env.stop)
    @override_settings(PUBLIC_ORIGIN='http://127.0.0.1:17860')
    def test_only_known_ready_original_can_resolve(self):
        source=resolve_document_source('known');self.assertEqual(source['documentId'],'known')
        with self.assertRaises(Problem):resolve_document_source('../source.pdf')
        with closing(sqlite3.connect(self.db)) as c:
            c.execute("UPDATE documents SET status='pending'")
            c.commit()
        with self.assertRaises(Problem):resolve_document_source('known')
    @override_settings(PUBLIC_ORIGIN='http://127.0.0.1:17860')
    def test_modified_bytes_fail_even_at_known_path(self):
        self.file.write_bytes(b'%PDF-1.4 changed')
        with self.assertRaises(Problem) as problem:resolve_document_source('known')
        self.assertEqual(problem.exception.status,409)
    @override_settings(PUBLIC_ORIGIN='https://example.test')
    def test_public_installation_cannot_read_local_library(self):
        with self.assertRaises(Problem) as problem:resolve_document_source('known')
        self.assertEqual(problem.exception.status,403)
