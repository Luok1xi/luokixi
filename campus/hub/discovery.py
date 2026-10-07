"""Bounded public fetches, RSS/HTML source monitoring and external discovery."""
import hashlib
import http.client
import ipaddress
import json
import socket
import ssl
from datetime import timedelta
from urllib.parse import quote, urlencode, urljoin, urlsplit
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree
from django.db import transaction
from django.utils import timezone
from .core import Problem, text, url
from .models import Entry, ExternalCache, Revision, Source

UA = 'LuokixiCommunity/2.0 (educational public index)'


def fetch_public(target, limit=2*1024*1024, headers=None):
    """Pin validated DNS addresses to the connection, including every redirect."""
    for _ in range(6):
        target = url(target,True)
        p = urlsplit(target)
        if p.port not in (None,80,443) or p.hostname.lower()=='localhost' or p.hostname.lower().endswith(('.localhost','.local')):
            raise Problem('采集仅支持公开网站的标准端口。')
        port = p.port or (443 if p.scheme=='https' else 80)
        addresses = socket.getaddrinfo(p.hostname,port,type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0].split('%')[0]).is_global for a in addresses):
            raise Problem('采集目标不能是本机、内网或保留地址。')
        conn = http.client.HTTPSConnection(p.hostname,port,timeout=15) if p.scheme=='https' else http.client.HTTPConnection(p.hostname,port,timeout=15)
        try:
            sock = socket.create_connection((addresses[0][4][0],port),timeout=15)
            conn.sock = ssl.create_default_context().wrap_socket(sock,server_hostname=p.hostname) if p.scheme=='https' else sock
            conn.request('GET',p.path+('?' + p.query if p.query else '') or '/',headers={'User-Agent':UA,**(headers or {})})
            response = conn.getresponse()
            if response.status in (301,302,303,307,308):
                redirected = urljoin(target,response.getheader('Location',''))
                if urlsplit(redirected).netloc != p.netloc or urlsplit(redirected).scheme != p.scheme:
                    headers = {k:v for k,v in (headers or {}).items() if k.lower() not in ('authorization','cookie','proxy-authorization')}
                target = redirected
                continue
            if response.status==304:
                return b'',dict(response.getheaders()),target,304
            if response.status!=200:
                error = Problem(f'来源返回 HTTP {response.status}。',502)
                error.http_status, error.headers = response.status, dict(response.getheaders())
                raise error
            length = int(response.getheader('Content-Length','0'))
            if length>limit:
                raise Problem('来源内容超出读取上限。')
            raw = response.read(limit+1)
            if len(raw)>limit:
                raise Problem('来源内容超出读取上限。')
            return raw,dict(response.getheaders()),target,200
        finally:
            conn.close()
    raise Problem('来源重定向次数过多。')


def validate_source(body):
    source_url = url(body.get('url',''),True)
    p = urlsplit(source_url)
    if p.port not in (None,80,443) or p.hostname.lower() in ('localhost','127.0.0.1'):
        raise Problem('请填写公开资料来源。')
    kind, entry_kind = body.get('kind','rss'),body.get('entry_kind','news')
    if kind not in ('rss','html') or entry_kind not in ('news','contest','resource','paper'):
        raise Problem('来源类型无效。')
    interval = int(body.get('interval_hours',24))
    if not 1<=interval<=720:
        raise Problem('采集间隔应为 1–720 小时。')
    return {'name':text(body.get('name',''),160,True),'url':source_url,'kind':kind,
            'entry_kind':entry_kind,'enabled':body.get('enabled') is True,'interval_hours':interval}


def parse_source(raw, kind, origin):
    if kind=='rss':
        if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
            raise Problem('不接受含外部实体声明的订阅文件。')
        root = ElementTree.fromstring(raw)
        items = root.findall('.//item') or root.findall('{http://www.w3.org/2005/Atom}entry')
        output = []
        for node in items[:40]:
            def find(name):
                e = node.find(name)
                return e if e is not None else node.find('{http://www.w3.org/2005/Atom}'+name)
            title_node, link_node = find('title'),find('link')
            if title_node is None or link_node is None:
                continue
            title = ''.join(title_node.itertext()).strip()[:160]
            link = link_node.get('href') or link_node.text or ''
            if title and link:
                output.append({'title':title,'url':urljoin(origin,link),'summary':'原始订阅标题；详情请查看来源。'})
        return output
    from scrapling.parser import Selector
    page = Selector(content=raw, url=origin)
    found = []
    for a in page.css('a[href]'):
        title = ' '.join(a.css('::text').getall()).strip()
        link = urljoin(origin,a.attrib.get('href',''))
        if len(title)>=8 and urlsplit(link).hostname==urlsplit(origin).hostname and not link.endswith(('.jpg','.png','.css','.js')):
            found.append({'title':title[:160],'url':link,'summary':'公开网页目录索引；年份与适用范围待维护者核对。'})
    return list({i['url']:i for i in found}.values())[:40]


