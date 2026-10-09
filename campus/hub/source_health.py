"""Maintainer-only source provenance and the most recent parsing result."""
from .core import require
from .models import ExternalCache, Source


def list_sources(request):
    require(request.user, staff=True)
    sources = list(Source.objects.order_by('name')[:200])
    checks = {row.key: row for row in ExternalCache.objects.filter(key__in=['source-health:' + str(source.pk) for source in sources])}
    items = []
    for source in sources:
        check = checks.get('source-health:' + str(source.pk))
        data = check.data if check else {}
        items.append({'id': str(source.pk), 'name': source.name, 'url': source.url, 'kind': source.kind,
                      'entryKind': source.entry_kind, 'enabled': source.enabled, 'intervalHours': source.interval_hours,
                      'metadata': source.metadata, 'lastSuccess': source.last_success, 'lastAttempt': source.last_attempt,
                      'status': 'failed' if source.error else data.get('status', 'unchecked'),
                      'matched': data.get('matched'), 'pending': data.get('pending'), 'error': source.error})
    return {'items': items}
