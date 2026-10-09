"""Prefer verified source images; use explicitly marked thematic covers only as a fallback."""
import re
from .models import Entry


def choose(data, fetch_source=False):
    from .source_media import resolve
    original = resolve(data, refresh=fetch_source)
    if original:
        return original
    text = ' '.join(str(data.get(k) or '') for k in ('category','course','title','summary','tags'))
    slot = next((s for pattern, s in [
        (r'嵌入式|embedded|电路|单片机', 'project-embedded'), (r'机械|机电|mech', 'project-mech'),
        (r'科研|论文|research|AI|模型|人工智能', 'hero-open-research'),
        (r'英语|六级|四级|CET', 'mat-cet'), (r'数学|微积分|高数', 'mat-calc'),
        (r'线性|代数', 'mat-linalg'), (r'算法|algo', 'project-algo'),
        (r'物理|力学', 'mat-physics'), (r'化学|材料', 'mat-chem'),
        (r'程序|编程|软件|software|服务器|维护', 'project-software'),
        (r'课程|学习|资料|course', 'board-materials')]
        if re.search(pattern, text, re.I)), 'hero-circle')
    from .editorial_art import cover
    return cover(data, slot)


def sweep(source_limit=12):
    from .editorial_art import VERSION
    from .source_media import generated, needs_refresh
    count = examined = preserved = unavailable = conflicts = recovered = source_checks = 0
    errors = []
    for entry in Entry.objects.filter(state='published').iterator():
        examined += 1
        data = entry.published
        if data.get('uploads') or data.get('media', {}).get('src'):
            preserved += 1; continue
        fetch = source_checks < source_limit and needs_refresh(data)
        source_checks += int(fetch)
        media = choose(data, fetch_source=fetch)
        if fetch:
            from .source_media import cache_key
            from .models import ExternalCache
            checked = ExternalCache.objects.filter(pk=cache_key(data)).first()
            if checked and checked.error:
                errors.append(str(data.get('title',''))[:60] + '：' + checked.error)
        if not generated(data.get('autoMedia')) and generated(media):
            preserved += 1; continue
        if media == data.get('autoMedia'):
            preserved += 1; continue
        if not media['url']: unavailable += 1; continue
        # Conditional update preserves simultaneous author edits.
        published = dict(data, autoMedia=media)
        fields = {'published': published}
        if entry.draft == data: fields['draft'] = published
        changed = Entry.objects.filter(pk=entry.pk, revision=entry.revision, published=data).update(**fields)
        count += changed
        recovered += int(bool(changed) and not generated(media))
        if not changed: conflicts += 1
    return {'examined': examined, 'illustrated': count, 'preserved': preserved, 'unavailable': unavailable,
            'concurrentChanges': conflicts, 'sourceRecovered': recovered, 'sourceChecks': source_checks, 'errors': errors}
