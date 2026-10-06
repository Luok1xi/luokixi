"""Explicit live checks: public resource search and a bounded one-page crawl."""
import json
import time
from pathlib import Path
from urllib.request import Request,urlopen

BASE='http://127.0.0.1:17860'
def call(path,data=None):
    req=Request(BASE+path,data=json.dumps(data).encode() if data else None,headers={'Content-Type':'application/json','X-Campus-Request':'1'})
    with urlopen(req,timeout=55) as r:return json.load(r)

report={'health':call('/api/health'),'meta':call('/api/meta')}
report['local_search']=call('/api/catalogue?q=ecosystems')
report['web_search']=call('/api/search-web?q=site%3Acumtb.edu.cn%20%E9%AB%98%E7%AD%89%E6%95%B0%E5%AD%A6')
jid=call('/api/crawl',{'url':'https://www.wehuster.com/cet4','limit':1,'course':'英语四级'})['id']
for _ in range(35):
    job=next(j for j in call('/api/jobs')['items'] if j['id']==jid)
    if job['state'] not in ('queued','running'):break
    time.sleep(1)
report['crawl']=job
target=Path(__file__).parent/'.data'/'live-verification.json'
target.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'local_documents':report['meta']['documents'],'search_hits':report['local_search']['total'],'web_results':len(report['web_search']['items']),'crawl':job},ensure_ascii=True))
