"""Real HTTP + mobile page acceptance against an isolated, disposable database.

Run with the same Python runtime as campus/manage_hub.py after npm run build.
No real account, email, library file or external AI service is used.
"""
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
from email import policy
from email.parser import BytesParser
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
CAMPUS = ROOT/'campus'
ORIGIN = 'http://127.0.0.1:17960'
OUT = CAMPUS/'.data/hub-qa'
OUT.mkdir(parents=True,exist_ok=True)
checks = []


def main():
    with tempfile.TemporaryDirectory(prefix='luokixi-hub-test-') as folder:
        data = Path(folder)
        env = dict(os.environ,HUB_DATA_DIR=str(data/'hub'),CAMPUS_DATA_DIR=str(data/'library'),
                   CAMPUS_HUB_PORT='17961',HUB_PUBLIC_ORIGIN=ORIGIN,HUB_PRODUCTION='0',
                   HUB_SMTP_HOST='',HUB_GITHUB_CLIENT_ID='',HUB_GITHUB_CLIENT_SECRET='',HUB_AI_MODEL='')
        password = secrets.token_urlsafe(24)
        env['HUB_TEST_PASSWORD'] = password
        # Windows venv launchers spawn a child that outlives terminate(); use the base
        # interpreter for server subprocesses so cleanup owns the actual process.
        server_python = getattr(sys,'_base_executable',sys.executable)
        command = [server_python,str(CAMPUS/'manage_hub.py')]
        subprocess.run(command+['migrate','--noinput'],env=env,check=True,stdout=subprocess.DEVNULL)
        subprocess.run(command+['shell','-c',
            "import os; from hub.models import Member; Member.objects.create_user('qa_moderator','mod@example.test',os.environ['HUB_TEST_PASSWORD'],email_verified=True,is_staff=True)"],
            env=env,check=True,stdout=subprocess.DEVNULL)
        processes,logs = [],[]
        try:
            for script,port in [('run_hub.py','17961'),('server.py','17960')]:
                log = (data/(script+'.log')).open('w',encoding='utf-8')
                logs.append(log)
                processes.append(subprocess.Popen([server_python,str(CAMPUS/script),'--port',port],
                    env=env,cwd=CAMPUS,stdout=log,stderr=log,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0))
            for attempt in range(50):
                try:
                    with urlopen(ORIGIN+'/api/hub/health',timeout=1) as response:
                        assert json.load(response)['version']=='2.0'
                    break
                except Exception:
                    time.sleep(.15)
            else:
                raise AssertionError('isolated HTTP services failed to start')
            with sync_playwright() as p:
                browser = p.chromium.launch(channel='msedge',headless=True)
                context = browser.new_context(viewport={'width':390,'height':844},device_scale_factor=1)
                page = context.new_page()
                errors = []
                page.on('pageerror',lambda exc:errors.append(str(exc)))

                def register_page(handle):
                    page.goto(ORIGIN+'/auth.html?mode=register',wait_until='networkidle')
                    page.locator('input[name=email]').fill(handle+'@example.test')
                    page.locator('input[name=username]').fill(handle)
                    page.locator('input[name=password]').fill(password)
                    page.locator('button[type=submit]').click()
                    page.locator('.acct-ok').wait_for()
                    assert '你的邮箱不会收到' in page.inner_text('body')
                    mails = sorted((data/'hub/mail-preview').glob('*'),key=lambda x:x.stat().st_mtime)
                    msg = BytesParser(policy=policy.default).parsebytes(mails[-1].read_bytes())
                    link = re.search(r'http://[^\s]+/hub/#verify/[^\s]+',msg.get_content()).group()
                    page.goto(link,wait_until='networkidle')
                    page.get_by_role('heading',name='邮箱已验证').wait_for()
                    assert '#' not in page.url and 'token=' not in page.url
                    return context.request

                def post(client,path,body,code=200):
                    token = client.get(ORIGIN+'/api/hub/auth/session').json()['csrfToken']
                    response = client.post(ORIGIN+'/api/hub/'+path,data=body,
                        headers={'Content-Type':'application/json','X-CSRFToken':token,'Origin':ORIGIN})
                    assert response.status==code,(path,response.status,response.text()[:250])
                    return response.json()

                alice = register_page('qa_alice')
                page.goto(ORIGIN+'/me.html#profile',wait_until='networkidle')
                page.locator('input[name=display_name]').fill('手机测试同学')
                page.locator('#profile-form button[type=submit]').click()
                page.wait_for_timeout(200)
                assert alice.get(ORIGIN+'/api/hub/me').json()['profile']['name']=='手机测试同学'
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                page.screenshot(path=str(OUT/'mobile-account.png'),full_page=True)
                checks.append('mobile register, empty nickname, verification link, profile persistence, no horizontal overflow')
                draft = post(alice,'entries',{'kind':'project','data':{'title':'QA isolated robot',
                    'summary':'Disposable acceptance content','body':'Robot setup','license':'MIT','rightsConfirmed':True,
                    'links':{'repo':'https://github.com/example/qa-isolated'},'tags':['robot'],'category':'mech'}})
                eid = draft['id']
                post(alice,'entries/'+eid+'/submit',{'revision':draft['editRevision']})
                moderator = browser.new_context().request
                post(moderator,'auth/login',{'email':'mod@example.test','password':password})
                post(moderator,'entries/'+eid+'/review',{'revision':1,'decision':'approve','note':'test fixture only'})
                bob_context = browser.new_context(viewport={'width':390,'height':844})
                bob = bob_context.request
                post(bob,'auth/register',{'username':'qa_bob','email':'qa_bob@example.test','password':password})
                mail = sorted((data/'hub/mail-preview').glob('*'),key=lambda x:x.stat().st_mtime)[-1]
                message = BytesParser(policy=policy.default).parsebytes(mail.read_bytes()).get_content()
                token = re.search(r'/hub/#verify/([^\s]+)',message).group(1)
                post(bob,'auth/verify',{'token':token})
                post(bob,'entries/'+eid+'/star',{'enabled':True})
                post(bob,'entries/'+eid+'/star',{'enabled':True})
                assert bob.get(ORIGIN+'/api/hub/entries/'+eid).json()['siteStars']==1
                post(bob,'entries/'+eid+'/watch',{'events':['revision']})
                reply = post(bob,'entries/'+eid+'/replies',{'body':'How do I reproduce the example?'})
                post(moderator,'replies/'+reply['id']+'/review',{'approve':True})
                edit = post(alice,'entries/'+eid+'/save',{'revision':1,'data':dict(draft['draft'],summary='Updated example')})
                post(alice,'entries/'+eid+'/submit',{'revision':edit['editRevision']})
                post(moderator,'entries/'+eid+'/review',{'revision':edit['editRevision'],'decision':'approve','note':'revision checked'})
                notes = bob.get(ORIGIN+'/api/hub/notifications').json()['items']
                assert any(n['event']=='revision' for n in notes)
                post(bob,'entries/'+eid+'/watch',{'events':[]})
                post(bob,'entries/'+eid+'/save',{'revision':2,'data':draft['draft']},403)
                private = post(alice,'entries',{'kind':'topic','data':{'title':'Private QA draft'}})
                assert bob.get(ORIGIN+'/api/hub/entries/'+private['id']).status==404
                forbidden = bob.post(ORIGIN+'/api/hub/auth/profile',data={},headers={'Origin':'https://foreign.example','Content-Type':'application/json'})
                assert forbidden.status in (400,403),forbidden.status
                no_csrf = bob.post(ORIGIN+'/api/hub/auth/profile',data={},headers={'Origin':ORIGIN,'Content-Type':'application/json'})
                assert no_csrf.status==403
                checks.append('two accounts through same-origin proxy: submit, moderation, idempotent star, reply, revision notification, ownership, private draft, CSRF')
                public = browser.new_context().request
                assert public.get(ORIGIN+'/api/hub/catalogue').json()['total']==1
                page.goto(ORIGIN+'/discover.html',wait_until='networkidle')
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                assert not errors,errors
                checks.append('discovery online empty state, public search excludes private draft, zero page errors')
                browser.close()
        finally:
            for process in reversed(processes):
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            for log in logs:
                log.close()
        result = {'status':'PASS','checks':checks,'database':'temporary and removed','realEmailSent':False,
                  'limits':['no live GitHub OAuth','no configured AI model','no campus login or seat API','submission UI owned by Opus not exercised']}
        (OUT/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    main()
