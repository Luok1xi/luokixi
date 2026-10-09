"""Local, open-source campus library. Run: python server.py --port 17860."""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import mimetypes
import os
import re
import socket
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlsplit, unquote, quote
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from urllib.robotparser import RobotFileParser
import community

ROOT = Path(__file__).resolve().parent
STATIC = Path(os.environ.get('CAMPUS_STATIC_DIR', ROOT.parent / 'dist'))
DATA = Path(os.environ.get('CAMPUS_DATA_DIR', ROOT / '.data'))
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / 'library.sqlite3'
LOCK = threading.RLock()
JOB_LOCK = threading.Lock()
USER_AGENT = 'LuokixiCampusLibrary/1.0 (public educational resource indexing)'
MAX_BYTES = 25 * 1024 * 1024
HUB_PORT = int(os.environ.get('CAMPUS_HUB_PORT','17861'))
COURSES = ['高等数学 A1', '高等数学 A2', '线性代数', '大学物理', '概率论与数理统计', '大学英语', '英语四级', '英语六级', '程序设计', '数据结构', '电路', '思想政治', '专业课程', '未分类']

def now():
    return datetime.now(timezone.utc).isoformat()

@contextmanager
def connection():
    c = sqlite3.connect(DB, timeout=20)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    try:
        yield c
        c.commit()
    except BaseException:
        c.rollback()
        raise
    finally:
        c.close()

