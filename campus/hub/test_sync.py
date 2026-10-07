import json
from django.test import Client, TestCase
from .models import DeviceSync, Member


class DeviceSyncTests(TestCase):
    """手机 → 本人账号的同步：只存数据、只本人可读、带登录凭据的数据整条拒绝。"""

    @classmethod
    def setUpTestData(cls):
        cls.alice = Member.objects.create_user('alice_s', 'alice-s@example.test', 'Quartz-sync-water-521', email_verified=True)
        cls.bob = Member.objects.create_user('bob_s', 'bob-s@example.test', 'Quartz-sync-water-522', email_verified=True)

    def setUp(self):
        self.a, self.b, self.visitor = Client(), Client(), Client()
        self.a.force_login(self.alice)
        self.b.force_login(self.bob)

    def post(self, client, path, data, status=200):
        r = client.post('/api/hub/' + path, json.dumps(data), content_type='application/json')
        self.assertEqual(r.status_code, status, r.content)
        return r.json()

    def test_requires_login(self):
        self.assertIn(self.visitor.get('/api/hub/sync').status_code, (401, 403))
        self.post(self.visitor, 'sync/push', {'kind': 'seat', 'data': {'items': []}}, 401)

    def test_push_read_and_isolation(self):
        seat = {'items': [{'date': '2026-10-08', 'start': '08:00', 'end': '12:00', 'area': '三层东', 'seat': '3E-021', 'status': '已预约'}]}
        row = self.post(self.a, 'sync/push', {'kind': 'seat', 'data': seat, 'source': 'luokixi-ios 0.1', 'fetchedAt': '2026-10-07T07:30:00+08:00'})
        self.assertEqual((row['kind'], row['label'], row['data']), ('seat', '图书馆座位', seat))
        # 同一类型再次同步是覆盖，不是追加
        self.post(self.a, 'sync/push', {'kind': 'seat', 'data': {'items': []}})
        self.assertEqual(DeviceSync.objects.filter(user=self.alice).count(), 1)
        self.post(self.a, 'sync/push', {'kind': 'grades', 'data': {'items': [{'course': '线性代数', 'score': 92}]}})
        mine = self.a.get('/api/hub/sync')
        self.assertEqual(mine['Cache-Control'], 'private, no-store')
        self.assertEqual(set(mine.json()['items']), {'seat', 'grades'})
        self.assertTrue(mine.json()['items']['grades']['sensitive'])
        # 别人看不到
        self.assertEqual(self.b.get('/api/hub/sync').json()['items'], {})

    def test_rejects_credentials_anywhere_in_the_data(self):
        for bad in [{'password': 'x'}, {'account': {'pwd': 'x'}}, {'items': [{'Cookie': 'a=b'}]}, {'session': {'accessToken': 't'}}, {'学校密码': 'x'}]:
            self.post(self.a, 'sync/push', {'kind': 'card', 'data': bad}, 400)
        self.assertFalse(DeviceSync.objects.exists())
        # 普通字段名（作者、登录时间）不误伤
        self.post(self.a, 'sync/push', {'kind': 'library', 'data': {'items': [{'title': '线性代数', 'author': '同济大学数学系', 'loginAt': '2026-10-07'}]}})

    def test_validation_and_clear(self):
        self.post(self.a, 'sync/push', {'kind': 'unknown', 'data': {}}, 400)
        self.post(self.a, 'sync/push', {'kind': 'seat', 'data': 'not json object'}, 400)
        self.post(self.a, 'sync/push', {'kind': 'seat', 'data': {'blob': 'x' * 3000 + 'y' * 1000}}, 200)
        self.post(self.a, 'sync/push', {'kind': 'seat', 'data': {'items': ['x' * 3999] * 80}}, 400)  # 超过 256 KB
        self.post(self.a, 'sync/push', {'kind': 'seat', 'data': {}, 'fetchedAt': '2026-10-07 08:00'}, 400)  # 没有时区
        self.post(self.a, 'sync/push', {'kind': 'exam', 'data': {'items': []}})
        self.assertEqual(self.post(self.a, 'sync/clear', {'kind': 'exam'})['deleted'], 1)
        self.post(self.a, 'sync/clear', {'kind': 'nope'}, 400)
        self.assertEqual(self.post(self.a, 'sync/clear', {'kind': 'all'})['deleted'], 1)
        self.assertFalse(DeviceSync.objects.filter(user=self.alice).exists())
