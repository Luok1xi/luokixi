import json
import tempfile
import uuid
from datetime import timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from django.test import Client, TestCase, override_settings
from django.utils import timezone
from .core import Problem
from .models import Member, StudioRoom, StudioRun, StudioMessage, StudioDay, StudioCall
from . import studio_worker, studio_providers
from .studio_config import config, price_rates
from .studio_workspace import safe_path, context_files, prepare_artifact, verify_artifact


class StudioTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = Member.objects.create_user('studio-owner', 'studio-owner@example.invalid', 'owner-strong-example-password', is_staff=True, email_verified=True)
        cls.other = Member.objects.create_user('other-staff', 'other@example.invalid', 'other-strong-example-password', is_staff=True, email_verified=True)
        cls.regular = Member.objects.create_user('ordinary', 'ordinary@example.invalid', 'other-strong-example-password', email_verified=True)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.source = root / 'source'
        (self.source / 'campus').mkdir(parents=True)
        (root / 'data').mkdir()
        self.original = self.source / 'campus' / 'search_helper.py'
        self.original.write_text('def normalize(value):\n    return value\n', encoding='utf-8')
        self.override = override_settings(DATA=root / 'data', BASE=self.source / 'campus', PRODUCTION=False)
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.cfg = {'enabled': True, 'owner_id': self.owner.pk, 'daily_cny': '5', 'max_rounds': 6,
            'codex_daily_calls': 12, 'codex_executable': str(self.original), 'codex_model': '',
            'deepseek_api_key': 'test-placeholder-not-live', 'deepseek_model': 'deepseek-flash',
            'input_cny_per_million': '3', 'output_cny_per_million': '12',
            'price_valid_until': (timezone.localdate() + timedelta(days=1)).isoformat(), 'max_output_tokens': 3000}
        (root / 'data' / 'studio-config.json').write_text(json.dumps(self.cfg), encoding='utf-8')
        self.client.force_login(self.owner)

    def post(self, route, body, status=200, client=None):
        res = (client or self.client).post('/api/hub/studio/' + route, json.dumps(body), content_type='application/json')
        self.assertEqual(res.status_code, status, res.content)
        return res.json()

    def room(self, context=None):
        return self.post('rooms', {'title': 'Search improvement', 'contextFiles': context or []})['id']

    def start_run(self, room=None, **kwargs):
        payload = dict(prompt='Improve search', requestKey=uuid.uuid4().hex, seats=['codex'], rounds=1)
        payload.update(kwargs)
        return self.post(f'rooms/{room or self.room()}/runs', payload)

    def answer(self, message='A real adapter result in this mocked test.', files=None):
        return {'message': message, 'tasks': ['Review behaviour'], 'files': files or []}, 'mock-test-model', {'input_tokens': 100}

    def test_stage_expression_keeps_old_replies_and_never_accepts_actions(self):
        old={'message':'我看过了。','tasks':[],'files':[]}
        self.assertEqual(studio_providers.reply_json(json.dumps(old)),old)
        self.assertEqual(studio_providers.reply_json(json.dumps(dict(old,expression='happy')))['expression'],'happy')
        self.assertEqual(studio_providers.reply_json(json.dumps(dict(old,expression='execute-command')))['expression'],'neutral')
        with self.assertRaises(Problem):
            studio_providers.reply_json(json.dumps(dict(old,command='publish')))

    def test_selected_expression_is_persisted_and_returned_with_existing_studio_message(self):
        run=self.start_run()
        answer,model,usage=self.answer();answer['expression']='composed'
        with patch.object(studio_providers,'codex',return_value=(answer,model,usage)):
            studio_worker.run_one()
        row=StudioMessage.objects.get(run_id=run['id'])
        self.assertEqual(row.expression,'composed')
        from .studio import run_data
        self.assertEqual(run_data(row.run)['messages'][0]['expression'],'composed')

    def test_supervisor_and_codex_can_discuss_without_publishing(self):
        from .models import ExternalCache, Entry
        from .test_project_repository import fixture
        from .github_guides import cache_key
        from .supervisor import inspect_all, status
        d=fixture()
        ExternalCache.objects.create(pk=cache_key(d['repository']),data=d,success=timezone.now())
        inspect_all()
        case=status()['cases'][0]
        response=self.client.post('/api/hub/supervisor/discuss',json.dumps({'id':case['id'],'message':'请一起核对来源。'}),content_type='application/json')
        self.assertEqual(response.status_code,200,response.content)
        run=StudioRun.objects.get(pk=response.json()['run']['id'])
        self.assertEqual(run.seats,['beikuang','codex']);self.assertEqual(run.rounds,2)
        with patch.object(studio_providers,'codex',return_value=self.answer()) as call:
            with patch.object(studio_providers,'deepseek',return_value=self.answer()) as flash:
                self.assertTrue(studio_worker.run_one())
        self.assertEqual(call.call_count,1)
        self.assertEqual(flash.call_count,1)
        run.refresh_from_db();self.assertEqual(run.state,'completed')
        self.assertEqual(list(run.messages.order_by('id').values_list('seat',flat=True)),['beikuang','codex'])
        self.assertFalse(Entry.objects.filter(state='published').exists())

    def test_local_owner_only_and_csrf(self):
        anon = Client()
        self.post('rooms', {'title': 'x'}, 401, anon)
        for member in (self.other, self.regular):
            c = Client(); c.force_login(member)
            self.post('rooms', {'title': 'x'}, 403, c)
        response = self.client.get('/api/hub/studio/capabilities', REMOTE_ADDR='10.0.0.8')
        self.assertEqual(response.status_code, 403)
        with override_settings(PRODUCTION=True):
            self.assertEqual(self.client.get('/api/hub/studio/capabilities').status_code, 403)
        strict = Client(enforce_csrf_checks=True); strict.force_login(self.owner)
        self.post('rooms', {'title': 'x'}, 403, strict)

    def test_room_owner_cannot_read_another_owner(self):
        foreign = StudioRoom.objects.create(owner=self.other, title='Private')
        self.assertEqual(self.client.get('/api/hub/studio/rooms/' + str(foreign.pk)).status_code, 404)

    def test_local_bootstrap_needs_superuser_and_matching_owner(self):
        self.owner.email_verified = False
        self.owner.save(update_fields=['email_verified'])
        with patch('hub.studio.config', return_value=dict(config(), local_owner_bootstrap=True)):
            self.assertEqual(self.client.get('/api/hub/studio/capabilities').status_code, 403)
            self.owner.is_superuser = True
            self.owner.save(update_fields=['is_superuser'])
            self.assertEqual(self.client.get('/api/hub/studio/capabilities').status_code, 200)
            self.assertEqual(self.client.get('/api/hub/studio/capabilities', REMOTE_ADDR='10.2.3.4').status_code, 403)
        self.assertEqual(self.client.get('/api/hub/studio/capabilities').status_code, 403)

    def test_unselected_existing_file_cannot_be_overwritten(self):
        with self.assertRaises(Problem):
            prepare_artifact(uuid.uuid4(), {}, [{'path': 'campus/search_helper.py', 'content': 'x=1\n'}])

    def test_changed_candidate_invalidates_confirmation(self):
        from .studio_workspace import artifact_dir
        self.start_run(mode='work')
        with patch.object(studio_providers, 'codex', return_value=self.answer(files=[{'path': 'campus/new_helper.py', 'content': 'x=1\n'}])):
            studio_worker.run_one()
        run = StudioRun.objects.get()
        (artifact_dir(run.pk) / 'campus' / 'new_helper.py').write_text('x=2\n', encoding='utf-8')
        with self.assertRaises(Problem):
            verify_artifact(run)

    def test_capabilities_no_secret_or_fake_opus(self):
        response = self.client.get('/api/hub/studio/capabilities')
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(self.cfg['deepseek_api_key'], response.content.decode())
        design = next(x for x in response.json()['members'] if x['id'] == 'design')
        self.assertEqual(design['provider'], 'codex')
        self.assertFalse(response.json()['publishEnabled'])

    def test_idempotent_start_and_six_reply_ceiling(self):
        room = self.room()
        first = self.start_run(room, requestKey='repeat')
        self.assertEqual(self.start_run(room, requestKey='repeat')['id'], first['id'])
        self.post(f'rooms/{room}/runs', dict(prompt='Different', requestKey='repeat', seats=['codex'], rounds=1), 409)
        self.post(f'rooms/{room}/runs', dict(prompt='x', requestKey='next', seats=['codex'], rounds=7), 400)
        self.assertEqual(StudioRun.objects.count(), 1)

    def test_missing_deepseek_prevents_queueing(self):
        room = self.room()
        with patch('hub.studio.config', return_value=dict(config(), deepseek_api_key='')):
            self.post(f'rooms/{room}/runs', dict(prompt='x', requestKey='missing', seats=['deepseek'], rounds=1), 503)
        self.assertEqual(StudioRun.objects.count(), 0)

    def test_price_expiry_blocks_spend(self):
        bad = dict(config(), price_valid_until='2000-01-01')
        with self.assertRaises(Problem):
            price_rates(bad)

    def test_reentrant_worker_does_not_duplicate_calls(self):
        self.start_run(rounds=2, seats=['codex', 'design'])
        def answer(*args):
            self.assertIsNone(studio_worker.claim_next())
            return self.answer()
        with patch.object(studio_providers, 'codex', side_effect=answer) as model:
            self.assertTrue(studio_worker.run_one())
            self.assertFalse(studio_worker.run_one())
            self.assertEqual(model.call_count, 2)
        self.assertEqual(StudioMessage.objects.count(), 2)
        self.assertEqual(StudioDay.objects.get().codex_calls, 2)

    def test_failure_is_not_retried_or_faked(self):
        self.start_run()
        with patch.object(studio_providers, 'codex', side_effect=RuntimeError('secret-raw-response')) as model:
            studio_worker.run_one(); studio_worker.run_one()
            self.assertEqual(model.call_count, 1)
        run = StudioRun.objects.get()
        self.assertEqual(run.state, 'failed')
        self.assertNotIn('secret', run.error)
        self.assertFalse(run.messages.exists())
        self.assertEqual(StudioCall.objects.get().state, 'uncertain')

    def test_budget_reserved_before_call_and_failure_keeps_reserve(self):
        self.start_run(seats=['deepseek'])
        with patch.object(studio_providers, 'deepseek', side_effect=Problem('timeout')):
            studio_worker.run_one()
        self.assertGreater(StudioDay.objects.get().reserved_cny, 0)
        self.assertEqual(StudioCall.objects.get().state, 'uncertain')

    def test_budget_cannot_overspend(self):
        StudioDay.objects.create(day=timezone.localdate(), reserved_cny=Decimal('4.999999'))
        self.start_run(seats=['deepseek'])
        with patch.object(studio_providers, 'deepseek') as model:
            studio_worker.run_one()
            model.assert_not_called()
        self.assertEqual(StudioDay.objects.get().reserved_cny, Decimal('4.999999'))
        self.assertEqual(StudioRun.objects.get().state, 'failed')

    def test_codex_daily_limit(self):
        StudioDay.objects.create(day=timezone.localdate(), codex_calls=12)
        self.start_run()
        with patch.object(studio_providers, 'codex') as model:
            studio_worker.run_one()
            model.assert_not_called()

    def test_stop_during_reply_discards_result_and_stops_next_speaker(self):
        run = self.start_run(rounds=3)
        def stop(*args):
            self.post('runs/' + run['id'] + '/stop', {})
            return self.answer()
        with patch.object(studio_providers, 'codex', side_effect=stop) as model:
            studio_worker.run_one()
            self.assertEqual(model.call_count, 1)
        self.assertEqual(StudioRun.objects.get().state, 'cancelled')
        self.assertFalse(StudioMessage.objects.exists())

    def test_code_candidate_validation_and_approval_are_not_publication(self):
        room = self.room(['campus/search_helper.py'])
        run = self.start_run(room, mode='work')
        body = 'def normalize(value):\n    return " ".join(value.split())\n'
        with patch.object(studio_providers, 'codex', return_value=self.answer(files=[{'path': 'campus/search_helper.py', 'content': body}])):
            studio_worker.run_one()
        candidate = StudioRun.objects.get()
        self.assertEqual(candidate.state, 'awaiting_review')
        self.assertEqual(candidate.artifact['checks'][0]['state'], 'passed')
        self.assertNotIn('join', self.original.read_text())
        route = 'runs/' + run['id'] + '/approve'
        self.post(route, {'hash': 'wrong', 'acknowledgeUnrunTests': True}, 409)
        result = self.post(route, {'hash': candidate.artifact['hash'], 'acknowledgeUnrunTests': True})
        self.assertEqual(result['state'], 'approved')
        self.assertFalse(result['artifact']['published'])
        self.original.write_text('changed concurrently by Opus\n', encoding='utf-8')
        self.post(route, {'hash': candidate.artifact['hash'], 'acknowledgeUnrunTests': True}, 409)

    def test_invalid_code_fails_check(self):
        artifact = prepare_artifact(uuid.uuid4(), {}, [{'path': 'campus/new_code.py', 'content': 'def broken(:'}])
        self.assertEqual(artifact['checks'][0]['state'], 'failed')

    def test_context_paths_and_secrets(self):
        for name in ['../escape.py', '/campus/a.py', 'campus/../a.py', 'campus/.data/auth.json',
                     'C:/campus/a.py', 'campus\\a.py', 'campus/studio.py', 'campus/CON.py', 'campus/a.py:secret']:
            with self.subTest(name=name), self.assertRaises(Problem):
                safe_path(name)
        self.original.write_text('api_key = "sk-' + 'a' * 40 + '"', encoding='utf-8')
        with self.assertRaises(Problem):
            context_files(['campus/search_helper.py'])

    def test_stale_job_before_model_call_can_be_claimed_again(self):
        self.start_run()
        run = studio_worker.claim_next()
        StudioRun.objects.filter(pk=run.pk).update(updated=timezone.now() - timedelta(minutes=6))
        self.assertEqual(studio_worker.recover_interrupted(), 1)
        self.assertEqual(studio_worker.claim_next().pk,run.pk)

    def test_codex_protocol_has_no_shell_or_publish(self):
        args = studio_providers.codex_command('codex', '.', 'schema', 'out')
        self.assertIn('read-only', args)
        self.assertIn('--ignore-user-config', args)
        self.assertIn('features.shell_tool=false', args)
        self.assertNotIn('--dangerously-bypass-approvals-and-sandbox', args)
        with self.assertRaises(Problem):
            studio_providers.reply_json('{"message":"fake"}')

    def test_codex_chat_is_owner_only_and_has_its_own_room(self):
        response=self.client.get('/api/hub/studio/codex/chat')
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['runs'],[])
        other=Client();other.force_login(self.other)
        self.assertEqual(other.get('/api/hub/studio/codex/chat').status_code,403)
        run=self.post('codex/messages',{'body':'你好','requestKey':'codex-test-1'})
        self.assertEqual(run['seats'],['codex'])
        self.assertEqual(run['mode'],'chat')
        self.assertEqual(run['rounds'],1)
        repeat=self.post('codex/messages',{'body':'你好','requestKey':'codex-test-1'})
        self.assertEqual(run['id'],repeat['id'])
        self.post('codex/messages',{'body':'另一句','requestKey':'codex-test-1'},409)
        self.post('codex/messages',{'body':'另一句','requestKey':'codex-test-2'},409)

    def test_codex_chat_preserves_both_sides_of_history_and_actual_model(self):
        first=self.post('codex/messages',{'body':'先帮我记一下讨论主题：资料整理','requestKey':'chat-history-1'})
        with patch.object(studio_providers,'codex',return_value=self.answer('资料整理，继续说。')):
            self.assertTrue(studio_worker.run_one())
        second=self.post('codex/messages',{'body':'接着上面的话说','requestKey':'chat-history-2'})
        with patch.object(studio_providers,'codex',return_value=self.answer('接着讨论资料整理。')) as call:
            studio_worker.run_one()
        prompt=call.call_args.args[0]
        self.assertIn('先帮我记一下讨论主题',prompt)
        self.assertIn('资料整理，继续说。',prompt)
        view=self.client.get('/api/hub/studio/codex/chat').json()
        self.assertEqual(len(view['runs']),2)
        self.assertEqual(view['runs'][0]['messages'][0]['model'],'mock-test-model')
        self.assertEqual(StudioDay.objects.get().codex_calls,2)
        self.assertFalse(any(run['artifact'] for run in view['runs']))

    def test_codex_chat_failure_is_visible_and_does_not_fake_a_reply(self):
        run=self.post('codex/messages',{'body':'测试错误状态','requestKey':'chat-failure'})
        with patch.object(studio_providers,'codex',side_effect=Problem('本机账号额度不足',502)):
            studio_worker.run_one()
        view=self.client.get('/api/hub/studio/codex/chat').json()
        self.assertEqual(view['runs'][0]['state'],'failed')
        self.assertEqual(view['runs'][0]['messages'],[])
        self.assertIn('额度不足',view['runs'][0]['error'])
        with patch.object(studio_providers,'codex') as call:
            self.assertFalse(studio_worker.run_one())
        call.assert_not_called()

    def test_codex_chat_history_fetch_has_bounded_query_count(self):
        from .codex_chat import chat_room,view
        from django.db import connection
        from django.test.utils import CaptureQueriesContext
        room=chat_room(self.owner,True)
        for n in range(35):
            run=StudioRun.objects.create(room=room,request_key='query-test-'+str(n),prompt='一个历史问题',mode='chat',state='completed',seats=['codex'],rounds=1)
            StudioMessage.objects.create(run=run,sequence=0,seat='codex',provider='codex',model='isolated',body='历史回复')
        with CaptureQueriesContext(connection) as queries:
            result=view(self.owner,config())
        self.assertEqual(len(result['runs']),35)
        self.assertLessEqual(len(queries),7)

    def test_existing_joint_history_reaches_codex_without_other_owners_private_rooms(self):
        from .studio import collaboration_context
        room=StudioRoom.objects.create(owner=self.owner,title='已有 SimpleFOC 讨论')
        prior=StudioRun.objects.create(room=room,request_key='old-discussion',prompt='核对项目分类',
            seats=['beikuang','codex'],rounds=2,state='completed')
        StudioMessage.objects.create(run=prior,sequence=0,seat='beikuang',provider='codex',
            model='historical',body='这项控制算法应该归嵌入式。',tasks=['核对分类原文'])
        foreign=StudioRoom.objects.create(owner=self.other,title='别人的私密工作')
        StudioRun.objects.create(room=foreign,request_key='private',prompt='私密内容',seats=['beikuang','codex'],state='completed')
        data=collaboration_context(self.owner)
        self.assertEqual([r['id'] for r in data['runs']],[str(prior.pk)])
        self.assertEqual(data['runs'][0]['functionalTests'],'not-run')
        self.post('codex/messages',{'body':'还记得和小煤渣的讨论吗','requestKey':'joint-recall'})
        with patch.object(studio_providers,'codex',return_value=self.answer()) as provider:
            studio_worker.run_one()
        prompt=provider.call_args.args[0]
        self.assertIn('这项控制算法应该归嵌入式',prompt)
        self.assertIn('清冷、克制',prompt)
        self.assertIn('闺蜜',prompt)
        self.assertNotIn('私密内容',prompt)
        self.assertEqual(StudioRoom.objects.filter(title='已有 SimpleFOC 讨论').count(),1)

    def test_joint_seat_uses_original_companion_and_does_not_double_reserve(self):
        from . import companion_bridge
        self.start_run(rounds=2,seats=['beikuang','codex'])
        with patch.object(companion_bridge,'enabled',return_value=True), \
             patch.object(companion_bridge,'studio_respond',return_value=self.answer('原版人格对搭档的实际回应')) as original, \
             patch.object(studio_providers,'deepseek') as legacy, \
             patch.object(studio_providers,'codex',return_value=self.answer()):
            studio_worker.run_one()
        original.assert_called_once();legacy.assert_not_called()
        self.assertEqual(StudioDay.objects.get().reserved_cny,0,'only the original bridge reserves DeepSeek cost')
        self.assertEqual(StudioDay.objects.get().codex_calls,1)
        self.assertEqual(StudioMessage.objects.filter(seat='beikuang').get().body,'原版人格对搭档的实际回应')

    def test_original_companion_failure_never_falls_back_to_legacy_persona_in_studio(self):
        from . import companion_bridge
        self.start_run(rounds=1,seats=['beikuang'])
        with patch.object(companion_bridge,'enabled',return_value=True), \
             patch.object(companion_bridge,'studio_respond',side_effect=Problem('原版服务断开',503)), \
             patch.object(studio_providers,'deepseek') as legacy:
            studio_worker.run_one()
        legacy.assert_not_called()
        self.assertEqual(StudioRun.objects.get().state,'reconnecting')
        self.assertFalse(StudioMessage.objects.exists())
