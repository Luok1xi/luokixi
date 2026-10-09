import json
import uuid
from decimal import Decimal
from unittest.mock import patch
from django.test import Client
from django.utils import timezone
from .test_studio import StudioTests as _StudioTests
from django.test import TestCase
from .models import StudioDay, StudioRoom, StudioRun, Job
from .studio_config import config
from .companion_team import dispatch, observation


class CompanionControlsTests(TestCase):
    setUpTestData = classmethod(_StudioTests.setUpTestData.__func__)
    setUp = _StudioTests.setUp
    post = _StudioTests.post
    def test_studio_defaults_to_owners_joint_room_and_retains_private_history(self):
        shared=StudioRoom.objects.create(owner=self.owner,title='共同工作')
        StudioRun.objects.create(room=shared,request_key='joint',mode='discuss',seats=['codex','beikuang'])
        private=StudioRoom.objects.create(owner=self.owner,title='私人对话')
        StudioRun.objects.create(room=private,request_key='private',mode='chat',seats=['codex','beikuang'])
        foreign=StudioRoom.objects.create(owner=self.other,title='其他用户')
        StudioRun.objects.create(room=foreign,request_key='foreign',mode='discuss',seats=['codex','beikuang'])
        result=self.client.get('/api/hub/studio/rooms').json()
        self.assertEqual(result['preferredRoom'],str(shared.pk))
        self.assertEqual({r['id'] for r in result['items']},{str(shared.pk),str(private.pk)})

    def test_budget_changes_ceiling_without_resetting_usage_or_exposing_secrets(self):
        StudioDay.objects.create(day=timezone.localdate(), reserved_cny=Decimal('4.98'), codex_calls=12)
        result = self.post('budget', {'dailyCny': '8.50', 'codexDailyCalls': 24})
        self.assertEqual(Decimal(result['remainingCny']), Decimal('3.52'))
        self.assertEqual(result['codexRemaining'], 12)
        self.assertEqual(config()['daily_cny'], Decimal('8.50'))
        self.assertNotIn('test-placeholder', json.dumps(result))
        self.post('budget', {'dailyCny': '2', 'codexDailyCalls': 6})
        self.assertEqual(StudioDay.objects.get().codex_calls, 12)

    def test_budget_rejects_non_owner_nan_and_configuration_injection(self):
        for amount in ['NaN', 'Infinity', '0', '100.01', '1.001']:
            self.post('budget', {'dailyCny': amount, 'codexDailyCalls': 12}, 400)
        self.post('budget', {'dailyCny': '5', 'codexDailyCalls': True}, 400)
        self.post('budget', {'dailyCny': '5', 'codexDailyCalls': 12, 'enabled': True}, 400)
        c = Client(); c.force_login(self.other)
        self.post('budget', {'dailyCny': '6', 'codexDailyCalls': 20}, 403, c)
        self.assertEqual(config()['daily_cny'], Decimal('5'))

    def test_autonomous_discussion_uses_existing_studio_and_is_idempotent(self):
        body = {'id': str(uuid.uuid4()), 'action': 'discuss', 'goal': '分析资料审核积压', 'reason': '有待办需要共同排查'}
        result = dispatch(self.owner, body, {'queued': 305})
        self.assertEqual(dispatch(self.owner, body, {'queued': 305})['key'], result['key'])
        run = StudioRun.objects.get()
        self.assertEqual(run.mode, 'discuss')
        self.assertEqual(run.seats, ['codex', 'beikuang'])
        self.assertEqual(run.messages.count(), 0, 'dispatch does not fabricate a conversation')
        self.assertNotIn('discuss', observation({'queued': 305})['actions'])

    def test_low_budget_defers_discussion_but_exposes_read_only_inspection(self):
        StudioDay.objects.create(day=timezone.localdate(), reserved_cny=Decimal('4.98'))
        result = observation({'queued': 300})
        self.assertNotIn('discuss', result['actions'])
        self.assertIn('inspect_site', result['actions'])
        body = {'id': str(uuid.uuid4()), 'action': 'inspect_site', 'goal': '检查网页', 'reason': '检查图片'}
        dispatch(self.owner, body, {'queued': 300})
        self.assertEqual(Job.objects.get().kind, 'site-browser-audit')
        self.assertNotIn('inspect_site', observation({'queued': 300})['actions'])

    def test_voice_rejects_invalid_seat_and_preserves_expression(self):
        self.post('voice', {'text': '你好', 'seat': 'external', 'expression': 'neutral'}, 400)
        with patch('hub.companion_bridge.call', return_value={'audio': 'UklGRg==', 'type': 'audio/wav'}) as call:
            self.post('voice', {'text': '你好', 'seat': 'beikuang', 'expression': 'happy'})
            self.assertEqual(call.call_args.args[1]['expression'], 'happy')
            self.assertEqual(call.call_args.args[1]['seat'], 'beikuang')

    def test_same_codex_remembers_private_chat_in_studio_and_joint_work_back_in_chat(self):
        from .studio_worker import prompt_for
        from .companion_continuity import seat_context
        from .models import StudioMessage
        personal = StudioRoom.objects.create(owner=self.owner, title='Codex 单聊')
        first = StudioRun.objects.create(room=personal, request_key='first-memory', mode='chat', seats=['codex'], state='done', prompt='分类约定：按大学、学科和要紧程度整理。')
        StudioMessage.objects.create(run=first, sequence=0, seat='codex', provider='codex', body='我记下这个分类约定。')
        shared = StudioRoom.objects.create(owner=self.owner, title='共同工作')
        work = StudioRun.objects.create(room=shared, request_key='work-memory', mode='discuss', seats=['codex','beikuang'], state='done', prompt='继续分类约定')
        StudioMessage.objects.create(run=work, sequence=0, seat='beikuang', provider='deepseek', body='按这套约定整理，尚未上架。')
        self.assertIn('大学、学科和要紧程度', prompt_for(work, 'codex', [], [], False))
        self.assertIn('尚未上架', prompt_for(first, 'codex', [], [], False))
        context = seat_context(self.owner, 'beikuang', '分类')
        self.assertEqual([r['id'] for r in context['conversations']], [str(work.pk)])
        self.assertFalse(seat_context(self.other, 'codex')['available'])
        foreign = StudioRoom.objects.create(owner=self.other, title='另一人私聊')
        StudioRun.objects.create(room=foreign, request_key='secret', mode='chat', seats=['codex'], state='done', prompt='不可泄漏的私聊')
        self.assertNotIn('不可泄漏', json.dumps(seat_context(self.owner, 'codex'),ensure_ascii=False))

    def test_successful_usage_releases_unused_reservation_once_and_failure_keeps_it(self):
        from .companion_bridge import reserve, settle
        ident=str(uuid.uuid4())
        reserve({'id':ident,'inputUnits':30000,'outputTokens':3000})
        before=StudioDay.objects.get().reserved_cny
        body={'id':ident,'usage':{'prompt_tokens':1000,'completion_tokens':100}}
        settle(body);after=StudioDay.objects.get().reserved_cny
        self.assertLess(after,before)
        settle(body);self.assertEqual(StudioDay.objects.get().reserved_cny,after)
        ident=str(uuid.uuid4());reserve({'id':ident,'inputUnits':30000,'outputTokens':3000})
        before=StudioDay.objects.get().reserved_cny
        settle({'id':ident,'failed':True});self.assertEqual(StudioDay.objects.get().reserved_cny,before)



del _StudioTests
