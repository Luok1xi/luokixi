"""Automatic choice among existing original illustrations; never fake documentary photos."""
import re
from .models import Entry


def choose(data):
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


def sweep():
    from .editorial_art import VERSION
    count = examined = preserved = unavailable = conflicts = 0
    for entry in Entry.objects.filter(state='published').iterator():
        examined += 1
        data = entry.published
        if data.get('uploads') or data.get('media', {}).get('src') or data.get('autoMedia', {}).get('method') == f'article-editorial-v{VERSION}':
            preserved += 1; continue
        media = choose(data)
        if not media['url']: unavailable += 1; continue
        # Conditional update preserves simultaneous author edits.
        published = dict(data, autoMedia=media)
        fields = {'published': published}
        if entry.draft == data: fields['draft'] = published
        changed = Entry.objects.filter(pk=entry.pk, revision=entry.revision, published=data).update(**fields)
        count += changed
        if not changed: conflicts += 1
    return {'examined': examined, 'illustrated': count, 'preserved': preserved, 'unavailable': unavailable,
            'concurrentChanges': conflicts, 'errors': []}
