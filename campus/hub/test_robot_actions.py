import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from django.test import TestCase, override_settings
from django.utils import timezone
from .core import Problem
from .models import Audit, Entry, ExternalCache, Job, Member, StudioDay
from . import robot_actions as actions, robot_workbench as code
from .robot_inventory import snapshot, record_run
from .studio_workspace import digest


class RobotActionsTests(TestCase):
    def setUp(self):
        self.owner = Member.objects.create_user('robot-owner', 'owner@robots.test', 'private-test-only', is_staff=True, email_verified=True)
        self.policy = patch('hub.robot_actions.policy', return_value={'enabled': True})
        self.policy.start(); self.addCleanup(self.policy.stop)

    def call(self, operation, args, ident=None, seat='beikuang'):
        return actions.execute(self.owner, seat, operation, args, ident or str(uuid.uuid4()))

    def test_queue_idempotency_and_actor(self):
        ident = str(uuid.uuid4())
        first = self.call('run_robot', {'kind': 'maint-links', 'reason': '检查故障'}, ident, 'codex')
        second = self.call('run_robot', {'kind': 'maint-links', 'reason': '检查故障'}, ident, 'codex')
        self.assertEqual(first['id'], second['id']); self.assertTrue(second['duplicate'])
        self.assertEqual(Job.objects.get().payload['actorSeat'], 'codex')
        self.assertEqual(Audit.objects.filter(action='robot.action').count(), 1)
        with self.assertRaises(Problem): self.call('run_robot', {'kind': 'maint-news', 'reason': '不同操作'}, ident)

    def test_pause_blocks_writes_but_not_inventory(self):
        with patch('hub.robot_actions.policy', return_value={'enabled': False}):
            with self.assertRaises(Problem): self.call('run_robot', {'kind': 'maint-links', 'reason': '检查'})
            self.assertIn('robots', self.call('inventory', {}))

    def test_job_status_reads_actual_completion_separately_from_dispatch(self):
        action = self.call('run_robot', {'kind':'pipeline-illustrations','reason':'核对配图'})
        self.assertFalse(self.call('job_status', {'id':action['id']})['completed'])
        Job.objects.filter(pk=action['id']).update(state='done', result={'illustrated':1,'preserved':8})
        result = self.call('job_status', {'id':action['id']}, seat='codex')
        self.assertTrue(result['completed']); self.assertTrue(result['terminal'])
        self.assertEqual(result['result']['preserved'], 8)

    def test_withdraw_restore_preserves_original_and_checks_state(self):
        entry = Entry.objects.create(kind='news', slug='preserve', state='published', published={'title': 'original'}, draft={'title': 'original'})
        args = {'id': str(entry.pk), 'revision': 1, 'state': 'published', 'reason': '来源失效暂时下架'}
        self.call('withdraw_content', args)
        entry.refresh_from_db(); self.assertEqual(entry.state, 'withdrawn'); self.assertEqual(entry.published['title'], 'original')
        with self.assertRaises(Problem): self.call('restore_content', args)
        self.call('restore_content', dict(args, state='withdrawn', reason='原来源恢复'))
        entry.refresh_from_db(); self.assertEqual(entry.state, 'published')

    def test_actor_collision_not_elevated(self):
        impostor = Member.objects.create_user('Codex', 'human@example.test', 'unrelated-human-password')
        with self.assertRaises(Problem): actions.actor('codex')
        impostor.refresh_from_db(); self.assertFalse(impostor.is_staff)

    def test_historical_duration_is_unknown_and_search_total_not_counted(self):
        job = Job.objects.create(kind='maint-github', state='done', key='sample', due=timezone.now(), result={
            'created': ['one'], 'inspected': 2, 'queries': [{'total_count': 999999}]})
        item = next(r for r in snapshot()['robots'] if r['id'] == 'maint-github')
        self.assertIsNone(item['meanDurationMs']); self.assertEqual(item['counts']['collected'], 1)
        record_run(job, timezone.now(), 6000)
        item = next(r for r in snapshot()['robots'] if r['id'] == 'maint-github')
        self.assertEqual(item['examinedPerMinute'], 20)
        self.assertEqual(item['meanDurationMs'], 6000)

    def test_code_cannot_read_credentials_or_controls(self):
        for path in ('campus/.data/hub/studio-config.json', 'campus/hub/robot_actions.py', '../config.json'):
            with self.assertRaises(Problem): code.read([path])

    def test_apply_requires_functional_tests_and_conflict_free_source(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root/'campus/hub').mkdir(parents=True)
            path = root/'campus/hub/github_crawler.py'; path.write_text('value = 1\n', encoding='utf-8')
            with override_settings(DATA=root/'data'), patch('hub.studio_workspace.source_root', return_value=root), patch('hub.robot_workbench.source_root', return_value=root):
                candidate = code.candidate([{'path': 'campus/hub/github_crawler.py', 'content': 'value = 2\n', 'beforeHash': digest('value = 1\n')}])
                with self.assertRaises(Problem): code.apply(candidate['id'])
                row = code.get(candidate['id']); row.data['tests'] = {'state': 'passed'}; row.save()
                path.write_text('value = 3\n', encoding='utf-8')
                with self.assertRaises(Problem): code.apply(candidate['id'])
                self.assertEqual(path.read_text(), 'value = 3\n')
                path.write_text('value = 1\n', encoding='utf-8')
                code.apply(candidate['id']); self.assertEqual(path.read_text(), 'value = 2\n')
                code.rollback(candidate['id']); self.assertEqual(path.read_text(), 'value = 1\n')

    def test_unlimited_counts_still_record_every_call(self):
        from .companion_codex import reserve
        from .studio_budget import view
        cfg = {'codex_daily_calls': 1, 'codex_unlimited': True, 'daily_cny': __import__('decimal').Decimal('5')}
        reserve(str(uuid.uuid4()), cfg, 'test'); reserve(str(uuid.uuid4()), cfg, 'test')
        self.assertEqual(StudioDay.objects.get().codex_calls, 2)
        self.assertIsNone(view(cfg)['codexRemaining'])

    def test_skill_immutable_revision_is_required(self):
        from .robot_skills import fetch
        for commit in ('main', 'HEAD', 'abc123'):
            with self.assertRaises(Problem): fetch('owner/repo', commit, 'SKILL.md')
