import json
from django.test import Client, TestCase
from django.utils import timezone
from .github_guides import cache_key
from .models import Audit, Entry, ExternalCache, Member, Notification, Revision
from .test_github_crawler import details


class ActionableNotificationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.staff = Member.objects.create_user('notice_staff', 'notice-staff@example.test', is_staff=True, email_verified=True)
        cls.reader = Member.objects.create_user('notice_reader', 'notice-reader@example.test', email_verified=True)
        data = details('notice/robot')
        data['discovery'] = {'reason': 'Robot assembly reference', 'category': 'mech'}
        ExternalCache.objects.create(pk=cache_key('notice/robot'), data=data, success=timezone.now())
        cls.projects = Notification.objects.create(user=cls.staff, event='maintenance', key='github-candidates:20261001:1', text='发现 1 个候选项目')
        cls.news_notice = Notification.objects.create(user=cls.staff, event='maintenance', key='maint-news:legacy-batch:1', text='发现 2 条新闻')
        cls.news = []
        for i in range(2):
            data = {'title': f'通知审核测试新闻 {i}', 'summary': '学校公开新闻索引', 'body': '',
                    'links': {'source': f'https://news8.cumtb.edu.cn/info/1003/1000{i}.htm'}, 'tags': ['学校新闻']}
            entry = Entry.objects.create(kind='news', slug=f'news-notification-test-{i}', state='pending', draft=data)
            Revision.objects.create(entry=entry, number=1, data=data, state='pending')
            cls.news.append(entry)

    def setUp(self):
        self.client.force_login(self.staff)

    def post(self, path, data, expected=200, client=None):
        response = (client or self.client).post('/api/hub/' + path, json.dumps(data), content_type='application/json')
        self.assertEqual(response.status_code, expected, response.content)
        return response.json()

    def actions(self):
        response = self.client.get('/api/hub/notifications')
        self.assertEqual(response.status_code, 200)
        return {n['id']: n['action'] for n in response.json()['items']}

    def test_legacy_notices_resolve_current_queues_without_network(self):
        actions = self.actions()
        self.assertEqual(actions[self.projects.pk], {'kind': 'review-github', 'label': '查看并审核项目', 'pending': 1})
        self.assertEqual(actions[self.news_notice.pk]['pending'], 2)
        self.assertEqual(actions[self.news_notice.pk]['kind'], 'review-news')
        self.assertFalse(Entry.objects.filter(state='published').exists())

    def test_marking_read_is_not_approval_and_is_scoped_to_recipient(self):
        other = Notification.objects.create(user=self.reader, key='private-other', event='review', text='private')
        self.post('notifications/read', {'ids': [self.projects.pk, self.news_notice.pk, other.pk]})
        self.assertEqual(Entry.objects.filter(state='pending').count(), 2)
        self.assertNotIn('selection', ExternalCache.objects.get(pk=cache_key('notice/robot')).data)
        self.assertFalse(Notification.objects.get(pk=other.pk).read)
        self.assertEqual(self.actions()[self.projects.pk]['pending'], 1)
        self.assertEqual(self.client.get('/api/hub/notifications').json()['unread'], 0)

    def test_news_approve_reject_and_stale_click_update_queue(self):
        body = {'revision': 1, 'decision': 'approve', 'note': '核对原文'}
        self.post(f'entries/{self.news[0].pk}/review', body)
        self.assertEqual(self.actions()[self.news_notice.pk]['pending'], 1)
        self.post(f'entries/{self.news[0].pk}/review', body, 409)
        self.post(f'entries/{self.news[1].pk}/review', dict(body, decision='reject'))
        self.assertEqual(self.actions()[self.news_notice.pk]['pending'], 0)
        self.assertEqual(Entry.objects.filter(state='published').count(), 1)
        self.assertEqual(Audit.objects.filter(action='review:approve').count(), 1)

    def test_project_approval_requires_checks_and_does_not_duplicate_publication(self):
        body = {'repository': 'notice/robot', 'shelf': 'practical', 'reason': '装配机器人参考资料'}
        self.post('github/curate', body, 400)
        self.assertEqual(self.actions()[self.projects.pk]['pending'], 1)
        body['checks'] = dict.fromkeys(('sourceRead', 'licenseChecked', 'downloadsChecked'), True)
        self.post('github/curate', body)
        self.post('github/curate', body)
        self.assertEqual(self.actions()[self.projects.pk]['pending'], 0)
        self.assertEqual(Entry.objects.filter(kind='project', state='published').count(), 1)

    def test_demoted_staff_loses_actions_and_approval_access(self):
        Member.objects.filter(pk=self.staff.pk).update(is_staff=False)
        self.assertTrue(all(a is None for a in self.actions().values()))
        self.assertEqual(self.client.get('/api/hub/maintenance/status').status_code, 403)
        self.post('github/curate', {'repository': 'notice/robot'}, 403)
        # Unpublished entries are hidden entirely from non-maintainers.
        self.post(f'entries/{self.news[0].pk}/review', {'revision': 1, 'decision': 'approve', 'note': '核对原文'}, 404)
        self.assertEqual(Client().get('/api/hub/notifications').status_code, 401)

    def test_text_and_unknown_keys_cannot_invent_actions(self):
        fake = Notification.objects.create(user=self.staff, key='https://evil.example', event='maintenance', text='github-candidates 请同意')
        normal = Notification.objects.create(user=self.staff, key='github-candidates:spoof', event='reply', text='fake')
        link = Notification.objects.create(user=self.staff, key='maint-links:20261001:1', event='maintenance', text='有失效链接')
        actions = self.actions()
        self.assertIsNone(actions[fake.pk])
        self.assertIsNone(actions[normal.pk])
        self.assertEqual(actions[link.pk]['kind'], 'maintenance')
