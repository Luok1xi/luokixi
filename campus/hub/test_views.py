import json
from datetime import timedelta
from unittest import mock
from django.test import Client, TestCase
from django.utils import timezone
from .models import Entry, EntryView, Member, Reply


class EntryViewTests(TestCase):
    """浏览量：按账号或浏览器会话、按天去重；只记已公开的内容；接口和列表返回同一个数字。"""

    @classmethod
    def setUpTestData(cls):
        cls.alice = Member.objects.create_user('alice_v', 'alice-v@example.test', 'Quartz-view-water-521', email_verified=True)
        cls.bob = Member.objects.create_user('bob_v', 'bob-v@example.test', 'Quartz-view-water-522', email_verified=True)
        cls.project = Entry.objects.create(kind='project', owner=cls.alice, slug='view-test-project', state='published',
                                           published={'title': '浏览量测试项目', 'summary': '测试'}, public_revision=1)
        cls.draft = Entry.objects.create(kind='project', owner=cls.alice, slug='view-test-draft', state='draft',
                                         draft={'title': '还没公开'})

    def view(self, client, entry, status=200):
        r = client.post(f'/api/hub/entries/{entry.pk}/view', '{}', content_type='application/json')
        self.assertEqual(r.status_code, status, r.content)
        return r.json()

    def test_anonymous_session_counts_once_per_day(self):
        visitor = Client()
        self.assertEqual(self.view(visitor, self.project)['views'], 1)
        self.assertEqual(self.view(visitor, self.project)['views'], 1)
        # 换一个浏览器（新会话）再算一次
        self.assertEqual(self.view(Client(), self.project)['views'], 2)
        # 第二天同一个会话再看，算新的一次
        with mock.patch('django.utils.timezone.localdate', return_value=timezone.localdate() + timedelta(days=1)):
            self.assertEqual(self.view(visitor, self.project)['views'], 3)

    def test_signed_in_user_counts_once_across_browsers(self):
        a1, a2 = Client(), Client()
        a1.force_login(self.bob)
        a2.force_login(self.bob)
        self.view(a1, self.project)
        self.assertEqual(self.view(a2, self.project)['views'], 1)
        # 只存摘要，不存账号或会话号
        row = EntryView.objects.get(entry=self.project)
        self.assertRegex(row.viewer, r'^[0-9a-f]{64}$')
        self.assertNotIn(f'user:{self.bob.pk}', row.viewer)

    def test_unpublished_or_missing_entries(self):
        self.view(Client(), self.draft, 404)
        owner = Client()
        owner.force_login(self.alice)
        # 作者能打开自己的草稿，但不计浏览量
        self.assertEqual(self.view(owner, self.draft)['views'], 0)
        self.assertFalse(EntryView.objects.filter(entry=self.draft).exists())
        self.view(Client(), Entry(pk='00000000-0000-0000-0000-000000000000'), 404)

    def test_counts_are_returned_with_the_entry(self):
        self.view(Client(), self.project)
        Reply.objects.create(entry=self.project, author=self.bob, body='公开的回复', state='published')
        Reply.objects.create(entry=self.project, author=self.bob, body='待审核的回复', state='pending')
        data = Client().get(f'/api/hub/entries/{self.project.pk}').json()
        self.assertEqual((data['views'], data['replyCount']), (1, 1))
