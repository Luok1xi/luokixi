"""Real multipart/proxy/worker/HTML5 playback check; no product UI or live accounts."""
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
ORIGIN = 'http://127.0.0.1:17980'
OUT = CAMPUS / '.data/reputation-qa'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    checks = []
    with tempfile.TemporaryDirectory(prefix='luokixi-video-test-') as directory:
        folder = Path(directory)
        password = secrets.token_urlsafe(24)
        env = dict(os.environ, HUB_DATA_DIR=str(folder / 'hub'), CAMPUS_DATA_DIR=str(folder / 'library'),
                   CAMPUS_HUB_PORT='17981', HUB_PUBLIC_ORIGIN=ORIGIN, HUB_PRODUCTION='0',
                   HUB_SMTP_HOST='', HUB_TEST_PASSWORD=password, HUB_TEST_VIDEO=str(folder / 'sample.mp4'))
        python = getattr(sys, '_base_executable', sys.executable)
        command = [python, str(CAMPUS / 'manage_hub.py')]
        subprocess.run(command + ['migrate', '--noinput'], env=env, check=True, stdout=subprocess.DEVNULL)
        fixture = """
import os,subprocess
from hub.clips import encoder
from hub.models import Member,Teacher
for name in ['clip_author','clip_moderator']:
 Member.objects.create_user(name,name+'@example.test',os.environ['HUB_TEST_PASSWORD'],email_verified=True,is_staff=name=='clip_moderator')
Teacher.objects.create(name='视频验收教师（隔离测试）',source_url='https://example.test/teacher')
subprocess.run([encoder(),'-nostdin','-v','error','-f','lavfi','-i','color=c=blue:size=320x240:rate=10',
 '-f','lavfi','-i','sine=frequency=440:sample_rate=22050','-t','2','-c:v','libx264','-pix_fmt','yuv420p',
 '-c:a','aac',os.environ['HUB_TEST_VIDEO']],check=True,capture_output=True,timeout=30,
 creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
"""
        subprocess.run(command + ['shell', '-c', fixture], env=env, check=True, stdout=subprocess.DEVNULL)
        processes, logs = [], []
        try:
            for script, port in [('run_hub.py', '17981'), ('server.py', '17980')]:
                log = (folder / (script + '.log')).open('w', encoding='utf-8')
                logs.append(log)
                processes.append(subprocess.Popen([python, str(CAMPUS / script), '--port', port], env=env, cwd=CAMPUS,
                    stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0))
            for _ in range(80):
                try:
                    with urlopen(ORIGIN + '/api/hub/clips/capabilities', timeout=1) as response:
                        assert json.load(response)['available']
                    break
                except Exception:
                    time.sleep(.15)
            else:
                raise AssertionError('Clip HTTP services did not start')
            with sync_playwright() as pw:
                browser = pw.chromium.launch(channel='msedge', headless=True)
                author, mod, visitor = [browser.new_context() for _ in range(3)]

                def headers(context):
                    csrf = context.request.get(ORIGIN + '/api/hub/auth/session').json()['csrfToken']
                    return {'X-CSRFToken': csrf, 'Origin': ORIGIN}

                def post(context, route, data):
                    response = context.request.post(ORIGIN + '/api/hub/' + route, data=data, headers=headers(context))
                    assert response.status == 200, (route, response.status, response.text())
                    return response.json()

                for context, name in [(author, 'clip_author'), (mod, 'clip_moderator')]:
                    post(context, 'auth/login', {'email': name + '@example.test', 'password': password})
                teacher = author.request.get(ORIGIN + '/api/hub/teachers').json()['items'][0]['id']
                response = author.request.post(ORIGIN + '/api/hub/clips', headers=headers(author), multipart={
                    'file': {'name': 'sample.mp4', 'mimeType': 'video/mp4', 'buffer': (folder / 'sample.mp4').read_bytes()},
                    'title': '隔离视频验收', 'transcript': '测试上传、审核与播放，非真实经验。',
                    'subjectType': 'teacher', 'subjectId': teacher, 'rightsConfirmed': 'true'})
                assert response.status == 200, response.text()
                identifier = response.json()['id']
                stream = ORIGIN + '/api/hub/clips/' + identifier + '/stream'
                assert visitor.request.get(stream).status == 404
                for _ in range(160):
                    item = author.request.get(ORIGIN + '/api/hub/clips/mine').json()['items'][0]
                    assert item['state'] != 'failed', item
                    if item['state'] == 'pending':
                        break
                    time.sleep(.2)
                else:
                    raise AssertionError('Video worker did not finish')
                assert visitor.request.get(stream).status == 404
                assert author.request.get(ORIGIN + item['posterUrl']).status == 200
                checks.append('real multipart upload through proxy, independent worker, private poster/playback before review')
                post(mod, 'clips/' + identifier + '/moderate', {'decision': 'approve', 'note': '隔离验收通过'})
                partial = visitor.request.get(stream, headers={'Range': 'bytes=0-31'})
                assert partial.status == 206 and len(partial.body()) == 32
                assert partial.headers['content-range'].startswith('bytes 0-31/')
                checks.append('moderation and HTTP 206 range headers preserved through proxy')
                page = visitor.new_page()
                page.goto(ORIGIN + '/reputation.html', wait_until='networkidle')
                # Ephemeral browser-only harness: Opus owns all actual video page layout.
                page.set_content('<video id="clip" controls muted playsinline preload="auto"></video>')
                page.locator('#clip').evaluate('(video, src) => { video.src = src; video.load(); }', stream)
                page.wait_for_function('document.querySelector("video").readyState >= 3')
                duration = page.locator('#clip').evaluate('(video) => video.duration')
                assert 1.8 < duration < 2.5, duration
                page.locator('#clip').evaluate('(video) => video.play()')
                page.wait_for_function('document.querySelector("video").currentTime > 0.2')
                page.locator('#clip').evaluate('(video) => {video.pause(); video.currentTime = 1.2;}')
                page.wait_for_function('!document.querySelector("video").seeking')
                assert page.locator('#clip').evaluate('(video) => video.error === null && video.currentTime >= 1.1')
                checks.append('Edge HTML5 actual decode, playback, duration and seeking')
                post(author, 'clips/' + identifier + '/withdraw', {'note': '验收后撤回'})
                assert visitor.request.get(stream).status == 404
                assert visitor.request.get(ORIGIN + '/api/hub/clips').json()['total'] == 0
                checks.append('withdrawal immediately closes new stream requests and removes public listing')
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
        result = {'status': 'PASS', 'checks': checks}
        (OUT / 'clip-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
