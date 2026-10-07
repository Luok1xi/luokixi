import json
from datetime import timedelta
from django.test import Client, TestCase
from django.utils import timezone
from .models import (CampusBoard, CircleLike, CourseReview, CourseReviewLike, Entry, ExternalMention, Member,
                     Notification, Reply, ReplyLike, Teacher)


def make_review(author, teacher, rating, body='讲得清楚，作业适中。', tags=None, days=0):
    data = {'rating': rating, 'body': body, 'anonymous': True, 'courseId': '', 'courseName': '', 'term': '', 'tags': tags or []}
    return CourseReview.objects.create(author=author, teacher=teacher, state='published', draft=data, published=data,
                                       public_revision=1, published_at=timezone.now() - timedelta(days=days))


class HupuRatingTests(TestCase):
    """虎扑式评分：印象标签、最热排序、评分榜（≥5 人、无最差榜）、热议榜、弹幕墙、站外讨论。"""

    @classmethod
    def setUpTestData(cls):
        cls.users = [Member.objects.create_user(f'u{i}', f'u{i}@example.test', f'Quartz-hupu-water-{i:03d}', email_verified=True) for i in range(7)]
        cls.mod = Member.objects.create_user('mod_h', 'mod-h@example.test', 'Quartz-hupu-water-900', email_verified=True, is_staff=True)
        cls.t1 = Teacher.objects.create(name='张老师', faculty='理学院', source_url='https://lxy.cumtb.edu.cn/info/1/1.htm')
        cls.t2 = Teacher.objects.create(name='李老师', faculty='理学院', source_url='https://lxy.cumtb.edu.cn/info/1/2.htm')
        cls.t3 = Teacher.objects.create(name='王老师', faculty='管理学院', source_url='https://glxy.cumtb.edu.cn/info/1/3.htm')

    def setUp(self):
        self.c = [Client() for _ in self.users]
        for client, user in zip(self.c, self.users):
            client.force_login(user)
        self.m, self.visitor = Client(), Client()
        self.m.force_login(self.mod)

    def post(self, client, path, data, status=200):
        r = client.post('/api/hub/' + path, json.dumps(data), content_type='application/json')
        self.assertEqual(r.status_code, status, r.content)
        return r.json()

    def test_tags_are_validated_and_counted(self):
        base = {'subjectType': 'teacher', 'subjectId': str(self.t1.pk)}
        self.post(self.c[0], 'reviews', dict(base, data={'rating': 5, 'body': '很好', 'tags': ['讲解清楚', '不存在的标签']}), 400)
        self.post(self.c[0], 'reviews', dict(base, data={'rating': 5, 'body': '很好', 'tags': ['讲解清楚', '有干货', '互动多', '负责耐心']}), 400)
        self.post(self.c[0], 'reviews', dict(base, data={'rating': 5, 'body': '很好', 'tags': ['讲解清楚', '有干货']}))
        self.assertIn('讲解清楚', self.visitor.get('/api/hub/reputation/tags').json()['items'])
        make_review(self.users[1], self.t1, 4, tags=['讲解清楚'])
        stats = self.visitor.get(f'/api/hub/teachers/{self.t1.pk}').json()['stats']
        self.assertEqual(stats['tags'][0], {'tag': '讲解清楚', 'count': 1})  # 待审的不计

    def test_hot_sort_and_rankings(self):
        for i in range(5):
            make_review(self.users[i], self.t1, 5 if i else 4)
        for i in range(3):
            make_review(self.users[i], self.t2, 5)  # 只有 3 人：不进评分榜
        old = make_review(self.users[0], self.t3, 1, days=200)
        liked = make_review(self.users[1], self.t3, 2, body='考核较难，但讲得清楚')
        for u in self.users[2:5]:
            CourseReviewLike.objects.create(review=liked, user=u)
        hot = self.visitor.get(f'/api/hub/reviews?teacher={self.t3.pk}&sort=hot').json()['items']
        self.assertEqual(hot[0]['id'], str(liked.pk))
        newest = self.visitor.get(f'/api/hub/reviews?teacher={self.t3.pk}&sort=newest').json()['items']
        self.assertEqual(newest[-1]['id'], str(old.pk))
        r = self.visitor.get('/api/hub/reputation/rankings?kind=teachers').json()
        self.assertEqual([x['name'] for x in r['top']], ['张老师'])  # ≥5 人才上榜
        self.assertEqual(r['top'][0]['stats']['average'], 4.8)
        self.assertNotIn('bottom', r)
        hot_names = [x['name'] for x in r['hot']]
        self.assertEqual(hot_names[0], '张老师')
        self.assertEqual(next(x for x in r['hot'] if x['name'] == '王老师')['recent'], 1)  # 200 天前的不算近期
        self.visitor.get('/api/hub/reputation/rankings?kind=courses')
        self.assertEqual(self.visitor.get('/api/hub/reputation/rankings?kind=students').status_code, 400)
        wall = self.visitor.get('/api/hub/reputation/wall').json()['items']
        self.assertEqual((wall[0]['id'], wall[0]['subject'], wall[0]['likes']), (str(liked.pk), '王老师', 3))
        self.assertNotIn('username', wall[0]['author'])  # 匿名评价不暴露账号

    def test_external_mentions_are_links_with_source_and_never_scored(self):
        body = {'subjectType': 'teacher', 'subjectId': str(self.t1.pk), 'url': 'https://tieba.baidu.com/p/123456',
                'title': '张老师的期末怎么复习', 'summary': '几位同学在聊复习重点'}
        self.post(self.visitor, 'reputation/mentions', body, 401)
        self.post(self.c[0], 'reputation/mentions', dict(body, url='http://tieba.baidu.com/p/1'), 400)
        made = self.post(self.c[0], 'reputation/mentions', body)
        self.assertEqual((made['site'], made['siteLabel'], made['state']), ('tieba', '百度贴吧', 'pending'))
        self.post(self.c[1], 'reputation/mentions', body, 409)
        self.assertTrue(Notification.objects.filter(user=self.mod, event='mention').exists())
        listing = f'/api/hub/reputation/mentions?teacher={self.t1.pk}'
        self.assertEqual(self.visitor.get(listing).json()['items'], [])  # 审核前不公开
        self.assertEqual(self.c[0].get('/api/hub/reputation/mentions/pending').status_code, 403)
        self.post(self.c[0], f"reputation/mentions/{made['id']}/moderate", {'decision': 'approve'}, 403)
        self.post(self.m, f"reputation/mentions/{made['id']}/moderate", {'decision': 'approve', 'note': '已打开原帖核对'})
        item = self.visitor.get(listing).json()['items'][0]
        self.assertEqual((item['site'], item['title']), ('tieba', '张老师的期末怎么复习'))
        self.assertNotIn('author', item)
        hupu = self.post(self.c[2], 'reputation/mentions', dict(body, url='https://bbs.hupu.com/12345.html'))
        self.assertEqual(hupu['siteLabel'], '虎扑')
        # 站外讨论不计入评分
        self.assertEqual(self.visitor.get(f'/api/hub/teachers/{self.t1.pk}').json()['stats']['count'], 0)
        self.post(self.c[2], f"reputation/mentions/{hupu['id']}/withdraw", {})
        self.assertEqual(ExternalMention.objects.get(pk=hupu['id']).state, 'withdrawn')


