import base64
import json
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock
from django.contrib.auth.tokens import default_token_generator
from django.core import mail, signing
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings
from django.utils import timezone
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from . import discovery, files, github_guides
from .core import Problem
from .models import (Asset, Contribution, Entry, ExternalCache, Job, Member, Notification,
                     Reply, Source, Star, Task, Upload, Watch, Workspace)


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class HubTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = Member.objects.create_user('alice','alice@example.com','Rainy-copper-river-839',email_verified=True)
        cls.bob = Member.objects.create_user('bob','bob@example.com','Rainy-copper-river-839',email_verified=True)
        cls.mod = Member.objects.create_user('moderator','mod@example.com','Rainy-copper-river-839',email_verified=True,is_staff=True)

    def setUp(self):
        self.a,self.b,self.m,self.anon = [Client() for _ in range(4)]
        for client,user in [(self.a,self.alice),(self.b,self.bob),(self.m,self.mod)]:
            client.force_login(user)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.override = override_settings(MEDIA_ROOT=Path(self.temp.name))
        self.override.enable()
        self.addCleanup(self.override.disable)

    def post(self, client, path, body=None, code=200):
        response = client.post('/api/hub/'+path,data=json.dumps(body or {}),content_type='application/json')
        self.assertEqual(response.status_code,code,response.content[:1000])
        return response.json()

    def get(self, client, path, code=200):
        response = client.get('/api/hub/'+path)
        self.assertEqual(response.status_code,code,response.content[:1000])
        return response.json()

    def payload(self, title='机器人视觉入门'):
        return {'title':title,'summary':'测试中用于验证社区流程的项目。','license':'MIT','rightsConfirmed':True,
                'links':{'repo':'https://github.com/example/robot'},'tags':['机器人'],'body':'图像处理和控制。'}

    def test_private_preferences_and_explained_recommendations(self):
        self.publish(self.draft())
        settings = {'faculty':'机械与电气工程学院','campus':'沙河','year':'2026',
                    'interests':['机器人'],'goals':['竞赛'],'courses':[]}
        self.post(self.b,'auth/profile',{'preferences':settings,'campus_verified':True})
        own = self.get(self.b,'auth/session')['user']
        self.assertEqual(own['preferences'],settings)
        self.assertFalse(own['campusVerified'])
        self.assertNotIn('preferences',self.get(self.anon,'members/bob')['profile'])
        found = self.get(self.b,'recommendations')
        self.assertEqual(len(found['items']),1)
        self.assertIn('机器人',found['items'][0]['reasons'][0])
        self.post(self.b,'auth/profile',{'preferences':{}})
        self.assertEqual(self.get(self.b,'recommendations')['items'],[])
        self.get(self.anon,'recommendations',401)

    def test_shared_categories_and_html_source_parser(self):
        self.assertIn('mech',self.get(self.anon,'categories')['categories'])
        invalid = self.payload()
        invalid['category']='does-not-exist'
        self.post(self.a,'entries',{'kind':'project','data':invalid},400)
        parsed = discovery.parse_source('<a href="/news/42">大学生机器人竞赛通知</a>'.encode(),'html','https://school.example/index')
        self.assertEqual(parsed[0]['url'],'https://school.example/news/42')

    def draft(self, client=None, data=None, kind='project'):
        return self.post(client or self.a,'entries',{'kind':kind,'data':data or self.payload()})

    def publish(self, draft, client=None):
        owner = client or self.a
        pending = self.post(owner,f'entries/{draft["id"]}/submit',{'revision':draft['editRevision']})
        return self.post(self.m,f'entries/{draft["id"]}/review',{'revision':pending['editRevision'],'decision':'approve','note':'已核对来源与说明。'})

    def test_registration_csrf_email_verification_and_login(self):
        c = Client(enforce_csrf_checks=True)
        self.post(c,'auth/register',{'email':'new@example.com','username':'newmember','password':'Rainy-copper-river-739'},403)
        csrf = self.get(c,'auth/session')['csrfToken']
        r = c.post('/api/hub/auth/register',json.dumps({'email':'new@example.com','username':'newmember','password':'Rainy-copper-river-739'}),content_type='application/json',HTTP_X_CSRFTOKEN=csrf)
        self.assertEqual(r.status_code,200,r.content)
        user = Member.objects.get(email='new@example.com')
        self.assertFalse(user.is_staff)
        self.assertFalse(user.email_verified)
        self.assertNotIn('Rainy',user.password)
        self.assertEqual(len(mail.outbox),1)
        token = signing.dumps({'id':user.pk,'email':user.email},salt='hub.verify')
        self.post(self.anon,'auth/verify',{'token':token})
        user.refresh_from_db()
        self.assertTrue(user.email_verified)
        login = self.post(self.anon,'auth/login',{'email':'NEW@example.com','password':'Rainy-copper-river-739'})
        self.assertEqual(login['user']['username'],'newmember')
        self.post(self.anon,'auth/logout')
        self.assertIsNone(self.get(self.anon,'auth/session')['user'])

    def test_password_reset_token_is_single_use_and_revokes_session(self):
        token = default_token_generator.make_token(self.alice)
        body = {'uid':urlsafe_base64_encode(force_bytes(self.alice.pk)),'token':token,'password':'Another-copper-river-641'}
        self.post(self.anon,'auth/reset-confirm',body)
        self.post(self.anon,'auth/reset-confirm',body,400)
        self.assertIsNone(self.get(self.a,'auth/session')['user'])

    def test_cross_origin_post_and_session_private_fields(self):
        c = Client(enforce_csrf_checks=True)
        token = self.get(c,'auth/session')['csrfToken']
        r = c.post('/api/hub/auth/login','{}',content_type='application/json',HTTP_X_CSRFTOKEN=token,HTTP_ORIGIN='https://attacker.example')
        self.assertEqual(r.status_code,403)
        public = self.get(self.anon,'members/alice')['profile']
        self.assertNotIn('email',public)
        self.post(self.b,'auth/profile',{'campus_verified':True,'is_staff':True})
        self.bob.refresh_from_db()
        self.assertFalse(self.bob.campus_verified or self.bob.is_staff)

    def test_draft_is_private_and_cannot_be_overwritten(self):
        d = self.draft()
        self.get(self.b,'entries/'+d['id'],404)
        self.get(self.anon,'entries/'+d['id'],404)
        self.post(self.b,'entries/'+d['id']+'/save',{'revision':1,'data':self.payload()},403)
        self.assertEqual(self.get(self.anon,'catalogue')['total'],0)
        self.post(self.a,'entries/'+d['id']+'/save',{'revision':999,'data':self.payload()},409)

    def test_two_members_review_star_discuss_and_notifications(self):
        entry = self.publish(self.draft())
        eid = entry['id']
        self.post(self.b,f'entries/{eid}/star',{'enabled':True})
        result = self.post(self.b,f'entries/{eid}/star',{'enabled':True})
        self.assertEqual(result['siteStars'],1)
        self.post(self.b,f'entries/{eid}/watch',{'events':['release','discussion']})
        self.post(self.a,f'entries/{eid}/release',{'version':'v1','url':'https://github.com/example/robot/releases/v1','note':'初版'})
        self.post(self.a,f'entries/{eid}/release',{'version':'v1','url':'https://github.com/example/robot/releases/v1','note':'初版'})
        self.assertEqual(Notification.objects.filter(user=self.bob,event='release').count(),1)
        reply = self.post(self.b,f'entries/{eid}/replies',{'body':'如何配置相机？'})
        self.assertEqual(reply['state'],'pending')
        self.assertEqual(self.get(self.anon,f'entries/{eid}')['replies'],[])
        self.post(self.m,f'replies/{reply["id"]}/review',{'approve':True})
        self.post(self.a,f'replies/{reply["id"]}/accept')
        self.post(self.a,f'replies/{reply["id"]}/accept')
        self.assertEqual(Contribution.objects.filter(user=self.bob,active=True).count(),1)
        self.assertEqual(self.get(self.b,'notifications')['unread'],2)

    def test_unwatch_stops_notifications_and_digest(self):
        eid = self.publish(self.draft())['id']
        self.post(self.b,f'entries/{eid}/watch',{'events':['release']})
        self.post(self.a,f'entries/{eid}/release',{'version':'v1','url':'https://example.com/v1','note':'v1'})
        self.post(self.b,f'entries/{eid}/watch',{'events':[]})
        self.post(self.a,f'entries/{eid}/release',{'version':'v2','url':'https://example.com/v2','note':'v2'})
        self.assertEqual(Notification.objects.filter(user=self.bob,event='release').count(),1)
        self.bob.digest_enabled=True
        self.bob.save()
        from .worker import digest
        self.assertEqual(digest(self.bob.pk)['reason'],'empty')

    def test_edits_do_not_replace_public_version_until_approved(self):
        entry = self.publish(self.draft())
        new = self.payload('尚未核对的新标题')
        draft = self.post(self.a,f'entries/{entry["id"]}/save',{'revision':1,'data':new})
        self.assertEqual(self.get(self.anon,f'entries/{entry["id"]}')['data']['title'],'机器人视觉入门')
        self.publish(draft)
        self.assertEqual(self.get(self.anon,f'entries/{entry["id"]}')['data']['title'],'尚未核对的新标题')
        self.assertEqual(Contribution.objects.count(),1)
        self.post(self.a,f'entries/{entry["id"]}/withdraw',{'reason':'资料需要修正'})
        self.assertEqual(self.get(self.anon,'contributions')['total'],0)
        self.get(self.anon,f'entries/{entry["id"]}',404)

    def test_upload_duplicates_preserve_attribution_without_leaking_private_data(self):
        def upload(c):
            r = c.post('/api/hub/uploads',{'file':SimpleUploadedFile('笔记.md','机器人 PID 笔记'.encode())})
            self.assertEqual(r.status_code,200,r.content)
            return r.json()
        first,second = upload(self.a),upload(self.b)
        self.assertNotEqual(first['id'],second['id'])
        self.assertFalse(second['duplicate'])
        self.assertEqual(Asset.objects.count(),1)
        self.get(self.b,'uploads/'+first['id'],404)
        files.extract(first['sha256'])
        data = {'title':'控制笔记','summary':'原始课堂笔记','license':'CC BY 4.0','rightsConfirmed':True,'uploads':[first['id']]}
        entry = self.publish(self.draft(data=data,kind='resource'))
        self.assertIn('PID',self.get(self.anon,'uploads/'+first['id'])['preview'])
        d2 = dict(data,uploads=[second['id']])
        duplicate = self.publish(self.draft(client=self.b,data=d2,kind='resource'),self.b)
        self.assertEqual(duplicate['canonical'],entry['id'])
        self.assertEqual(Contribution.objects.count(),1)
        self.assertEqual(self.get(self.anon,'catalogue?q=PID')['total'],2)

    def test_attachment_owner_validation_and_download_denial(self):
        r = self.a.post('/api/hub/uploads',{'file':SimpleUploadedFile('x.md',b'private note')}).json()
        self.post(self.b,'entries',{'kind':'resource','data':{'title':'窃取附件','uploads':[r['id']]}},403)
        self.assertEqual(self.b.get('/api/hub/uploads/'+r['id']+'/file').status_code,404)
        response = self.a.get('/api/hub/uploads/'+r['id']+'/file')
        self.assertEqual(response.status_code,200)
        self.assertEqual(b''.join(response.streaming_content),b'private note')
        response.close()

    def test_task_claim_requires_project_and_evidence(self):
        eid = self.publish(self.draft())['id']
        task = self.post(self.a,f'entries/{eid}/tasks',{'title':'验证安装','description':'记录硬件和结果。'})
        self.post(self.b,f'tasks/{task["id"]}/claim')
        self.post(self.b,f'tasks/{task["id"]}/submit',{'evidence':'https://github.com/example/robot/issues/1'})
        self.post(self.a,f'tasks/{task["id"]}/review',{'approve':True,'note':'步骤及结果已核对'})
        self.post(self.a,f'tasks/{task["id"]}/review',{'approve':True,'note':'再次核对'})
        self.assertEqual(Contribution.objects.filter(user=self.bob).count(),1)
        self.post(self.a,f'entries/{eid}/withdraw',{'reason':'项目撤回'})
        self.post(self.a,f'tasks/{task["id"]}/review',{'approve':True,'note':'不应恢复贡献'},400)

    def test_private_research_notes_bibliography_and_portable_backup(self):
        data = {'kind':'reading','title':'定位文献','data':{'references':[{'title':'Example paper','authors':'A and B','year':'2025','url':'https://doi.org/10.1234/test','note':'方法对比'}]}}
        w = self.post(self.a,'workspaces',data)
        self.get(self.b,'workspaces/'+w['id'],404)
        self.assertIn(b'@misc',self.a.get('/api/hub/workspaces/'+w['id']+'/bibliography').content)
        backup = self.get(self.a,'backup')
        self.post(self.b,'restore',backup,400)
        restored = self.post(self.b,'restore',dict(backup,confirmed=True))
        self.assertEqual(restored['restored'],1)
        self.assertEqual(self.post(self.b,'restore',dict(backup,confirmed=True))['restored'],0)
        self.assertEqual(Workspace.objects.filter(owner=self.alice).count(),1)

    def test_plans_have_distinct_tracks_real_resources_and_budget(self):
        self.publish(self.draft())
        plan = self.post(self.a,'planning',{'goal':'employment','topic':'机器人','weeklyHours':6,'weeks':8})
        steps = plan['data']['steps']
        self.assertEqual(sum(s['hours'] for s in steps),48)
        self.assertEqual(steps[2]['availability'],'matched')
        research = self.post(self.a,'planning',{'goal':'research','topic':'机器人','weeklyHours':6,'weeks':8})
        self.assertNotEqual(steps[1]['title'],research['data']['steps'][1]['title'])

    def test_external_failure_retains_last_success(self):
        with patch('hub.discovery.fetch_public',return_value=(json.dumps({'items':[{'full_name':'e/r','html_url':'https://github.com/e/r'}]}).encode(),{},'',200)):
            first = discovery.external_search('robot','github')
        cache = ExternalCache.objects.get(key__startswith='search:')
        cache.checked = None
        cache.save()
        with patch('hub.discovery.fetch_public',side_effect=TimeoutError):
            second = discovery.external_search('robot','github')
        self.assertTrue(second['stale'])
        self.assertEqual(first['items'],second['items'])
        self.assertEqual(first['lastSuccess'],second['lastSuccess'])

    def test_crawler_rejects_internal_destinations_and_xml_entities(self):
        with patch('hub.discovery.socket.getaddrinfo',return_value=[(2,1,6,'',('127.0.0.1',443))]):
            with self.assertRaises(Problem):
                discovery.fetch_public('https://evil.example/')
        with self.assertRaises(Problem):
            discovery.parse_source(b'<!DOCTYPE x [<!ENTITY a "b">]><rss/>','rss','https://example.com')
        parsed = discovery.parse_source(b'<rss><channel><item><title>Contest</title><link>https://example.com/c</link></item></channel></rss>','rss','https://example.com')
        self.assertEqual(parsed[0]['title'],'Contest')

    def github_fixture(self, refresh=False):
        def api(repo,suffix=''):
            if suffix=='/readme':
                return {'content':base64.b64encode(b'# Robot\nA robot tool\n## Install\nRead docs.').decode(),'sha':'abc','html_url':'https://github.com/e/robot/blob/main/README.md'}
            if suffix=='/releases/latest':
                return {'tag_name':'v1','html_url':'https://github.com/e/robot/releases/tag/v1','assets':[{'name':'robot.zip','size':10,'browser_download_url':'https://github.com/e/robot/releases/download/v1/robot.zip'}]}
            if suffix=='/contents':
                return [{'name':'tests'}]
            return {'full_name':'e/robot','html_url':'https://github.com/e/robot','owner':{'login':'e'},'description':'Robot tool','license':{'spdx_id':'MIT'},'default_branch':'main','stargazers_count':3}
        with patch('hub.github_guides.api',side_effect=api):
            return github_guides.inspect('e/robot',refresh=refresh)

    def test_github_downloads_are_official_and_no_fake_ai(self):
        data = self.github_fixture()
        self.assertEqual(data['downloads'][0]['kind'],'official-release')
        self.assertEqual(data['downloads'][1]['kind'],'source-archive')
        self.assertEqual(data['guide']['state'],'awaiting-model')
        self.assertTrue(data['evidence'][1]['url'].endswith('#L1-L4'))
        self.post(self.b,'github/curate',{'repository':'e/robot'},403)

    @patch.dict('os.environ',{'HUB_AI_MODEL':'test-only-model','HUB_AI_PROVIDER':'ollama'})
    def test_ai_rejects_nonexistent_citations_and_stays_unreviewed(self):
        self.github_fixture()
        value = {'oneLiner':'一个机器人工具','sections':[{'heading':'用途','text':'机器人项目','evidenceIds':['invented']}] * 3}
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({'message':{'content':json.dumps(value)}}).encode()
        with patch('hub.github_guides.urlopen',return_value=response),self.assertRaises(Problem):
            github_guides.generate_guide('e/robot')
        value['sections'] = [{'heading':'用途','text':'机器人项目','evidenceIds':['readme-1']}] * 3
        response.__enter__.return_value.read.return_value = json.dumps({'message':{'content':json.dumps(value)}}).encode()
        with patch('hub.github_guides.urlopen',return_value=response):
            guide = github_guides.generate_guide('e/robot')
        self.assertEqual(guide['reviewState'],'pending')

    def test_curated_feed_explicit_feedback_and_workflow(self):
        self.github_fixture()
        cache = ExternalCache.objects.get(key=github_guides.cache_key('e/robot'))
        cache.data['guide']={'state':'generated','reviewState':'pending','oneLiner':'机器人入门工具',
            'sections':[{'heading':'先看说明','text':'阅读原项目说明','evidenceIds':['readme-1']}],'unknowns':[]}
        cache.save()
        selected = self.post(self.m,'github/curate',{'repository':'e/robot','shelf':'creative','reason':'提供清晰的机器人实验入口',
             'checks':{'sourceRead':True,'licenseChecked':True,'downloadsChecked':True},'approveGuide':True})
        refreshed = self.github_fixture(refresh=True)
        self.assertEqual(refreshed['entryId'],selected['entryId'])
        self.assertEqual(refreshed['guide']['reviewState'],'reviewed')
        feed = self.get(self.b,'feed')
        self.assertEqual(feed['total'],1)
        self.assertEqual(feed['items'][0]['media']['type'],'project-card')
        self.assertFalse(feed['items'][0]['tested'])
        self.assertEqual(feed['items'][0]['idea'],'机器人入门工具')
        self.post(self.b,'entries/'+selected['entryId']+'/star',{'enabled':True})
        workflow = self.post(self.b,'feed/workflow',{'goal':'搭建机器人视觉工作流','repositories':['e/robot']})
        self.assertTrue(workflow['data']['steps'])
        self.get(self.a,'workspaces/'+workflow['id'],404)
        self.post(self.b,'feed/feedback',{'repository':'e/robot','action':'not-interested'})
        self.assertEqual(self.get(self.b,'feed')['total'],0)

    def test_moderation_and_jobs_require_ownership(self):
        self.get(self.b,'moderation',403)
        job = Job.objects.create(kind='github-inspect',key='private',owner=self.alice,payload={},due=timezone.now())
        self.get(self.b,'jobs/'+str(job.pk),404)
        self.assertEqual(self.get(self.a,'jobs/'+str(job.pk))['state'],'queued')
        self.post(self.b,'sources',{'name':'not admin'},403)
