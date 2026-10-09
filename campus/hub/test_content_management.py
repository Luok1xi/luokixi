import json
import uuid
from unittest.mock import patch
from django.test import TestCase, Client
from django.contrib.auth.models import AnonymousUser
from .models import Member, Entry, EditorialOverride, EditorialRevision, ExternalCache, ContentTask, Audit, CampusBoard
from . import content_management as cm
from .core import save_entry, submit_entry, can_participate, Problem
from .robot_actions import actor, execute


class ContentManagementTests(TestCase):
    def setUp(self):
        self.owner=Member.objects.create_superuser('owner','owner@example.com','test-password-long',email_verified=False)
        self.user=Member.objects.create_user('student','student@example.com','test-password-long',email_verified=True)
        self.client=Client();self.client.force_login(self.owner)
        self.payload={'title':'待审校圈测试','summary':'实际审核测试','body':'只用于测试。','license':'MIT','rightsConfirmed':True}
        self.entry=save_entry(self.user,{'kind':'topic','data':self.payload})

    def test_owner_edits_publish_and_restore_with_real_audit(self):
        result=cm.publish(self.owner,{'key':'entry/'+str(self.entry.pk),'revision':1,'patch':{'body':'已修改正文'},'reason':'修正'})
        self.assertTrue(result['completed']);self.entry.refresh_from_db()
        self.assertEqual(self.entry.published['body'],'已修改正文');self.assertEqual(self.entry.public_revision,2)
        cm.publish(self.owner,{'key':result['key'],'revision':2,'restoreRevision':1,'reason':'回退'})
        self.entry.refresh_from_db();self.assertEqual(self.entry.published['body'],self.payload['body'])
        audit=Audit.objects.filter(action='content.publish').first();self.assertIn('before',audit.detail)
        self.assertTrue(can_participate(self.owner))

    def test_untrusted_users_cannot_publish(self):
        for user in (self.user,AnonymousUser()):
            with self.assertRaises(Problem): cm.publish(user,{'key':'entry/'+str(self.entry.pk),'revision':1,'patch':{},'reason':'测试'})
        self.assertFalse(cm.manager(Member.objects.create_user('fake','fake@system.invalid','test-password-long',is_staff=True)))

    def test_both_system_actors_can_edit_without_mail_gate(self):
        for seat in ('beikuang','codex'):
            who=actor(seat);who.email_verified=False;who.save()
            self.assertTrue(can_participate(who));self.assertTrue(cm.manager(who))
            self.entry.refresh_from_db()
            cm.publish(who,{'key':'entry/'+str(self.entry.pk),'revision':self.entry.revision,'patch':{'body':seat},'reason':'角色编辑'})

    def test_version_conflict_does_not_change_public_copy(self):
        cm.publish(self.owner,{'key':'entry/'+str(self.entry.pk),'revision':1,'patch':{'body':'新版'},'reason':'修正'})
        with self.assertRaises(Problem) as exc: cm.publish(self.owner,{'key':'entry/'+str(self.entry.pk),'revision':1,'patch':{'body':'旧版'},'reason':'修正'})
        self.assertEqual(exc.exception.status,409);self.entry.refresh_from_db();self.assertEqual(self.entry.published['body'],'新版')

    def test_harvest_refresh_keeps_editorial_changes_and_fresh_stats(self):
        ExternalCache.objects.create(key='github:example/test',data={'repository':'example/test','description':'原文','stars':10})
        result=cm.publish(self.owner,{'key':'github/example/test','revision':0,'patch':{'description':'本站中文介绍'},'reason':'翻译'})
        ExternalCache.objects.filter(pk='github:example/test').update(data={'repository':'example/test','description':'上游更新','stars':20})
        self.assertEqual(cm.read(self.owner,result['key'])['data']['description'],'本站中文介绍')
        self.assertEqual(cm.read(self.owner,result['key'])['data']['stars'],20)
        self.assertEqual(cm.apply_public({'items':[{'repository':'example/test','stars':20}]})['items'][0]['description'],'本站中文介绍')
        self.assertEqual(EditorialRevision.objects.count(),2)

    def test_homepage_image_overlay_history_and_invalid_focal(self):
        key='featured/cumtb-20261001-national-day'
        original=cm.read(self.owner,key)
        media={'src':'/art/beikuang/avatar.png','sourceUrl':'https://example.com/photo','focal':'30% 70%','fit':'contain','alt':'测试'}
        cm.publish(self.owner,{'key':key,'revision':0,'patch':{'title':'新标题','media':media},'reason':'更换'})
        self.assertEqual(cm.overlays()['items'][key]['media']['fit'],'contain')
        cm.publish(self.owner,{'key':key,'revision':1,'restoreRevision':0,'reason':'恢复'})
        self.assertEqual(cm.read(self.owner,key)['data']['title'],original['data']['title'])
        with self.assertRaises(Problem): cm.validate_media(dict(media,focal='999% 0%'),self.owner)
        with self.assertRaises(Problem): cm.validate_media(dict(media,src='javascript:alert(1)'),self.owner)

    def test_search_finds_private_pending_circle(self):
        submit_entry(self.user,self.entry,1)
        r=cm.search(actor('beikuang'),'待审校圈测试','pending')
        self.assertEqual(r['items'][0]['id'],str(self.entry.pk))

    @patch('hub.robot_actions.policy',return_value={'enabled':True})
    def test_task_completion_requires_fresh_bound_receipt_and_deduplicates(self,_):
        task=cm.ensure_task(self.owner,'beikuang','chat:test','请审核待审校圈测试')
        old_id=str(uuid.uuid4())
        execute(self.owner,'beikuang','content_review',{'key':'entry/'+str(self.entry.pk),'revision':1,'decision':'approve','reason':'已核对'},old_id)
        result=cm.update_task(self.owner,'beikuang',{'id':str(task.pk),'state':'completed','result':{'actionIds':[old_id]}})
        self.assertEqual(result['state'],'failed')
        new=cm.ensure_task(self.owner,'codex','chat:new','请修改待审校圈测试的正文')
        aid=str(uuid.uuid4());args={'key':'entry/'+str(self.entry.pk),'revision':1,'patch':{'body':'Codex 编辑'},'reason':'核验'}
        r=execute(self.owner,'codex','content_publish',args,aid,str(new.pk))
        self.assertTrue(r['completed'])
        duplicate=execute(self.owner,'codex','content_publish',args,aid,str(new.pk));self.assertTrue(duplicate['duplicate'])
        result=cm.update_task(self.owner,'codex',{'id':str(new.pk),'state':'completed','result':{'actionIds':[aid]}})
        self.assertEqual(result['state'],'completed')
        self.assertEqual(ContentTask.objects.get(pk=new.pk).result['actionIds'],[aid])

    def test_owner_own_circle_publishes_directly_but_student_drafts(self):
        CampusBoard.objects.create(id='daily',name='日常',active=True)
        data=dict(self.payload,circle={'board':'daily','format':'moment'})
        r=self.client.post('/api/hub/circle/posts',data=json.dumps({'data':data}),content_type='application/json')
        self.assertEqual(r.status_code,200,r.content);self.assertEqual(Entry.objects.get(pk=r.json()['id']).state,'published')
        c=Client();c.force_login(self.user)
        r=c.post('/api/hub/circle/posts',data=json.dumps({'data':data}),content_type='application/json')
        self.assertEqual(Entry.objects.get(pk=r.json()['id']).state,'draft')

    def test_unfold_reuses_session_and_is_private(self):
        response=self.client.get('/manage/')
        self.assertEqual(response.status_code,200)
        self.assertContains(response,'内容管理')
        self.assertEqual(Client().get('/manage/').status_code,302)
        c=Client();c.force_login(self.user);self.assertEqual(c.get('/manage/').status_code,302)
        self.assertEqual(self.client.get('/manage-assets/unfold/css/styles.css').status_code,200)
        self.assertEqual(self.client.get('/manage-assets/../secret.key').status_code,404)

    def test_collector_provenance_survives_edit(self):
        self.entry.draft['publishedAt']='2026-10-09T00:00:00Z';self.entry.draft['sourceDigest']='abc';self.entry.save()
        cm.publish(self.owner,{'key':'entry/'+str(self.entry.pk),'revision':1,'patch':{'body':'已编辑'},'reason':'更正'})
        self.entry.refresh_from_db();self.assertEqual(self.entry.published['sourceDigest'],'abc')

    def test_unfold_form_writes_through_publication_service(self):
        response=self.client.post('/manage/hub/entry/'+str(self.entry.pk)+'/change/',{
            'expected_revision':1,'title':self.payload['title'],'summary':self.payload['summary'],
            'body':'管理中心编辑正文','draft':json.dumps(self.entry.draft),'reason':'后台编辑','_save':'保存'})
        self.assertEqual(response.status_code,302, response.content[:3000])
        self.entry.refresh_from_db();self.assertEqual(self.entry.published['body'],'管理中心编辑正文')

    def test_static_project_can_be_edited_without_an_upstream_cache(self):
        catalogue=json.loads((__import__('django.conf',fromlist=['settings']).settings.BASE.parent/'public/data/community.json').read_text(encoding='utf8'))
        project=next(p for p in catalogue['projects'] if p.get('repo',{}).get('fullName'))
        key='github/'+project['repo']['fullName']
        cm.publish(self.owner,{'key':key,'revision':0,'patch':{'description':'本站修订简介'},'reason':'修订静态目录'})
        self.assertEqual(cm.read(self.owner,key)['data']['description'],'本站修订简介')
        self.assertTrue(any(r['key']==key for r in cm.search(self.owner,project['repo']['fullName'])['items']))

    @patch('hub.robot_actions.policy',return_value={'enabled':True})
    def test_restart_reconciles_completed_writes_and_keeps_report_warning(self,_):
        task=cm.ensure_task(self.owner,'beikuang','chat:format','请审核 entry/'+str(self.entry.pk))
        aid=str(uuid.uuid4());execute(self.owner,'beikuang','content_review',{'key':'entry/'+str(self.entry.pk),'revision':1,'decision':'approve','reason':'已核对'},aid,str(task.pk))
        cm.update_task(self.owner,'beikuang',{'id':str(task.pk),'state':'failed','error':'结论格式错误','result':{'actionIds':[aid],'gaps':['结论格式错误']}})
        cm.reconcile_tasks();task.refresh_from_db()
        self.assertEqual(task.state,'completed');self.assertEqual(task.result['reportWarnings'],['结论格式错误'])
        self.assertTrue(Audit.objects.filter(action='content.task.reconciled',target=str(task.pk)).exists())

    @patch('hub.robot_actions.policy',return_value={'enabled':True})
    def test_one_receipt_cannot_complete_a_two_target_task(self,_):
        second=save_entry(self.user,{'kind':'topic','data':dict(self.payload,title='另一个测试')})
        task=cm.ensure_task(self.owner,'beikuang','chat:two','请审核 entry/'+str(self.entry.pk)+' 和 entry/'+str(second.pk))
        aid=str(uuid.uuid4());execute(self.owner,'beikuang','content_review',{'key':'entry/'+str(self.entry.pk),'revision':1,'decision':'approve','reason':'已核对'},aid,str(task.pk))
        r=cm.update_task(self.owner,'beikuang',{'id':str(task.pk),'state':'completed','result':{'actionIds':[aid]}})
        self.assertEqual(r['state'],'failed');cm.reconcile_tasks();task.refresh_from_db();self.assertEqual(task.state,'failed')

    def test_malformed_receipt_is_a_task_failure_not_a_server_error(self):
        task=cm.ensure_task(self.owner,'beikuang','chat:invalid','请审核测试')
        r=cm.update_task(self.owner,'beikuang',{'id':str(task.pk),'state':'completed','result':{'actionIds':['not-a-uuid']}})
        self.assertEqual(r['state'],'failed')