def refresh_source(identifier):
    source = Source.objects.get(pk=identifier)
    if source.kind == 'faculty':
        # 教师资料机器人：读学院官网师资页，更新教师目录（faculty.py），不生成待审条目
        from .faculty import crawl_source
        return crawl_source(source)
    source.last_attempt = timezone.now()
    source.save(update_fields=['last_attempt'])
    try:
        p = urlsplit(source.url)
        robots = RobotFileParser()
        try:
            raw,_,_,_ = fetch_public(f'{p.scheme}://{p.netloc}/robots.txt',256*1024)
            robots.parse(raw.decode('utf-8',errors='replace').splitlines())
        except Problem as exc:
            if 'HTTP 404' not in str(exc):
                raise
            robots.parse([])
        if not robots.can_fetch(UA,source.url):
            raise Problem('来源 robots.txt 不允许采集。')
        headers = {}
        if source.etag:
            headers['If-None-Match'] = source.etag
        if source.modified:
            headers['If-Modified-Since'] = source.modified
        raw, response_headers, final_url, status = fetch_public(source.url,headers=headers)
        count = 0
        if status!=304:
            items = parse_source(raw,source.kind,final_url)
            for item in items:
                link = url(item['url'],True)
                fingerprint = hashlib.sha256(link.encode()).hexdigest()
                slug = 'source-'+fingerprint
                payload = {'title':item['title'],'summary':item['summary'],'body':'','links':{'source':link},
                           'sourceNote':source.name,'license':'来源版权保留，仅提供索引链接',
                           'sourceId':str(source.pk),'collectedAt':timezone.now().isoformat(),
                           'year':'年份待核','audience':'适用范围待核','tags':[],'uploads':[],'rightsConfirmed':False}
                with transaction.atomic():
                    entry = Entry.objects.filter(slug=slug).first()
                    if entry:
                        if entry.draft.get('title')==payload['title'] and entry.draft.get('summary')==payload['summary']:
                            continue
                        entry.revision += 1
                        entry.draft,entry.state = payload,'pending'
                        entry.save()
                    else:
                        entry = Entry.objects.create(kind=source.entry_kind,slug=slug,state='pending',draft=payload)
                    Revision.objects.create(entry=entry,number=entry.revision,data=payload,state='pending')
                count += 1
            source.fingerprint = hashlib.sha256(raw).hexdigest()
            source.etag = response_headers.get('ETag','')[:300]
            source.modified = response_headers.get('Last-Modified','')[:100]
        source.last_success, source.error = timezone.now(),''
        source.save()
        return {'pending':count,'unchanged':status==304,'source':source.name}
    except Exception as exc:
        source.error = str(exc)[:300]
        source.save(update_fields=['error'])
        raise


def external_search(query, provider):
    providers = {'github','crossref'}
    portals = [
        {'name':'GitHub','url':'https://github.com/search?'+urlencode({'q':query,'type':'repositories'})},
        {'name':'洛谷','url':'https://www.luogu.com.cn/problem/list?'+urlencode({'keyword':query})},
        {'name':'力扣','url':'https://leetcode.cn/problemset/?'+urlencode({'search':query})},
        {'name':'Google Scholar','url':'https://scholar.google.com/scholar?'+urlencode({'q':query})},
        {'name':'矿大（北京）公开资料','url':'https://www.bing.com/search?'+urlencode({'q':'site:cumtb.edu.cn '+query})},
    ]
    if provider not in providers:
        return {'items':[],'portals':portals,'notice':'此平台提供原站搜索入口，未声称抓取其题库。'}
    key = 'search:'+hashlib.sha256((provider+':'+query).encode()).hexdigest()
    cache,_ = ExternalCache.objects.get_or_create(pk=key)
    if cache.checked and (timezone.now()-cache.checked).total_seconds()<600:
        return dict(cache.data,portals=portals,stale=bool(cache.error),lastSuccess=cache.success,error=cache.error)
    try:
        target = ('https://api.github.com/search/repositories?'+urlencode({'q':query,'per_page':12}) if provider=='github'
                  else 'https://api.crossref.org/works?'+urlencode({'query':query,'rows':12}))
        raw,_,_,_ = fetch_public(target)
        data = json.loads(raw)
        items = []
        if provider=='github':
            for r in data.get('items',[]):
                items.append({'title':r['full_name'],'url':r['html_url'],'summary':r.get('description') or '',
                              'provider':provider,'kind':'project','stars':r.get('stargazers_count'),
                              'updated':r.get('pushed_at'),'license':(r.get('license') or {}).get('spdx_id')})
        else:
            for r in data.get('message',{}).get('items',[]):
                items.append({'title':(r.get('title') or ['未命名文献'])[0],'url':'https://doi.org/'+r['DOI'],
                              'doi':r['DOI'],'provider':provider,'kind':'paper','summary':'书目信息；全文可用性请查看原站。'})
        cache.data,cache.success,cache.error = {'items':items,'provider':provider},timezone.now(),''
    except Exception:
        cache.error = '来源暂不可用；保留上次结果，可使用原站搜索。'
        if not cache.data:
            cache.data = {'items':[],'provider':provider}
    cache.checked = timezone.now()
    cache.save()
    return dict(cache.data,portals=portals,stale=bool(cache.error),lastSuccess=cache.success,error=cache.error)
