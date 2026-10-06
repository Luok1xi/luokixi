"""End-to-end checks against a copy of the real library; user records stay intact."""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'.data'/'browser-qa';OUT.mkdir(exist_ok=True)
results=[];errors=[]

def checked(name,condition):
    if not condition:raise AssertionError(name)
    results.append(name)

with tempfile.TemporaryDirectory(prefix='campus-browser-') as tmp:
    source=sqlite3.connect(ROOT/'.data'/'library.sqlite3');target=sqlite3.connect(Path(tmp)/'library.sqlite3')
    try:source.backup(target)
    finally:target.close();source.close()
    proc=subprocess.Popen([sys.executable,'-u',str(ROOT/'server.py'),'--port','17861'],cwd=ROOT,env=dict(os.environ,CAMPUS_DATA_DIR=tmp,PYTHONUTF8='1'),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        for _ in range(30):
            try:
                with urlopen('http://127.0.0.1:17861/api/health',timeout=1):break
            except Exception:time.sleep(.2)
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
            try:
                page=browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1)
                page.on('pageerror',lambda error:errors.append(str(error)))
                page.goto('http://127.0.0.1:17861/knowledge.html',wait_until='networkidle')
                page.wait_for_function("document.querySelectorAll('.kb-item').length===30")
                checked('218 real resources loaded','218' in page.locator('#summary').inner_text())
                page.screenshot(path=str(OUT/'desktop.png'),full_page=False)
                page.locator('#query').fill('ecosystems');page.locator('#search-form button').click()
                page.wait_for_function("document.querySelector('#result-count').textContent.includes('3 份')")
                checked('full text search returned 3 papers',page.locator('.kb-item').count()==3)
                page.locator('[data-document]').first.click();page.locator('#document-dialog').wait_for(state='visible')
                checked('PDF opens on matched original page','#page=' in page.locator('#pdf-frame').get_attribute('src'))
                page.locator('#card-question').fill('Browser verification: ecosystem reasoning')
                page.locator('#card-form [name=answer]').fill('Verify against the original paper and record reasoning.')
                page.locator('#card-form button[type=submit]').click()
                page.wait_for_function("document.querySelector('#kb-toast').textContent.includes('已保存')")
                page.locator('[data-close=document-dialog]').click();page.locator('[data-mode=cards]').click()
                page.get_by_text('Browser verification: ecosystem reasoning',exact=True).wait_for()
                page.locator('.kb-review').filter(has_text='Browser verification: ecosystem reasoning').locator('summary').click()
                checked('answer reveal',page.get_by_text('Verify against the original paper and record reasoning.',exact=True).is_visible())
                page.locator('.kb-review').filter(has_text='Browser verification: ecosystem reasoning').locator('[data-correct=false]').click()
                page.wait_for_function("document.querySelector('#kb-toast').textContent.includes('复习已记录')")
                with page.expect_download() as dl:page.locator('#backup').click()
                backup=Path(tmp)/'backup.json';dl.value.save_as(backup)
                checked('backup schema',json.loads(backup.read_text(encoding='utf-8'))['schema']=='campus-study-backup-v1')
                page.locator('#backup-file').set_input_files(backup)
                page.wait_for_function("document.querySelector('#kb-toast').textContent.includes('导入 0')")
                checked('restoring does not duplicate notes',True)
                page.reload(wait_until='networkidle');page.locator('[data-mode=cards]').click()
                page.get_by_text('Browser verification: ecosystem reasoning',exact=True).wait_for()
                checked('notes survive reload',True)
                page.locator('[data-mode=pending]').click();page.wait_for_timeout(350)
                if page.locator('[data-document]').count():
                    page.locator('[data-document]').first.click();page.locator('#curate-form [name=course]').fill('英语四级')
                    page.locator('#curate-form [name=scope]').select_option(label='通用考试')
                    page.locator('#curate-form input[type=checkbox]').check();page.locator('#curate-form button').click()
                    page.wait_for_function("document.querySelector('#kb-toast').textContent.includes('已入库')")
                    checked('crawler review queue to library',True)
                page.locator('[data-mode=local]').click();page.locator('#query').fill('');page.locator('#course-filter').select_option(label='线性代数（4）')
                page.wait_for_function("document.querySelector('#result-count').textContent.includes('4 份')")
                checked('course filter works',page.locator('.kb-item').count()==4)
                page.locator('#open-crawl').click();page.locator('#crawl-url').fill('http://127.0.0.1/')
                page.locator('#crawl-form button').click();page.wait_for_function("document.querySelector('#kb-toast').textContent.includes('内网')")
                checked('UI surfaces rejected internal target',True)
                page.locator('[data-close=crawl-dialog]').click()
                page.locator('[data-mode=web]').click();page.locator('#query').fill('site:cumtb.edu.cn 高等数学');page.locator('#search-form button').click()
                page.wait_for_function("document.querySelector('#result-count').textContent.includes('条网络结果')",timeout=60000)
                checked('live public web search through UI',page.locator('[data-crawl]').count()>0)
                page.screenshot(path=str(OUT/'web-search.png'),full_page=True)
                mobile=browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
                mobile.on('pageerror',lambda error:errors.append(str(error)))
                mobile.goto('http://127.0.0.1:17861/knowledge.html',wait_until='networkidle')
                mobile.wait_for_selector('.kb-item')
                checked('390px has no horizontal overflow',mobile.evaluate('document.documentElement.scrollWidth<=innerWidth'))
                mobile.screenshot(path=str(OUT/'mobile.png'),full_page=False)
                mobile.locator('[data-theme-toggle]').click()
                mobile.screenshot(path=str(OUT/'mobile-dark.png'),full_page=False)
                for route in ['index.html','cet4.html','cet6.html','school.html']:
                    response=page.goto('http://127.0.0.1:17861/'+route,wait_until='networkidle')
                    checked('existing '+route,response.status==200 and page.locator('h1').count()==1)
                    if route in ['cet4.html','cet6.html']:
                        page.wait_for_selector('.set-card')
                        checked('real local PDFs connected to '+route,page.locator('a.res[href^="/api/file/"]').count()>20)
                        button=page.locator('[data-audio]').first
                        button.scroll_into_view_if_needed();button.click()
                        page.locator('.player-btn').first.click()
                        page.wait_for_function("[...document.querySelectorAll('.player-time')].some(el=>/^\\d+:\\d+$/.test(el.textContent)&&el.textContent!=='0:00')",timeout=15000)
                        checked('real audio playback advances '+route,True)
                        page.locator('.player-btn').first.click()
                checked('no browser script errors',not errors)
                static_calls=[]
                static=browser.new_page()
                static.on('request',lambda req: static_calls.append(req.url) if '/api/' in req.url else None)
                def serve_static(route):
                    from urllib.parse import urlsplit
                    file=ROOT.parent/'dist'/urlsplit(route.request.url).path.lstrip('/')
                    if file.is_file():route.fulfill(path=str(file))
                    else:route.fulfill(status=404,body='Not found')
                static.route('https://static.example/**',serve_static)
                static.goto('https://static.example/knowledge.html',wait_until='networkidle')
                checked('static hosting shows launch instructions','静态浏览版本' in static.locator('#connection').inner_text())
                checked('static hosting makes zero API calls',not static_calls)
            finally:browser.close()
    finally:
        proc.terminate();proc.wait(timeout=10)
        (OUT/'verification.json').write_text(json.dumps({'passed':results,'errors':errors},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'checks':len(results),'passed':results,'errors':errors},ensure_ascii=True))
