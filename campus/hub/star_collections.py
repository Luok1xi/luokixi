"""Private saved-content list, ordered by the user's real save time."""
from django.db.models import Count
from .core import entry_data, require
from .models import EntryView, Reply, Star, Watch


def starred_entries(user):
    """Return at most 200 visible saves in five queries, regardless of list length."""
    require(user)
    stars = list(Star.objects.filter(user=user, entry__public_revision__gt=0)
                 .exclude(entry__state='withdrawn').select_related('entry__owner')
                 .order_by('-created', '-pk')[:200])
    if not stars:
        return []
    entry_ids = [star.entry_id for star in stars]

    def counts(queryset):
        return dict(queryset.filter(entry_id__in=entry_ids).values('entry_id')
                    .annotate(total=Count('pk')).values_list('entry_id', 'total'))

    star_counts = counts(Star.objects.all())
    view_counts = counts(EntryView.objects.all())
    reply_counts = counts(Reply.objects.filter(state='published'))
    watches = dict(Watch.objects.filter(user=user, entry_id__in=entry_ids)
                   .values_list('entry_id', 'events'))
    result = []
    for star in stars:
        data = entry_data(star.entry, user,
            counts={'siteStars': star_counts.get(star.entry_id, 0),
                    'views': view_counts.get(star.entry_id, 0),
                    'replyCount': reply_counts.get(star.entry_id, 0)},
            interaction={'starred': True, 'collection': star.collection,
                         'watch': watches.get(star.entry_id, [])})
        data['starredAt'] = star.created.isoformat()
        result.append(data)
    return result
