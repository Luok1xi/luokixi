"""Browser checks for data adapters, using a temporary DB; no final community UI exists yet."""
import json
import shutil
import tempfile
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
import server
import community

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'.data/community-qa'
passed=[]
catalogue=json.loads((ROOT.parent/'public/data/community.json').read_text(encoding='utf-8-sig'))
reference_count=sum(p.get('external') is True or p.get('origin')=='external' for p in catalogue['projects'])
old_db,old_static=server.DB,server.STATIC
with tempfile.TemporaryDirectory() as td:
    temporary=Path(td)
    server.DB=temporary/'library.sqlite3'
    server.STATIC=temporary/'site'
    server.STATIC.mkdir()
    for module in (OUT/'client').glob('*.js'):
        shutil.copy2(module,server.STATIC/module.name)
    (server.STATIC/'data').mkdir()
    shutil.copy2(ROOT.parent/'public/data/community.json',server.STATIC/'data/community.json')
    (server.STATIC/'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Community adapter verification</title>',encoding='utf-8')
    server.init_db()
    httpd=server.Server(('127.0.0.1',0),server.Handler)
    worker=threading.Thread(target=httpd.serve_forever,daemon=True);worker.start()
    base=f'http://127.0.0.1:{httpd.server_port}'
    try:
        real_repo=community.github_repo(server.connection,'https://github.com/simplefoc/Arduino-FOC')
        assert real_repo['name']=='simplefoc/Arduino-FOC' and real_repo['license']=='MIT'
        passed.append('real public GitHub metadata and license')
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='msedge',headless=True)
            context=browser.new_context()
            page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(base)
            result=page.evaluate('''async()=>{
              window.module=await import('/adapter.js');
              const state=await module.loadCommunity();
              return {connected:state.connected,references:state.references.length,total:state.activity.total};
            }''')
            assert result=={'connected':True,'references':reference_count,'total':0}, result
            passed.append('local adapter loads verified reference catalogue and empty real activity')
            page.evaluate('''async()=>{
              const api=module.communityApi;
              window.submitted=await api.submit({kind:'project',title:'浏览器测试项目',summary:'浏览器验证中的临时投稿，不写用户数据库。',category:'机电与机器人',author:'临时测试',url:'https://github.com/example/browser-test',tags:['test'],license:'MIT',body:'测试',setup:'',needs:'',rightsConfirmed:true});
              const state=await api.overview();
              if(state.activity.total!==0 || state.entries[0].status!=='pending')throw Error('pending leakage');
              await api.review(submitted.id,'approved','已验证临时来源',true);
              const after=await api.overview();if(after.activity.total!==1)throw Error('missing contribution');
            }''');passed.append('browser submit to review to real contribution count')
            page.evaluate('''async()=>{
              const api=module.communityApi;
              const t=await api.addTopic({title:'浏览器讨论验证',category:'提问',author:'测试同学',body:'这是浏览器验证中的临时测试讨论。'});
              const r=await api.reply({topic:t.id,author:'另一位测试同学',body:'这是一条可采纳回复。'});
              await api.acceptReply(t.id,r.id);
              const thread=await api.topic(t.id);
              if(thread.topic.state!=='solved'||thread.replies.length!==1)throw Error('thread not solved');
            }''');passed.append('browser discussion reply and acceptance')
            page.evaluate('''async()=>{
              const {createNotebook}=await import('/notebook.js');
              const notes=createNotebook();notes.addProblem('https://www.luogu.com.cn/problem/P1001','A+B');
              notes.updateProblem('https://www.luogu.com.cn/problem/P1001',{status:'review',note:'重做边界'});
            }''')
            page.reload()
            note=page.evaluate('''async()=>{const {createNotebook}=await import('/notebook.js');return createNotebook().read().problems[0];}''')
            assert note['note']=='重做边界' and note['status']=='review';passed.append('learning note persists across browser reload')
            assert not errors;passed.append('no browser script errors in adapter workflows')
            context.close()
            remote=browser.new_context();calls=[]
            def proxy(route):
                path=route.request.url.split('community-static.test',1)[-1]
                if path.startswith('/api'):
                    calls.append(path);route.abort();return
                response=remote.request.get(base+path)
                route.fulfill(response=response)
            remote.route('https://community-static.test/**',proxy)
            static=remote.new_page();static.goto('https://community-static.test/index.html')
            state=static.evaluate('''async()=>{const m=await import('/adapter.js');const s=await m.loadCommunity();let blocked=false;try{await m.communityApi.submit({});}catch{blocked=true;}return {connected:s.connected,references:s.references.length,activity:s.activity,blocked};}''')
            assert state=={'connected':False,'references':reference_count,'activity':None,'blocked':True} and not calls
            passed.append('static host gets catalogue and blocks mutations with zero API requests')
            static.evaluate('''async()=>{const {createNotebook}=await import('/notebook.js');createNotebook().addProblem('https://leetcode.cn/problems/two-sum','两数之和');}''')
            static.reload()
            size=static.evaluate('''async()=>{const {createNotebook}=await import('/notebook.js');return createNotebook().read().problems.length;}''')
            assert size==1;passed.append('static host retains browser-local problem notebook')
            remote.close();browser.close()
        (OUT/'verification.json').write_text(json.dumps({'passed':passed,'errors':[],'scope':'Data adapters and local service, not final community page UI','github':real_repo},ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({'passed':len(passed),'errors':0,'result':str(OUT/'verification.json')}),flush=True)
    finally:
        httpd.shutdown();worker.join();httpd.server_close()
        server.DB,server.STATIC=old_db,old_static
