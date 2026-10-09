import io
import json
import tempfile
from pathlib import Path
from unittest import mock

from django.core.management import call_command
from django.test import SimpleTestCase, TestCase
from PIL import Image

from . import maintenance, news_media
from .models import Audit, Entry, Member, Revision


def picture(size, fmt='JPEG', orientation=None):
    image = Image.new('RGB', size, '#26384a')
    # A uniform dark photo is deliberate: dark pixels are not proof of padding.
    out = io.BytesIO()
    options = {}
    if orientation:
        exif = Image.Exif()
        exif[274] = orientation
        options['exif'] = exif
    image.save(out, fmt, **options)
    return out.getvalue()


class NewsMediaTests(SimpleTestCase):
    def test_candidates_skip_decorations_and_use_lazy_original(self):
        raw = b'''<div class="v_news_content"><img src="/logo.png">
        <img src="/spacer.gif" width="1" height="1"><img src="/s.gif" width="30">
        <img src="data:image/gif,AA" data-original="/poster.jpg" alt="Poster">
        <img src="/photo.jpg"><img src="/photo.jpg"><img src="javascript:alert(1)"></div>'''
        article = maintenance.parse_article(raw, 'https://example.org/news/1')
        self.assertEqual([i['url'] for i in article['imageCandidates']], ['https://example.org/poster.jpg', 'https://example.org/photo.jpg'])

    def test_landscape_replaces_first_portrait_and_stops_network_early(self):
        portrait, landscape = picture((800, 1131)), picture((1280, 800))
        fetch = mock.Mock(side_effect=[(portrait, 'https://example.org/poster.jpg'), (landscape, 'https://example.org/photo.jpg')])
        selected, errors = news_media.select([{'url': f'https://example.org/{i}', 'alt': ''} for i in range(6)], fetch)
        self.assertEqual((selected['width'], selected['height'], selected['fit']), (1280, 800, 'cover'))
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(errors, [])

    def test_portrait_only_is_not_cropped_and_exif_matches_browser(self):
        source = picture((1131, 800), orientation=6)
        selected, _ = news_media.select([{'url': 'https://example.org/portrait.jpg', 'alt': ''}], lambda *args: (source, args[0]))
        self.assertEqual((selected['width'], selected['height'], selected['fit']), (800, 1131, 'contain'))
        self.assertEqual(selected['position'], '50% 50%')
        self.assertEqual(selected['url'], 'https://example.org/portrait.jpg')
        self.assertEqual(source, picture((1131, 800), orientation=6))

    def test_dark_content_preserved_invalid_responses_skipped_and_probes_bounded(self):
        dark = picture((1200, 750), 'PNG')
        selected, errors = news_media.select([{'url': 'https://example.org/photo.png', 'alt': ''}], lambda *args: (dark, args[0]))
        self.assertEqual((selected['width'], selected['height']), (1200, 750))
        self.assertEqual(errors, [])
        fetch = mock.Mock(return_value=(b'<html>access denied</html>', 'https://example.org/blocked'))
        selected, errors = news_media.select([{'url': f'https://example.org/{i}', 'alt': ''} for i in range(6)], fetch)
        self.assertIsNone(selected)
        self.assertEqual(len(errors), 3)
        self.assertEqual(fetch.call_count, 3)

    def test_rejects_tracking_image_and_extreme_ribbon(self):
        for size in [(1, 1), (1000, 100)]:
            selected, errors = news_media.select([{'url': 'https://example.org/p.png', 'alt': ''}], lambda *args: (picture(size), args[0]))
            self.assertIsNone(selected)
            self.assertEqual(len(errors), 1)

    def test_truncated_jpeg_is_not_published_as_a_verified_photo(self):
        truncated = picture((1200, 750))[:-100]
        selected, errors = news_media.select([{'url': 'https://example.org/incomplete.jpg', 'alt': ''}], lambda *args: (truncated, args[0]))
        self.assertIsNone(selected)
        self.assertEqual(len(errors), 1)


