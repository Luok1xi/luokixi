"""Local community workbench. Identity/roles must be added before public hosting."""
from __future__ import annotations
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit, quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

TZ = timezone(timedelta(hours=8))
CATEGORIES = ('机电与机器人', '软件与 AI', '课程与资料', '算法与编程', '其他')
TOPICS = ('提问', '协作招募', '资料纠错', '想法')

def now():
    return datetime.now(timezone.utc).isoformat()

def text(value, label, maximum=200, minimum=1):
    if not isinstance(value, str):
        raise ValueError(f'{label}需要文字。')
    value = value.strip()
    if not minimum <= len(value) <= maximum:
        raise ValueError(f'{label}请填写 {minimum}–{maximum} 个字符。')
    return value

def init_db(connection):
    with connection() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS community_entries (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
          summary TEXT NOT NULL, category TEXT NOT NULL, author TEXT NOT NULL,
          url TEXT NOT NULL, tags TEXT NOT NULL, license TEXT NOT NULL,
          body TEXT NOT NULL, setup TEXT NOT NULL, needs TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', created TEXT NOT NULL,
          reviewed TEXT, reason TEXT DEFAULT '', UNIQUE(kind,url,author));
        CREATE TABLE IF NOT EXISTS community_events (
          id TEXT PRIMARY KEY, target TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
          author TEXT NOT NULL, title TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS community_topics (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL,
          author TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL,
          created TEXT NOT NULL, accepted TEXT DEFAULT '');
        CREATE TABLE IF NOT EXISTS community_replies (
          id TEXT PRIMARY KEY, topic TEXT NOT NULL, author TEXT NOT NULL,
          body TEXT NOT NULL, created TEXT NOT NULL,
          FOREIGN KEY(topic) REFERENCES community_topics(id));
        CREATE TABLE IF NOT EXISTS community_repo_cache (
          repo TEXT PRIMARY KEY, payload TEXT NOT NULL, checked TEXT NOT NULL);
        ''')

def source_url(raw, kind):
    raw = text(raw, '来源链接', 500)
    u = urlsplit(raw)
    if u.scheme != 'https' or u.username or u.password or u.port not in (None, 443):
        raise ValueError('请使用不含账号密码的 HTTPS 原始链接。')
    host = (u.hostname or '').lower()
    path = u.path.rstrip('/')
    if kind == 'project':
        if host not in ('github.com', 'gitee.com', 'codeberg.org', 'gitlab.com') or not re.fullmatch(r'/[\w.-]+/[\w.-]+', path):
            raise ValueError('请填写 GitHub、Gitee、Codeberg 或 GitLab 的 owner/repository 仓库主页。')
    elif kind == 'solution':
        if not ((host in ('leetcode.cn','leetcode.com') and re.fullmatch(r'/problems/[a-z0-9-]+(?:/description)?', path)) or
                (host == 'www.luogu.com.cn' and re.fullmatch(r'/problem/[A-Za-z0-9_-]+', path))):
            raise ValueError('请填写洛谷 /problem/题号 或力扣 /problems/题目名称/ 的原题链接。')
    else:
        raise ValueError('不支持的投稿类型。')
    if path.endswith('/description'):
        path = path[:-12]
    return 'https://' + host + path

def entry(row):
    d = dict(row)
    d['tags'] = json.loads(d['tags'])
    return d

def add_entry(connection, data):
    kind = data.get('kind')
    url = source_url(data.get('url'), kind)
    category = data.get('category')
    if category not in CATEGORIES:
        raise ValueError('请选择项目方向。')
    if data.get('rightsConfirmed') is not True:
        raise ValueError('请先确认来源与分享权限。')
    tags = data.get('tags', [])
    if not isinstance(tags, list) or len(tags)>6:
        raise ValueError('最多填写 6 个标签。')
    values = (uuid.uuid4().hex, kind, text(data.get('title'), '标题', 100),
              text(data.get('summary'), '简述', 300, 8), category,
              text(data.get('author'), '署名', 40), url,
              json.dumps([text(t,'标签',24) for t in tags], ensure_ascii=False),
              text(data.get('license','未说明'), '许可', 100),
              text(data.get('body',''), '详细说明', 12000, 0),
              text(data.get('setup',''), '复现条件', 2000, 0),
              text(data.get('needs',''), '希望得到的帮助', 1000, 0), now())
    with connection() as c:
        duplicate_sql = 'SELECT id FROM community_entries WHERE kind=? AND url=?' + (' AND author=?' if kind=='solution' else '')
        duplicate_args = (kind,url,values[5]) if kind=='solution' else (kind,url)
        if c.execute(duplicate_sql, duplicate_args).fetchone():
            raise ValueError('这个来源已投稿，请在待核对或已收录列表查看。')
        c.execute('''INSERT INTO community_entries
          (id,kind,title,summary,category,author,url,tags,license,body,setup,needs,created)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''', values)
    return {'id':values[0], 'status':'pending'}

def review(connection, data):
    status = data.get('status')
    if status not in ('approved','rejected'):
        raise ValueError('请选择收录或退回。')
    reason = text(data.get('reason',''), '核对说明', 1000, 1 if status=='rejected' else 0)
    if status=='approved' and data.get('checked') is not True:
        raise ValueError('收录前请核对来源、署名和许可。')
    with connection() as c:
        row = c.execute('SELECT * FROM community_entries WHERE id=?', (data.get('id'),)).fetchone()
        if not row or row['status']!='pending':
            raise ValueError('投稿不存在或已经处理。')
        stamp = now()
        c.execute('UPDATE community_entries SET status=?,reviewed=?,reason=? WHERE id=?', (status,stamp,reason,row['id']))
        if status=='approved':
            c.execute('INSERT INTO community_events VALUES (?,?,?,?,?,?)', (uuid.uuid4().hex,row['id'],row['kind'],row['author'],row['title'],stamp))
    return {'ok':True, 'status':status}

def activity(connection):
    today = datetime.now(TZ).date()
    first = today - timedelta(days=181)
    days = {(first+timedelta(days=i)).isoformat():0 for i in range(182)}
    people = {}
    with connection() as c:
        events = [dict(r) for r in c.execute('SELECT * FROM community_events ORDER BY created DESC')]
    for item in events:
        day = datetime.fromisoformat(item['created']).astimezone(TZ).date().isoformat()
        if day in days:
            days[day] += 1
            people[item['author']] = people.get(item['author'],0)+1
    return {'days':[{'date':day,'count':count} for day,count in days.items()],
            'total':sum(days.values()), 'activeDays':sum(v>0 for v in days.values()),
            'contributors':[{'name':k,'count':v} for k,v in sorted(people.items(), key=lambda kv:(-kv[1],kv[0]))],
            'events':events[:80], 'timezone':'Asia/Shanghai',
            'definition':'近 182 天已收录项目、题解与被采纳回复；每项只记一次。署名由投稿者填写，不代表平台身份认证。'}

def list_topics(connection):
    with connection() as c:
        return [dict(r) for r in c.execute('''SELECT t.*, (SELECT count(*) FROM community_replies r WHERE r.topic=t.id) replies
            FROM community_topics t ORDER BY created DESC LIMIT 100''')]

def add_topic(connection,data):
    category = data.get('category')
    if category not in TOPICS:
        raise ValueError('请选择讨论分类。')
    row = (uuid.uuid4().hex, text(data.get('title'),'讨论标题',100),category,
           text(data.get('author'),'署名',40),text(data.get('body'),'讨论内容',12000,10),'open',now())
    with connection() as c:
        c.execute('INSERT INTO community_topics(id,title,category,author,body,state,created) VALUES (?,?,?,?,?,?,?)',row)
    return {'id':row[0]}

def add_reply(connection,data):
    rid=uuid.uuid4().hex
    with connection() as c:
        topic=c.execute('SELECT * FROM community_topics WHERE id=?',(data.get('topic'),)).fetchone()
        if not topic or topic['state']=='closed':
            raise ValueError('讨论不存在或已关闭。')
        c.execute('INSERT INTO community_replies VALUES (?,?,?,?,?)',(rid,topic['id'],text(data.get('author'),'署名',40),text(data.get('body'),'回复',8000,2),now()))
    return {'id':rid}

def topic_action(connection,data):
    action=data.get('action')
    with connection() as c:
        topic=c.execute('SELECT * FROM community_topics WHERE id=?',(data.get('id'),)).fetchone()
        if not topic: raise ValueError('讨论不存在。')
        if action=='solve':
            reply=c.execute('SELECT * FROM community_replies WHERE id=? AND topic=?',(data.get('reply'),topic['id'])).fetchone()
            if not reply: raise ValueError('请选择这个讨论中的回复。')
            if topic['state']!='open': raise ValueError('讨论已解决或已关闭。')
            c.execute('UPDATE community_topics SET state="solved",accepted=? WHERE id=?',(reply['id'],topic['id']))
            c.execute('INSERT OR IGNORE INTO community_events VALUES (?,?,?,?,?,?)',(uuid.uuid4().hex,topic['id'],'help',reply['author'],topic['title'],now()))
        elif action=='close':
            c.execute('UPDATE community_topics SET state="closed" WHERE id=?',(topic['id'],))
        else: raise ValueError('无效讨论操作。')
    return {'ok':True}

def github_repo(connection,raw):
    url=source_url(raw,'project')
    if urlsplit(url).hostname!='github.com':
        raise ValueError('自动核对目前支持 GitHub。其他托管平台可提交链接，由维护者核对。')
    repo=urlsplit(url).path.strip('/')
    with connection() as c:
        cached=c.execute('SELECT * FROM community_repo_cache WHERE repo=?',(repo,)).fetchone()
    if cached and datetime.now(timezone.utc)-datetime.fromisoformat(cached['checked'])<timedelta(minutes=15):
        return dict(json.loads(cached['payload']),cached=True)
    req=Request('https://api.github.com/repos/'+quote(repo,safe='/'),headers={'Accept':'application/vnd.github+json','User-Agent':'LuokixiCampusLibrary/1.0'})
    try:
        with urlopen(req,timeout=12) as response:
            if urlsplit(response.url).hostname!='api.github.com':
                raise ValueError('GitHub 返回了意外地址。')
            raw=response.read(1024*1024+1)
            if len(raw)>1024*1024: raise ValueError('仓库信息过大。')
            result=json.loads(raw)
    except HTTPError as error:
        if error.code in (403,429): raise ValueError('GitHub 暂时限制查询频率，请稍后重试；仍可手动填写并提交链接。') from error
        if error.code==404: raise ValueError('未找到公开仓库；本功能不访问私有代码。') from error
        raise ValueError('GitHub 查询失败，请稍后重试。') from error
    except URLError as error:
        raise ValueError('暂时连接不上 GitHub，请稍后重试。') from error
    if result.get('private') or not result.get('full_name'): raise ValueError('仅支持公开仓库。')
    checked=now()
    payload={'name':result['full_name'],'url':result['html_url'],'description':result.get('description') or '',
             'license':(result.get('license') or {}).get('spdx_id') or '未说明',
             'language':result.get('language') or '', 'stars':result.get('stargazers_count',0),
             'forks':result.get('forks_count',0),'openIssues':result.get('open_issues_count',0),
             'archived':bool(result.get('archived')), 'updated':result.get('pushed_at'),
             'checked':checked,'cached':False,'notice':'公开仓库信息不证明投稿者拥有该仓库；星标也不表示质量认证。'}
    with connection() as c:
        c.execute('INSERT OR REPLACE INTO community_repo_cache VALUES (?,?,?)',(repo,json.dumps(payload,ensure_ascii=False),checked))
    return payload

def handle(method,path,query,data,connection):
    if method=='GET':
        if path=='/api/community':
            with connection() as c:
                entries=[entry(r) for r in c.execute('SELECT * FROM community_entries ORDER BY created DESC')]
            return {'entries':entries,'activity':activity(connection),'topics':list_topics(connection),
                    'localOnly':True,'categories':CATEGORIES,'identity':'self-declared'}
        if path=='/api/community/repo': return github_repo(connection,query.get('url'))
        if path=='/api/community/topic':
            with connection() as c:
                row=c.execute('SELECT * FROM community_topics WHERE id=?',(query.get('id'),)).fetchone()
                if not row: raise ValueError('讨论不存在。')
                return {'topic':dict(row),'replies':[dict(r) for r in c.execute('SELECT * FROM community_replies WHERE topic=? ORDER BY created',(row['id'],))]}
    if method=='POST':
        if path=='/api/community/submit': return add_entry(connection,data)
        if path=='/api/community/review': return review(connection,data)
        if path=='/api/community/topics': return add_topic(connection,data)
        if path=='/api/community/replies': return add_reply(connection,data)
        if path=='/api/community/topic-action': return topic_action(connection,data)
    raise ValueError('社区操作不存在。')
