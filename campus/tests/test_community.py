import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen
import server
import community


class CommunityTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.old=server.DB
        server.DB=Path(self.tmp.name)/'test.sqlite3'
        server.init_db()

    def tearDown(self):
        server.DB=self.old
        self.tmp.cleanup()

    def submission(self,**changes):
        data={'kind':'project','title':'电机课程实验','summary':'可以复现的控制实验与文档','category':'机电与机器人',
              'author':'本机测试者','url':'https://github.com/example/motor','tags':['STM32'],
              'license':'MIT','body':'如何复现与边界情况','setup':'开发板与驱动','needs':'文档测试', 'rightsConfirmed':True}
        return dict(data,**changes)

    def test_approval_counts_once_and_keeps_submission_time_separate(self):
        item=community.add_entry(server.connection,self.submission())
        self.assertEqual(community.activity(server.connection)['total'],0)
        community.review(server.connection,{'id':item['id'],'status':'approved','checked':True})
        activity=community.activity(server.connection)
        self.assertEqual(activity['total'],1)
        self.assertEqual(activity['activeDays'],1)
        self.assertEqual(len(activity['days']),182)
        with self.assertRaises(ValueError):
            community.review(server.connection,{'id':item['id'],'status':'approved','checked':True})
        self.assertEqual(community.activity(server.connection)['total'],1)

    def test_rejection_requires_reason_and_never_counts(self):
        item=community.add_entry(server.connection,self.submission())
        with self.assertRaises(ValueError): community.review(server.connection,{'id':item['id'],'status':'rejected'})
        community.review(server.connection,{'id':item['id'],'status':'rejected','reason':'来源未确认'})
        state=community.handle('GET','/api/community',{},None,server.connection)
        self.assertEqual(state['entries'][0]['status'],'rejected')
        self.assertEqual(state['activity']['total'],0)

    def test_two_people_can_share_different_solutions_to_one_problem(self):
        data=self.submission(kind='solution',url='https://leetcode.cn/problems/two-sum/description/?x=1')
        community.add_entry(server.connection,data)
        community.add_entry(server.connection,dict(data,author='另一位同学'))
        with self.assertRaises(ValueError): community.add_entry(server.connection,data)
        state=community.handle('GET','/api/community',{},None,server.connection)
        self.assertEqual(len(state['entries']),2)
        self.assertEqual(state['entries'][0]['url'],'https://leetcode.cn/problems/two-sum')

    def test_duplicate_projects_and_unconfirmed_rights_are_rejected(self):
        community.add_entry(server.connection,self.submission())
        with self.assertRaises(ValueError): community.add_entry(server.connection,self.submission(author='另一个昵称'))
        with self.assertRaises(ValueError): community.add_entry(server.connection,self.submission(rightsConfirmed=False,url='https://github.com/example/other'))

    def test_reject_unsafe_and_impersonating_urls(self):
        for url,kind in [('http://github.com/a/b','project'),('https://github.com.evil.test/a/b','project'),
                         ('https://127.0.0.1/a/b','project'),('https://user:secret@github.com/a/b','project'),
                         ('https://github.com/a/b/issues','project'),('https://leetcode.cn.evil.test/problems/a','solution'),
                         ('javascript:alert(1)','solution')]:
            with self.subTest(url=url),self.assertRaises(ValueError): community.source_url(url,kind)

    def test_discussion_reply_must_belong_to_topic_and_counts_once(self):
        body={'title':'如何调试','category':'提问','author':'提问者','body':'已经检查供电和接线，仍然无法启动。'}
        t1=community.add_topic(server.connection,body)['id']
        t2=community.add_topic(server.connection,body)['id']
        reply=community.add_reply(server.connection,{'topic':t1,'author':'回答者','body':'先检查使能引脚。'})['id']
        with self.assertRaises(ValueError): community.topic_action(server.connection,{'id':t2,'action':'solve','reply':reply})
        community.topic_action(server.connection,{'id':t1,'action':'solve','reply':reply})
        self.assertEqual(community.activity(server.connection)['contributors'],[{'name':'回答者','count':1}])
        with self.assertRaises(ValueError): community.topic_action(server.connection,{'id':t1,'action':'solve','reply':reply})
        community.topic_action(server.connection,{'id':t2,'action':'close'})
        with self.assertRaises(ValueError): community.add_reply(server.connection,{'topic':t2,'author':'人','body':'回复'})

    def test_repository_lookup_uses_fixed_api_and_cache(self):
        class Response:
            url='https://api.github.com/repos/example/motor'
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def read(self,n): return json.dumps({'full_name':'example/motor','html_url':'https://github.com/example/motor',
                                               'license':{'spdx_id':'MIT'},'private':False,'stargazers_count':7}).encode()
        with patch('community.urlopen',return_value=Response()) as fetch:
            first=community.github_repo(server.connection,'https://github.com/example/motor')
            second=community.github_repo(server.connection,'https://github.com/example/motor')
        self.assertFalse(first['cached']);self.assertTrue(second['cached'])
        self.assertEqual(fetch.call_count,1)
        self.assertEqual(fetch.call_args.args[0].full_url,'https://api.github.com/repos/example/motor')

    def test_http_integration_preserves_json_contract(self):
        httpd=server.Server(('127.0.0.1',0),server.Handler)
        worker=threading.Thread(target=httpd.serve_forever,daemon=True);worker.start()
        base=f'http://127.0.0.1:{httpd.server_port}'
        try:
            req=Request(base+'/api/community/submit',data=json.dumps(self.submission()).encode(),headers={'Content-Type':'application/json','X-Campus-Request':'1'})
            with urlopen(req) as r:self.assertEqual(json.load(r)['status'],'pending')
            with urlopen(base+'/api/community') as r:self.assertEqual(len(json.load(r)['entries']),1)
        finally:
            httpd.shutdown();worker.join();httpd.server_close()

if __name__=='__main__': unittest.main()
