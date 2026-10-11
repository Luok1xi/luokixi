"""Save-time and query-budget checks; all accounts and entries are isolated fixtures."""
from datetime import timedelta
from django.contrib.auth.models import AnonymousUser
from django.db import connection
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from .core import Problem, entry_data
from .models import Entry, EntryView, Member, Reply, Star, Watch, Workspace
from .star_collections import starred_entries


class StarCollectionTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.reader = Member.objects.create_user('saved_reader', 'saved-reader@example.test')
        cls.author = Member.objects.create_user('saved_author', 'saved-author@example.test')
        cls.other = Member.objects.create_user('saved_other', 'saved-other@example.test')

    def entry(self, slug, **changes):
        fields = {'owner': self.author, 'kind': 'project', 'slug': slug, 'state': 'published',
                  'public_revision': 1, 'published': {'title': slug},
                  'draft': {'title': 'private draft'}}
        return Entry.objects.create(**dict(fields, **changes))

    def test_uses_real_save_time_instead_of_entry_update_time(self):
        first, second = self.entry('saved-first'), self.entry('saved-second')
        old = timezone.now() - timedelta(days=4)
        recent = old + timedelta(days=3)
        first_star = Star.objects.create(user=self.reader, entry=first, collection='嵌入式')
        second_star = Star.objects.create(user=self.reader, entry=second, collection='科研')
        Star.objects.filter(pk=first_star.pk).update(created=old)
        Star.objects.filter(pk=second_star.pk).update(created=recent)
        Entry.objects.filter(pk=first.pk).update(updated=timezone.now())
        rows = starred_entries(self.reader)
        self.assertEqual([r['id'] for r in rows], [str(second.pk), str(first.pk)])
        self.assertEqual([r['starredAt'] for r in rows], [recent.isoformat(), old.isoformat()])
        self.assertEqual([r['collection'] for r in rows], ['科研', '嵌入式'])

    def test_private_saves_and_unavailable_content_are_not_returned(self):
        visible = self.entry('saved-visible')
        own_draft = self.entry('saved-own-draft', owner=self.reader, state='draft', public_revision=0)
        withdrawn = self.entry('saved-withdrawn', state='withdrawn')
        someone_elses = self.entry('saved-by-someone-else')
        for entry in (visible, own_draft, withdrawn):
            Star.objects.create(user=self.reader, entry=entry)
        Star.objects.create(user=self.other, entry=someone_elses)
        rows = starred_entries(self.reader)
        self.assertEqual([r['id'] for r in rows], [str(visible.pk)])
        self.assertNotIn('draft', rows[0])
        with self.assertRaises(Problem) as error:
            starred_entries(AnonymousUser())
        self.assertEqual(error.exception.status, 401)

    def test_equal_save_times_have_stable_primary_key_order(self):
        entries = [self.entry(f'saved-tie-{i}') for i in range(4)]
        stars = [Star.objects.create(user=self.reader, entry=e) for e in entries]
        same_time = timezone.now()
        Star.objects.filter(pk__in=[s.pk for s in stars]).update(created=same_time)
        expected = [str(s.entry_id) for s in sorted(stars, key=lambda s: s.pk, reverse=True)]
        for _ in range(2):
            rows = starred_entries(self.reader)
            self.assertEqual([r['id'] for r in rows], expected)
            self.assertTrue(all(r['starredAt'] == same_time.isoformat() for r in rows))

    def test_batched_counts_and_user_state_match_the_shared_serializer(self):
        entry = self.entry('saved-counts')
        Star.objects.create(user=self.reader, entry=entry, collection='硬件')
        Star.objects.create(user=self.other, entry=entry, collection='別人的分类')
        Watch.objects.create(user=self.reader, entry=entry, events=['release'])
        Watch.objects.create(user=self.other, entry=entry, events=['discussion'])
        for i in range(3):
            EntryView.objects.create(entry=entry, viewer=f'fixture-{i}', day=timezone.localdate())
        Reply.objects.create(entry=entry, author=self.reader, body='公开回复', state='published')
        Reply.objects.create(entry=entry, author=self.other, body='待审回复', state='pending')
        row = starred_entries(self.reader)[0]
        expected = entry_data(entry, self.reader)
        self.assertEqual({k: v for k, v in row.items() if k != 'starredAt'}, expected)
        self.assertEqual((row['siteStars'], row['views'], row['replyCount']), (2, 3, 1))
        self.assertEqual(row['watch'], ['release'])

    def test_queries_stay_constant_for_one_and_twelve_entries(self):
        Star.objects.create(user=self.reader, entry=self.entry('saved-query-0'))
        with CaptureQueriesContext(connection) as one:
            self.assertEqual(len(starred_entries(self.reader)), 1)
        for i in range(1, 12):
            Star.objects.create(user=self.reader, entry=self.entry(f'saved-query-{i}'))
        with CaptureQueriesContext(connection) as twelve:
            rows = starred_entries(self.reader)
            self.assertEqual(len(rows), 12)
        self.assertEqual(len(one), 5)
        self.assertEqual(len(twelve), len(one))

    def test_limit_is_applied_after_ordering_visible_saves(self):
        entries = [self.entry(f'saved-limit-{i}') for i in range(202)]
        stars = [Star.objects.create(user=self.reader, entry=e) for e in entries]
        same_time = timezone.now()
        Star.objects.filter(user=self.reader).update(created=same_time)
        rows = starred_entries(self.reader)
        self.assertEqual(len(rows), 200)
        self.assertEqual([r['id'] for r in rows], [str(s.entry_id) for s in reversed(stars[-200:])])

    def test_empty_list_needs_only_its_selection_query(self):
        with self.assertNumQueries(1):
            self.assertEqual(starred_entries(self.reader), [])

    def test_me_returns_ordered_save_times_and_preserves_private_account_sections(self):
        first, second = self.entry('me-saved-first'), self.entry('me-saved-second')
        own_draft = self.entry('me-own-draft', owner=self.reader, state='draft', public_revision=0)
        withdrawn = self.entry('me-saved-withdrawn', state='withdrawn')
        first_star = Star.objects.create(user=self.reader, entry=first, collection='嵌入式')
        second_star = Star.objects.create(user=self.reader, entry=second, collection='科研')
        for entry in (own_draft, withdrawn):
            Star.objects.create(user=self.reader, entry=entry)
        old = timezone.now() - timedelta(days=4)
        recent = old + timedelta(days=3)
        Star.objects.filter(pk=first_star.pk).update(created=old)
        Star.objects.filter(pk=second_star.pk).update(created=recent)
        Entry.objects.filter(pk=first.pk).update(updated=timezone.now())
        workspace = Workspace.objects.create(owner=self.reader, kind='project', title='我的工作区',
                                             data={'notes': '私有笔记'})
        Workspace.objects.create(owner=self.other, kind='project', title='他人的工作区')
        Workspace.objects.create(owner=self.reader, kind='building_name_vote', title='独立命名记录')
        client = Client()
        client.force_login(self.reader)

        response = client.get('/api/hub/me')

        self.assertEqual(response.status_code, 200, response.content[:1000])
        payload = response.json()
        self.assertEqual(set(payload), {'profile', 'entries', 'stars', 'workspaces'})
        self.assertEqual(payload['profile']['id'], self.reader.pk)
        self.assertEqual(payload['profile']['email'], self.reader.email)
        self.assertEqual([row['id'] for row in payload['stars']], [str(second.pk), str(first.pk)])
        self.assertEqual([row['starredAt'] for row in payload['stars']],
                         [recent.isoformat(), old.isoformat()])
        self.assertEqual([row['collection'] for row in payload['stars']], ['科研', '嵌入式'])
        self.assertTrue(all('draft' not in row for row in payload['stars']))
        self.assertEqual([row['id'] for row in payload['entries']], [str(own_draft.pk)])
        self.assertEqual(payload['entries'][0]['draft'], own_draft.draft)
        self.assertEqual([row['id'] for row in payload['workspaces']], [str(workspace.pk)])
        self.assertEqual(payload['workspaces'][0]['data'], workspace.data)
        self.assertEqual(response['Cache-Control'], 'private, no-store')

    def test_me_requires_login_and_does_not_expose_any_saved_content(self):
        Star.objects.create(user=self.reader, entry=self.entry('me-anonymous-hidden'))
        response = Client().get('/api/hub/me')
        self.assertEqual(response.status_code, 401, response.content[:1000])
        self.assertEqual(response.json(), {'error': '请先登录。'})
