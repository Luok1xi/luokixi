"""Exercise the actual headless client in Edge, with isolated HTTP services and no UI edits."""
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
CAMPUS = ROOT / 'campus'
ORIGIN = 'http://127.0.0.1:17990'


def main():
    checks = []
    with tempfile.TemporaryDirectory(prefix='luokixi-circle-test-') as temporary:
        folder = Path(temporary)
        password = secrets.token_urlsafe(24)
        env = dict(os.environ, HUB_DATA_DIR=str(folder / 'hub'), CAMPUS_DATA_DIR=str(folder / 'library'),
                   CAMPUS_HUB_PORT='17991', HUB_PUBLIC_ORIGIN=ORIGIN, HUB_PRODUCTION='0',
                   HUB_SMTP_HOST='', HUB_TEST_PASSWORD=password)
        python = getattr(sys, '_base_executable', sys.executable)
        command = [python, str(CAMPUS / 'manage_hub.py')]
        for args in [['migrate', '--noinput'], ['hub_import_boards']]:
            subprocess.run(command + args, env=env, check=True, stdout=subprocess.DEVNULL)
        fixture = """
import os
from hub.models import Member
for name in ['circle_author','circle_reader','circle_mod']:
 Member.objects.create_user(name,name+'@example.test',os.environ['HUB_TEST_PASSWORD'],email_verified=True,is_staff=name=='circle_mod')
"""
        subprocess.run(command + ['shell', '-c', fixture], env=env, check=True, stdout=subprocess.DEVNULL)
        processes, logs = [], []
        try:
            for script, port in [('run_hub.py', '17991'), ('server.py', '17990')]:
                log = (folder / (script + '.log')).open('w', encoding='utf-8')
                logs.append(log)
                processes.append(subprocess.Popen([python, str(CAMPUS / script), '--port', port], env=env, cwd=CAMPUS,
                    stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0))
            for _ in range(80):
                try:
                    with urlopen(ORIGIN + '/api/hub/circle/capabilities', timeout=1) as response:
                        assert json.load(response)['algorithmVersion'] == 'campus-explicit-v1'
                    break
                except Exception:
                    time.sleep(.15)
            else:
                raise AssertionError('Circle services did not start')
            with sync_playwright() as pw:
                browser = pw.chromium.launch(channel='msedge', headless=True)
                pages = [browser.new_context().new_page() for _ in range(3)]
                source = (CAMPUS / 'hub-client.js').read_text(encoding='utf-8')
                errors = []
                for page, name in zip(pages, ['circle_author', 'circle_reader', 'circle_mod']):
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto(ORIGIN + '/auth.html', wait_until='networkidle')
                    await_import = """async source => {
                        const blob = URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
                        window.circleClient = (await import(blob)).createHubClient();
                        URL.revokeObjectURL(blob);
                    }"""
                    page.evaluate(await_import, source)
                    page.evaluate('async credentials => await circleClient.login(credentials)',
                                  {'email': name + '@example.test', 'password': password})
                author, reader, mod = pages
                reader.evaluate("async () => {await circleClient.followCreator('circle_author',true,true); await circleClient.saveCirclePreferences({interests:['机器人']});}")
                draft = author.evaluate("""async () => await circleClient.createCirclePost({
                    title:'隔离测试的校园创作',body:'这里是测试内容，不进入真实校圈。',
                    tags:['机器人'],rightsConfirmed:true,circle:{board:'makers',format:'moment'}
                })""")
                identifier = draft['id']
                assert reader.evaluate('async () => (await circleClient.circleFeed()).items.length') == 0
                author.evaluate('async id => await circleClient.submit(id,1)', identifier)
                mod.evaluate("async id => await circleClient.review(id,1,'approve','已核对测试内容')", identifier)
                feed = reader.evaluate("async () => await circleClient.circleFeed({lane:'following'})")
                assert feed['items'][0]['id'] == identifier
                notes = reader.evaluate('async () => await circleClient.notifications()')
                assert any(n['event'] == 'circle-new' for n in notes['items'])
                checks.append('real browser client login, follow opt-in, draft isolation, submit, moderation, following feed and notification')
                likes = reader.evaluate('async id => {await circleClient.likeCirclePost(id,true);return (await circleClient.likeCirclePost(id,true)).likes;}', identifier)
                assert likes == 1
                reader.evaluate("async id => await circleClient.circleFeedback(id,'not-interested')", identifier)
                assert reader.evaluate('async () => (await circleClient.circleFeed()).items.length') == 0
                reader.evaluate('async () => await circleClient.resetCircleRecommendations()')
                assert reader.evaluate('async () => (await circleClient.circleFeed()).items.length') == 1
                reader.evaluate('async () => await circleClient.saveCirclePreferences({personalized:false})')
                assert reader.evaluate('async () => (await circleClient.circleFeed()).mode') == 'latest'
                author.evaluate("async id => await circleClient.withdraw(id,'结束隔离验收')", identifier)
                assert reader.evaluate('async () => (await circleClient.circleFeed()).items.length') == 0
                assert not errors, errors
                checks.append('idempotent like, not-interested, reset, non-personalized latest mode, immediate withdrawal and zero client errors')
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
    result = {'status': 'PASS', 'checks': checks, 'productUI': 'Opus-owned; not implemented by this test'}
    output = CAMPUS / '.data/circle-qa'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
