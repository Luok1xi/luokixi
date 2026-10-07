"""Resolve trusted actions for existing robot notices; reading is never approval."""
from .models import Entry, ExternalCache, Notification


def inbox(user):
    records = Notification.objects.filter(user=user).order_by('-created', '-pk')
    notices = list(records[:100])
    actions = {}
    if user.is_staff:
        keys = {n.key.split(':', 1)[0] for n in notices if n.event == 'maintenance'}
        if 'github-candidates' in keys:
            pending = sum(1 for data in ExternalCache.objects.filter(key__startswith='github:').values_list('data', flat=True)
                          if data.get('discovery') and not data.get('selection'))
            actions['github-candidates'] = {'kind': 'review-github', 'label': '查看并审核项目', 'pending': pending}
        if 'maint-news' in keys:
            pending = Entry.objects.filter(kind='news', state='pending', slug__startswith='news-').count()
            actions['maint-news'] = {'kind': 'review-news', 'label': '查看并审核新闻', 'pending': pending}
        actions['maint-links'] = {'kind': 'maintenance', 'label': '查看链接巡检'}
        if 'github-guides' in keys:
            pending = sum(1 for d in ExternalCache.objects.filter(key__startswith='github:').values_list('data',flat=True)
                          if (d.get('guide') or {}).get('reviewState')=='pending')
            actions['github-guides']={'kind':'review-guides','label':'查看并审核中文导读','pending':pending}
        if 'supervisor' in keys:
            from .supervisor import status
            s=status()
            actions['supervisor']={'kind':'review-supervisor','label':'回复北矿娘 / 核对公告','pending':len(s['cases'])+len(s['announcements'])}
    return {'unread': records.filter(read=False).count(), 'items': [
        {'id': n.pk, 'entry': str(n.entry_id) if n.entry_id else None,
         'event': n.event, 'text': n.text, 'read': n.read, 'created': n.created.isoformat(),
         'action': actions.get(n.key.split(':', 1)[0]) if n.event == 'maintenance' else None}
        for n in notices]}
