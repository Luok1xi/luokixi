"""Website-owned tools and source-bearing memory. No arbitrary commands or model writes."""
import hashlib
import json
import os
import re
import sqlite3
from pathlib import Path
from contextlib import closing
from django.utils import timezone
from .core import Problem, require, text
from .models import BeikuangMessage, BeikuangTask, ExternalCache, Job
from .beikuang_memory import normal, memory_key, recall


TOOLS = {
    'site_status': {'title': '网站工作状态', 'mode': 'read'},
    'library_search': {'title': '资料库检索', 'mode': 'read'},
    'library_read': {'title': '阅读资料正文', 'mode': 'read'},
    'audit_queue': {'title': '审核队列', 'mode': 'read'},
    'audit_lessons': {'title': '有出处的审核经验', 'mode': 'read'},
    'recall': {'title': '本站对话记忆', 'mode': 'read'},
    'remember': {'title': '记住明确偏好', 'mode': 'owner-command'},
    'forget': {'title': '忘记指定记忆', 'mode': 'owner-command'},
    'review': {'title': '安排自主巡检', 'mode': 'owner-command'},
    'work_log': {'title': '安排工作日志', 'mode': 'owner-command'},
}
WRITE_TOOLS = {name for name, spec in TOOLS.items() if spec['mode'] == 'owner-command'}


def audit_lessons(owner, limit=8, query=''):
    # Decisions retain their actor, note, evidence and subject. A preference never overrides checks.
    tasks = list(BeikuangTask.objects.filter(decided_by=owner.username, state__in=('published', 'dismissed', 'answered')).order_by('-decided')[:80])
    if query:
        from .beikuang_memory import terms
        wanted = terms(query)
        tasks.sort(key=lambda t: len(wanted & terms(t.title + ' ' + t.kind + ' ' + t.note)), reverse=True)
    return [{'task': str(t.pk), 'kind': t.kind, 'title': t.title, 'decision': t.state,
             'ownerNote': t.note[:240], 'failedChecks': [c['name'] for c in t.checks if not c.get('ok')],
             'source': t.link, 'meaning': '站主历史决定，仅作经验参考，不能代替本次证据'} for t in tasks[:limit]]


def library_path():
    # Fixed configured library only. Never create an empty replacement by importing server.py.
    return Path(os.environ.get('CAMPUS_DATA_DIR', Path(__file__).resolve().parents[1] / '.data')) / 'library.sqlite3'


def library_search(query='', limit=6):
    path = library_path()
    if not path.is_file():
        raise Problem('真实资料库暂时不可读取，未新建空库。', 503)
    query = text(query, 160).replace('高数', '高等数学').replace('线代', '线性代数').replace('大物', '大学物理')
    words = query.split()[:6]
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA query_only=ON')
        clauses, args = [], []
        for word in words:
            clauses.append("instr(lower(title||' '||course||' '||kind),lower(?))>0")
            args.append(word)
        where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
        total = connection.execute('SELECT COUNT(*) FROM documents' + where, args).fetchone()[0]
        rows = connection.execute('SELECT id,title,course,kind,status,source_url,extract_status FROM documents' + where + ' ORDER BY created DESC LIMIT ?', args + [limit]).fetchall()
    return {'query': query, 'total': total, 'items': [dict(r, href='/materials.html?q=' + __import__('urllib.parse', fromlist=['quote']).quote(r['title'])) for r in rows],
            'scope': '本机真实资料目录；pending表示尚未上架，不把索引条目当已下载原件'}


def command_authorized(message, name, arguments):
    words = message.body.strip()
    # The stored owner message, not model output or retrieved web text, grants write authority.
    patterns = {
        'remember': r'^(?:请)?记住[：:]?\s*(.+)$',
        'forget': r'^(?:请)?忘(?:记|掉)[：:]?\s*(.+)$',
        'review': r'^(?:请|帮我)?(?:重新|再|立即|马上)?(?:审核|巡检)(?:一遍|一下|积压|待办)?[。！!\s]*$',
        'work_log': r'^(?:请|帮我)?(?:写|生成)(?:一份|今天的|今日)?(?:工作日志|日志|日报)[。！!\s]*$',
    }
    match = re.fullmatch(patterns[name], words)
    if not match:
        return False
    if name in ('remember', 'forget'):
        return match.group(1).strip() == arguments.get('content', '').strip()
    return True


def library_read(document_id):
    """Read indexed text by ID, never a model-supplied filesystem path or URL."""
    path = library_path()
    if not path.is_file():
        raise Problem('真实资料库暂时不可读取。', 503)
    document_id = text(document_id, 160, True)
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA query_only=ON')
        row = connection.execute('SELECT id,title,course,kind,status,source_url,extract_status,substr(body,1,4500) AS body FROM documents WHERE id=?', [document_id]).fetchone()
        if row is None:
            raise Problem('没有找到这份资料，请先搜索获取资料编号。', 404)
        chunks = connection.execute('SELECT page,substr(text,1,2000) AS text FROM chunks WHERE docid=? ORDER BY page LIMIT 3', [document_id]).fetchall()
    result = dict(row)
    result['pages'] = [dict(p) for p in chunks]
    if chunks:
        result['body'] = ''
    result['hasText'] = bool((result['body'] or '').strip() or any((p['text'] or '').strip() for p in result['pages']))
    result['scope'] = '已提取正文的有限摘录；原件未提取文字时不会假装读过扫描图片。'
    return result


