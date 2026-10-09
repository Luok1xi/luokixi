import tempfile
import uuid
from pathlib import Path
from datetime import timedelta
from unittest.mock import patch
from django.test import TestCase, override_settings
from django.utils import timezone
from .core import Problem, can_participate, member_data
from .models import Member, StudioRoom, StudioRun, StudioCall, StudioDay, StudioMessage
from . import studio_worker, studio_workflow, companion_bridge, beikuang


class StudioRecoveryTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        (root/'campus').mkdir(); (root/'data').mkdir()
        self.settings_override = override_settings(BASE=root/'campus', DATA=root/'data', PRODUCTION=False)
        self.settings_override.enable(); self.addCleanup(self.settings_override.disable)
        self.owner = Member.objects.create_user('owner', 'owner@example.invalid', is_staff=True, email_verified=True)
        self.room = StudioRoom.objects.create(owner=self.owner, title='持续维护')
        self.run = StudioRun.objects.create(room=self.room, prompt='核验并修复图片', request_key='one', seats=['beikuang','codex'], rounds=2)
        self.cfg = {'enabled':True,'owner_id':self.owner.pk,'robot_autonomy':True}

    def test_dead_lease_is_requeued_and_stopped_work_is_not(self):
        StudioRun.objects.filter(pk=self.run.pk).update(state='running', updated=timezone.now()-timedelta(minutes=2))
        with patch('hub.robot_workbench.reload_source'):
            self.assertEqual(studio_worker.recover_interrupted(),1)
        self.run.refresh_from_db(); self.assertEqual(self.run.state,'queued')
        self.run.state='interrupted';self.run.stop_requested=True;self.run.save()
        self.assertEqual(studio_workflow.recover(),0)

    def test_completed_round_and_reservation_are_not_repeated(self):
        day=StudioDay.objects.create(day=timezone.localdate(), reserved_cny='1.23', codex_calls=9)
        StudioMessage.objects.create(run=self.run,sequence=0,seat='beikuang',provider='deepseek',body='已核验来源')
        StudioCall.objects.create(run=self.run,sequence=0,provider='deepseek',day=day,state='completed')
        StudioCall.objects.create(run=self.run,sequence=1,provider='codex',day=day)
        result=({'message':'我补上核对结果。','tasks':[],'files':[]},'mock',{})
        with patch('hub.studio_worker.config',return_value=self.cfg), patch('hub.studio_worker.ready'), \
             patch('hub.companion_bridge.connection',return_value={'port':1}), \
             patch('hub.studio_worker.seat_context',return_value={}), \
             patch('hub.studio.collaboration_context',return_value={}), \
             patch('hub.companion_bridge.studio_respond',return_value=result) as model:
            studio_worker.run_one()
        self.assertEqual(model.call_count,1)
        self.assertEqual(model.call_args.args[1],1)
        self.assertTrue(model.call_args.args[2]['_resume'])
        self.run.refresh_from_db();day.refresh_from_db()
        self.assertEqual(self.run.state,'completed')
        self.assertEqual(self.run.messages.count(),2)
        self.assertEqual(str(day.reserved_cny),'1.230000');self.assertEqual(day.codex_calls,9)

    def test_existing_runtime_result_is_rejoined_by_same_id(self):
        result={'state':'done','result':{'text':'原来已完成的回复','model':'mock'}}
        with patch.object(companion_bridge,'call',return_value=result) as remote:
            value,_,_=companion_bridge.studio_respond(self.run,1,{'_resume':True},seat='codex')
        self.assertEqual(value['message'],'原来已完成的回复')
        posts=[c for c in remote.call_args_list if c.args[0]=='jobs']
        self.assertEqual(posts[0].args[1]['id'],studio_workflow.job_id(self.run,1))
        self.assertFalse(studio_workflow.task(self.run).get('reconciliations'))

    def test_lost_legacy_result_only_allows_readonly_reconciliation(self):
        calls=[]
        def remote(route,body=None,**kwargs):
            calls.append((route,body))
            if route.endswith(studio_workflow.job_id(self.run,1)):raise Problem('没有该任务',404)
            return {'state':'done','result':{'text':'旧执行没有凭据，我先核验现有记录。'}}
        with patch.object(companion_bridge,'call',side_effect=remote):
            companion_bridge.studio_respond(self.run,1,{'_resume':True,'maintenance':{'enabled':True}},seat='codex',can_code=True)
        posted=next(body for route,body in calls if route=='jobs')
        self.assertEqual(posted['kind'],'studio');self.assertFalse(posted['material']['maintenance']['enabled'])
        self.assertEqual(posted['id'],studio_workflow.job_id(self.run,1,1))
        with patch.object(companion_bridge,'call',return_value={'state':'interrupted'}):
            with self.assertRaises(Problem):companion_bridge.studio_respond(self.run,1,{'_resume':True},seat='codex')

    def test_runtime_restart_between_enqueue_and_poll_waits_for_reconnection(self):
        with patch.object(companion_bridge,'call',side_effect=[{'state':'running'},Problem('没有该任务',404)]):
            with self.assertRaises(Problem) as raised:
                companion_bridge.studio_respond(self.run,1,{},seat='codex')
        self.assertEqual(raised.exception.status,503)
        self.assertIn('重新连接同一任务',raised.exception.message)

    def test_modules_have_version_conflicts_and_no_permission_grants(self):
        args={'id':'check-images','title':'图片核验','instructions':'核验图片来源和真实响应。','acceptance':['提供可达性证据'],'permissions':'everything'}
        first=studio_workflow.save_module(args)
        self.assertNotIn('permissions',first)
        with self.assertRaises(Problem):studio_workflow.save_module(args)
        second=studio_workflow.save_module(dict(args,beforeHash=first['hash']))
        self.assertEqual(second['version'],2)
        self.assertEqual(studio_workflow.modules()[0]['hash'],second['hash'])

    def test_queued_robot_is_followed_without_spending_another_model_call(self):
        from .models import Job
        job=Job.objects.create(key='real-receipt',kind='maint-links',owner=self.owner,due=timezone.now())
        studio_workflow.checkpoint(self.run,1,{'maintenance':{'trace':[{'receipt':{'operation':'run_robot','id':str(job.pk)}}]}})
        self.assertEqual(studio_workflow.settle_work(self.run),'waiting_jobs')
        self.run.state='waiting_jobs';self.run.save()
        job.state='done';job.result={'checked':5};job.save()
        studio_workflow.recover();self.run.refresh_from_db()
        self.assertEqual(self.run.state,'completed')
        self.assertEqual(studio_workflow.task(self.run)['executionResults'][0]['result'],{'checked':5})

    def test_failed_robot_remains_an_unresolved_result(self):
        from .models import Job
        job=Job.objects.create(key='failed-receipt',kind='maint-links',owner=self.owner,due=timezone.now(),state='failed',error='来源暂不可达')
        studio_workflow.checkpoint(self.run,1,{'maintenance':{'trace':[{'receipt':{'operation':'run_robot','id':str(job.pk)}}]}})
        self.assertEqual(studio_workflow.settle_work(self.run),'needs_attention')

    def test_only_workflow_code_is_opened_not_permissions(self):
        from .studio_workspace import safe_path
        from .robot_workbench import FILES
        self.assertIn('campus/hub/studio_workflow.py',FILES)
        safe_path('campus/hub/studio_workflow.py')
        for name in ['campus/hub/studio_config.py','campus/hub/studio_budget.py','campus/.data/config.json']:
            with self.assertRaises(Problem):safe_path(name)

    def test_system_account_is_verified_but_cannot_password_login(self):
        user=beikuang.agent();self.assertTrue(can_participate(user));self.assertFalse(user.has_usable_password())
        user.email_verified=False;user.save()
        self.assertTrue(beikuang.agent().email_verified)
        user.set_password('test-password');user.save()
        with self.assertRaises(Problem):beikuang.agent()

    def test_exact_avatar_is_returned_without_email_or_private_preferences(self):
        self.owner.preferences={'companionAvatar':'/art/companions/beikuang-chibi.png','private':'do-not-expose'}
        data=member_data(self.owner)
        self.assertEqual(data['avatar'],'/art/companions/beikuang-chibi.png')
        self.assertNotIn('preferences',data);self.assertNotIn('email',data)

    def test_room_task_receipts_are_loaded_in_one_query(self):
        second=StudioRun.objects.create(room=self.room,prompt='另一任务',request_key='two',seats=['codex'])
        runs=[self.run,second]
        studio_workflow.record(self.run,completedSequence=0)
        with self.assertNumQueries(1):studio_workflow.preload(runs)
        with self.assertNumQueries(0):
            self.assertEqual(studio_workflow.task(self.run)['completedSequence'],0)
            self.assertEqual(studio_workflow.task(second)['goal'],'另一任务')