class RepairNewsMediaTests(TestCase):
    def create_entry(self, slug, media=None, state='published'):
        data = {'title': 'Source article', 'body': 'Keep this text',
                'links': {'source': 'https://example.org/article'},
                'media': media or {'src': 'https://example.org/photo.jpg', 'credit': 'Original reporter'}}
        return Entry.objects.create(kind='news', slug=slug, state=state, published=data, draft=data,
                                    revision=3, public_revision=3, review_note='Keep original review')

    def command(self, *args):
        output = io.StringIO()
        call_command('hub_repair_news_media', *args, stdout=output)
        return json.loads(output.getvalue())

    def test_dry_run_is_read_only_and_reuses_image_probe(self):
        first, second = self.create_entry('a'), self.create_entry('b')
        before = list(Entry.objects.order_by('pk').values())
        with mock.patch.object(maintenance, 'get_page', return_value=(picture((800, 1131)), 'https://example.org/photo.jpg')) as fetch:
            plan = self.command('--dry-run', '--limit', '2')
        self.assertEqual(plan['applied'], 0)
        self.assertEqual(plan['imageRequests'], 1)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(list(Entry.objects.order_by('pk').values()), before)
        self.assertFalse(Audit.objects.exists())
        self.assertTrue(all(item['metadata']['fit'] == 'contain' for item in plan['items']))

    def test_apply_saved_plan_no_network_preserves_review_source_and_changed_draft(self):
        entry = self.create_entry('a', {'src': 'https://example.org/photo.jpg', 'credit': 'Original',
                                      'dimensions': {'width': 800, 'height': 1131}})
        reviewer = Member.objects.create_user('reviewer', 'reviewer@example.test', 'a-long-test-password')
        revision = Revision.objects.create(entry=entry, number=3, state='published', data=entry.published, reviewer=reviewer)
        created, source = entry.created, entry.published['media']['src']
        with mock.patch.object(maintenance, 'get_page') as fetch:
            plan = self.command('--dry-run')
            self.assertFalse(fetch.called)
            entry.draft = {**entry.draft, 'media': {'src': 'https://example.org/new-draft.jpg'}}
            entry.save(update_fields=['draft'])
            draft = entry.draft.copy()
            with tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / 'plan.json'
                path.write_text(json.dumps(plan), encoding='utf-8')
                result = self.command('--apply', '--plan', str(path))
            fetch.assert_not_called()
        entry.refresh_from_db(); revision.refresh_from_db()
        self.assertEqual(result['applied'], 1)
        self.assertEqual(entry.published['media']['fit'], 'contain')
        self.assertEqual(entry.published['media']['src'], source)
        self.assertEqual(entry.draft, draft)
        self.assertEqual((entry.state, entry.revision, entry.public_revision, entry.created), ('published', 3, 3, created))
        self.assertEqual(revision.reviewer, reviewer)
        self.assertEqual(entry.review_note, 'Keep original review')
        receipt = Audit.objects.get(action='news:media-metadata')
        self.assertEqual(receipt.detail['before']['src'], receipt.detail['after']['src'])
        self.assertFalse(receipt.detail['draftUpdated'])

    def test_concurrent_article_edits_are_skipped_and_existing_dimensions_avoid_fetch(self):
        entry = self.create_entry('a', {'src': 'https://example.org/photo.jpg', 'width': 1280, 'height': 800})
        self.create_entry('pending', state='pending')
        with mock.patch.object(maintenance, 'get_page') as fetch:
            plan = self.command('--dry-run')
            self.assertEqual(len(plan['items']), 1)
            entry.published = {**entry.published, 'title': 'Author updated'}
            entry.save(update_fields=['published'])
            with tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / 'plan.json'
                path.write_text(json.dumps(plan), encoding='utf-8')
                result = self.command('--apply', '--plan', str(path))
            fetch.assert_not_called()
        self.assertEqual(result['results'][0]['status'], 'changed-since-plan')
        self.assertEqual(result['applied'], 0)
        self.assertFalse(Audit.objects.exists())

    def test_apply_is_bounded_and_idempotent(self):
        for i in range(3):
            self.create_entry(str(i), {'src': 'https://example.org/photo.jpg', 'width': 1280, 'height': 800})
        with mock.patch.object(maintenance, 'get_page') as fetch:
            first = self.command('--apply', '--limit', '1')
            self.assertEqual(first['applied'], 1)
            self.assertEqual(self.command('--apply', '--limit', '3')['applied'], 2)
            self.assertEqual(self.command('--apply', '--limit', '3')['applied'], 0)
            fetch.assert_not_called()
        self.assertEqual(Audit.objects.count(), 3)

    def test_report_is_safe_for_legacy_console_encoding_without_losing_title(self):
        entry = self.create_entry('chinese', {'src': 'https://example.org/photo.jpg', 'width': 1280, 'height': 800})
        entry.published = {**entry.published, 'title': '新闻 · 科研 🛰️'}
        entry.save(update_fields=['published'])
        output = io.StringIO()
        call_command('hub_repair_news_media', '--dry-run', stdout=output)
        self.assertTrue(output.getvalue().isascii())
        self.assertEqual(json.loads(output.getvalue())['items'][0]['title'], entry.published['title'])
