"""GitHub-only pooled HTTP/2 via encode/httpx; no general-purpose open proxy."""
import atexit
import hashlib
import ipaddress
import os
import socket
import ssl
import threading
import time
from urllib.parse import urljoin, urlsplit
import httpx
from .core import Problem

HOSTS = {'api.github.com','github.com','codeload.github.com','objects.githubusercontent.com',
         'release-assets.githubusercontent.com','github-releases.githubusercontent.com','raw.githubusercontent.com'}
_clients, _dns = {}, {}
_lock=threading.Lock()


def target(url):
    p=urlsplit(url)
    if p.scheme!='https' or p.hostname not in HOSTS or p.port not in (None,443) or p.username or p.password:
        raise Problem('只允许 GitHub 官方公开文件服务地址。')
    with _lock:
        found=_dns.get(p.hostname)
        if not found or found[0]<time.monotonic():
            addresses=socket.getaddrinfo(p.hostname,443,type=socket.SOCK_STREAM)
            ips=[a[4][0] for a in addresses]
            if not ips or any(not ipaddress.ip_address(ip.split('%')[0]).is_global for ip in ips):
                raise Problem('GitHub 地址解析到内网或保留地址，已停止。')
            ip=next((ip for ip in ips if ':' not in ip),ips[0])
            _dns[p.hostname]=(time.monotonic()+60,ip)
        else: ip=found[1]
        key=(p.hostname,ip)
        if key not in _clients:
            _clients[key]=httpx.Client(http2=True,verify=ssl.create_default_context(),trust_env=False,follow_redirects=False,
                                      timeout=httpx.Timeout(30,connect=15),limits=httpx.Limits(max_connections=3,max_keepalive_connections=2,keepalive_expiry=30))
        client=_clients[key]
    # Pin the resolved address, retain the original TLS identity and HTTP host.
    pinned=httpx.URL(url).copy_with(host=ip)
    return client,pinned,p.hostname


@atexit.register
def close():
    for client in _clients.values(): client.close()


def response_stream(url, headers=None):
    headers=dict(headers or {})
    for _ in range(8):
        client,pinned,host=target(url)
        # API credentials never accompany release/CDN requests, including redirects.
        headers={k:v for k,v in headers.items() if k.lower() not in ('host','cookie') and (host=='api.github.com' or k.lower()!='authorization')}
        context=client.stream('GET',pinned,headers={'User-Agent':'Luokixi-project-library/1.0','Accept-Encoding':'identity',**headers,'Host':host},extensions={'sni_hostname':host})
        response=context.__enter__()
        if response.status_code in (301,302,303,307,308):
            next_url=urljoin(url,response.headers.get('location',''))
            context.__exit__(None,None,None)
            if urlsplit(next_url).hostname!=host: headers.pop('Authorization',None)
            url=next_url
            continue
        return context,response,url
    raise Problem('GitHub 下载重定向过多。',502)


def fetch_public(url, limit, headers=None):
    context,response,final=response_stream(url,headers)
    try:
        if response.status_code==304: return b'',dict(response.headers),final,304
        if response.status_code!=200:
            error=Problem(f'GitHub 返回 HTTP {response.status_code}。',502)
            error.http_status=response.status_code;error.headers=dict(response.headers)
            raise error
        chunks=[];size=0
        for chunk in response.iter_bytes():
            size+=len(chunk)
            if size>limit: raise Problem('GitHub 响应超过读取上限。')
            chunks.append(chunk)
        return b''.join(chunks),dict(response.headers),final,200
    finally: context.__exit__(None,None,None)


def stream_file(url, destination, limit):
    context,response,final=response_stream(url)
    tmp=destination.with_suffix(destination.suffix+'.part')
    try:
        if response.status_code!=200: raise Problem(f'文件下载返回 HTTP {response.status_code}。',502)
        if 'text/html' in response.headers.get('content-type','').lower(): raise Problem('下载返回网页，未入库。',502)
        length=int(response.headers.get('content-length','0') or 0)
        if length>limit: raise Problem('文件超过镜像上限。')
        digest=hashlib.sha256();size=0
        with tmp.open('wb') as f:
            for chunk in response.iter_bytes(chunk_size=256*1024):
                size+=len(chunk)
                if size>limit: raise Problem('文件超过镜像上限。')
                f.write(chunk);digest.update(chunk)
        if length and size!=length: raise Problem('文件未完整下载，未入库。',502)
        os.replace(tmp,destination)
        return size,digest.hexdigest(),final
    finally:
        context.__exit__(None,None,None)
        tmp.unlink(missing_ok=True)
