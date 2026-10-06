import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server

class BackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        server.DB=Path(cls.temp.name)/'test.sqlite3'
        server.init_db()
        cls.pdf=Path(cls.temp.name)/'paper.pdf'
        cls.pdf.write_bytes(b'%PDF-1.4\n' + b'original-test-content' * 50)
        server.put_document({'id':'paper-1','title':'高等数学 A1 2024 期末试卷','course':'高等数学 A1','year':'2024','kind':'试卷','scope':'本校资料','origin':'测试夹具','status':'ready','sha256':'test-sha-1','file_path':str(cls.pdf),'format':'pdf','pages':2,'body':'原卷文本'},[(1,'极限和微积分 exercises'),(2,'The ecosystems demonstrate conservation and integration.')])
        server.put_document({'id':'pending-1','title':'未核对外部材料','course':'未分类','origin':'网络采集','status':'pending','sha256':'test-sha-2','body':'待核对'},[(1,'微积分新题目')])
        cls.httpd=server.Server(('127.0.0.1',0),server.Handler)
        cls.worker=threading.Thread(target=cls.httpd.serve_forever,daemon=True);cls.worker.start()
        cls.base=f'http://127.0.0.1:{cls.httpd.server_port}'
    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown();cls.httpd.server_close();cls.worker.join();cls.temp.cleanup()
    def request(self,path,data=None,headers=None):
        h={'Content-Type':'application/json','X-Campus-Request':'1'}
        h.update(headers or {})
        req=Request(self.base+path,data=json.dumps(data).encode() if data is not None else None,headers=h)
        try:
            with urlopen(req,timeout=5) as r:return r.status,r.read(),dict(r.headers)
        except HTTPError as e:return e.code,e.read(),dict(e.headers)
    def test_fulltext_returns_original_page_and_scope_filter(self):
        code,raw,_=self.request('/api/catalogue?q=ecosystems')
        data=json.loads(raw)
        self.assertEqual(code,200);self.assertEqual(data['total'],1)
        self.assertEqual(data['items'][0]['match_page'],2)
        self.assertIn('ecosystems',data['items'][0]['snippet'])
        self.assertNotIn('file_path',data['items'][0])
    def test_pending_does_not_leak_into_ready_library(self):
        _,raw,_=self.request('/api/catalogue')
        self.assertEqual(json.loads(raw)['total'],1)
    def test_pdf_range_contains_exact_original_bytes(self):
        code,raw,h=self.request('/api/file/paper-1',headers={'Range':'bytes=0-8'})
        self.assertEqual(code,206);self.assertEqual(raw,b'%PDF-1.4\n')
        self.assertEqual(h['Content-Range'],f'bytes 0-8/{self.pdf.stat().st_size}')
    def test_rejects_untrusted_browser_origin_and_missing_marker(self):
        self.assertEqual(self.request('/api/courses',{'name':'X'},{'Origin':'https://attacker.example'})[0],400)
        self.assertEqual(self.request('/api/courses',{'name':'X'},{'X-Campus-Request':''})[0],400)
        self.assertEqual(self.request('/api/health',headers={'Host':'attacker.example'})[0],400)
    def test_rejects_internal_crawl_targets(self):
        for url in ['http://127.0.0.1/','http://192.168.1.1/','file:///C:/Windows/win.ini','http://user:pass@example.com/']:
            with self.subTest(url=url):self.assertEqual(self.request('/api/crawl',{'url':url})[0],400)
    def test_card_review_backup_restore_is_idempotent(self):
        _,raw,_=self.request('/api/cards',{'docid':'paper-1','page':2,'question':'What is conservation?','answer':'Review the original source.'})
        card=json.loads(raw)['id']
        code,raw,_=self.request('/api/review',{'id':card,'correct':False})
        self.assertEqual(code,200);self.assertGreater(json.loads(raw)['due'],server.now())
        _,backup,_=self.request('/api/backup')
        code,restored,_=self.request('/api/restore',json.loads(backup))
        self.assertEqual(code,200);self.assertEqual(json.loads(restored)['restored'],0)
    def test_invalid_card_page_is_rejected(self):
        self.assertEqual(self.request('/api/cards',{'docid':'paper-1','page':999,'question':'x'})[0],400)
    def test_unsafe_fts_input_does_not_break_query(self):
        for q in ['%22','%2A','%25','OR','%22OR%22']:
            self.assertEqual(self.request('/api/catalogue?q='+q)[0],200)

if __name__=='__main__':unittest.main()
