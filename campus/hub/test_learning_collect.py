from unittest.mock import patch

from django.test import RequestFactory, TestCase

from .core import Problem
from .discovery import fetch_public
from .learning_collect import MetadataParser, normalize_source, preview
from .models import Entry


class LearningCollectTests(TestCase):
    def setUp(self):
        self.request = RequestFactory().post('/api/hub/learning/preview', REMOTE_ADDR='127.0.0.1')

    def entry(self, slug, published, **kwargs):
        return Entry.objects.create(slug=slug, kind='resource', published=published, **kwargs)

    @patch('hub.learning_collect.fetch_public')
    def test_private_and_pending_snapshots_never_leak(self, fetch):
        target = 'https://example.edu/private-note'
        self.entry('private', {}, draft={'title': 'Private research', 'links': {'source': target}})
        self.entry('pending-edit', {'title': 'Public title', 'links': {'source': 'https://example.edu/public'}},
                   draft={'title': 'Pending secret title', 'links': {'source': target}}, public_revision=1, state='pending')
        self.entry('withdrawn', {'title': 'Withdrawn', 'links': {'source': target}}, public_revision=1, state='withdrawn')
        self.entry('private-marker', {'title': 'Private marker', 'links': {'source': target}, 'learning': {'visibility': 'private'}}, public_revision=1, state='published')
        result = preview(self.request, {'source': target})
        self.assertEqual(result['matches'], [])
        self.assertEqual(result['title'], '')
        fetch.assert_not_called()

    @patch('hub.learning_collect.fetch_public')
    def test_published_metadata_used_without_fetching_and_versions_preserved(self, fetch):
        target = 'https://example.edu/notes'
        first = self.entry('v1', {'title': '公开一版', 'links': {'source': target}, 'learning': {'version': '1'}},
                           public_revision=1, state='pending', draft={'title': '未公开修改'})
        second = self.entry('v2', {'title': '公开二版', 'links': {'source': target}, 'learning': {'version': '2'}},
                            public_revision=1, state='published')
        result = preview(self.request, {'source': target, 'fetchMetadata': True})
        self.assertEqual({x['id'] for x in result['matches']}, {str(first.pk), str(second.pk)})
        self.assertEqual({x['version'] for x in result['matches']}, {'1', '2'})
        self.assertNotIn('未公开', str(result))
        fetch.assert_not_called()

    @patch('hub.learning_collect.fetch_public')
    def test_explicit_external_read_is_bounded_title_and_author_only(self, fetch):
        fetch.return_value = (b'<html><title>Public title</title><meta name="author" content="A"><body>NEVER COPY FULL TEXT</body></html>',
                              {'Content-Type': 'text/html; charset=utf-8'}, 'https://example.edu/final', 200)
        result = preview(self.request, {'source': 'https://example.edu/page', 'fetchMetadata': True})
        self.assertEqual(result['title'], 'Public title')
        self.assertEqual(result['credit'], 'A')
        self.assertEqual(result['sourceUrl'], 'https://example.edu/page')
        self.assertNotIn('NEVER COPY', str(result))
        self.assertEqual(fetch.call_args.kwargs['limit'], 256 * 1024)

    @patch('hub.learning_collect.fetch_public')
    def test_files_and_private_payloads_are_not_fetched(self, fetch):
        result = preview(self.request, {'source': 'https://example.edu/file.pdf', 'fetchMetadata': True})
        self.assertEqual(result['metadataStatus'], 'unverified')
        with self.assertRaises(Problem):
            preview(self.request, {'source': 'https://example.edu', 'summary': 'private body'})
        fetch.assert_not_called()

    @patch('hub.learning_collect.fetch_public')
    def test_local_addresses_and_credential_urls_rejected(self, fetch):
        for source in ('http://127.0.0.1/a', 'http://169.254.169.254/', 'http://[::1]/',
                       'http://host.local/', 'https://example.edu:444/a', 'https://u:p@example.edu/a', 'file:///tmp/a'):
            with self.subTest(source=source), self.assertRaises(Problem):
                preview(self.request, {'source': source, 'fetchMetadata': True})
        fetch.assert_not_called()

    @patch('hub.discovery.socket.create_connection')
    @patch('hub.discovery.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('10.0.0.8', 443))])
    def test_discovery_fetch_rejects_private_dns_before_connecting(self, dns, connect):
        with self.assertRaises(Problem):
            fetch_public('https://example.edu/')
        connect.assert_not_called()

    @patch('hub.learning_collect.fetch_public', side_effect=Problem('来源内容超出读取上限。'))
    def test_failed_metadata_is_recoverable(self, fetch):
        result = preview(self.request, {'source': 'https://example.edu/page', 'fetchMetadata': True})
        self.assertEqual(result['metadataStatus'], 'unavailable')
        self.assertEqual(result['sourceUrl'], 'https://example.edu/page')
        self.assertEqual(result['matches'], [])

    def test_doi_and_url_identity_preserve_query_versions(self):
        self.assertEqual(normalize_source('DOI: 10.1234/AbC'), ('https://doi.org/10.1234/abc', '10.1234/abc'))
        self.assertEqual(normalize_source('https://doi.org/10.1234/ABC'), ('https://doi.org/10.1234/abc', '10.1234/abc'))
        self.assertNotEqual(normalize_source('https://example.edu/a?v=1'), normalize_source('https://example.edu/a?v=2'))

    @patch('hub.learning_collect.fetch_public')
    def test_distinct_paths_are_not_collapsed(self, fetch):
        self.entry('without-slash', {'title': 'Different page', 'links': {'source': 'https://example.edu/a'}}, public_revision=1, state='published')
        self.assertEqual(preview(self.request, {'source': 'https://example.edu/a/'})['matches'], [])

    def test_parser_ignores_unrelated_html(self):
        parser = MetadataParser()
        parser.feed('<script>secret</script><meta name="citation_title" content="A &amp; B"><title>Fallback</title><meta name="citation_author" content="Author">')
        self.assertEqual(parser.result(), {'title': 'A & B', 'credit': 'Author'})
