"""Private plan synchronization, validation, stale writes, and existing backup boundaries."""
import copy
import json
from urllib.parse import quote

from django.db import IntegrityError, transaction
from django.test import Client, TestCase

from .models import Audit, Member, Workspace
from .planner import KIND, singleton_id


def sample_plan():
    return {'version': 1, 'profile': {'faculty': '机电学院', 'major': '机械', 'year': '2026', 'campus': 'xueyuanlu'},
            'courses': [{'id': '数学课', 'name': '高等数学', 'courseId': '', 'room': '302', 'teacher': '张老师',
                         'building': {'campus': 'xueyuanlu', 'osm': 'way:123', 'name': '教学楼', 'center': [116.34, 39.98]},
                         'slots': [{'id': 'slot-0', 'day': 1, 'start': '08:00', 'end': '09:40'}],
                         'weekMode': 'odd', 'weeks': [1, 3, 5], 'hidden': False, 'color': '#3A6B9C'}],
            'visited': {'xueyuanlu': ['way:123']}, 'updated': '2026-10-07T08:30:00.000Z',
            'term': {'label': '2026 秋季', 'starts': '2026-09-07', 'weeks': 20},
            'events': [{'id': '期中考试', 'title': '高数期中考试', 'kind': 'exam', 'date': '2026-11-02',
                        'start': '09:00', 'end': '11:00', 'location': '302', 'notes': '带学生证\n和计算器',
                        'repeat': 'none', 'until': '', 'color': '', 'hidden': False}],
            'hiddenOccurrences': ['course:%E6%95%B0%E5%AD%A6%E8%AF%BE:slot-0:2026-09-07'],
            'settings': {'view': 'week', 'hideWeekend': False, 'showCourses': True,
                         'showEvents': True, 'compact': False, 'reminderMinutes': 15}}


class PlannerTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = Member.objects.create_user('planner_alice', 'planner-alice@example.test')
        cls.bob = Member.objects.create_user('planner_bob', 'planner-bob@example.test')
        cls.staff = Member.objects.create_user('planner_staff', 'planner-staff@example.test', is_staff=True)

    def setUp(self):
        self.a, self.b, self.s, self.visitor = Client(), Client(), Client(), Client()
        self.a.force_login(self.alice)
        self.b.force_login(self.bob)
        self.s.force_login(self.staff)

    def post(self, client, body, route='planner', status=200):
        response = client.post('/api/hub/' + route, json.dumps(body, ensure_ascii=False), content_type='application/json')
        self.assertEqual(response.status_code, status, response.content)
        return response.json()

    def save(self, plan=None, version=0, client=None):
        return self.post(client or self.a, {'version': version, 'data': plan if plan is not None else sample_plan()})

    def test_login_active_account_and_request_methods(self):
        self.assertEqual(self.visitor.get('/api/hub/planner').status_code, 401)
        self.post(self.visitor, {'version': 0, 'data': sample_plan()}, status=401)
        self.post(self.visitor, {'version': 0}, route='planner/clear', status=401)
        self.assertEqual(self.a.put('/api/hub/planner', '{}', content_type='application/json').status_code, 405)
        # Django hides inactive users from authenticated sessions as well.
        self.alice.is_active = False
        self.alice.save(update_fields=['is_active'])
        self.assertIn(self.a.get('/api/hub/planner').status_code, (401, 403))
        self.post(self.a, {'version': 0, 'data': sample_plan()}, status=401)

    def test_csrf_required_and_valid_token_succeeds(self):
        guarded = Client(enforce_csrf_checks=True)
        guarded.force_login(self.alice)
        body = json.dumps({'version': 0, 'data': sample_plan()})
        self.assertEqual(guarded.post('/api/hub/planner', body, content_type='application/json').status_code, 403)
        token = guarded.get('/api/hub/auth/session').json()['csrfToken']
        result = guarded.post('/api/hub/planner', body, content_type='application/json', HTTP_X_CSRFTOKEN=token)
        self.assertEqual(result.status_code, 200, result.content)
        self.assertEqual(guarded.post('/api/hub/planner/clear', '{"version":1}', content_type='application/json').status_code, 403)

    def test_roundtrip_private_headers_and_owner_isolation(self):
        empty = {'version': 0, 'data': None, 'updated': None}
        self.assertEqual(self.a.get('/api/hub/planner').json(), empty)
        plan = sample_plan()
        written = self.save(plan)
        self.assertEqual(written['data'], plan)
        self.assertEqual(written['version'], 1)
        self.assertIsNotNone(written['updated'])
        read = self.a.get('/api/hub/planner')
        self.assertEqual(read.json(), written)
        self.assertEqual(read['Cache-Control'], 'private, no-store')
        self.assertEqual(self.b.get('/api/hub/planner').json(), empty)
        self.assertEqual(self.s.get('/api/hub/planner').json(), empty)
        row = Workspace.objects.get(owner=self.alice, kind=KIND)
        self.assertEqual(self.b.get(f'/api/hub/workspaces/{row.pk}').status_code, 404)
        self.assertEqual(self.s.get(f'/api/hub/workspaces/{row.pk}').status_code, 404)

    def test_no_owner_selector_or_unknown_operations(self):
        self.post(self.a, {'version': 0, 'data': sample_plan(), 'userId': self.bob.pk}, status=400)
        self.assertEqual(self.a.get('/api/hub/planner', {'userId': self.bob.pk}).status_code, 400)
        self.assertEqual(self.a.get('/api/hub/planner/other').status_code, 404)
        self.post(self.a, {'version': 0}, route='planner/unknown', status=404)
        self.assertFalse(Workspace.objects.filter(kind=KIND).exists())

    def test_old_version_never_overwrites_latest_plan(self):
        first = self.save()
        second_plan = copy.deepcopy(first['data'])
        second_plan['events'][0]['title'] = '考试改期后确认'
        latest = self.save(second_plan, version=1)
        self.post(self.a, {'version': 1, 'data': sample_plan()}, status=409)
        self.assertEqual(self.a.get('/api/hub/planner').json(), latest)
        self.assertEqual(Audit.objects.filter(action='planner:save').count(), 2)

    def test_clear_preserves_version_tombstone(self):
        self.save()
        cleared = self.post(self.a, {'version': 1}, route='planner/clear')
        self.assertEqual((cleared['version'], cleared['data']), (2, None))
        self.assertIsNotNone(cleared['updated'])
        self.assertEqual(self.a.get('/api/hub/planner').json(), cleared)
        self.post(self.a, {'version': 0, 'data': sample_plan()}, status=409)
        self.post(self.a, {'version': 1}, route='planner/clear', status=409)
        self.assertEqual(self.a.get('/api/hub/planner').json(), cleared)
        self.assertEqual(self.save(version=2)['version'], 3)
        self.assertEqual(Workspace.objects.filter(owner=self.alice, kind=KIND).count(), 1)

    def test_clear_before_first_save_prevents_version_zero_write(self):
        self.assertEqual(self.post(self.a, {'version': 0}, route='planner/clear')['version'], 1)
        self.post(self.a, {'version': 0, 'data': sample_plan()}, status=409)
        self.assertEqual(Workspace.objects.get(owner=self.alice, kind=KIND).data, {})

    def test_legacy_v1_keeps_profile_buildings_and_visited(self):
        legacy = sample_plan()
        for key in ('term', 'events', 'hiddenOccurrences', 'settings'):
            del legacy[key]
        for key in ('teacher', 'color', 'hidden', 'weeks', 'weekMode'):
            del legacy['courses'][0][key]
        del legacy['courses'][0]['slots'][0]['id']
        legacy['visited']['xueyuanlu'].append('way:123')  # Older imports may retain duplicate visits.
        normalized = self.save(legacy)['data']
        self.assertEqual(normalized['profile'], legacy['profile'])
        self.assertEqual(normalized['courses'][0]['building'], legacy['courses'][0]['building'])
        self.assertEqual(normalized['visited'], legacy['visited'])
        self.assertEqual(normalized['courses'][0]['slots'][0]['id'], 'slot-0')
        self.assertNotIn('weeks', normalized['courses'][0])
        self.assertEqual(normalized['term'], {'label': '', 'starts': '', 'weeks': 20})

    def test_unknown_fields_discarded_and_cancelled_compatible(self):
        plan = sample_plan()
        plan['extra'] = {'value': 'unrecognized'}
        plan['profile']['unknown'] = 'discard'
        plan['courses'][0]['cancelled'] = True
        plan['courses'][0]['building']['extra'] = 'discard'
        plan['events'][0]['cancelled'] = False
        saved = self.save(plan)['data']
        self.assertNotIn('extra', saved)
        self.assertNotIn('unknown', saved['profile'])
        self.assertNotIn('extra', saved['courses'][0]['building'])
        self.assertTrue(saved['courses'][0]['cancelled'])
        self.assertFalse(saved['events'][0]['cancelled'])

    def test_invalid_content_does_not_replace_or_audit_plan(self):
        current = self.save()
        cases = []
        for change in (
            lambda p: p.update(version=True),
            lambda p: p['term'].update(starts='2026-09-08'),
            lambda p: p['term'].update(weeks=31),
            lambda p: p['courses'][0].update(name='字' * 81),
            lambda p: p['courses'][0].update(weeks=[1, 1]),
            lambda p: p['courses'][0].update(weeks=[21]),
            lambda p: p['courses'][0].update(hidden=1),
            lambda p: p['courses'][0].update(color='blue'),
            lambda p: p['courses'][0].update(id='course\n1'),
            lambda p: p['courses'][0]['slots'][0].update(start='25:00'),
            lambda p: p['courses'][0]['slots'][0].update(end='08:00'),
            lambda p: p['courses'][0]['building'].update(center=[181, 30]),
            lambda p: p['courses'][0]['building'].update(center=[True, 30]),
            lambda p: p['events'][0].update(date='2026-02-29'),
            lambda p: p['events'][0].update(repeat='weekly', until='2029-11-02'),
            lambda p: p['events'][0].update(until='2026-10-01'),
            lambda p: p['settings'].update(reminderMinutes=-1),
            lambda p: p.update(hiddenOccurrences=['event:x:2026-02-30']),
            lambda p: p.update(hiddenOccurrences=['event:%ff:2026-09-07']),
            lambda p: p.update(hiddenOccurrences=['event:%78:2026-09-07']),
            lambda p: p.update(updated='not-a-date'),
            lambda p: p['courses'].append(copy.deepcopy(p['courses'][0])),
            lambda p: p['events'].append(copy.deepcopy(p['events'][0])),
        ):
            plan = sample_plan()
            change(plan)
            cases.append(plan)
        for plan in cases:
            with self.subTest(plan=plan):
                self.post(self.a, {'version': 1, 'data': plan}, status=400)
        self.assertEqual(self.a.get('/api/hub/planner').json(), current)
        self.assertEqual(Audit.objects.filter(action='planner:save').count(), 1)

    def test_credentials_rejected_even_in_unknown_fields(self):
        for bad in ({'password': 'fake'}, {'secret': {'accessToken': 'fake'}}, {'notes': {'Cookie': 'fake'}}, {'学校密码': 'fake'}):
            plan = sample_plan()
            plan['unknown'] = bad
            self.post(self.a, {'version': 0, 'data': plan}, status=400)
        self.assertFalse(Workspace.objects.filter(kind=KIND).exists())
        self.assertFalse(Audit.objects.filter(action='planner:save').exists())

    def test_body_and_array_limits_without_truncation(self):
        plan = sample_plan()
        plan['courses'] = [dict(plan['courses'][0], id=f'course-{i}') for i in range(61)]
        self.post(self.a, {'version': 0, 'data': plan}, status=400)
        plan = sample_plan()
        plan['events'] = [dict(plan['events'][0], id=f'event-{i}', notes='a' * 4000) for i in range(140)]
        error = self.post(self.a, {'version': 0, 'data': plan}, status=400)
        self.assertIn('512 KB', error['error'])
        self.assertFalse(Workspace.objects.filter(kind=KIND).exists())

    def test_invalid_versions_and_nonfinite_coordinates(self):
        for version in (True, -1, '0', 0.0, None):
            self.post(self.a, {'version': version, 'data': sample_plan()}, status=400)
        plan = sample_plan()
        plan['courses'][0]['building']['center'] = [float('nan'), 40]
        self.post(self.a, {'version': 0, 'data': plan}, status=400)

    def test_unicode_occurrence_identifiers_survive(self):
        plan = sample_plan()
        identifier = '课程' * 20
        slot_id = '时间' * 20
        plan['courses'][0]['id'] = identifier
        plan['courses'][0]['slots'][0]['id'] = slot_id
        occurrence = 'course:' + quote(identifier, safe="-_.!~*'()") + ':' + quote(slot_id, safe="-_.!~*'()") + ':2026-09-07'
        self.assertGreater(len(occurrence), 320)
        plan['hiddenOccurrences'] = [occurrence]
        self.assertEqual(self.save(plan)['data']['hiddenOccurrences'], [occurrence])

    def test_audit_records_only_actor_action_and_identifier(self):
        self.save()
        self.post(self.a, {'version': 1}, route='planner/clear')
        records = list(Audit.objects.filter(action__startswith='planner:').order_by('created'))
        self.assertEqual([r.action for r in records], ['planner:save', 'planner:clear'])
        for record in records:
            self.assertEqual(record.actor_id, self.alice.pk)
            self.assertEqual(record.target, str(singleton_id(self.alice.pk)))
            self.assertEqual(record.detail, {})
        raw = json.dumps(list(Audit.objects.filter(action__startswith='planner:').values()), default=str, ensure_ascii=False)
        self.assertNotIn('高等数学', raw)
        self.assertNotIn('张老师', raw)

    def test_deterministic_owner_key_and_conflicting_first_writes(self):
        self.assertEqual(singleton_id(self.alice.pk), singleton_id(self.alice.pk))
        self.assertNotEqual(singleton_id(self.alice.pk), singleton_id(self.bob.pk))
        first = self.save()
        self.post(self.a, {'version': 0, 'data': sample_plan()}, status=409)
        self.assertEqual(Workspace.objects.filter(owner=self.alice, kind=KIND).count(), 1)
        self.assertEqual(Workspace.objects.get(kind=KIND).pk, singleton_id(self.alice.pk))
        # Even simultaneous insert attempts share one DB-enforced primary key.
        with self.assertRaises(IntegrityError), transaction.atomic():
            Workspace.objects.create(id=singleton_id(self.alice.pk), owner=self.alice, kind=KIND, title='duplicate')
        self.assertEqual(self.a.get('/api/hub/planner').json(), first)

    def test_generic_workspace_write_cannot_bypass_plan_validation(self):
        current = self.save()
        row = Workspace.objects.get(owner=self.alice, kind=KIND)
        self.post(self.a, {'version': 1, 'kind': 'plan', 'title': 'generic override', 'data': {'steps': []}},
                  route=f'workspaces/{row.pk}', status=400)
        self.assertEqual(self.a.get('/api/hub/planner').json(), current)
        self.post(self.visitor, {'version': 1, 'kind': 'plan', 'title': 'not authenticated', 'data': {'steps': []}},
                  route=f'workspaces/{row.pk}', status=401)

    def test_personal_backup_restore_still_works_and_explains_separate_plan_export(self):
        self.save()
        original = Workspace.objects.create(owner=self.alice, kind='plan', title='学习计划', data={'steps': []})
        response = self.a.get('/api/hub/backup')
        self.assertEqual(response.status_code, 200)
        backup = response.json()
        self.assertEqual([w['id'] for w in backup['workspaces']], [str(original.pk)])
        self.assertIn('计划页单独导出', backup['notice'])
        result = self.post(self.b, dict(backup, confirmed=True), route='restore')
        self.assertEqual(result['restored'], 1)
        self.assertFalse(Workspace.objects.filter(owner=self.bob, kind=KIND).exists())
