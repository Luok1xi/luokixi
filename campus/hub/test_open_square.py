"""Public square regressions; Django creates its own isolated test database."""
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from django.test import Client, TestCase
from django.utils import timezone
from .core import review_entry, withdraw_entry
from .github_guides import cache_key
from .models import Entry, ExternalCache, FeedFeedback, Member, Revision
from .test_project_repository import fixture


class OpenSquareTests(TestCase):
    def setUp(self):
        self.author = Member.objects.create_user('square-author', 'square-author@example.test', email_verified=True)
        self.staff = Member.objects.create_user('square-staff', 'square-staff@example.test', email_verified=True, is_staff=True)
        self.reader = Member.objects.create_user('square-reader', 'square-reader@example.test', email_verified=True)
        self.public = {'title': 'Approved original project', 'summary': 'Public approved summary', 'license': 'MIT',
                       'links': {'repo': 'https://github.com/fixture/robot'}, 'rightsConfirmed': True, 'category': 'mech'}
        self.draft = dict(self.public, title='SECRET pending title', summary='SECRET pending summary')
        self.entry = Entry.objects.create(kind='project', owner=self.author, slug='square-project', state='pending',
            public_revision=1, revision=2, published=self.public, draft=self.draft, search_text=json.dumps(self.public))
        Revision.objects.create(entry=self.entry, number=1, data=self.public, state='published')
        Revision.objects.create(entry=self.entry, number=2, data=self.draft, state='pending')
        data = fixture()
        data['entryId'] = str(self.entry.pk)
        data['selection'] = {'shelf': 'practical', 'reason': 'Checked original source', 'reviewedAt': timezone.now().isoformat()}
        ExternalCache.objects.create(key=cache_key('fixture/robot'), data=data, success=timezone.now())
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        (Path(self.temp.name) / 'community.json').write_text('{"projects":[]}', encoding='utf-8')
        self.directory = patch('hub.maintenance.public_data', return_value=Path(self.temp.name))
        self.directory.start()
        self.addCleanup(self.directory.stop)

    def get(self, client, route):
        response = client.get('/api/hub/' + route)
        self.assertEqual(response.status_code, 200, response.content[:500])
        return response.json()

    def test_catalogue_uses_public_revision_for_guests_author_and_staff_in_every_edit_state(self):
        clients = [Client(), Client(), Client()]
        clients[1].force_login(self.author)
        clients[2].force_login(self.staff)
        for state in ('published', 'draft', 'pending', 'rejected'):
            Entry.objects.filter(pk=self.entry.pk).update(state=state)
            for client in clients:
                item = self.get(client, 'catalogue?kind=project')['items'][0]
                self.assertEqual(item['data'], self.public)
                self.assertEqual(item['revision'], 1)
                self.assertNotIn('draft', item)
                self.assertNotIn('editRevision', item)
                self.assertNotIn('SECRET', json.dumps(item))

    def test_never_published_and_withdrawn_projects_stay_out_of_public_catalogue_and_repository(self):
        for revision, state in ((0, 'pending'), (1, 'withdrawn')):
            Entry.objects.filter(pk=self.entry.pk).update(public_revision=revision, state=state)
            for user in (None, self.staff):
                client = Client()
                if user: client.force_login(user)
                self.assertEqual(self.get(client, 'catalogue?kind=project')['total'], 0)
                self.assertEqual(self.get(client, 'repositories')['total'], 0)
                self.assertEqual(self.get(client, 'feed')['items'], [])

    def test_repository_retains_approved_project_through_draft_pending_and_rejected_revision(self):
        for state in ('draft', 'pending', 'rejected'):
            Entry.objects.filter(pk=self.entry.pk).update(state=state)
            for user in (None, self.staff):
                client = Client()
                if user: client.force_login(user)
                items = self.get(client, 'repositories')['items']
                self.assertEqual(len(items), 1)
                self.assertEqual(items[0]['pageUrl'], f'project.html?id={self.entry.pk}')
                self.assertNotIn('SECRET', json.dumps(items))

    def test_new_revision_changes_public_data_only_after_approval_then_withdrawal_hides_it(self):
        client = Client()
        self.assertEqual(self.get(client, 'catalogue')['items'][0]['data']['title'], self.public['title'])
        review_entry(self.staff, self.entry, {'revision': 2, 'decision': 'approve', 'note': 'Fixture-only source review'})
        public = self.get(client, 'catalogue')['items'][0]
        self.assertEqual(public['revision'], 2)
        self.assertEqual(public['data']['title'], self.draft['title'])
        withdraw_entry(self.staff, self.entry, 'Fixture-only withdrawal')
        self.assertEqual(self.get(client, 'catalogue')['items'], [])

    def test_public_catalogue_returns_every_page_without_pending_first_revisions(self):
        for number in range(34):
            Entry.objects.create(kind='project', slug=f'square-page-{number}', public_revision=1, state='published', published=self.public)
        Entry.objects.create(kind='project', slug='square-unpublished', state='pending', draft=self.draft)
        client = Client()
        page1 = self.get(client, 'catalogue?kind=project&offset=0')
        page2 = self.get(client, 'catalogue?kind=project&offset=30')
        self.assertEqual((page1['total'], len(page1['items']), len(page2['items'])), (35, 30, 5))
        self.assertEqual(len({p['id'] for p in page1['items'] + page2['items']}), 35)

    def test_not_interested_metadata_is_private_and_still_applies_to_an_existing_cursor(self):
        client = Client()
        client.force_login(self.reader)
        self.assertEqual(len(self.get(client, 'feed')['items']), 1)
        FeedFeedback.objects.create(user=self.reader, repository='fixture/robot', action='not-interested')
        own = self.get(client, 'feed')
        self.assertEqual(own['items'], [])
        self.assertEqual(own['ignoredRepositories'], ['fixture/robot'])
        self.assertEqual(self.get(Client(), 'feed')['ignoredRepositories'], [])
        self.assertEqual(len(self.get(Client(), 'feed')['items']), 1)

    def test_existing_feed_cursor_rechecks_new_feedback_and_public_binding(self):
        data = ExternalCache.objects.get(key=cache_key('fixture/robot')).data
        for number in range(8):
            # Keep the ignored project on the second page independently of
            # tie-breaking by hashed cache key in the Star-ranked feed.
            item = dict(data, repository=f'fixture/page-{number}', stars=501)
            item['selection'] = dict(data['selection'], reviewedAt=timezone.now().isoformat())
            ExternalCache.objects.create(key=cache_key(item['repository']), data=item, success=timezone.now())
        client = Client()
        client.force_login(self.reader)
        first = self.get(client, 'feed')
        self.assertEqual(len(first['items']), 8)
        self.assertIsNotNone(first['nextCursor'])
        FeedFeedback.objects.create(user=self.reader, repository='fixture/robot', action='not-interested')
        second = self.get(client, 'feed?cursor=' + first['nextCursor'])
        self.assertEqual(second['items'], [])
        self.assertEqual(second['ignoredRepositories'], ['fixture/robot'])
        Entry.objects.filter(pk=self.entry.pk).update(state='withdrawn')
        self.assertEqual(self.get(client, 'feed')['total'], 0)
