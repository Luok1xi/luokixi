"""Behavioral regression checks use isolated data and never contact a paid model."""
import json
import sqlite3
import tempfile
from pathlib import Path
from contextlib import closing
from datetime import timedelta
from unittest import mock
from django.test import TestCase
from django.utils import timezone
from . import beikuang, beikuang_tools as tools, beikuang_memory as memory, beikuang_turns as turns
from .models import BeikuangMessage, ExternalCache, Job, Member, StudioDay


class DialogueTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = Member.objects.create_user('dialogue_owner', 'dialogue@example.test', 'Quartz-water-991', is_staff=True)
        cls.other = Member.objects.create_user('dialogue_other', 'dialogue2@example.test', 'Quartz-water-992', is_staff=True)

    def setUp(self):
        self.patches = [mock.patch.object(turns, 'SETTLE_SECONDS', 0),
                        mock.patch('hub.studio_config.config', return_value={'enabled': True, 'owner_id': self.owner.pk,
                            'codex_daily_calls': 12, 'codex_model': '', 'codex_executable': 'codex'}),
                        mock.patch('hub.studio_config.ready')]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def message(self, body, owner=None):
        msg = BeikuangMessage.objects.create(owner=owner or self.owner, role='owner', kind='chat', body=body,
                                             state='waiting', data={'allowModel': True})
        Job.objects.create(key=f'beikuang-chat:{msg.pk}', kind='beikuang-chat', payload={'message': str(msg.pk)}, due=timezone.now())
        return msg

    def answers(self):
        return BeikuangMessage.objects.filter(owner=self.owner, role='beikuang', kind='chat')

    def model(self, *values):
        return mock.patch('hub.project_summaries.call_model', side_effect=[(v, 'isolated-model', {}) for v in values])

    def test_burst_is_one_reply_and_preserves_all_original_messages(self):
        one = self.message('我刚才说的那套题')
        two = self.message('是六级，不是四级')
        with mock.patch.object(beikuang, 'write', return_value=('好，接着看六级。', 'test')) as writer:
            result = beikuang.reply(one.pk)
        self.assertEqual(result['coalesced'], 2)
        context = writer.call_args.args[1]
        self.assertIn(one.body, context['owner'])
        self.assertIn(two.body, context['owner'])
        self.assertEqual(self.answers().count(), 1)
        self.assertEqual(self.answers().get().data['replyToMessages'], [str(one.pk), str(two.pk)])
        self.assertEqual(BeikuangMessage.objects.filter(role='owner', state='answered').count(), 2)
        self.assertFalse(Job.objects.filter(state='queued').exists())
        with mock.patch.object(beikuang, 'write') as again:
            self.assertEqual(beikuang.reply(two.pk)['skipped'], 'answered')
        again.assert_not_called()

    def test_chat_history_does_not_include_notices_or_work_reports(self):
        BeikuangMessage.objects.create(owner=self.owner, role='beikuang', kind='chat', body='我们刚才聊六级。')
        BeikuangMessage.objects.create(owner=self.owner, role='beikuang', kind='report', body='私有日报不当日常台词')
        BeikuangMessage.objects.create(owner=self.owner, role='beikuang', kind='escalation', body='审核确认通知')
        msg = self.message('接着说吧')
        with mock.patch.object(beikuang, 'write', return_value=('接着来。', 'test')) as writer, mock.patch.object(beikuang, 'today_stats') as stats:
            beikuang.reply(msg.pk)
        stats.assert_not_called()
        context = writer.call_args.args[1]
        self.assertEqual([m['text'] for m in context['recent']], ['我们刚才聊六级。'])
        self.assertTrue(context['frame']['alreadyMet'])
        self.assertIsNone(context['today'])

    def test_inflight_old_answer_is_not_sent_and_new_turn_keeps_both_inputs(self):
        msg = self.message('先说四级')
        newer = []
        def slow_response(*_):
            newer.append(self.message('改成六级，刚才说错了'))
            return '已经按四级说完了', 'test'
        with mock.patch.object(beikuang, 'write', side_effect=slow_response):
            self.assertTrue(beikuang.reply(msg.pk)['superseded'])
        self.assertFalse(self.answers().exists())
        msg.refresh_from_db()
        self.assertEqual(msg.state, 'waiting')
        with mock.patch.object(beikuang, 'write', return_value=('那就六级。', 'test')) as writer:
            beikuang.reply(newer[0].pk)
        self.assertIn('先说四级\n改成六级', writer.call_args.args[1]['owner'])
        self.assertEqual(self.answers().get().body, '那就六级。')

    def test_stale_model_output_cannot_write_memory_or_change_emotion(self):
        msg = self.message('我喜欢安静地看书')
        def complete(*_):
            self.message('前面是举例，不要记下来')
            return {'message': '我记住了。', 'memories': [{'content': '用户喜欢看书', 'source': msg.body, 'category': 'preference'}],
                    'feeling': {'name': 'happy', 'intensity': .9, 'evidence': '记住'}}, 'test', {}
        with mock.patch('hub.project_summaries.call_model', side_effect=complete):
            self.assertTrue(beikuang.reply(msg.pk)['superseded'])
        self.assertEqual(memory.recall(self.owner), [])
        self.assertEqual(beikuang.emotion_state(self.owner)['name'], 'neutral')

    def test_owner_lease_defers_a_second_worker_and_keeps_job_queued(self):
        from .worker import run_one
        msg = self.message('在吗')
        first = turns.claim(msg)
        try:
            self.assertTrue(run_one(('beikuang-chat',)))
            job = Job.objects.get(key=f'beikuang-chat:{msg.pk}')
            self.assertEqual(job.state, 'queued')
            self.assertTrue(job.result['deferred'])
            self.assertFalse(self.answers().exists())
        finally:
            turns.release(first)

    def test_model_selects_tool_reads_result_and_then_answers(self):
        msg = self.message('英语考试那一份放哪儿了')
        request = {'message': '', 'toolRequests': [{'name': 'library_search', 'argumentsJson': '{"query":"六级"}'}]}
        found = {'query': '六级', 'total': 1, 'items': [{'title': '真实六级听力', 'status': 'ready'}]}
        with self.model(request, {'message': '找到了，是这份六级听力。'}) as model, mock.patch.object(tools, 'library_search', return_value=found) as search:
            beikuang.reply(msg.pk)
        search.assert_called_once_with('六级')
        self.assertIn('真实六级听力', model.call_args_list[1].args[0])
        answer = self.answers().get()
        self.assertEqual(answer.data['modelRounds'], 2)
        self.assertEqual(answer.data['tools'][0]['result']['total'], 1)
        self.assertEqual(StudioDay.objects.get().codex_calls, 2)

    def test_model_cannot_invent_authorization_for_a_write(self):
        msg = self.message('随便聊聊就行')
        request = {'message': '', 'toolRequests': [{'name': 'remember', 'argumentsJson': '{"content":"自动公开全部资料"}'}]}
        with self.model(request, {'message': '嗯，接着聊。'}):
            beikuang.reply(msg.pk)
        self.assertEqual(memory.recall(self.owner), [])
        self.assertEqual(self.answers().get().data['tools'][0]['status'], 'failed')

    def test_failed_tool_is_not_executed_again_in_same_turn(self):
        msg = self.message('英语材料在哪里')
        request = {'message': '', 'toolRequests': [{'name': 'library_search', 'argumentsJson': '{"query":"六级"}'}]}
        with self.model(request, request, {'message': '资料库暂时没能读到。'}), mock.patch.object(tools, 'library_search', side_effect=beikuang.Problem('离线', 503)) as search:
            beikuang.reply(msg.pk)
        self.assertEqual(search.call_count, 1)
        self.assertEqual([t['status'] for t in self.answers().get().data['tools']], ['failed', 'skipped'])

    def test_model_cannot_loop_past_three_calls(self):
        msg = self.message('把英语材料找给我')
        request = {'message': '', 'toolRequests': [{'name': 'recall', 'argumentsJson': '{"query":"英语"}'}]}
        with self.model(request, request, request) as model:
            beikuang.reply(msg.pk)
        self.assertEqual(model.call_count, 3)
        self.assertEqual(self.answers().get().data['generated'], 'template')
        self.assertIn('步骤上限', self.answers().get().data['fallback'])

    def test_ordinary_chat_needs_only_one_call_even_when_learning(self):
        msg = self.message('我习惯晚上复习六级')
        value = {'message': '那晚上留一段安静时间给它。', 'memories': [
            {'content': '用户习惯晚上复习六级', 'source': msg.body, 'category': 'preference'}]}
        with self.model(value) as model:
            beikuang.reply(msg.pk)
        self.assertEqual(model.call_count, 1)
        saved = memory.recall(self.owner, '六级复习习惯')
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]['source'], msg.body)
        self.assertFalse(saved[0]['confirmed'])
        self.assertEqual(self.answers().get().data['learning']['memories'], 1)
        self.assertEqual(memory.recall(self.other), [])

    def test_memory_cannot_be_invented_from_assistant_or_tool_text(self):
        msg = self.message('今天聊点什么')
        value = {'message': '聊聊书吧。', 'memories': [
            {'content': '用户住在北京', 'source': '用户住在北京', 'category': 'profile'}]}
        with self.model(value):
            beikuang.reply(msg.pk)
        self.assertEqual(memory.recall(self.owner), [])

    def test_hypothetical_profile_is_not_automatically_saved(self):
        msg = self.message('假如我喜欢喝咖啡，你会怎么回答')
        with self.model({'message': '先看你想聊哪一种。', 'memories': [
                {'content': '用户喜欢咖啡', 'source': '我喜欢喝咖啡', 'category': 'preference'}]}):
            beikuang.reply(msg.pk)
        self.assertEqual(memory.recall(self.owner), [])

    def test_duplicate_source_is_not_saved_as_multiple_paraphrases(self):
        msg = self.message('我习惯晚上复习六级')
        outcome = {'memories': [{'content': '晚上复习六级', 'source': msg.body, 'category': 'preference'},
                                {'content': '六级学习安排在夜间', 'source': msg.body, 'category': 'preference'}]}
        self.assertEqual(memory.learn(self.owner, [msg], outcome)['memories'], 1)
        self.assertEqual(memory.learn(self.owner, [msg], outcome)['memories'], 0)

    def test_forgetting_by_original_quote_removes_the_automatic_summary(self):
        msg = self.message('我习惯晚上复习六级')
        memory.learn(self.owner, [msg], {'memories': [{'content': '晚上复习六级', 'source': msg.body, 'category': 'preference'}]})
        self.assertTrue(memory.forget(self.owner, msg.body))
        self.assertEqual(memory.recall(self.owner), [])
        newer = self.message(msg.body)
        memory.learn(self.owner, [newer], {'memories': [{'content': '晚上复习六级', 'source': msg.body, 'category': 'preference'}]})
        self.assertEqual(memory.recall(self.owner), [])

    def test_style_feedback_is_persisted_and_used_by_the_next_turn(self):
        msg = self.message('以后回复简短一点，别每次反问我')
        with self.model({'message': '嗯，刚才那句确实绕了。', 'styleLearning': {'evidence': msg.body},
                         'appraisal': {'event': 'correction', 'evidence': msg.body, 'confidence': .9}}):
            beikuang.reply(msg.pk)
        next_msg = self.message('接着聊')
        with mock.patch.object(beikuang, 'write', return_value=('好。', 'test')) as writer:
            beikuang.reply(next_msg.pk)
        frame = writer.call_args.args[1]['frame']
        self.assertEqual(frame['preferences'][0]['source'], msg.body)
        self.assertEqual(frame['recentEvents'][0]['event'], 'correction')
        self.assertEqual(beikuang.emotion_state(self.owner)['name'], 'think')

    def test_normal_style_correction_is_not_recorded_as_a_conflict(self):
        msg = self.message('你的语气有点客服了，请自然一点')
        result = memory.learn(self.owner, [msg], {'appraisal': {'event': 'conflict', 'evidence': msg.body, 'confidence': .99}})
        self.assertEqual(result['events'], 0)
        self.assertEqual(beikuang.emotion_state(self.owner)['name'], 'neutral')

    def test_emotional_event_has_a_cause_and_private_decay(self):
        msg = self.message('你今天这件事做得很好')
        memory.learn(self.owner, [msg], {'appraisal': {'event': 'praise', 'evidence': msg.body, 'confidence': .9}})
        mood = beikuang.emotion_state(self.owner)
        self.assertEqual(mood['name'], 'happy')
        self.assertEqual(mood['cause']['source'], msg.body)
        ExternalCache.objects.filter(pk=f'beikuang:feeling:{self.owner.pk}').update(checked=timezone.now() - timedelta(hours=2))
        self.assertAlmostEqual(beikuang.emotion_state(self.owner)['intensity'], .225, places=2)
        self.assertEqual(beikuang.emotion_state(self.other)['name'], 'neutral')

    def test_chinese_recall_finds_partial_phrases_and_aliases_with_one_query(self):
        msg = self.message('记住：我喜欢简洁的回复')
        tools.execute(self.owner, 'remember', {'content': '我喜欢简洁的回复'}, msg)
        with self.assertNumQueries(1):
            recalled = memory.recall(self.owner, '我之前说过回答要简短吗')
        self.assertEqual(len(recalled), 1)
        self.assertEqual(memory.recall(self.owner, '火山岩石的成分'), [])

    def test_committed_write_tool_is_not_replayed_when_old_reply_is_superseded(self):
        msg = self.message('重新审核一遍')
        newer = []
        def slow(*_):
            newer.append(self.message('做完告诉我就好'))
            return '好的。', 'test'
        with mock.patch.object(beikuang, 'write', side_effect=slow), mock.patch.object(beikuang, 'queue_review') as queue:
            beikuang.reply(msg.pk)
            with mock.patch.object(beikuang, 'write', return_value=('已经排队。', 'test')):
                beikuang.reply(newer[0].pk)
        self.assertEqual(queue.call_count, 1)

    def test_malformed_model_arguments_fail_without_breaking_reply(self):
        msg = self.message('可以聊天吗')
        request = {'message': '', 'toolRequests': [{'name': 'remember', 'argumentsJson': '{"content":[]}'}]}
        with self.model(request, {'message': '嗯。'}):
            beikuang.reply(msg.pk)
        self.assertEqual(self.answers().get().data['tools'][0]['status'], 'failed')

    def test_global_budget_applies_to_every_tool_round(self):
        msg = self.message('英语资料在哪儿')
        request = {'message': '', 'toolRequests': [{'name': 'recall', 'argumentsJson': '{}'}]}
        with mock.patch('hub.studio_config.config', return_value={'enabled': True, 'owner_id': self.owner.pk, 'codex_daily_calls': 1}), self.model(request) as model:
            beikuang.reply(msg.pk)
        self.assertEqual(model.call_count, 1)
        self.assertEqual(StudioDay.objects.get().codex_calls, 1)
        self.assertEqual(self.answers().get().data['generated'], 'template')

    def test_cancelled_owner_permission_cannot_use_the_model(self):
        msg = self.message('在吗')
        with mock.patch('hub.studio_config.config', return_value={'enabled': True, 'owner_id': self.other.pk}), self.model({'message': '不能发送'}) as model:
            beikuang.reply(msg.pk)
        model.assert_not_called()
        self.assertEqual(self.answers().get().data['generated'], 'template')

    def test_same_timestamp_input_still_invalidates_an_inflight_turn(self):
        msg = self.message('先看四级')
        turn = turns.claim(msg)
        try:
            newer = self.message('改为六级')
            BeikuangMessage.objects.filter(pk=newer.pk).update(created=turn['cutoff'])
            self.assertFalse(turns.current(turn))
        finally:
            turns.release(turn)

    def test_library_read_uses_indexed_text_and_handles_scan_without_ocr(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'library.sqlite3'
            with closing(sqlite3.connect(path)) as db:
                db.execute('CREATE TABLE documents(id TEXT,title TEXT,course TEXT,kind TEXT,status TEXT,source_url TEXT,extract_status TEXT,body TEXT)')
                db.execute('CREATE TABLE chunks(docid TEXT,page INTEGER,text TEXT)')
                db.execute('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?)', ('d1','六级听力','英语','听力','ready','https://example.test/source','ready',''))
                db.execute('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?)', ('d2','扫描试卷','英语','试卷','pending','','needs-ocr',''))
                db.execute('INSERT INTO chunks VALUES (?,?,?)', ('d1',1,'原始听力文本'))
                db.commit()
            with mock.patch.object(tools, 'library_path', return_value=path):
                found = tools.library_read('d1')
                self.assertEqual(found['pages'][0]['text'], '原始听力文本')
                self.assertTrue(found['hasText'])
                self.assertFalse(tools.library_read('d2')['hasText'])
                with self.assertRaises(beikuang.Problem):
                    tools.library_read('../private')

    def test_model_can_search_then_read_the_document_before_answering(self):
        msg = self.message('英语那份能给我讲讲内容吗')
        search = {'message': '', 'toolRequests': [{'name':'library_search','argumentsJson':'{"query":"六级"}'}]}
        read = {'message': '', 'toolRequests': [{'name':'library_read','argumentsJson':'{"document_id":"d1"}'}]}
        with self.model(search, read, {'message':'这份包含听力原文。'}) as model, \
                mock.patch.object(tools, 'library_search', return_value={'total':1,'items':[{'id':'d1','title':'六级听力'}]}), \
                mock.patch.object(tools, 'library_read', return_value={'id':'d1','hasText':True,'pages':[{'page':1,'text':'原始听力文本'}]}) as reader:
            beikuang.reply(msg.pk)
        reader.assert_called_once_with('d1')
        self.assertIn('原始听力文本', model.call_args_list[2].args[0])
        self.assertEqual(self.answers().get().data['modelRounds'], 3)

    def test_malformed_learning_and_tool_name_do_not_prevent_a_reply(self):
        msg = self.message('我今天在复习英语')
        request = {'message': '', 'toolRequests': [{'name': ['recall'], 'argumentsJson': '{}'}]}
        answer = {'message': '嗯，接着说。', 'appraisal': {'event': [], 'confidence': .9, 'evidence': msg.body}}
        with self.model(request, answer):
            beikuang.reply(msg.pk)
        self.assertEqual(self.answers().get().body, '嗯，接着说。')
        self.assertEqual(beikuang.emotion_state(self.owner)['name'], 'neutral')

    def test_forget_turn_does_not_relearn_its_quoted_preference(self):
        msg = self.message('以后回复简短一点')
        memory.learn(self.owner, [msg], {'styleLearning': {'evidence': msg.body}, 'memories': [
            {'content': '用户希望简短回复', 'source': msg.body, 'category': 'preference'}]})
        self.assertTrue(memory.forget(self.owner, msg.body))
        forget = self.message('忘记：' + msg.body)
        memory.learn(self.owner, [forget], {'styleLearning': {'evidence': msg.body}, 'memories': [
            {'content': '用户偏好短回复', 'source': msg.body, 'category': 'preference'}]})
        self.assertEqual(memory.recall(self.owner), [])
        self.assertEqual(memory.conversation_state(self.owner)['styleRules'], [])

    def test_work_report_does_not_overwrite_the_ongoing_emotional_event(self):
        msg = self.message('你今天这件事做得很好')
        memory.learn(self.owner, [msg], {'appraisal': {'event':'praise','evidence':msg.body,'confidence':.9}})
        with self.model({'message':'今天有一项待处理。','feeling':{'name':'sad','intensity':1,'evidence':'待处理'}}):
            beikuang.write('daily-report', {'ownerId':self.owner.pk}, 'isolated-daily')
        self.assertEqual(beikuang.emotion_state(self.owner)['name'], 'happy')
        self.assertEqual(beikuang.emotion_state(self.owner)['cause']['source'], msg.body)

    def test_codex_transport_receives_the_turn_cancellation_check(self):
        from .project_summaries import call_model
        stop = lambda: True
        with mock.patch('hub.studio_providers.codex', return_value=({'message':'test'}, 'test', {})) as codex:
            call_model('test', {'summary_provider':'codex','summary_stopped':stop}, {'type':'object'})
        self.assertIs(codex.call_args.kwargs['stopped'], stop)

    def test_codex_process_obeys_the_chat_deadline(self):
        from .studio_providers import codex
        process = mock.Mock()
        process.poll.side_effect = [None, 0]
        with mock.patch('hub.studio_providers.subprocess.Popen', return_value=process), \
                mock.patch('hub.studio_providers.time.monotonic', side_effect=[0, 2]):
            with self.assertRaises(beikuang.Problem):
                codex('test', {'codex_executable':'codex','codex_model':'','summary_timeout':1}, output_schema={'type':'object'})
        process.kill.assert_called_once()

    def test_codex_process_is_stopped_when_followup_arrives(self):
        from .studio_providers import codex
        process = mock.Mock()
        process.poll.side_effect = [None, 0]
        with mock.patch('hub.studio_providers.subprocess.Popen', return_value=process):
            with self.assertRaises(beikuang.Problem):
                codex('test', {'codex_executable':'codex','codex_model':'','summary_timeout':25},
                      stopped=mock.Mock(side_effect=[False, True]), output_schema={'type':'object'})
        process.kill.assert_called_once()
