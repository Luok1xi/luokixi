import json
from datetime import timedelta
from unittest.mock import patch
from django.test import Client, TestCase
from django.utils import timezone
from . import operations
from .models import Audit, ExternalCache, Job, Member, Notification


class OperationsTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = Member.objects.create_user('ops_owner', 'ops-owner@example.test', 'Quartz-ops-water-331', is_staff=True, email_verified=True)
        cls.member = Member.objects.create_user('ops_user', 'ops-user@example.test', 'Quartz-ops-water-332', email_verified=True)

    def setUp(self):
        self.now = timezone.now()
        self.client.force_login(self.owner)

    def observation(self, ok=False):
        return {'worker': {'ok': ok, 'text': '测试处理器故障'}}

    def post(self, route, data):
        return self.client.post('/api/hub/operations/'+route, json.dumps(data), content_type='application/json')

    def test_two_failures_one_notice_then_one_recovery(self):
        operations.poll_once(self.now, self.observation())
        self.assertFalse(Notification.objects.filter(event='operations').exists())
        operations.poll_once(self.now+timedelta(seconds=30), self.observation())
        operations.poll_once(self.now+timedelta(seconds=60), self.observation())
        self.assertEqual(Notification.objects.filter(event='operations').count(), 1)
        operations.poll_once(self.now+timedelta(seconds=90), self.observation(True))
        operations.poll_once(self.now+timedelta(seconds=120), self.observation(True))
        self.assertEqual(Notification.objects.filter(event='operations').count(), 2)
        self.assertFalse(operations.alert_status()['incidents'][0]['open'])

    def test_failed_delivery_is_durable_and_recovery_waits(self):
        operations.poll_once(self.now, self.observation())
        with patch.object(operations, '_deliver', side_effect=RuntimeError('offline')):
            operations.poll_once(self.now+timedelta(seconds=30), self.observation())
        self.assertEqual(operations.alert_status()['pendingDelivery'], 1)
        # A new invocation reads the stored outbox, rather than relying on process memory.
        operations.poll_once(self.now+timedelta(seconds=31), self.observation(True))
        self.assertFalse(Notification.objects.filter(event='operations').exists())
        self.assertEqual(operations.alert_status()['pendingDelivery'], 2)
        operations.flush_alerts(self.now+timedelta(seconds=90))
        notes = list(Notification.objects.filter(event='operations').order_by('pk'))
        self.assertEqual(len(notes), 2)
        self.assertIn('提醒', notes[0].text)
        self.assertIn('恢复', notes[1].text)
        self.assertEqual(operations.alert_status()['pendingDelivery'], 0)

    def test_no_human_admin_keeps_pending_until_one_exists(self):
        self.owner.set_unusable_password()
        self.owner.save(update_fields=['password'])
        operations.poll_once(self.now, self.observation())
        operations.poll_once(self.now+timedelta(seconds=30), self.observation())
        self.assertEqual(operations.alert_status()['pendingDelivery'], 1)
        self.owner.set_password('Quartz-ops-water-331')
        self.owner.save(update_fields=['password'])
        operations.flush_alerts(self.now+timedelta(minutes=2))
        self.assertEqual(Notification.objects.filter(event='operations').count(), 1)

    def test_disabled_worker_does_not_report_fault_and_stale_worker_does(self):
        operations.worker_mode(False)
        self.assertTrue(operations.diagnostics(self.now)['checks']['worker']['ok'])
        ExternalCache.objects.filter(pk=operations.WORKER_KEY).update(data={'enabled': True, 'heartbeat': (self.now-timedelta(minutes=20)).isoformat()})
        self.assertFalse(operations.diagnostics(self.now)['checks']['worker']['ok'])

    def test_review_worker_does_not_report_intentionally_paused_crawlers(self):
        Job.objects.create(kind='maint-summaries', key='paused-crawler', state='queued', due=self.now-timedelta(hours=1))
        operations.heartbeat(('site-backup', 'site-backup-check'))
        self.assertTrue(operations.diagnostics(self.now)['checks']['queue-delay']['ok'])

    def test_enabled_worker_that_never_heartbeats_eventually_reports_fault(self):
        operations.worker_mode(True)
        self.assertEqual(operations.diagnostics(self.now)['worker']['state'], 'waiting')
        self.assertEqual(operations.diagnostics(self.now+timedelta(minutes=16))['worker']['state'], 'stale')

    def test_backup_worker_dispatches_and_completes(self):
        from .worker import run_one
        job = Job.objects.create(kind='site-backup', key='fixture-backup', state='queued', due=self.now)
        with patch('hub.backup.create_backup', return_value={'id': 'fixture.zip'}):
            self.assertTrue(run_one(('site-backup', 'site-backup-check')))
        job.refresh_from_db()
        self.assertEqual(job.state, 'done')
        self.assertEqual(job.result['id'], 'fixture.zip')

    def test_private_operations_and_audited_acknowledgement(self):
        self.client.logout()
        self.assertEqual(self.client.get('/api/hub/operations/status').status_code, 401)
        self.client.force_login(self.member)
        self.assertEqual(self.client.get('/api/hub/operations/status').status_code, 403)
        self.assertEqual(self.post('backup', {}).status_code, 403)
        self.client.force_login(self.owner)
        operations.poll_once(self.now, self.observation())
        incident = operations.poll_once(self.now+timedelta(seconds=30), self.observation())['incidents'][0]['incident']
        with patch.object(operations, 'status', return_value={'ok': True}):
            self.assertEqual(self.post('acknowledge', {'incident': incident}).status_code, 200)
        self.assertTrue(operations.alert_status()['incidents'][0]['acknowledged'])
        self.assertTrue(Audit.objects.filter(actor=self.owner, action='operations-acknowledge').exists())

    def test_backup_request_retries_are_idempotent(self):
        token = 'same-request'
        a = self.post('backup', {'requestId': token}).json()
        Job.objects.filter(pk=a['id']).update(state='done')
        b = self.post('backup', {'requestId': token}).json()
        self.assertEqual(a['id'], b['id'])
        self.assertEqual(Job.objects.filter(kind='site-backup').count(), 1)

    def test_another_active_backup_task_cannot_be_mistaken_for_requested_check(self):
        running = Job.objects.create(kind='site-backup', key='other-backup', state='running', due=self.now)
        with patch('hub.backup.get_backup_path'):
            response = self.post('backup-check', {'id': 'fixture.zip', 'requestId': 'new-check'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(Job.objects.count(), 1)
        running.refresh_from_db()
        self.assertEqual(running.state, 'running')

    def test_reading_status_does_not_start_jobs_or_alerts(self):
        with patch('hub.backup.status', return_value={'items': []}):
            self.assertEqual(self.client.get('/api/hub/operations/status').status_code, 200)
        self.assertEqual(Job.objects.count(), 0)
        self.assertEqual(Notification.objects.count(), 0)

    @patch('hub.backup.list_backups', return_value=[])
    def test_daily_backup_schedule_is_bounded_and_can_be_disabled(self, _backups):
        with patch.dict('os.environ', {'HUB_BACKUP_AUTO': '0'}):
            operations.schedule_backup(self.now)
        self.assertEqual(Job.objects.count(), 0)
        with patch.dict('os.environ', {'HUB_BACKUP_AUTO': '1'}):
            operations.schedule_backup(self.now)
            operations.schedule_backup(self.now)
        self.assertEqual(Job.objects.filter(kind='site-backup').count(), 1)
