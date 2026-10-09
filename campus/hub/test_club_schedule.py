"""Club scheduling: real membership, private imports, atomic displacement, and stale-write rejection."""
import json
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.test import Client, TestCase
from django.utils import timezone

from .models import (Audit, Club, ClubEvent, ClubMembership, ClubMutationReceipt,
                     DeviceSync, Member, RateBucket, SeatPlan, Workspace)


class ClubScheduleTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = Member.objects.create_user('club_owner', 'owner-club@example.test')
        cls.member = Member.objects.create_user('club_member', 'member-club@example.test')
        cls.member2 = Member.objects.create_user('club_member2', 'member2-club@example.test')
        cls.outsider = Member.objects.create_user('club_outsider', 'outsider-club@example.test')

    def setUp(self):
        self.a, self.b, self.c, self.x, self.guest = [Client() for _ in range(5)]
        for client, user in ((self.a, self.owner), (self.b, self.member), (self.c, self.member2), (self.x, self.outsider)):
            client.force_login(user)

    def post(self, route, body, client=None, status=200):
        response = (client or self.a).post('/api/hub/club-schedule' + route,
            json.dumps(body, ensure_ascii=False), content_type='application/json')
        self.assertEqual(response.status_code, status, response.content)
        return response.json()

    def board(self, client=None):
        response = (client or self.a).get('/api/hub/club-schedule')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response['Cache-Control'], 'private, no-store')
        return response.json()

    def club(self, client=None, name='机器人社'):
        return self.post('/clubs', {'name': name}, client)['club']

    def invite(self, club):
        return self.post(f"/clubs/{club['id']}/invite", {'revision': club['revision']})['code']

    def change(self, club, changes, status=200, client=None, **extra):
        return self.post('/batch', {'revisions': {club['id']: club['revision']},
            'changes': [{'clubId': club['id'], **change} for change in changes], **extra}, client, status)

    def test_read_never_creates_groups_memberships_or_workspace(self):
        baseline = (Audit.objects.count(), RateBucket.objects.count(), Workspace.objects.count())
        for _ in range(2):
            board = self.board()
            self.assertEqual(board['clubs'], [])
            self.assertEqual(board['events'], [])
            self.assertEqual(board['reservations']['items'], [])
            self.assertFalse(board['reservations']['providerConnected'])
        self.assertFalse(Club.objects.exists())
        self.assertFalse(ClubMembership.objects.exists())
        self.assertEqual(baseline, (Audit.objects.count(), RateBucket.objects.count(), Workspace.objects.count()))

    def test_login_and_csrf_boundary(self):
        self.assertEqual(self.guest.get('/api/hub/club-schedule').status_code, 401)
        self.post('/clubs', {'name': '社团'}, self.guest, 401)
        guarded = Client(enforce_csrf_checks=True)
        guarded.force_login(self.owner)
        self.post('/clubs', {'name': '社团'}, guarded, 403)

    def test_real_members_share_same_events_and_cannot_edit(self):
        club = self.club()
        code = self.invite(club)
        for client in (self.b, self.c):
            joined = self.post('/join', {'code': code}, client)
            self.assertEqual(joined['club']['role'], 'member')
            self.assertFalse(joined['club']['canManage'])
        result = self.change(club, [{'title': '每周制作', 'status': 'scheduled', 'date': '2026-10-12',
            'start': '16:00', 'end': '17:30', 'location': '社团活动室'}])
        event = result['events'][0]
        for client in (self.b, self.c):
            board = self.board(client)
            self.assertEqual(board['events'][0]['id'], event['id'])
            self.assertEqual(board['events'][0]['start'], '16:00')
            self.assertEqual(board['events'][0]['location'], '社团活动室')
            self.assertFalse(board['events'][0]['canManage'])
            self.change(result['clubs'][0], [{'id': event['id'], 'status': 'pending'}], 403, client)
        self.assertEqual(self.board(self.x)['events'], [])
        self.assertEqual(self.board(self.a)['clubs'][0]['memberCount'], 3)

    def test_pending_needs_only_title_and_preserves_duration(self):
        club = self.club()
        result = self.change(club, [{'title': '排练', 'duration': 90}])
        event = result['events'][0]
        self.assertTrue(event['pending'])
        self.assertIsNone(event['date'])
        self.assertIsNone(event['start'])
        self.assertEqual(event['duration'], 90)
        self.assertEqual(result['clubs'][0]['revision'], 2)

    def test_displacement_is_a_single_atomic_final_state(self):
        club = self.club()
        result = self.change(club, [
            {'title': '制作', 'status': 'scheduled', 'date': '2026-10-12', 'start': '16:00', 'end': '17:00'},
            {'title': '讨论', 'status': 'scheduled', 'date': '2026-10-12', 'start': '17:00', 'end': '18:00'}])
        first, second = result['events']
        result = self.change(result['clubs'][0], [
            {'id': first['id'], 'start': '17:00', 'end': '18:00'},
            {'id': second['id'], 'start': '18:00', 'end': '19:00'}])
        self.assertEqual([event['start'] for event in result['events']], ['17:00', '18:00'])
        self.assertEqual(result['clubs'][0]['revision'], 3)

    def test_partial_validation_failure_rolls_back_everything(self):
        club = self.club()
        result = self.change(club, [{'title': '原活动'}])
        club, event = result['clubs'][0], result['events'][0]
        self.change(club, [{'id': event['id'], 'title': '不应留下的改名'},
                           {'title': '错误时段', 'status': 'scheduled', 'date': '2026-10-12', 'start': '19:00', 'end': '18:00'}], 400)
        self.assertEqual(ClubEvent.objects.get(pk=event['id']).title, '原活动')
        self.assertEqual(Club.objects.get(pk=club['id']).revision, club['revision'])
        self.assertEqual(ClubEvent.objects.count(), 1)

    def test_conflict_against_unchanged_schedule_rolls_back(self):
        club = self.club()
        result = self.change(club, [{'title': '已有活动', 'status': 'scheduled', 'date': '2026-10-12', 'start': '16:00', 'end': '18:00'}])
        club = result['clubs'][0]
        self.change(club, [{'title': '重叠活动', 'status': 'scheduled', 'date': '2026-10-12', 'start': '17:00', 'end': '19:00'}], 409)
        self.assertEqual(ClubEvent.objects.count(), 1)
        self.assertEqual(Club.objects.get(pk=club['id']).revision, club['revision'])

    def test_stale_revision_does_not_overwrite(self):
        club = self.club()
        self.change(club, [{'title': '先保存'}])
        self.change(club, [{'title': '旧版本'}], 409)
        self.assertEqual(list(ClubEvent.objects.values_list('title', flat=True)), ['先保存'])

    def test_cross_club_event_id_cannot_be_reassigned(self):
        mine, other = self.club(), self.club(self.x, '其他社团')
        external = self.change(other, [{'title': '其他人的活动'}], client=self.x)['events'][0]
        self.change(mine, [{'title': '本社创建'}, {'id': external['id'], 'title': '试图窃取'}], 403)
        self.assertEqual(ClubEvent.objects.count(), 1)
        self.assertEqual(ClubEvent.objects.get(pk=external['id']).club_id, uuid.UUID(other['id']))
        self.assertEqual(Club.objects.get(pk=mine['id']).revision, 1)

    def test_multi_club_batch_permission_failure_rolls_back_all(self):
        mine, other = self.club(), self.club(self.x, '其他社团')
        self.post('/batch', {'revisions': {mine['id']: 1, other['id']: 1}, 'changes': [
            {'clubId': mine['id'], 'title': '我的活动'}, {'clubId': other['id'], 'title': '越权'}]}, status=404)
        self.assertFalse(ClubEvent.objects.exists())
        self.assertEqual(set(Club.objects.values_list('revision', flat=True)), {1})

    def test_cancel_keeps_history_but_hides_shared_card(self):
        club = self.club()
        code = self.invite(club)
        self.post('/join', {'code': code}, self.b)
        result = self.change(club, [{'title': '取消的活动'}])
        event = result['events'][0]
        result = self.change(result['clubs'][0], [{'id': event['id'], 'status': 'cancelled'}])
        self.assertEqual(result['events'], [])
        self.assertEqual(self.board(self.b)['events'], [])
        self.assertEqual(ClubEvent.objects.get(pk=event['id']).status, 'cancelled')
        self.change(result['clubs'][0], [{'id': event['id'], 'status': 'pending'}], 409)

    def test_invites_private_rotate_expire_and_revoke(self):
        club = self.club()
        old = self.invite(club)
        self.assertNotIn(old, json.dumps(self.board()))
        self.assertNotEqual(Club.objects.get(pk=club['id']).invite_hash, old)
        new = self.invite(club)
        self.post('/join', {'code': old}, self.b, 404)
        self.post('/join', {'code': new}, self.b)
        self.post(f"/clubs/{club['id']}/invite", {'revision': 1}, self.b, 403)
        self.assertEqual(self.b.get(f"/api/hub/club-schedule/clubs/{club['id']}/members").status_code, 403)
        self.post(f"/clubs/{club['id']}/invite/revoke", {'revision': 1})
        self.post('/join', {'code': new}, self.c, 404)
        expired = self.invite(club)
        Club.objects.filter(pk=club['id']).update(invite_expires=timezone.now() - timedelta(seconds=1))
        self.post('/join', {'code': expired}, self.c, 404)

    def test_join_leave_and_owner_removal(self):
        club = self.club()
        code = self.invite(club)
        for _ in range(2):
            self.post('/join', {'code': code}, self.b)
        self.assertEqual(ClubMembership.objects.count(), 2)
        for _ in range(2):
            self.post(f"/clubs/{club['id']}/leave", {}, self.b)
        self.assertEqual(self.board(self.b)['clubs'], [])
        self.post(f"/clubs/{club['id']}/leave", {}, status=409)
        self.post('/join', {'code': code}, self.b)
        self.post(f"/clubs/{club['id']}/members/remove", {'revision': 1, 'memberId': self.member.pk})
        self.assertEqual(self.board(self.b)['clubs'], [])
        self.post('/join', {'code': code}, self.b, 404)
        self.post(f"/clubs/{club['id']}/members/remove", {'revision': 1, 'memberId': self.owner.pk}, status=409)

    def test_request_keys_make_retry_idempotent_and_mismatch_rejected(self):
        body = {'name': '摄影社', 'requestKey': str(uuid.uuid4())}
        first = self.post('/clubs', body)
        self.assertEqual(first, self.post('/clubs', body))
        self.post('/clubs', {**body, 'name': '另一个社团'}, status=409)
        self.assertEqual(Club.objects.count(), 1)
        key = str(uuid.uuid4())
        result = self.change(first['club'], [{'title': '外拍'}], requestKey=key)
        again = self.change(first['club'], [{'title': '外拍'}], requestKey=key)
        self.assertEqual(result, again)
        self.assertEqual(ClubEvent.objects.count(), 1)
        self.assertEqual(ClubMutationReceipt.objects.count(), 2)

    def test_times_duration_and_unknown_fields_are_rejected(self):
        club = self.club()
        for change in ({'title': 'a', 'duration': 0}, {'title': 'a', 'duration': True},
                       {'title': 'a', 'schoolCourses': []}, {'title': 'a', 'date': '2026-10-12', 'status': 'scheduled', 'start': '23:00', 'end': '01:00'},
                       {'title': 'a', 'date': '2026-13-12', 'status': 'scheduled', 'start': '10:00', 'end': '11:00'}):
            self.change(club, [change], 400)
        self.assertFalse(ClubEvent.objects.exists())
        self.change(club, [{'title': '晚间活动', 'date': '2026-10-12', 'status': 'scheduled', 'start': '23:00', 'end': '24:00'}])

    def test_private_imports_do_not_leak_and_reminders_are_not_reservations(self):
        club = self.club()
        self.post('/join', {'code': self.invite(club)}, self.b)
        DeviceSync.objects.create(user=self.owner, kind='seat', source='本人手机', data={'items': [
            {'date': '2026-10-12', 'start': '10:00', 'end': '12:00', 'status': '已预约', 'area': '三层', 'seat': '021'},
            {'date': '2026-10-12', 'start': '14:00', 'end': '16:00', 'status': '待预约'},
            {'date': '2026-10-12', 'start': '14:00', 'end': '16:00', 'status': '已取消'}]})
        DeviceSync.objects.create(user=self.owner, kind='timetable', data={'privateCourse': '仅本人主课'})
        start = datetime(2026, 10, 13, 8, tzinfo=ZoneInfo('Asia/Shanghai'))
        for state in ('scheduled', 'reported_reserved', 'checked_in'):
            SeatPlan.objects.create(owner=self.owner, request_key=uuid.uuid4(), campus='xueyuanlu', starts=start,
                ends=start + timedelta(hours=2), remind_at=start - timedelta(days=1), state=state, preference='二层')
        before = (Audit.objects.count(), RateBucket.objects.count())
        result = self.board()['reservations']
        self.assertEqual(len(result['items']), 3)
        self.assertEqual(result['unmappedCount'], 1)
        self.assertFalse(result['providerConnected'])
        self.assertTrue(all(not item['providerConfirmed'] and item['fixed'] for item in result['items']))
        self.assertEqual(self.board(self.b)['reservations']['items'], [])
        self.assertNotIn('privateCourse', json.dumps(self.board()))
        self.assertEqual(before, (Audit.objects.count(), RateBucket.objects.count()))
        self.assertTrue(SeatPlan.objects.filter(state='scheduled').exists())
