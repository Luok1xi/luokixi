"""Bounded, reviewable metadata repair; does not crop, replace, or publish images."""
import hashlib
import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from hub import maintenance, news_media
from hub.models import Audit, Entry


def fingerprint(data):
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def dimensions(data):
    nested = data.get('dimensions') or {}
    try:
        width, height = int(data.get('width') or nested.get('width') or 0), int(data.get('height') or nested.get('height') or 0)
    except (TypeError, ValueError, OverflowError):
        return None
    if width < 240 or height < 160 or width * height > 20_000_000 or not .35 <= width / height <= 4:
        return None
    return {'width': width, 'height': height,
            'fit': 'contain' if width / height < 1.05 else 'cover', 'position': '50% 50%'}


class Command(BaseCommand):
    help = 'Inspect published news image dimensions; --apply changes only display metadata and writes an audit receipt.'

    def add_arguments(self, parser):
        mode = parser.add_mutually_exclusive_group()
        mode.add_argument('--dry-run', action='store_true', help='Read-only plan (the default).')
        mode.add_argument('--apply', action='store_true', help='Explicitly apply the bounded metadata repair.')
        parser.add_argument('--limit', type=int, default=12, help='Maximum articles to inspect/apply; 1–50.')
        parser.add_argument('--entry', action='append', default=[], help='Optional exact entry IDs.')
        parser.add_argument('--plan', help='Reuse a prior JSON dry-run plan; no network requests.')

    def handle(self, *args, **options):
        limit = options['limit']
        if not 1 <= limit <= 50:
            raise CommandError('--limit must be between 1 and 50.')
        if options['plan']:
            try:
                path = Path(options['plan'])
                if path.stat().st_size > 1024 * 1024:
                    raise ValueError('plan exceeds 1 MiB')
                plan = json.loads(path.read_text('utf-8-sig'))
                if plan.get('version') != 1 or not isinstance(plan.get('items'), list):
                    raise ValueError('unrecognized plan')
                if not all(isinstance(item, dict) for item in plan['items']):
                    raise ValueError('invalid plan item')
                if options['entry']:
                    plan['items'] = [item for item in plan['items'] if item.get('id') in options['entry']]
                plan['items'] = plan['items'][:limit]
            except (OSError, ValueError, TypeError) as exc:
                raise CommandError(f'Cannot read media repair plan: {exc}') from exc
        else:
            plan = self.inspect(limit, options['entry'])
        results = []
        if options['apply']:
            for item in plan['items']:
                if item.get('status') == 'ready':
                    results.append(self.apply(item))
        plan.update(mode='applied' if options['apply'] else 'dry-run', results=results,
                    applied=sum(item['status'] == 'applied' for item in results))
        # Windows redirected stdout may use GBK/CP936. JSON escapes retain the
        # exact Chinese strings while avoiding an encoding error after commit.
        self.stdout.write(json.dumps(plan, ensure_ascii=True, indent=2))

    def inspect(self, limit, identifiers):
        entries = Entry.objects.filter(kind='news', state='published').order_by('-updated')
        if identifiers:
            entries = entries.filter(pk__in=identifiers)
        items, cached, requests = [], {}, 0
        for entry in entries.iterator():
            media = entry.published.get('media') or {}
            if not isinstance(media, dict) or not media.get('src'):
                continue
            known = dimensions(media)
            if known and media.get('width') and media.get('height') and media.get('fit') in ('contain', 'cover'):
                continue
            if len(items) >= limit:
                break
            row = {'id': str(entry.pk), 'title': entry.published.get('title', ''), 'revision': entry.revision,
                   'expectedPublished': fingerprint(entry.published), 'before': media}
            try:
                if known:
                    info, via = known, 'existing-dimensions'
                elif media['src'] in cached:
                    info, via = cached[media['src']], 'batch-cache'
                else:
                    # Uses the existing public-only DNS pinning/redirect checks,
                    # robots policy, 15 s socket timeout and 4 MiB response cap.
                    requests += 1
                    raw, final = maintenance.get_page(media['src'], news_media.MAX_IMAGE_BYTES)
                    info = news_media.metadata(raw)
                    cached[media['src']] = info
                    via = 'verified-image'
                proposed = dimensions(info)
                if not proposed:
                    raise ValueError('invalid image dimensions')
                # Respect a prior explicit focal position or fit decision.
                proposed['position'] = media.get('position') or proposed['position']
                proposed['fit'] = media.get('fit') if media.get('fit') in ('contain', 'cover') else proposed['fit']
                row.update(status='ready', metadata=proposed, evidence=via)
            except Exception as exc:
                row.update(status='error', error=str(exc)[:200])
            items.append(row)
        return {'version': 1, 'generatedAt': timezone.now().isoformat(), 'checked': len(items),
                'imageRequests': requests, 'items': items}

    def apply(self, item):
        identifier = item.get('id')
        info = dimensions(item.get('metadata') or {})
        if not info:
            return {'id': identifier, 'status': 'invalid-metadata'}
        with transaction.atomic():
            entry = Entry.objects.select_for_update().filter(pk=identifier, kind='news', state='published').first()
            if not entry or entry.revision != item.get('revision') or fingerprint(entry.published) != item.get('expectedPublished'):
                return {'id': identifier, 'status': 'changed-since-plan'}
            old = entry.published.get('media') or {}
            if old != item.get('before') or not old.get('src'):
                return {'id': identifier, 'status': 'changed-since-plan'}
            # A plan cannot change source, crop, credit, article text or status.
            # Position/fit chosen explicitly by an author remain untouched.
            info['position'] = old.get('position') or info['position']
            info['fit'] = old.get('fit') if old.get('fit') in ('contain', 'cover') else info['fit']
            new = {**old, **info, 'selectionVersion': news_media.VERSION}
            if new == old:
                return {'id': identifier, 'status': 'unchanged'}
            published = {**entry.published, 'media': new}
            fields = {'published': published, 'updated': timezone.now()}
            draft_updated = entry.draft.get('media') == old
            if draft_updated:
                fields['draft'] = {**entry.draft, 'media': new}
            Entry.objects.filter(pk=entry.pk).update(**fields)
            receipt = Audit.objects.create(action='news:media-metadata', target=str(entry.pk), detail={
                'command': 'hub_repair_news_media', 'before': old, 'after': new,
                'evidence': item.get('evidence', ''), 'draftUpdated': draft_updated,
                'revision': entry.revision, 'publicRevision': entry.public_revision})
            return {'id': identifier, 'status': 'applied', 'auditId': receipt.pk}
