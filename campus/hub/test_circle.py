import io
import json
import tempfile
from datetime import timedelta
from pathlib import Path
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings
from django.utils import timezone
from .models import (Member, Entry, CampusBoard, CircleLike, CircleFeedback, CircleSelection,
                     CreatorFollow, BoardFollow, Contribution, Notification)
from .circle import rank


class CircleTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = Member.objects.create_user('alice_circle', 'alice-circle@example.test', 'Quartz-circle-water-521', email_verified=True)
        cls.bob = Member.objects.create_user('bob_circle', 'bob-circle@example.test', 'Quartz-circle-water-522', email_verified=True)
        cls.mod = Member.objects.create_user('mod_circle', 'mod-circle@example.test', 'Quartz-circle-water-523', email_verified=True, is_staff=True)
        CampusBoard.objects.create(id='daily', name='校园日常')
        CampusBoard.objects.create(id='makers', name='创作开源')
        CampusBoard.objects.create(id='reading', name='精选阅读')

    def setUp(self):
        self.a, self.b, self.m, self.visitor = [Client() for _ in range(4)]
        for client, user in [(self.a, self.alice), (self.b, self.bob), (self.m, self.mod)]:
            client.force_login(user)

    def post(self, client, path, data, status=200):
        response = client.post('/api/hub/' + path, json.dumps(data), content_type='application/json')
        self.assertEqual(response.status_code, status, response.content)
        return response.json()

    def data(self, title='校园项目进展', **extra):
        return {'title': title, 'body': '今天完成了第一台机器人的装配。', 'tags': ['机器人'],
                'circle': {'board': 'makers', 'format': 'moment'}, 'rightsConfirmed': True, **extra}

    def publish(self, data=None, client=None):
        client = client or self.a
        draft = self.post(client, 'circle/posts', {'data': data or self.data()})
        identifier = draft['id']
        self.post(client, f'entries/{identifier}/submit', {'revision': 1})
        self.post(self.m, f'entries/{identifier}/review', {'revision': 1, 'decision': 'approve', 'note': '已核对'})
        return identifier

    def feed(self, client=None, **filters):
        response = (client or self.b).get('/api/hub/circle/feed', filters)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def select(self, identifier, enabled=True, revision=1):
        return self.post(self.m, f'circle/posts/{identifier}/select', {
            'revision': revision, 'enabled': enabled, 'reason': '有步骤和验证依据，适合入门', 'sourceChecked': True})

    def test_post_review_permissions_and_public_contract(self):
        draft = self.post(self.a, 'circle/posts', {'data': self.data()})
        identifier = draft['id']
        self.assertEqual(self.feed()['items'], [])
        self.assertEqual(self.visitor.get('/api/hub/circle/posts/' + identifier).status_code, 404)
        self.post(self.b, f'entries/{identifier}/save', {'revision': 1, 'data': self.data()}, 403)
        self.post(self.a, f'entries/{identifier}/submit', {'revision': 1})
        self.post(self.m, f'entries/{identifier}/review', {'revision': 1, 'decision': 'approve', 'note': '核对完成'})
        item = self.feed(self.visitor, lane='latest')['items'][0]
        self.assertEqual(item['data']['circle']['visibility'], 'public')
        self.assertEqual(item['owner']['username'], self.alice.username)
        self.assertNotIn('email', item['owner'])
        self.assertFalse(Contribution.objects.filter(entry_id=identifier).exists())
        self.post(self.visitor, 'circle/posts', {'data': self.data()}, 401)
        blocked = Client(enforce_csrf_checks=True)
        blocked.force_login(self.bob)
        self.post(blocked, 'circle/follow-board', {'board': 'makers', 'enabled': True}, 403)

    def test_idempotent_likes_selection_versions_and_withdrawal(self):
        identifier = self.publish()
        for _ in range(2):
            self.post(self.b, f'circle/posts/{identifier}/like', {'enabled': True})
        self.assertEqual(CircleLike.objects.filter(entry_id=identifier).count(), 1)
        self.post(self.a, f'circle/posts/{identifier}/like', {'enabled': True}, 400)
        self.post(self.b, f'circle/posts/{identifier}/like', {'enabled': False})
        self.assertEqual(CircleLike.objects.count(), 0)
        self.post(self.b, f'circle/posts/{identifier}/feedback', {'action': 'useful'})
        self.post(self.b, f'circle/posts/{identifier}/feedback', {'action': 'useful'})
        self.assertEqual(CircleFeedback.objects.count(), 1)
        self.select(identifier)
        self.assertEqual(Contribution.objects.filter(active=True).count(), 1)
        self.post(self.a, f'entries/{identifier}/save', {'revision': 1, 'data': self.data(title='新版')})
        self.post(self.a, f'entries/{identifier}/submit', {'revision': 2})
        self.post(self.m, f'entries/{identifier}/review', {'revision': 2, 'decision': 'approve', 'note': '新版已核对'})
        card = self.b.get('/api/hub/circle/posts/' + identifier).json()
        self.assertIsNone(card['selection'])
        self.assertEqual(card['likes'], 0)
        self.assertFalse(Contribution.objects.filter(active=True).exists())
        self.select(identifier, revision=2)
        self.assertEqual(Contribution.objects.filter(active=True).count(), 1)
        self.post(self.a, f'entries/{identifier}/withdraw', {'reason': '作者撤回'})
        self.assertEqual(self.feed()['items'], [])
        self.assertEqual(self.visitor.get('/api/hub/circle/posts/' + identifier).status_code, 404)

    def test_follow_notify_opt_in_dedup_unfollow_and_mute(self):
        self.post(self.b, 'circle/follow-creator', {'username': self.alice.username, 'enabled': True})
        self.publish()
        self.assertFalse(Notification.objects.filter(user=self.bob, event='circle-new').exists())
        self.post(self.b, 'circle/follow-creator', {'username': self.alice.username, 'enabled': True, 'notify': True})
        self.post(self.b, 'circle/follow-board', {'board': 'makers', 'enabled': True, 'notify': True})
        second = self.publish(self.data(title='第二条'))
        self.assertEqual(Notification.objects.filter(user=self.bob, entry_id=second, event='circle-new').count(), 1)
        self.assertEqual(len(self.feed(lane='following')['items']), 2)
        self.post(self.b, 'circle/follow-creator', {'username': self.alice.username, 'enabled': False})
        self.post(self.b, 'circle/follow-board', {'board': 'makers', 'enabled': False})
        third = self.publish(self.data(title='第三条'))
        self.assertFalse(Notification.objects.filter(user=self.bob, entry_id=third).exists())
        self.assertEqual(self.feed(lane='following')['items'], [])
        self.post(self.b, 'circle/follow-board', {'board': 'makers', 'enabled': True, 'notify': True})
        self.post(self.b, 'circle/preferences', {'mutedCreators': [self.alice.username]})
        fourth = self.publish(self.data(title='第四条'))
        self.assertFalse(Notification.objects.filter(user=self.bob, entry_id=fourth).exists())
        self.assertEqual(self.feed()['items'], [])
        self.assertEqual(self.b.get('/api/hub/circle/posts/' + fourth).status_code, 404)
        self.assertEqual(self.visitor.get('/api/hub/circle/posts/' + fourth).status_code, 200)
        self.assertEqual(self.visitor.get('/api/hub/circle/following').status_code, 401)

    def test_recommendation_explicit_interests_switch_reset_and_reasons(self):
        older = self.publish()
        Entry.objects.filter(pk=older).update(created=timezone.now() - timedelta(days=2))
        newer = self.publish(self.data(title='摄影展', tags=['摄影'], circle={'board': 'daily', 'format': 'moment'}))
        self.post(self.b, 'circle/preferences', {'interests': ['机器人']})
        feed = self.feed()
        self.assertEqual(feed['items'][0]['id'], older)
        self.assertIn('机器人', ''.join(feed['items'][0]['recommendationReasons']))
        self.post(self.b, 'circle/preferences', {'personalized': False})
        self.assertEqual(self.feed()['mode'], 'latest')
        self.assertEqual(self.feed()['items'][0]['id'], newer)
        self.post(self.b, f'circle/posts/{newer}/feedback', {'action': 'not-interested'})
        self.assertNotIn(newer, [i['id'] for i in self.feed()['items']])
        self.post(self.b, 'circle/reset', {})
        self.assertIn(newer, [i['id'] for i in self.feed()['items']])
        self.assertFalse(self.b.get('/api/hub/circle/preferences').json()['personalized'])

    def test_zhihu_links_selection_dedup_and_new_version(self):
        data = self.data(title='机器人入门阅读', body='我推荐这篇，因为它说明了实践顺序。', circle={
            'board': 'reading', 'format': 'link', 'external': {'platform': 'zhihu',
            'url': 'https://www.zhihu.com/question/123/answer/456?utm_source=test',
            'author': '原作者', 'reason': '有清晰的实践步骤', 'audience': '机器人初学者'}})
        identifier = self.publish(data)
        self.assertEqual(self.feed()['items'], [])
        self.assertEqual(self.feed(lane='reading')['items'], [])
        selected = self.select(identifier)
        self.assertEqual(selected['data']['circle']['external']['url'], 'https://www.zhihu.com/question/123/answer/456')
        self.assertEqual(selected['data']['circle']['external']['mode'], 'link-only')
        self.assertEqual(self.feed(lane='reading')['items'][0]['id'], identifier)
        duplicate = self.publish(data)
        self.select(duplicate)
        self.assertEqual(Contribution.objects.filter(active=True).count(), 1)
        self.assertEqual(len(self.feed()['items']), 1)
        self.post(self.a, f'entries/{identifier}/save', {'revision': 1, 'data': dict(data, body='我的新版推荐理由。')})
        self.post(self.a, f'entries/{identifier}/submit', {'revision': 2})
        self.post(self.m, f'entries/{identifier}/review', {'revision': 2, 'decision': 'approve', 'note': '修改已核对'})
        self.assertNotIn(identifier, [i['id'] for i in self.feed(lane='reading')['items']])
        data['circle']['external']['url'] = 'https://zhihu.com.evil.example/question/123/answer/456'
        self.post(self.a, 'circle/posts', {'data': data}, 400)

    def test_cursor_filters_account_binding_and_live_withdrawal(self):
        base = self.publish()
        first = Entry.objects.get(pk=base)
        for i in range(20):
            Entry.objects.create(kind='topic', owner=self.alice, slug=f'cursor-test-{i}',
                published=first.published, draft=first.draft, state='published', public_revision=1, search_text='机器人')
        page = self.feed(lane='latest')
        self.assertEqual(len(page['items']), 12)
        token = page['nextCursor']
        rest = self.feed(lane='latest', cursor=token)
        self.assertEqual(len(rest['items']), 9)
        self.assertFalse(set(i['id'] for i in page['items']) & set(i['id'] for i in rest['items']))
        self.assertEqual(self.a.get('/api/hub/circle/feed', {'lane': 'latest', 'cursor': token}).status_code, 409)
        self.assertEqual(self.b.get('/api/hub/circle/feed', {'lane': 'reading', 'cursor': token}).status_code, 409)
        withdrawn = rest['items'][0]['id']
        self.post(self.a, f'entries/{withdrawn}/withdraw', {'reason': '撤回测试'})
        self.assertNotIn(withdrawn, [i['id'] for i in self.feed(lane='latest', cursor=token)['items']])
        self.post(self.b, 'circle/preferences', {'mutedBoards': ['makers']})
        self.assertEqual(self.b.get('/api/hub/circle/feed', {'lane': 'latest', 'cursor': token}).status_code, 409)

    def test_board_admin_email_visibility_and_moderation_guards(self):
        self.post(self.a, 'circle/boards', {'id': 'new', 'name': '新吧'}, 403)
        self.post(self.m, 'circle/boards', {'id': 'new', 'name': '新吧'})
        self.post(self.b, 'circle/follow-creator', {'username': self.bob.username, 'enabled': True}, 400)
        self.post(self.a, 'circle/posts', {'data': self.data(circle={'board': 'daily', 'visibility': 'friends'})}, 400)
        self.post(self.a, 'circle/posts', {'data': self.data(circle={'board': 'daily', 'anonymous': True})}, 400)
        own = self.post(self.m, 'circle/posts', {'data': self.data()})['id']
        self.post(self.m, f'entries/{own}/submit', {'revision': 1})
        self.post(self.m, f'entries/{own}/review', {'revision': 1, 'decision': 'approve', 'note': '自审'}, 403)
        self.bob.email_verified = False
        self.bob.save()
        self.post(self.b, 'circle/posts', {'data': self.data()}, 403)

    def test_photos_strip_exif_original_private_and_withdraw(self):
        from PIL import Image
        with tempfile.TemporaryDirectory(prefix='luokixi-circle-photo-') as temporary, override_settings(MEDIA_ROOT=Path(temporary)):
            content = io.BytesIO()
            image = Image.new('RGB', (32, 32), 'blue')
            exif = Image.Exif()
            exif[270] = 'private-camera-metadata'
            image.save(content, 'JPEG', exif=exif)
            upload = self.a.post('/api/hub/uploads', {'file': SimpleUploadedFile('photo.jpg', content.getvalue(), 'image/jpeg')})
            self.assertEqual(upload.status_code, 200, upload.content)
            uid = upload.json()['id']
            identifier = self.publish(self.data(uploads=[uid]))
            raw = self.visitor.get(f'/api/hub/uploads/{uid}/file')
            self.assertEqual(raw.status_code, 404)
            preview = self.visitor.get(f'/api/hub/uploads/{uid}/photo')
            self.assertEqual(preview.status_code, 200)
            with Image.open(io.BytesIO(b''.join(preview.streaming_content))) as decoded:
                self.assertFalse(decoded.getexif())
            self.post(self.a, f'entries/{identifier}/withdraw', {'reason': '不再分享'})
            self.assertEqual(self.visitor.get(f'/api/hub/uploads/{uid}/photo').status_code, 404)

    def test_ranking_diversity_and_new_creator_exploration(self):
        entries = []
        for author in range(8):
            owner = Member.objects.create_user(f'creator_{author}', f'creator{author}@example.test')
            for j in range(3):
                payload = self.data(circle={'board': ['daily', 'makers', 'reading'][author % 3], 'format': 'thread'})
                item = Entry.objects.create(owner=owner, kind='topic', slug=f'creator-{author}-{j}',
                    published=payload, public_revision=1, state='published')
                item.useful_count = 0
                entries.append(item)
        keys, reasons = rank(entries, {'personalized': True, 'interests': []}, [], [])
        first_page = [e for e in entries if str(e.pk) in keys[:12]]
        from collections import Counter
        self.assertLessEqual(max(Counter(e.owner_id for e in first_page).values()), 2)
        self.assertIn('探索', ''.join(reasons[keys[4]]))
        self.assertEqual(len(keys), len(set(keys)))
