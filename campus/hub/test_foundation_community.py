"""Regression tests for a real community participation loop, using isolated accounts."""
import json
from datetime import timedelta
from django.test import Client, TestCase
from django.utils import timezone
from .models import (BoardFollow, CampusBoard, CircleFeedback, CirclePreference,
                     Contribution, CourseReview, CreatorFollow, Entry, Member,
                     Notification, Reply, Teacher)


class CommunityFoundationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = Member.objects.create_user('foundation_author', 'foundation-author@example.test', email_verified=True, trusted=True)
        cls.reader = Member.objects.create_user('foundation_reader', 'foundation-reader@example.test', email_verified=True, trusted=True)
        cls.other = Member.objects.create_user('foundation_other', 'foundation-other@example.test', email_verified=True, trusted=True)
        cls.staff = Member.objects.create_user('foundation_staff', 'foundation-staff@example.test', email_verified=True, is_staff=True)
        CampusBoard.objects.create(pk='foundation-makers', name='机器人吧')
        CampusBoard.objects.create(pk='foundation-daily', name='日常吧')

    def setUp(self):
        self.author, self.viewer, self.stranger, self.moderator = [Client() for _ in range(4)]
        for client, user in ((self.author, self.owner), (self.viewer, self.reader), (self.stranger, self.other), (self.moderator, self.staff)):
            client.force_login(user)

    def post(self, client, route, data, status=200):
        response = client.post('/api/hub/' + route, json.dumps(data), content_type='application/json')
        self.assertEqual(response.status_code, status, response.content)
        return response.json()

    def public_post(self, title='机器人记录', owner=None, board='foundation-makers', tags=None):
        payload = {'title': title, 'body': '真实装配记录', 'tags': tags or ['机器人'], 'circle': {'board': board, 'format': 'thread', 'campus': 'all', 'publishedAt': timezone.now().isoformat()}}
        return Entry.objects.create(owner=owner or self.owner, kind='topic', slug='foundation-' + str(Entry.objects.count()), published=payload, draft=payload, public_revision=1, state='published', search_text=title)

    def notifications(self, client=None):
        return (client or self.author).get('/api/hub/notifications').json()['items']

    def test_reply_notice_returns_to_exact_thread_and_reply_without_approval(self):
        entry = self.public_post()
        reply = self.post(self.viewer, f'entries/{entry.pk}/replies', {'body': '传感器怎么选？'})
        notice = next(n for n in self.notifications() if n['event'] == 'reply')
        self.assertEqual(notice['action']['href'], f'circle.html?post={entry.pk}&reply={reply["id"]}')
        self.assertEqual(notice['action']['reply'], reply['id'])
        thread = self.author.get(f'/api/hub/circle/posts/{entry.pk}/thread', {'reply': reply['id']}).json()
        self.assertEqual(thread['replies'][0]['id'], reply['id'])
        self.assertTrue(thread['replies'][0]['canAccept'])
        self.assertFalse(Reply.objects.get(pk=reply['id']).accepted)
        self.post(self.author, 'notifications/read', {'ids': [notice['id']]})
        self.assertFalse(Reply.objects.get(pk=reply['id']).accepted)

    def test_notice_target_is_verified_and_withdrawal_hides_stale_content(self):
        entry = self.public_post('曾经公开的标题')
        other_entry = self.public_post('另一篇')
        wrong = Reply.objects.create(entry=other_entry, author=self.other, body='不该定位到这篇', state='published')
        bad = Notification.objects.create(user=self.owner, entry=entry, event='reply', key='reply:' + str(wrong.pk), text='链接 https://evil.example')
        notice = next(n for n in self.notifications() if n['id'] == bad.pk)
        self.assertEqual(notice['action']['status'], 'reply-unavailable')
        self.assertNotIn(str(wrong.pk), notice['action']['href'])
        self.assertNotIn('evil', notice['text'])
        self.post(self.author, f'entries/{entry.pk}/withdraw', {'reason': '撤回测试'})
        notice = next(n for n in self.notifications() if n['id'] == bad.pk)
        self.assertEqual(notice['action']['status'], 'withdrawn')
        self.assertIsNone(notice['action']['href'])
        self.assertIsNone(notice['entry'])
        self.assertNotIn('曾经公开', notice['text'])
        self.assertEqual(self.author.get(f'/api/hub/circle/posts/{entry.pk}/thread').status_code, 404)

    def test_private_draft_notice_does_not_give_other_user_title_or_entry(self):
        entry = Entry.objects.create(owner=self.owner, kind='topic', slug='foundation-private', draft={'title': '秘密草稿'})
        Notification.objects.create(user=self.reader, entry=entry, event='review', key='foundation-leaked', text='秘密草稿待审核')
        n = self.notifications(self.viewer)[0]
        self.assertIsNone(n['entry'])
        self.assertIsNone(n['action']['href'])
        self.assertEqual(n['action']['status'], 'unavailable')
        self.assertNotIn('秘密', n['text'])

    def test_retracted_reply_keeps_original_post_but_not_body_or_target(self):
        entry = self.public_post()
        reply = self.post(self.viewer, f'entries/{entry.pk}/replies', {'body': '后面撤回的回复'})
        self.post(self.moderator, f'replies/{reply["id"]}/review', {'approve': False, 'reason': '撤回'})
        notice = next(n for n in self.notifications() if n['event'] == 'reply')
        self.assertEqual(notice['action']['status'], 'reply-unavailable')
        self.assertEqual(notice['action']['href'], f'circle.html?post={entry.pk}')
        thread = self.viewer.get(f'/api/hub/circle/posts/{entry.pk}/thread').json()
        self.assertFalse(thread['replies'])

    def test_reply_notice_can_find_a_public_reply_beyond_first_300(self):
        entry = self.public_post()
        Reply.objects.bulk_create([Reply(entry=entry, author=self.reader, body=f'楼层 {i}', state='published') for i in range(305)])
        target = Reply.objects.filter(entry=entry).order_by('created', 'id').last()
        response = self.author.get(f'/api/hub/circle/posts/{entry.pk}/thread', {'reply': str(target.pk)})
        self.assertEqual(response.status_code, 200)
        reply = next(r for r in response.json()['replies'] if r['id'] == str(target.pk))
        self.assertEqual(reply['floor'], 306)

    def test_following_merges_authors_and_boards_dedups_and_honors_live_filters(self):
        author_only = self.public_post('作者关注', board='foundation-daily')
        both = self.public_post('双重关注')
        board_only = self.public_post('吧关注', owner=self.other)
        excluded = self.public_post('无关帖', owner=self.other, board='foundation-daily')
        CreatorFollow.objects.create(user=self.reader, creator=self.owner)
        BoardFollow.objects.create(user=self.reader, board_id='foundation-makers')
        rows = self.viewer.get('/api/hub/circle/feed?lane=following').json()['items']
        self.assertEqual({r['id'] for r in rows}, {str(author_only.pk), str(both.pk), str(board_only.pk)})
        self.assertEqual(len(rows), 3)
        shared = next(r for r in rows if r['id'] == str(both.pk))
        self.assertEqual(len(shared['recommendationReasons']), 2)
        self.assertTrue(shared['authorFollowed'])
        self.post(self.viewer, 'circle/preferences', {'mutedCreators': [self.other.username]})
        self.assertNotIn(str(board_only.pk), [r['id'] for r in self.viewer.get('/api/hub/circle/feed?lane=following').json()['items']])
        self.post(self.viewer, f'circle/posts/{both.pk}/feedback', {'action': 'not-interested'})
        self.assertEqual([r['id'] for r in self.viewer.get('/api/hub/circle/feed?lane=following').json()['items']], [str(author_only.pk)])
        self.post(self.viewer, 'circle/follow-creator', {'username': self.owner.username, 'enabled': False})
        self.assertEqual(self.viewer.get('/api/hub/circle/feed?lane=following').json()['items'], [])
        self.assertEqual(Client().get('/api/hub/circle/feed?lane=following').status_code, 401)

    def test_following_pagination_remains_deduped_and_rechecks_withdrawals(self):
        BoardFollow.objects.create(user=self.reader, board_id='foundation-makers')
        CreatorFollow.objects.create(user=self.reader, creator=self.owner)
        for i in range(16):
            self.public_post(f'连续帖子 {i}')
        first = self.viewer.get('/api/hub/circle/feed?lane=following').json()
        self.assertEqual(len(first['items']), 12)
        second = self.viewer.get('/api/hub/circle/feed', {'lane': 'following', 'cursor': first['nextCursor']}).json()
        self.assertEqual(len(second['items']), 4)
        self.assertFalse({r['id'] for r in first['items']} & {r['id'] for r in second['items']})
        Entry.objects.filter(pk=second['items'][0]['id']).update(state='withdrawn')
        live = self.viewer.get('/api/hub/circle/feed', {'lane': 'following', 'cursor': first['nextCursor']}).json()
        self.assertEqual(len(live['items']), 3)

    def test_account_interests_immediately_affect_circle_and_invalidate_old_cursor(self):
        robot = self.public_post('机器人记录')
        photo = self.public_post('摄影记录', tags=['摄影'], board='foundation-daily')
        for i in range(12): self.public_post(f'摄影补充 {i}', tags=['摄影'], board='foundation-daily')
        baseline = self.viewer.get('/api/hub/circle/feed').json()
        self.post(self.viewer, 'auth/profile', {'preferences': {'interests': ['机器人'], 'faculty': '机电学院'}})
        rows = self.viewer.get('/api/hub/circle/feed').json()['items']
        self.assertEqual(rows[0]['id'], str(robot.pk))
        self.assertIn('机器人', ''.join(rows[0]['recommendationReasons']))
        pref = self.viewer.get('/api/hub/circle/preferences').json()
        self.assertEqual(pref['interests'], ['机器人'])
        self.assertEqual(CirclePreference.objects.get(user=self.reader).interests, ['机器人'])
        response = self.viewer.get('/api/hub/circle/feed', {'cursor': baseline['nextCursor']})
        self.assertEqual(response.status_code, 409)
        self.post(self.viewer, 'circle/preferences', {'interests': ['摄影']})
        session = self.viewer.get('/api/hub/auth/session').json()
        self.assertEqual(session['user']['preferences']['interests'], ['摄影'])
        self.assertEqual(session['user']['preferences']['faculty'], '机电学院')
        self.post(self.viewer, 'auth/profile', {'preferences': {'year': '大一'}})
        self.assertEqual(self.viewer.get('/api/hub/circle/preferences').json()['interests'], ['摄影'])
        self.post(self.viewer, 'circle/reset', {})
        self.assertEqual(self.viewer.get('/api/hub/auth/session').json()['user']['preferences']['interests'], [])

    def test_legacy_interests_migrate_once_and_explicit_empty_is_not_restored(self):
        CirclePreference.objects.create(user=self.reader, interests=['机器人', '机器人'])
        session = self.viewer.get('/api/hub/auth/session').json()
        self.assertEqual(session['user']['preferences']['interests'], ['机器人'])
        self.reader.refresh_from_db()
        self.assertEqual(self.reader.preferences['interests'], ['机器人'])
        self.post(self.viewer, 'auth/profile', {'preferences': {'interests': []}})
        CirclePreference.objects.filter(user=self.reader).update(interests=['旧数据不应恢复'])
        self.assertEqual(self.viewer.get('/api/hub/circle/preferences').json()['interests'], [])
        self.assertEqual(self.viewer.get('/api/hub/auth/session').json()['user']['preferences']['interests'], [])

    def test_acceptance_permissions_and_change_are_single_traceable_contribution(self):
        entry = self.public_post()
        first = self.post(self.viewer, f'entries/{entry.pk}/replies', {'body': '第一条解答'})
        second = self.post(self.stranger, f'entries/{entry.pk}/replies', {'body': '第二条解答'})
        self.post(self.stranger, f'replies/{first["id"]}/accept', {}, 403)
        self.post(self.author, f'replies/{first["id"]}/accept', {})
        self.post(self.author, f'replies/{first["id"]}/accept', {})
        self.assertEqual(Contribution.objects.filter(category='answer', active=True).count(), 1)
        self.post(self.author, f'replies/{second["id"]}/accept', {})
        self.assertEqual(Contribution.objects.filter(category='answer', active=True).count(), 1)
        thread = self.author.get(f'/api/hub/circle/posts/{entry.pk}/thread').json()
        self.assertEqual([r['id'] for r in thread['replies'] if r['accepted']], [second['id']])
        self.assertTrue(all(r['canAccept'] for r in thread['replies']))
        visitor = Client().get(f'/api/hub/circle/posts/{entry.pk}/thread').json()
        self.assertFalse(any(r['canAccept'] for r in visitor['replies']))
        accepted_notice = next(n for n in self.notifications(self.stranger) if n['event'] == 'accepted')
        self.assertIn(second['id'], accepted_notice['action']['href'])

    def test_anonymous_review_notice_only_links_recipients_private_review(self):
        teacher = Teacher.objects.create(name='测试教师', faculty='测试学院')
        review = CourseReview.objects.create(author=self.owner, teacher=teacher, draft={'body': '匿名体验', 'anonymous': True}, force_anonymous=True)
        Notification.objects.create(user=self.owner, event='review-result', key=f'review-result:{review.pk}:1', text='你的评价已退回')
        own = self.notifications()[0]
        self.assertEqual(own['action']['href'], f'reputation.html?view=mine#review-{review.pk}')
        self.assertNotIn('author', own)
        Notification.objects.create(user=self.reader, event='review-result', key=f'review-result:{review.pk}:1', text='伪造关系')
        self.assertIsNone(self.notifications(self.viewer)[0]['action'])
        response = Client().get(f'/api/hub/reviews/{review.pk}')
        self.assertEqual(response.status_code, 404)

    def test_operations_notice_has_staff_only_maintenance_link(self):
        notice = Notification.objects.create(user=self.staff, event='operations', key='operations:test', text='采集任务持续失败')
        action = next(n['action'] for n in self.notifications(self.moderator) if n['id'] == notice.pk)
        self.assertEqual(action['href'], 'me.html#maintenance')
        Member.objects.filter(pk=self.staff.pk).update(is_staff=False)
        self.assertIsNone(next(n['action'] for n in self.notifications(self.moderator) if n['id'] == notice.pk))
