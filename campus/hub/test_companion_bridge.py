import json
import uuid
from decimal import Decimal
from unittest import mock
from types import SimpleNamespace
from django.test import TestCase
# Load the shared studio before patching its config dependency for individual tests.
# Otherwise its lazy first import captures a temporary MagicMock for later tests.
from . import companion_bridge as bridge, beikuang, studio
from .models import Member, BeikuangMessage, StudioDay, Job
from .core import Problem


class CompanionBridgeTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner=Member.objects.create_user('bridge_owner','bridge@example.test','Quartz-water-821',is_staff=True)

    def setUp(self):
        bridge._state_cache.clear()
        self.cfg={'owner_id':self.owner.pk,'enabled':True,'daily_cny':Decimal('5'),'codex_daily_calls':12}
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(bridge,'connection',return_value={'token':'private','port':17862}).start()
        mock.patch('hub.studio_config.config',return_value=self.cfg).start()
        mock.patch('hub.studio_config.price_rates',return_value=(Decimal('2'),Decimal('8'))).start()

    def post(self,body,**kwargs):
        return self.client.post('/api/hub/companion-bridge',json.dumps(body),content_type='application/json',HTTP_AUTHORIZATION='Bearer private',**kwargs)

    def test_bridge_denies_public_addresses_and_missing_credentials(self):
        self.assertEqual(self.post({'op':'tool','name':'site_status'},REMOTE_ADDR='10.0.0.2').status_code,403)
        self.assertEqual(self.client.post('/api/hub/companion-bridge','{}',content_type='application/json').status_code,403)

    def test_current_emotion_is_original_cached_state_and_not_shared_with_other_accounts(self):
        state={'engine':'campus-companion','emotion':{'name':'happy','intensity':.8},'self':{'mood':'bright'},'private':'not exposed'}
        with mock.patch.object(bridge,'call',return_value=state) as call:
            result=bridge.runtime_state(self.owner)
            self.assertEqual(result['self']['mood'],'bright');self.assertNotIn('private',result)
            self.assertEqual(bridge.runtime_state(self.owner),result);call.assert_called_once()
            self.assertEqual(bridge.runtime_state(SimpleNamespace(pk=self.owner.pk+99)),{})
        bridge._state_cache.clear()
        with mock.patch.object(bridge,'call',side_effect=Problem('原版暂未连接',503)):
            self.assertEqual(bridge.runtime_state(self.owner),{'error':'原版暂未连接'})

    def test_budget_shared_with_existing_site_jobs_and_no_double_reservation(self):
        ident=str(uuid.uuid4());body={'op':'reserve','id':ident,'inputUnits':10000,'outputTokens':1000}
        self.assertEqual(self.post(body).status_code,200)
        self.assertEqual(StudioDay.objects.get().reserved_cny,Decimal('.028'))
        self.assertEqual(self.post(body).status_code,409)
        row=StudioDay.objects.get();row.reserved_cny=Decimal('4.999');row.save()
        self.assertEqual(self.post(dict(body,id=str(uuid.uuid4()))).status_code,429)
        self.cfg['enabled']=False
        self.assertEqual(self.post(dict(body,id=str(uuid.uuid4()))).status_code,403)

    def test_runtime_cache_keeps_both_seats_without_crossing_identity(self):
        with mock.patch.object(bridge,'call',side_effect=lambda *a,**kw:{'engine':kw['seat']}) as call:
            self.assertEqual(bridge.runtime_state(self.owner)['engine'],'beikuang')
            self.assertEqual(bridge.runtime_state(self.owner,'codex')['engine'],'codex')
            self.assertEqual(bridge.runtime_state(self.owner)['engine'],'beikuang')
            self.assertEqual(bridge.runtime_state(self.owner,'codex')['engine'],'codex')
            self.assertEqual(call.call_count,2)

    def test_codex_voice_console_uses_shared_gpu_queue_and_token_identity(self):
        with mock.patch.object(bridge,'connection',side_effect=lambda seat='beikuang':{'token':seat,'port':17864 if seat=='codex' else 17862}),mock.patch.object(bridge,'call',return_value={'audio':'AA==','type':'audio/wav'}) as call:
            response=self.client.post('/api/hub/companion-bridge',json.dumps({'op':'voice','text':'覚えてる。','seat':'beikuang','language':'ja'}),content_type='application/json',HTTP_AUTHORIZATION='Bearer codex')
            self.assertEqual(response.status_code,200)
            self.assertEqual(call.call_args.args[1]['seat'],'codex')
            self.assertEqual(call.call_args.args[1]['language'],'ja')

    def test_proactive_delivery_exactly_once_and_no_arbitrary_write_tool(self):
        body={'op':'delivery','id':'reading-1','text':'读到了一段有意思的公开资料。'}
        self.assertEqual(self.post(body).status_code,200);self.assertTrue(self.post(body).json()['duplicate'])
        self.assertEqual(BeikuangMessage.objects.count(),1)
        self.assertEqual(self.post({'op':'tool','name':'remember','arguments':{'content':'不许从网页写入'}}).status_code,403)

    def test_original_engine_is_called_and_legacy_writer_is_never_a_fallback(self):
        with mock.patch.object(bridge,'respond',return_value=('原版回答','deepseek-flash')) as original, mock.patch('hub.beikuang_dialogue.respond') as legacy:
            self.assertEqual(beikuang.write('chat',{'ownerId':self.owner.pk},'x')[0],'原版回答')
            original.assert_called_once();legacy.assert_not_called()
        with mock.patch.object(bridge,'respond',side_effect=Problem('原版离线',503)),mock.patch('hub.beikuang_dialogue.respond') as legacy:
            with self.assertRaises(Problem):beikuang.write('chat',{},'x')
            legacy.assert_not_called()

    def test_poll_delivers_original_metadata_and_cancels_superseded_turn(self):
        context={'ownerId':self.owner.pk,'owner':'你好'}
        with mock.patch.object(bridge,'call',side_effect=[{'state':'running'},{'state':'done','result':{'text':'原版文本','engine':'campus-companion','self':{'mood':'bright'}}}]):
            self.assertEqual(bridge.respond(context,'chat-x')[0],'原版文本')
            self.assertEqual(context['_companion']['self']['mood'],'bright')
        from .beikuang_turns import Superseded
        with mock.patch.object(bridge,'call',return_value={'state':'running'}) as call:
            with self.assertRaises(Superseded):bridge.respond({'ownerId':self.owner.pk,'_isCurrent':lambda:False},'chat-y')
            self.assertEqual(call.call_args.args[0],'cancel')

    def test_report_keeps_original_message_chain_instead_of_only_flattened_text(self):
        chain=[{'type':'text','text':'今天整理好了。'}, {'type':'sticker','id':'heart'}, {'type':'text','text':'出错的两项还在查。'}]
        def write(skill, context, key):
            context['_companion']={'engine':'campus-companion','messages':chain,'emotion':{'name':'happy'},'self':{'mood':'bright'}}
            return '今天整理好了。\n出错的两项还在查。','deepseek-flash'
        with mock.patch.object(beikuang,'today_stats',return_value={}), mock.patch.object(beikuang,'model_ready',return_value=(True,'')), mock.patch.object(beikuang,'write',side_effect=write):
            report=beikuang.write_report(self.owner)
        report.refresh_from_db()
        self.assertEqual(report.data['messages'],chain)
        self.assertEqual(report.data['engine'],'campus-companion')
        self.assertEqual(beikuang.message_data(report)['messages'],chain)

    def test_autonomous_work_is_opt_in_and_only_dispatches_supported_action_once(self):
        body={'op':'work-action','id':str(uuid.uuid4()),'action':'review','goal':'处理积压资料','reason':'有待审资料'}
        self.assertEqual(self.post(body).status_code,403)
        with mock.patch.object(bridge,'autonomy_enabled',return_value=True),mock.patch.object(beikuang,'enabled',return_value=True),mock.patch.object(beikuang,'today_stats',return_value={'queued':305}):
            self.assertEqual(self.post(dict(body,action='delete')).status_code,403)
            first=self.post(body);self.assertEqual(first.status_code,200);self.assertEqual(first.json()['state'],'queued')
            self.assertTrue(self.post(body).json()['duplicate']);self.assertEqual(Job.objects.count(),1)
            self.assertEqual(Job.objects.get().payload['companionDecision']['goal'],'处理积压资料')
            state=self.post({'op':'work-state'}).json()
            self.assertEqual(state['jobs'][0]['decisionId'],body['id'])
            self.assertEqual(state['jobs'][0]['state'],'queued')
            self.post(dict(body,id=str(uuid.uuid4())))
            self.assertEqual(Job.objects.count(),1,'an active review is reused, not started twice')
            job=Job.objects.get();job.state='done';job.result={'skipped':'awaiting-companion-decision'};job.save()
            self.assertEqual(self.post({'op':'work-state'}).json()['jobs'],[])

    def test_existing_studio_transport_keeps_identity_and_cancels_without_accepting_reply(self):
        run=SimpleNamespace(pk=uuid.uuid4(),mode='discuss',prompt='',room=SimpleNamespace(owner_id=self.owner.pk))
        material={'goal':'核对已有候选','history':[{'seat':'codex','body':'还没有运行功能测试。'}]}
        with mock.patch.object(bridge,'call',side_effect=[{'state':'running'},
                {'state':'done','result':{'text':'我先看证据。'}}]) as call:
            answer,model,_=bridge.studio_respond(run,1,material)
            request=call.call_args_list[0].args[1]
            self.assertEqual(request['kind'],'studio')
            self.assertEqual(request['owner'],self.owner.pk)
            self.assertEqual(request['material'],material)
            self.assertEqual(call.call_args.args[0],'jobs/'+request['id'])
            self.assertEqual(answer,{'message':'我先看证据。','tasks':[],'files':[],'messages':[],'expression':'neutral'})
            self.assertEqual(model,'deepseek-flash')
        with mock.patch.object(bridge,'call',return_value={'state':'running'}) as call:
            with self.assertRaises(Problem):
                bridge.studio_respond(run,1,material,mock.Mock(side_effect=[False,True]))
            self.assertEqual(call.call_args.args,('cancel',{'id':request['id']}))

    def test_clock_no_longer_forces_review_or_report_but_explicit_owner_request_still_works(self):
        with mock.patch.object(bridge,'autonomy_enabled',return_value=True),mock.patch.object(beikuang,'enabled',return_value=True):
            beikuang.queue_review();self.assertEqual(Job.objects.count(),0)
            self.assertEqual(beikuang.review_all()['skipped'],'awaiting-companion-decision')
            with mock.patch.object(beikuang,'write_report') as writer:
                beikuang.maybe_report();beikuang.report_job(self.owner.pk,automatic=True);writer.assert_not_called()
            beikuang.queue_review(decided=True);self.assertTrue(Job.objects.get().payload['ownerRequested'])
