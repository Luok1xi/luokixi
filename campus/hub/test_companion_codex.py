import json
import uuid
import base64
from unittest.mock import patch
from django.test import TestCase
from .test_studio import StudioTests as _StudioTests
from . import companion_codex,companion_bridge,studio_worker,studio_providers
from .models import StudioDay,StudioMessage,StudioRun
from .core import Problem

class CodexRuntimeTests(TestCase):
    setUpTestData=classmethod(_StudioTests.setUpTestData.__func__)
    setUp=_StudioTests.setUp
    post=_StudioTests.post
    def request(self,**extra):
        return dict(id=str(uuid.uuid4()),kind='complete',messages=[{'role':'system','content':'JSON'},{'role':'user','content':'test'}],json=True,purpose='routing',**extra)
    def test_original_steps_share_real_codex_counter_and_never_replay_same_call(self):
        body=self.request()
        def output(prompt,cfg,**kw):return kw['parse_result']('{"text":"{\\"actions\\":[]}"}'),'test-model',{'input_tokens':10}
        with patch.object(studio_providers,'codex',side_effect=output) as model:
            result=companion_codex.respond(body)
            self.assertEqual(json.loads(result['text']),{'actions':[]})
            with self.assertRaises(Problem):companion_codex.respond(body)
            model.assert_called_once()
        self.assertEqual(StudioDay.objects.get().codex_calls,1)
        self.assertEqual(StudioDay.objects.get().reserved_cny,0)

    def test_fast_dialogue_preserves_model_and_deep_analysis_keeps_its_effort(self):
        from .models import ExternalCache
        for thinking,effort in [('fast','low'),('deep','high')]:
            body=self.request(thinking=thinking)
            with patch.object(studio_providers,'codex',return_value=({'text':'{}'},'same-model',{})) as model:
                companion_codex.respond(body)
            cfg=model.call_args.args[1]
            self.assertEqual(cfg['codex_reasoning_effort'],effort)
            self.assertEqual(cfg['codex_model'],self.cfg['codex_model'])
            self.assertEqual(cfg['daily_cny'],5)
            receipt=ExternalCache.objects.get(pk='codex-companion-call:'+body['id']).data
            self.assertGreaterEqual(receipt['latencyMs'],0)
            self.assertGreater(receipt['inputBytes'],0)
        args=studio_providers.codex_command('codex','.','schema','out',reasoning_effort='low')
        self.assertIn('model_reasoning_effort="low"',args)
        self.assertIn('features.shell_tool=false',args)

    def test_chat_priority_does_not_interrupt_active_work_or_starve_aged_work(self):
        from datetime import timedelta
        from django.utils import timezone
        room=_StudioTests.room(self)
        background=StudioRun.objects.create(room_id=room,request_key='background',prompt='work',mode='discuss',seats=['codex'],rounds=1)
        self.post('codex/messages',{'body':'你好','requestKey':'priority'})
        run=studio_worker.claim_next()
        self.assertEqual(run.mode,'chat')
        self.assertIsNone(studio_worker.claim_next(),'running work is never interrupted')
        StudioRun.objects.filter(pk=run.pk).update(state='completed')
        StudioRun.objects.filter(pk=background.pk).update(created=timezone.now()-timedelta(minutes=3))
        self.post('codex/messages',{'body':'再聊一句','requestKey':'priority-2'})
        self.assertEqual(studio_worker.claim_next().pk,background.pk)

    def test_heartbeat_protects_slow_live_work_but_lost_claim_cannot_block_chat(self):
        from datetime import timedelta
        from django.utils import timezone
        room=_StudioTests.room(self)
        StudioRun.objects.create(room_id=room,request_key='lease',prompt='work',mode='discuss',seats=['codex'],rounds=1)
        run=studio_worker.claim_next()
        StudioRun.objects.filter(pk=run.pk).update(updated=timezone.now()-timedelta(minutes=6))
        self.assertEqual(studio_worker.refresh_claim(run),1)
        self.assertEqual(studio_worker.recover_interrupted(),0,'a long model call with heartbeat is still alive')
        StudioRun.objects.filter(pk=run.pk).update(updated=timezone.now()-timedelta(seconds=76))
        self.assertEqual(studio_worker.recover_interrupted(),1)
        self.assertEqual(studio_worker.refresh_claim(run),0,'late worker cannot revive interrupted work')
        run.refresh_from_db();self.assertEqual(run.state,'queued')
    def test_tool_requests_use_original_registry_protocol_and_reject_unknown_tools(self):
        body=self.request();body.update(kind='chat',tools=[{'type':'function','function':{'name':'read_page'}}])
        def output(prompt,cfg,**kw):return kw['parse_result'](json.dumps({'content':'','tool_calls':[{'id':'x','name':'read_page','arguments':'{"url":"https://example.org"}'}]})),'test',{}
        with patch.object(studio_providers,'codex',side_effect=output):
            result=companion_codex.respond(body)
        self.assertEqual(result['message']['tool_calls'][0]['function']['name'],'read_page')
        body['id']=str(uuid.uuid4());body['tools']=[]
        with patch.object(studio_providers,'codex',side_effect=output),self.assertRaises(Problem):companion_codex.respond(body)
    def test_codex_private_chat_uses_original_engine_and_keeps_chain(self):
        self.post('codex/messages',{'body':'继续昨天的事','requestKey':'original-codex'})
        result={'message':'我记着。','tasks':[],'files':[],'expression':'think','messages':[{'type':'text','text':'我记着。','speech':'覚えてる。','expression':'think'}]}
        with patch.object(companion_bridge,'connection',side_effect=lambda seat='beikuang':{'port':17864} if seat=='codex' else None),patch.object(companion_bridge,'studio_respond',return_value=(result,'codex-fixture',{})) as original,patch.object(studio_providers,'codex') as direct:
            studio_worker.run_one()
        original.assert_called_once();direct.assert_not_called()
        self.assertEqual(original.call_args.kwargs['seat'],'codex')
        self.assertEqual(StudioMessage.objects.get().messages[0]['speech'],'覚えてる。')
        self.assertEqual(StudioDay.objects.get().codex_calls,0,'actual original model steps reserve their own calls')
    def test_reply_chain_normalization_and_old_saved_outputs(self):
        data={'message':'old','tasks':[],'files':[],'messages':[{'type':'text','text':'实际这一句','speech':'この一言。','expression':'happy'}]}
        self.assertEqual(studio_providers.reply_json(json.dumps(data))['message'],'实际这一句')
        self.assertEqual(studio_providers.reply_json('{"message":"旧对话","tasks":[],"files":[]}')['message'],'旧对话')

    def test_images_are_real_attachments_and_remote_urls_are_not_fetched(self):
        body=self.request();raw=b'\x89PNG\r\n\x1a\nfixture';body['messages'][1]['content']=[{'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(raw).decode()}}]
        with patch.object(studio_providers,'codex',return_value=({'text':'{}'},'test',{})) as model:
            companion_codex.respond(body)
        self.assertEqual(model.call_args.kwargs['images'],[('.png',raw)])
        self.assertNotIn(base64.b64encode(raw).decode(),model.call_args.args[0])
        body['messages'][1]['content'][0]['image_url']['url']='http://127.0.0.1/private'
        with patch.object(studio_providers,'codex') as model,self.assertRaises(Problem): companion_codex.respond(body)
        model.assert_not_called()

    def test_exhausted_quota_blocks_original_background_steps_before_call(self):
        from django.utils import timezone
        StudioDay.objects.create(day=timezone.localdate(),codex_calls=12)
        with patch.object(studio_providers,'codex') as model,self.assertRaises(Problem):companion_codex.respond(self.request())
        model.assert_not_called();self.assertEqual(StudioDay.objects.get().codex_calls,12)