def init_db():
    community.init_db(connection)
    with connection() as c:
        c.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, course TEXT NOT NULL,
          year TEXT DEFAULT '', kind TEXT DEFAULT '资料', scope TEXT DEFAULT '外部资料',
          source_url TEXT DEFAULT '', origin TEXT NOT NULL, status TEXT NOT NULL,
          rights TEXT DEFAULT '来源版权保留，未获转载授权', sha256 TEXT UNIQUE,
          file_path TEXT DEFAULT '', body TEXT DEFAULT '', pages INTEGER DEFAULT 0,
          format TEXT DEFAULT 'html', created TEXT NOT NULL, extract_status TEXT DEFAULT '',
          group_key TEXT DEFAULT '');
        CREATE TABLE IF NOT EXISTS chunks (docid TEXT, page INTEGER, text TEXT,
          PRIMARY KEY(docid,page), FOREIGN KEY(docid) REFERENCES documents(id) ON DELETE CASCADE);
        CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(docid UNINDEXED, page UNINDEXED, text, tokenize='trigram');
        CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, docid TEXT NOT NULL, page INTEGER,
          question TEXT NOT NULL, answer TEXT DEFAULT '', due TEXT NOT NULL,
          attempts INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, last_result TEXT DEFAULT '',
          created TEXT NOT NULL, FOREIGN KEY(docid) REFERENCES documents(id));
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,state TEXT,progress INTEGER DEFAULT 0,
          total INTEGER DEFAULT 0,message TEXT,created TEXT, details TEXT DEFAULT '[]');
        CREATE TABLE IF NOT EXISTS courses (name TEXT PRIMARY KEY);
        ''')
        c.executemany('INSERT OR IGNORE INTO courses VALUES (?)', [(s,) for s in COURSES])
        c.execute("UPDATE jobs SET state='interrupted', message='服务重启，任务已中断，可重新提交；已抓取内容保留。' WHERE state IN ('queued','running')")

def pdf_pages(path):
    from pypdf import PdfReader
    reader = PdfReader(path)
    return [(i+1, (page.extract_text() or '').replace('\x00', '')) for i,page in enumerate(reader.pages)]

def put_document(doc, chunks):
    doc = dict(doc, created=now())
    with LOCK, connection() as c:
        previous = c.execute('SELECT id FROM documents WHERE sha256=?', (doc['sha256'],)).fetchone()
        if previous:
            return previous['id'], False
        names = list(doc)
        c.execute('INSERT INTO documents ('+','.join(names)+') VALUES ('+','.join('?' for _ in names)+')', list(doc.values()))
        for page, text in chunks:
            c.execute('INSERT INTO chunks VALUES (?,?,?)', (doc['id'],page,text))
            c.execute('INSERT INTO page_search VALUES (?,?,?)', (doc['id'],page,text))
        c.execute('INSERT OR IGNORE INTO courses VALUES (?)', (doc['course'],))
    return doc['id'], True

def public_doc(row):
    from local_course_links import course_for_document
    return {**{k:row[k] for k in row.keys() if k not in ('file_path','body')}, 'course_id': course_for_document(row)}

def catalogue(q='',course='',scope='',kind='',status='ready',offset=0):
    q = q.strip()[:160]
    q = q.replace('高数','高等数学').replace('线代','线性代数').replace('大物','大学物理')
    terms = q.split()[:8]
    clauses, args = ['d.status=?'], [status]
    for col,val in [('course',course),('scope',scope),('kind',kind)]:
        if val:
            clauses.append('d.'+col+'=?'); args.append(val)
    with connection() as c:
        rows = c.execute('SELECT d.* FROM documents d WHERE '+' AND '.join(clauses)+''' ORDER BY CASE scope WHEN '本校资料' THEN 0 WHEN '通用考试' THEN 1 ELSE 2 END, CASE WHEN year GLOB '[0-9]*' THEN 0 ELSE 1 END, year DESC, title''', args).fetchall()
        hits = {}
        if terms:
            for term in terms:
                if len(term)>=3:
                    match='"'+term.replace('"','""')+'"'
                    matches=c.execute('SELECT docid,page,text FROM page_search WHERE page_search MATCH ? LIMIT 5000',(match,)).fetchall()
                else:
                    matches=c.execute('SELECT docid,page,text FROM chunks WHERE instr(lower(text),lower(?))>0 LIMIT 5000',(term,)).fetchall()
                for m in matches:
                    hits.setdefault(m['docid'],{}).setdefault(term,m)
        found=[]
        for row in rows:
            meta=' '.join(str(row[k]) for k in ('title','course','year','kind','scope')).lower()
            if terms and not all(t.lower() in meta or t in hits.get(row['id'],{}) for t in terms):
                continue
            item=public_doc(row)
            item['match_page']=1
            item['snippet']='扫描资料可查看原卷；未做 OCR 或自动判题。' if row['extract_status']=='scan' else row['extract_status']
            hit=next(iter(hits.get(row['id'],{}).values()),None)
            if hit:
                text=hit['text']; idx=next((text.lower().find(t.lower()) for t in terms if t.lower() in text.lower()),0)
                item['snippet']=' '.join(text[max(0,idx-55):idx+220].split())
                item['match_page']=hit['page']
            item['score']=sum(12 for t in terms if t.lower() in row['title'].lower())+len(hits.get(row['id'],{}))
            found.append(item)
        if terms: found.sort(key=lambda d:d['score'],reverse=True)
        return {'items':found[offset:offset+30], 'total':len(found), 'offset':offset}

def validate_url(url):
    parsed=urlsplit(url)
    if parsed.scheme not in ('https','http') or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None,80,443):
        raise ValueError('请使用不含账号信息的公开 http/https 网址。')
    host=parsed.hostname.lower()
    if host=='localhost' or host.endswith(('.local','.localhost')):
        raise ValueError('采集目标须为公开网站。')
    addresses=socket.getaddrinfo(host,parsed.port or (443 if parsed.scheme=='https' else 80),type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0].split('%')[0]).is_global for a in addresses):
        raise ValueError('不能采集本机、内网或保留地址。')
    return parsed

class CheckedRedirect(HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        validate_url(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

def download(url,limit=MAX_BYTES):
    validate_url(url)
    with build_opener(CheckedRedirect()).open(Request(url,headers={'User-Agent':USER_AGENT}),timeout=20) as response:
        if int(response.headers.get('Content-Length','0'))>limit: raise ValueError('文件超过 25 MB 上限。')
        body=response.read(limit+1)
        if len(body)>limit: raise ValueError('内容超过本次采集大小上限。')
        return body, response.headers.get('Content-Type',''),response.url

def robots_allowed(url,cache):
    p=validate_url(url)
    origin=f'{p.scheme}://{p.netloc}'
    if origin not in cache:
        robot=RobotFileParser()
        try:
            raw,_,_=download(origin+'/robots.txt',1024*1024)
            robot.parse(raw.decode('utf-8',errors='replace').splitlines())
        except HTTPError as e:
            if e.code==404: robot.parse([])
            else: raise ValueError(f'robots.txt 返回 {e.code}，此次采集停止。')
        cache[origin]=robot
    if not cache[origin].can_fetch(USER_AGENT,url): raise ValueError('网站 robots.txt 不允许采集此页。')

def update_job(jid,**fields):
    with LOCK, connection() as c:
        c.execute('UPDATE jobs SET '+','.join(k+'=?' for k in fields)+' WHERE id=?',[*fields.values(),jid])

def crawl_job(jid,seed,limit,dynamic,course):
    from scrapling.fetchers import Fetcher, DynamicFetcher
    queue=[seed]; seen=set(); robots={}; details=[]; added=0
    try:
        with JOB_LOCK:
            update_job(jid,state='running',total=limit,message='正在检查来源与读取网页')
            while queue and len(seen)<limit:
                url=queue.pop(0)
                if url in seen: continue
                seen.add(url)
                try:
                    robots_allowed(url,robots)
                    parsed=urlsplit(url)
                    is_pdf=parsed.path.lower().endswith('.pdf')
                    if is_pdf:
                        raw,_,final=download(url)
                        if not raw.startswith(b'%PDF-'): raise ValueError('此地址没有返回 PDF 文件。')
                        sha=hashlib.sha256(raw).hexdigest()
                        folder=DATA/'files'; folder.mkdir(exist_ok=True)
                        file=folder/(sha+'.pdf'); file.write_bytes(raw)
                        chunks=pdf_pages(file); title=unquote(parsed.path.rsplit('/',1)[-1]); fmt='pdf'
                        body='\n'.join(t for _,t in chunks)
                    else:
                        if dynamic:
                            options={'headless':True,'timeout':25000,'disable_resources':True,'google_search':False,'wait':500}
                            edge=Path('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
                            if edge.exists(): options['executable_path']=str(edge)
                            response=DynamicFetcher.fetch(url,**options)
                        else:
                            response=Fetcher.get(url,timeout=20,retries=0,follow_redirects='safe',headers={'User-Agent':USER_AGENT},stealthy_headers=False)
                        if response.status!=200: raise ValueError(f'来源网站返回 HTTP {response.status}')
                        final=response.url
                        validate_url(final)
                        body=response.markdown(main_content_only=True)
                        if not body.strip(): raise ValueError('页面无可提取正文，可能需要登录或为扫描件。')
                        if len(body.encode('utf-8'))>MAX_BYTES: raise ValueError('页面超过大小限制。')
                        title=response.css('title::text').get() or parsed.hostname
                        sha=hashlib.sha256(body.encode('utf-8')).hexdigest(); file=''; fmt='html';chunks=[(1,body)]
                        if len(seen)<limit:
                            for href in response.css('a::attr(href)').getall():
                                child=urljoin(final,href).split('#')[0]
                                cp=urlsplit(child)
                                if cp.hostname==urlsplit(seed).hostname and cp.scheme in ('http','https') and child not in seen and child not in queue and not re.search(r'login|logout|register|sign.?in|\.mp3$|\.zip$|\.jpg$|\.png$',child,re.I):
                                    queue.append(child)
                                if len(queue)>=limit*4: break
                    docid,created=put_document(dict(id=uuid.uuid4().hex,title=str(title)[:250],course=course,source_url=final,origin='网络采集',status='pending',sha256=sha,file_path=str(file),body=body[:500000],pages=len(chunks),format=fmt,extract_status='已提取正文，内容与授权待核对'),chunks)
                    added+=int(created)
                    details.append({'url':url,'ok':True,'created':created,'id':docid,'title':title})
                except Exception as e:
                    details.append({'url':url,'ok':False,'error':str(e)[:300]})
                update_job(jid,progress=len(seen),message=f'已处理 {len(seen)} 页，新增 {added} 份待核对资料',details=json.dumps(details,ensure_ascii=False))
                if queue and len(seen)<limit: time.sleep(1)
            failures=sum(not x['ok'] for x in details)
            update_job(jid,state='done' if not failures else 'partial' if added else 'failed',message=f'采集结束：新增 {added} 份；{failures} 页无法读取。请到待核对列表查看。')
    except Exception as e:
        update_job(jid,state='failed',message=str(e)[:300])

class Server(ThreadingHTTPServer):
    daemon_threads=True
    # Browser modules, fonts and PDF workers arrive together. Windows can refuse
    # a new local connection while the standard five-slot accept backlog is full.
    request_queue_size=128

class Handler(BaseHTTPRequestHandler):
    server_version='CampusLibrary/1.0'
    def log_message(self,fmt,*args):
        pass
    def headers_common(self):
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('X-Frame-Options','SAMEORIGIN')
    def send_json(self,data,status=200):
        raw=json.dumps(data,ensure_ascii=False).encode('utf-8')
        self.send_response(status);self.headers_common()
        if len(raw)>16384 and 'gzip' in self.headers.get('Accept-Encoding',''):
            import gzip
            raw=gzip.compress(raw,compresslevel=3)
            self.send_header('Content-Encoding','gzip');self.send_header('Vary','Accept-Encoding')
        self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def valid_origin(self,mutation=False):
        allowed={f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}
        if self.headers.get('Host') not in allowed: raise ValueError('仅支持本机访问。')
        origin=self.headers.get('Origin')
        dev_origins={'http://127.0.0.1:5173','http://localhost:5173'}
        if origin and origin not in {'http://'+a for a in allowed}|dev_origins: raise ValueError('请求来源不匹配。')
        if mutation and self.headers.get('X-Campus-Request')!='1': raise ValueError('缺少本机应用请求标识。')
    def read_json(self):
        size=int(self.headers.get('Content-Length','0'))
        if size<1 or size>1024*1024: raise ValueError('请求内容为空或超过 1 MB。')
        if not self.headers.get('Content-Type','').startswith('application/json'):raise ValueError('需要 JSON 内容。')
        return json.loads(self.rfile.read(size))
    def proxy_hub(self):
        # Fixed local destination; never proxy a user-supplied host or private library route.
        size = int(self.headers.get('Content-Length','0'))
        upload_limit = (201 if urlsplit(self.path).path == '/api/hub/clips' else 26)*1024*1024
        if size < 0 or size > upload_limit or self.headers.get('Transfer-Encoding'):
            return self.send_json({'error':'请求超过社区上传上限或传输格式不受支持。'},413)
        conn = HTTPConnection('127.0.0.1',HUB_PORT,timeout=120)
        try:
            headers = {k:v for k,v in self.headers.items() if k.lower() in
                       ('content-type','cookie','host','origin','referer','x-csrftoken','accept','range','if-range')}
            # Forward bounded chunks: a 200 MB video must not become a 200 MB RAM buffer.
            headers['Content-Length'] = str(size)
            conn.putrequest(self.command,self.path,skip_host=True,skip_accept_encoding=True)
            for key,value in headers.items():
                conn.putheader(key,value)
            conn.endheaders()
            remaining = size
            while remaining:
                chunk = self.rfile.read(min(65536,remaining))
                if not chunk:
                    raise ConnectionError('Incomplete community request')
                conn.send(chunk)
                remaining -= len(chunk)
            response = conn.getresponse()
            self.send_response(response.status)
            for key,value in response.getheaders():
                if key.lower() not in ('connection','transfer-encoding','server','date'):
                    self.send_header(key,value)
            self.end_headers()
            while True:
                chunk = response.read(64*1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (ConnectionRefusedError,TimeoutError):
            self.send_json({'error':'社区服务未启动；请运行 campus/start.ps1。'},503)
        finally:
            conn.close()
    def do_GET(self):
        try:
            self.valid_origin()
            u=urlsplit(self.path);path=u.path; query={k:v[0] for k,v in parse_qs(u.query).items()}
            if path.startswith(('/api/hub/','/hub/','/manage/','/manage-assets/')):
                return self.proxy_hub()
            if path=='/api/community' or path.startswith('/api/community/'):
                return self.send_json(community.handle('GET',path,query,None,connection))
            if path=='/api/health': return self.send_json({'ok':True,'app':'cumtb-campus-library','version':'1.1','libraryPipelineVersion':3,'managementVersion':1,'socialMediaVersion':1,'local_only':True,'community':'local-workbench-v1'})
            if path=='/api/library/feed':
                from library_pipeline import catalogue as library_feed
                return self.send_json(library_feed(DATA))
            if path=='/api/catalogue':return self.send_json(catalogue(**{k:v for k,v in query.items() if k in ('q','course','scope','kind','status')},offset=max(0,int(query.get('offset',0)))))
            if path=='/api/library/collections':
                from library_organizer import get_library_collections
                from local_course_links import course_for_document
                return self.send_json(get_library_collections(DB,course_resolver=course_for_document))
            if path=='/api/library/university-sources':
                from university_question_bank import catalogue_response
                compressed='gzip' in self.headers.get('Accept-Encoding','').lower()
                raw,tag=catalogue_response(DATA,compressed)
                self.send_response(304 if self.headers.get('If-None-Match')==tag else 200)
                self.headers_common()
                self.send_header('ETag',tag)
                self.send_header('Cache-Control','private, max-age=0, must-revalidate')
                self.send_header('Vary','Accept-Encoding')
                if self.headers.get('If-None-Match')==tag:
                    self.end_headers();return
                self.send_header('Content-Type','application/json; charset=utf-8')
                if compressed:self.send_header('Content-Encoding','gzip')
                self.send_header('Content-Length',str(len(raw)))
                self.end_headers();self.wfile.write(raw);return
            if path.startswith('/api/library/university-sources/banks/'):
                from university_question_bank import get_bank
                try:
                    bank=get_bank(DATA,path.rsplit('/',1)[-1])
                except LookupError as error:
                    return self.send_json({'error':str(error)},404)
                except ValueError as error:
                    return self.send_json({'error':str(error)},409)
                return self.send_json({'bank':bank})
            if path=='/api/library/sources':
                from learning_sources_robot import get_learning_sources
                return self.send_json(get_learning_sources(DATA))
            if path=='/api/meta':
                with connection() as c:
                    counts=dict(c.execute('SELECT course,count(*) FROM documents WHERE status="ready" GROUP BY course').fetchall())
                    scopes=dict(c.execute('SELECT scope,count(*) FROM documents WHERE status="ready" GROUP BY scope').fetchall())
                    info={'school':'中国矿业大学（北京）','courses':[{'name':r[0],'count':counts.get(r[0],0)} for r in c.execute('SELECT name FROM courses ORDER BY name')], 'scopes':scopes,'documents':sum(scopes.values()),'pending':c.execute('SELECT count(*) FROM documents WHERE status="pending"').fetchone()[0],'pages':c.execute('SELECT count(*) FROM chunks JOIN documents ON docid=id WHERE status="ready"').fetchone()[0],'due':c.execute('SELECT count(*) FROM cards WHERE due<=?',(now(),)).fetchone()[0]}
                return self.send_json(info)
            if path=='/api/exam-resources':
                exam=query.get('exam','')
                if exam not in ('cet4','cet6'):raise ValueError('无效考级。')
                groups={}
                with connection() as c:
                    for row in c.execute('SELECT id,group_key,kind FROM documents WHERE status="ready" AND group_key LIKE ?',(exam+'_%',)):
                        # Only exact, single-set filenames are mapped. Combined sets remain in the library.
                        if not re.fullmatch(r'cet[46]_\d{4}_\d{2}_[123]',row['group_key']):continue
                        key={'试卷':'paper','答案解析':'answer','听力音频':'audio'}.get(row['kind'])
                        if key:groups.setdefault(row['group_key'].replace('_','-'),{})[key]='/api/file/'+row['id']
                return self.send_json({'sets':groups,'origin':'本机已有资料'})
            if path.startswith('/api/document/'):
                docid=path.rsplit('/',1)[-1]
                with connection() as c:
                    row=c.execute('SELECT * FROM documents WHERE id=?',(docid,)).fetchone()
                    if not row: return self.send_json({'error':'资料不存在。'},404)
                    item=public_doc(row);item['body']=row['body']
                    item['chunks']=[dict(r) for r in c.execute('SELECT page,text FROM chunks WHERE docid=? ORDER BY page',(docid,))]
                    item['related']=[public_doc(r) for r in c.execute('SELECT * FROM documents WHERE group_key=? AND group_key<>"" AND id<>? AND status="ready"',(row['group_key'],docid))]
                return self.send_json(item)
            if path.startswith('/api/file/'):
                with connection() as c: row=c.execute('SELECT * FROM documents WHERE id=?',(path.rsplit('/',1)[-1],)).fetchone()
                if not row:return self.send_json({'error':'文件不存在。'},404)
                if row['format']=='html' and row['body']:
                    raw=('# '+row['title']+'\n\n来源：'+row['source_url']+'\n\n以下为本站已保存的提取文本，非原始网页完整副本。\n\n'+row['body']).encode('utf-8')
                    self.send_response(200);self.headers_common()
                    self.send_header('Content-Type','text/markdown; charset=utf-8')
                    self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote(row['title'][:100]+'.md',safe=''))
                    self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw);return
                if row['format'] not in ('pdf','mp3'):return self.send_json({'error':'尚未保存可下载原件。'},404)
                return self.send_file(Path(row['file_path']))
            if path=='/api/search-web':
                from ddgs import DDGS
                q=query.get('q','').strip()[:180]
                if len(q)<2:raise ValueError('请输入至少两个字的检索内容。')
                items=DDGS(timeout=12).text(q,region='cn-zh',max_results=8,backend='auto')
                return self.send_json({'items':items,'query':q,'notice':'网络搜索结果尚未核对；标题不能证明是本校真题。'})
            if path=='/api/jobs':
                with connection() as c:items=[dict(r) for r in c.execute('SELECT * FROM jobs ORDER BY created DESC LIMIT 20')]
                for item in items:item['details']=json.loads(item['details'])
                return self.send_json({'items':items})
            if path=='/api/cards':
                with connection() as c:items=[dict(r) for r in c.execute('SELECT cards.*,documents.title,documents.course FROM cards JOIN documents ON docid=documents.id ORDER BY due')]
                return self.send_json({'items':items})
            if path=='/api/backup':
                with connection() as c:cards=[dict(r) for r in c.execute('SELECT * FROM cards')]
                return self.send_json({'schema':'campus-study-backup-v1','created':now(),'cards':cards})
            base=STATIC; target=(base/unquote(path.lstrip('/') or 'index.html')).resolve()
            if not target.is_relative_to(base.resolve()) or not target.is_file(): return self.send_json({'error':'页面不存在。'},404)
            return self.send_file(target)
        except (ValueError,KeyError,json.JSONDecodeError) as e:self.send_json({'error':str(e)},400)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
        except Exception as e:self.send_json({'error':str(e)[:300]},502)
    def send_file(self,path):
        if not path.is_file():return self.send_json({'error':'原文件已移动，请重新导入资料。'},404)
        length=path.stat().st_size;start=0;end=length-1;code=200
        range_header=self.headers.get('Range','')
        if range_header:
            match=re.fullmatch(r'bytes=(\d+)-(\d*)',range_header)
            if not match:return self.send_json({'error':'不支持此分段请求。'},416)
            start=int(match[1]);end=min(int(match[2]) if match[2] else end,end);code=206
            if start>end:return self.send_json({'error':'分段越界。'},416)
        self.send_response(code);self.headers_common()
        self.send_header('Content-Type',mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        self.send_header('Accept-Ranges','bytes');self.send_header('Content-Length',str(end-start+1))
        if code==206:self.send_header('Content-Range',f'bytes {start}-{end}/{length}')
        self.end_headers()
        try:
            with path.open('rb') as f:
                f.seek(start);remaining=end-start+1
                while remaining:
                    chunk=f.read(min(65536,remaining))
                    if not chunk:break
                    self.wfile.write(chunk);remaining-=len(chunk)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
    def do_POST(self):
        try:
            if urlsplit(self.path).path.startswith(('/api/hub/','/manage/')):
                self.valid_origin()
                return self.proxy_hub()
            self.valid_origin(True); body=self.read_json();path=urlsplit(self.path).path
            if path.startswith('/api/community/'):
                return self.send_json(community.handle('POST',path,{},body,connection))
            if path=='/api/crawl':
                url=str(body.get('url','')).strip();validate_url(url)
                limit=max(1,min(int(body.get('limit',1)),10));jid=uuid.uuid4().hex
                with connection() as c:
                    if c.execute("SELECT count(*) FROM jobs WHERE state IN ('queued','running')").fetchone()[0]>=3:raise ValueError('已有三个采集任务，请等待完成。')
                    c.execute('INSERT INTO jobs(id,state,total,message,created) VALUES (?,?,?,?,?)',(jid,'queued',limit,'等待采集',now()))
                threading.Thread(target=crawl_job,args=(jid,url,limit,bool(body.get('dynamic')),str(body.get('course','未分类'))[:80]),daemon=True).start()
                return self.send_json({'id':jid},202)
            if path=='/api/curate':
                course=str(body.get('course','')).strip()[:80];scope=body.get('scope','外部资料')
                if not course:raise ValueError('请填写课程名称。')
                if scope not in ('本校资料','通用考试','外部资料'):raise ValueError('无效资料范围。')
                with LOCK,connection() as c:
                    changed=c.execute('UPDATE documents SET course=?,scope=?,year=?,kind=?,status="ready" WHERE id=? AND status="pending"',(course,scope,str(body.get('year',''))[:30],str(body.get('kind','资料'))[:30],body['id'])).rowcount
                    if not changed:raise ValueError('资料不存在或已整理。')
                    c.execute('INSERT OR IGNORE INTO courses VALUES (?)',(course,))
                return self.send_json({'ok':True})
            if path=='/api/courses':
                name=str(body.get('name','')).strip()[:80]
                if not name:raise ValueError('请输入课程名称。')
                with connection() as c:c.execute('INSERT OR IGNORE INTO courses VALUES (?)',(name,))
                return self.send_json({'ok':True})
            if path=='/api/cards':
                question=str(body.get('question','')).strip()[:8000]
                if not question:raise ValueError('请填写题目或需要复习的知识点。')
                page=max(1,int(body.get('page',1)));docid=body['docid']
                with connection() as c:
                    doc=c.execute('SELECT pages FROM documents WHERE id=?',(docid,)).fetchone()
                    if not doc or page>max(1,doc['pages']):raise ValueError('资料或页码不存在。')
                    cid=uuid.uuid4().hex
                    c.execute('INSERT INTO cards(id,docid,page,question,answer,due,created) VALUES (?,?,?,?,?,?,?)',(cid,docid,page,question,str(body.get('answer',''))[:12000],now(),now()))
                return self.send_json({'ok':True,'id':cid})
            if path=='/api/review':
                correct=body.get('correct') is True
                with connection() as c:
                    card=c.execute('SELECT * FROM cards WHERE id=?',(body['id'],)).fetchone()
                    if not card:raise ValueError('复习卡不存在。')
                    streak=card['streak']+1 if correct else 0
                    due=(datetime.now(timezone.utc)+timedelta(days=([1,3,7,14,30][min(streak-1,4)] if correct else 1))).isoformat()
                    c.execute('UPDATE cards SET streak=?,attempts=attempts+1,last_result=?,due=? WHERE id=?',(streak,'掌握' if correct else '再练',due,body['id']))
                return self.send_json({'ok':True,'due':due})
            if path=='/api/restore':
                if body.get('schema')!='campus-study-backup-v1' or not isinstance(body.get('cards'),list) or len(body['cards'])>1000:raise ValueError('备份格式不匹配，或超过 1000 张卡。')
                restored=0;skipped=0
                with LOCK,connection() as c:
                    for item in body['cards']:
                        if not isinstance(item,dict) or not isinstance(item.get('question'),str) or not isinstance(item.get('answer'),str):raise ValueError('备份中含无效卡片，已取消导入。')
                        if not c.execute('SELECT id FROM documents WHERE id=?',(item.get('docid'),)).fetchone():skipped+=1;continue
                        cid=item.get('id','')
                        if not re.fullmatch('[a-f0-9]{32}',cid) or len(item['question'])>8000 or len(item['answer'])>12000:raise ValueError('备份卡片字段无效。')
                        datetime.fromisoformat(item['due'])
                        restored+=c.execute('INSERT OR IGNORE INTO cards VALUES (?,?,?,?,?,?,?,?,?,?)',(cid,item['docid'],max(1,int(item['page'])),item['question'],item['answer'],item['due'],max(0,int(item['attempts'])),max(0,int(item['streak'])),str(item['last_result'])[:20],str(item['created'])[:60])).rowcount
                return self.send_json({'ok':True,'restored':restored,'skipped':skipped})
            return self.send_json({'error':'操作不存在。'},404)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
        except (ValueError,KeyError,TypeError,json.JSONDecodeError) as e:self.send_json({'error':str(e)},400)
        except Exception as e:self.send_json({'error':str(e)[:300]},500)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=17860);args=parser.parse_args()
    init_db()
    httpd=Server(('127.0.0.1',args.port),Handler)
    print(f'Campus library ready: http://127.0.0.1:{args.port}',flush=True)
    try:httpd.serve_forever()
    except KeyboardInterrupt:pass
    finally:httpd.server_close()