class CircleHotTests(TestCase):
    """校圈热榜（近 7 天、热度、变化箭头、屏蔽生效）与帖子楼层、亮回复。"""

    @classmethod
    def setUpTestData(cls):
        cls.alice = Member.objects.create_user('alice_c', 'alice-c@example.test', 'Quartz-circ-water-521', email_verified=True)
        cls.bob = Member.objects.create_user('bob_c', 'bob-c@example.test', 'Quartz-circ-water-522', email_verified=True)
        cls.carol = Member.objects.create_user('carol_c', 'carol-c@example.test', 'Quartz-circ-water-523', email_verified=True)
        CampusBoard.objects.get_or_create(id='daily', defaults={'name': '矿大日常'})

    def setUp(self):
        self.a, self.b, self.c, self.visitor = Client(), Client(), Client(), Client()
        self.a.force_login(self.alice)
        self.b.force_login(self.bob)
        self.c.force_login(self.carol)

    def post(self, client, path, data, status=200):
        r = client.post('/api/hub/' + path, json.dumps(data), content_type='application/json')
        self.assertEqual(r.status_code, status, r.content)
        return r.json()

    def topic(self, owner, title, days=0):
        when = (timezone.now() - timedelta(days=days)).isoformat()
        data = {'title': title, 'summary': title, 'body': title, 'tags': [], 'uploads': [], 'license': '原作者保留权利',
                'circle': {'board': 'daily', 'format': 'thread', 'campus': 'all', 'visibility': 'public', 'publishedAt': when}}
        return Entry.objects.create(kind='topic', slug=f'topic-{title}', owner=owner, state='published', draft=data,
                                    published=data, public_revision=1, revision=1)

    def test_hot_list_and_lit_replies(self):
        quiet = self.topic(self.alice, '安静的帖子')
        hot = self.topic(self.alice, '沙河食堂新窗口')
        old = self.topic(self.alice, '十天前的帖子', days=10)
        for user in (self.bob, self.carol):
            CircleLike.objects.create(user=user, entry=hot, revision=1)
            CircleLike.objects.create(user=user, entry=old, revision=1)
        r1 = Reply.objects.create(entry=hot, author=self.bob, body='二楼：去了，好吃', state='published')
        r2 = Reply.objects.create(entry=hot, author=self.carol, body='三楼：排队太长', state='published')
        Reply.objects.create(entry=hot, author=self.carol, body='待审核的回复', state='pending')
        # 楼层按发表时间排；测试里连着建的回复时间可能相同，显式错开
        start = timezone.now() - timedelta(minutes=10)
        for i, reply in enumerate(Reply.objects.filter(entry=hot).order_by('body')):
            Reply.objects.filter(pk=reply.pk).update(created=start + timedelta(minutes={'二楼：去了，好吃': 0, '三楼：排队太长': 1}.get(reply.body, 2)))
        board = self.visitor.get('/api/hub/circle/hot').json()
        self.assertEqual([x['title'] for x in board['items']], ['沙河食堂新窗口'])  # 没互动的、7 天前的都不上榜
        top = board['items'][0]
        self.assertEqual((top['rank'], top['replies'], top['likes'], top['change']['kind']), (1, 2, 2, 'new'))
        self.assertIn('72 小时减半', board['definition'])
        self.assertNotIn('owner', top)
        # 自己屏蔽的创作者不出现在自己的榜里
        self.post(self.b, 'circle/preferences', {'mutedCreators': ['alice_c']})
        self.assertEqual(self.b.get('/api/hub/circle/hot').json()['items'], [])
        self.post(self.b, 'circle/preferences', {'mutedCreators': []})
        # 亮回复：不能点亮自己的；获赞多的放在顶部，楼层从 2 楼开始
        self.post(self.b, f'circle/replies/{r1.pk}/like', {'enabled': True}, 400)
        self.post(self.a, f'circle/replies/{r2.pk}/like', {'enabled': True})
        self.assertEqual(self.post(self.b, f'circle/replies/{r2.pk}/like', {'enabled': True})['likes'], 2)
        self.post(self.visitor, f'circle/replies/{r2.pk}/like', {'enabled': True}, 401)
        thread = self.visitor.get(f'/api/hub/circle/posts/{hot.pk}/thread').json()
        self.assertEqual(thread['lit'], [str(r2.pk)])
        self.assertEqual([(x['floor'], x['likes']) for x in thread['replies']], [(2, 0), (3, 2)])  # 访客看不到待审回复
        mine = self.c.get(f'/api/hub/circle/posts/{hot.pk}/thread').json()
        self.assertEqual([x['state'] for x in mine['replies']], ['published', 'published', 'pending'])
        self.assertTrue(mine['replies'][1]['own'])
        self.assertEqual(ReplyLike.objects.count(), 2)
        self.assertEqual(quiet.pk, Entry.objects.get(slug='topic-安静的帖子').pk)