def execute(owner, name, arguments=None, message=None):
    require(owner, staff=True)
    if name not in TOOLS or not isinstance(arguments or {}, dict):
        raise Problem('工具不存在或参数无效。')
    args = arguments or {}
    allowed = {'library_search': {'query'}, 'library_read': {'document_id'}, 'audit_lessons': {'query'},
               'recall': {'query'}, 'remember': {'content'}, 'forget': {'content'}}.get(name, set())
    if set(args) - allowed or any(not isinstance(v, str) for v in args.values()):
        raise Problem('工具参数无效。')
    if name in WRITE_TOOLS:
        if (message is None or message.owner_id != owner.pk or message.role != 'owner'
                or not BeikuangMessage.objects.filter(pk=message.pk, owner=owner, role='owner', body=message.body).exists()
                or not command_authorized(message, name, args)):
            raise Problem('此操作需要当前站主消息中的明确指令。', 403)
    reference = str(message.pk) if message else 'read'
    trace_key = 'beikuang:tool:' + hashlib.sha256(f'{owner.pk}:{reference}:{name}:{json.dumps(args,sort_keys=True)}'.encode()).hexdigest()
    if name in WRITE_TOOLS:
        prior = ExternalCache.objects.filter(pk=trace_key).first()
        if prior and isinstance(prior.data.get('result'), dict):
            result = dict(prior.data['result'])
            if name == 'remember':
                result['alreadyKnown'] = True
            return {'tool': name, 'title': TOOLS[name]['title'], 'status': 'done', 'result': result, 'arguments': args}
    if name == 'site_status':
        from .beikuang import today_stats
        last = ExternalCache.objects.filter(pk='beikuang:last').first()
        result = {'today': today_stats(), 'lastReview': last.data if last else None,
                  'faults': [{'kind': j.kind, 'error': j.error[:240]} for j in Job.objects.filter(state__in=('failed','partial')).order_by('-updated')[:5]]}
    elif name == 'library_search':
        result = library_search(text(args.get('query',''),160))
    elif name == 'library_read':
        result = library_read(args.get('document_id', ''))
    elif name == 'audit_queue':
        from django.db.models import Count
        result = {'counts': list(BeikuangTask.objects.values('kind','state').annotate(count=Count('pk'))),
                  'policy': '照片由北矿娘自行核对和提交；读不到的来源退避重试，异常候选暂存或驳回，不逐张请示。'}
    elif name == 'audit_lessons':
        result = {'items': audit_lessons(owner, query=args.get('query', ''))}
    elif name == 'recall':
        result = {'items': recall(owner,args.get('query',''))}
    elif name == 'remember':
        from .beikuang_memory import forgotten_key
        content=text(args.get('content',''),300,True)
        now=timezone.now()
        memory, made=ExternalCache.objects.get_or_create(key=memory_key(owner,content), defaults={
            'data': {'owner': owner.pk, 'content': content, 'source': message.body, 'message': str(message.pk), 'confirmed': True}, 'checked': now, 'success': now})
        if not memory.data.get('confirmed', True):
            memory.data = dict(memory.data, confirmed=True, source=message.body, message=str(message.pk))
            memory.save(update_fields=['data'])
        ExternalCache.objects.filter(pk=forgotten_key(owner, content)).delete()
        result={'saved': True, 'alreadyKnown': not made, 'content': memory.data['content'], 'source': message.body}
    elif name == 'forget':
        from .beikuang_memory import forget
        result={'forgotten': forget(owner,text(args.get('content',''),300,True)), 'content': args['content']}
    elif name == 'review':
        from .beikuang import queue_review
        queue_review(decided=True)
        result={'queued': True, 'completed': False}
    elif name == 'work_log':
        key=f'beikuang-tool-report:{message.pk}'
        Job.objects.get_or_create(key=key,defaults={'kind':'beikuang-report','payload':{'owner':owner.pk},'due':timezone.now()})
        result={'queued': True, 'completed': False}
    now=timezone.now()
    ExternalCache.objects.update_or_create(key=trace_key, defaults={'data': {'owner':owner.pk,'name':name,'status':'done','message':reference,'result':result},'checked':now,'success':now})
    return {'tool':name,'title':TOOLS[name]['title'],'status':'done','result':result,'arguments':args}


def prepare_context(message, reads=True, memories=True):
    owner, words = message.owner, message.body.strip()
    results=[]
    def collect(name,args=None):
        try:
            results.append(execute(owner,name,args,message))
        except (Problem,sqlite3.Error,OSError) as exc:
            results.append({'tool':name,'title':TOOLS[name]['title'],'status':'failed','result':{'error':exc.message if isinstance(exc,Problem) else '站内工具暂时无法完成，稍后可重试。'}})
    for name in ('remember','forget','review','work_log'):
        content=re.sub(r'^(?:请)?(?:记住|忘记|忘掉)[：:]?\s*','',words)
        args={'content':content} if name in ('remember','forget') else {}
        if command_authorized(message,name,args):
            collect(name,args)
            break
    searching=re.search(r'^(?:请|帮我)?(?:搜(?:索|一下)?|找(?:找|一下)?|查(?:查|一下)?)(?:资料库[：:]?)?\s*(.*)$',words)
    if reads and searching and ('资料' in words or searching.group(1)):
        query=searching.group(1).replace('资料库','').strip()
        collect('library_search',{'query':query})
    if reads and re.search(r'进度|今日|今天.*(情况|工作|发布)|审核|待办|资料|机器人|故障|巡检',words):
        collect('site_status')
    if reads and re.search(r'审核|待办|积压|效率',words):
        collect('audit_queue')
    return {'tools': results[:4], 'memories': recall(owner,words) if memories else [],
            'auditLessons': audit_lessons(owner, query=words) if reads and re.search(r'审核|待办|经验|学习',words) else [],
            'capabilities': TOOLS}
