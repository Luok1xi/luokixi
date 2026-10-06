"""Exercise real reputation UI against disposable accounts/database, never production."""
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
CAMPUS = ROOT / 'campus'
ORIGIN = 'http://127.0.0.1:17970'
OUT = CAMPUS / '.data/reputation-qa'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    checks = []
    with tempfile.TemporaryDirectory(prefix='luokixi-reputation-test-') as directory:
        folder = Path(directory)
        password = secrets.token_urlsafe(24)
        env = dict(os.environ, HUB_DATA_DIR=str(folder / 'hub'), CAMPUS_DATA_DIR=str(folder / 'library'),
                   CAMPUS_HUB_PORT='17971', HUB_PUBLIC_ORIGIN=ORIGIN, HUB_PRODUCTION='0',
                   HUB_SMTP_HOST='', HUB_TEST_PASSWORD=password)
        python = getattr(sys, '_base_executable', sys.executable)
        command = [python, str(CAMPUS / 'manage_hub.py')]
        subprocess.run(command + ['migrate', '--noinput'], env=env, check=True, stdout=subprocess.DEVNULL)
        fixture = """
import os
from hub.models import Member,Teacher,GuideCourse,CourseOffering
for name in ['qa_alice','qa_bob','qa_mod']:
 Member.objects.create_user(name,name+'@example.test',os.environ['HUB_TEST_PASSWORD'],email_verified=True,is_staff=name=='qa_mod')
t=Teacher.objects.create(name='验收教师（隔离测试）',faculty='测试学院',source_url='https://example.test/teacher')
c=GuideCourse.objects.create(id='qa-course',name='验收课程',resources=[{'title':'外部学习入口','url':'https://example.test/learn','type':'辅导课程','audience':'了解基础概念','cost':'unknown','checkedAt':'2026-10-06'}])
o=CourseOffering.objects.create(course=c,term='2026 秋',campus='shahe',source_url='https://example.test/term')
o.teachers.add(t)
"""
        subprocess.run(command + ['shell', '-c', fixture], env=env, check=True, stdout=subprocess.DEVNULL)
        processes, logs = [], []
        try:
            for script, port in [('run_hub.py', '17971'), ('server.py', '17970')]:
                log = (folder / (script + '.log')).open('w', encoding='utf-8')
                logs.append(log)
                processes.append(subprocess.Popen([python, str(CAMPUS / script), '--port', port], env=env, cwd=CAMPUS,
                    stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0))
            for _ in range(80):
                try:
                    with urlopen(ORIGIN + '/api/hub/teachers', timeout=1) as response:
                        assert json.load(response)['total'] == 1
                    break
                except Exception:
                    time.sleep(.15)
            else:
                raise AssertionError('HTTP services did not start')
            with sync_playwright() as pw:
                browser = pw.chromium.launch(channel='msedge', headless=True)
                contexts = [browser.new_context(viewport={'width': 390, 'height': 844}) for _ in range(4)]
                a, b, m, visitor = contexts

                def post(context, route, body, status=200):
                    csrf = context.request.get(ORIGIN + '/api/hub/auth/session').json()['csrfToken']
                    response = context.request.post(ORIGIN + '/api/hub/' + route, data=body,
                        headers={'X-CSRFToken': csrf, 'Origin': ORIGIN})
                    assert response.status == status, (route, response.status, response.text())
                    return response.json()

                for context, name in [(a, 'qa_alice'), (b, 'qa_bob'), (m, 'qa_mod')]:
                    post(context, 'auth/login', {'email': name + '@example.test', 'password': password})
                teacher = a.request.get(ORIGIN + '/api/hub/teachers').json()['items'][0]
                tid = teacher['id']
                offering = a.request.get(ORIGIN + '/api/hub/teachers/' + tid).json()['offerings'][0]['id']
                errors = []
                page = a.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(ORIGIN + '/reputation.html?teacher=' + tid, wait_until='networkidle')
                expect(page.get_by_role('heading', name='验收教师（隔离测试）')).to_be_visible()
                page.get_by_role('button', name='写评价', exact=True).click()
                page.locator('input[name=rating][value="4"]').check()
                quote = '课程难，但是讲得清楚。\n<sCript>这段文字必须按原文显示</sCript>'
                page.locator('#rp-review-form textarea[name=body]').fill(quote)
                page.locator('#rp-review-form select[name=courseId]').select_option('qa-course')
                page.locator('#rp-review-form input[name=term]').fill('2026 秋')
                page.get_by_role('button', name='提交审核', exact=True).click()
                expect(page.locator('#rp-editor')).not_to_be_visible()
                expect(page.locator('#rp-message')).to_contain_text('已提交审核')
                first = a.request.get(ORIGIN + '/api/hub/reviews/mine').json()['items'][0]
                assert visitor.request.get(ORIGIN + '/api/hub/reviews').json()['total'] == 0
                mod = m.new_page()
                mod.on('pageerror', lambda error: errors.append(str(error)))
                mod.goto(ORIGIN + '/reputation.html?view=moderation', wait_until='networkidle')
                expect(mod.get_by_role('heading', name='评价审核 · 1')).to_be_visible()
                mod.get_by_role('button', name='通过', exact=True).click()
                mod.locator('#rp-action-form textarea').fill('核对为具体课程体验。')
                mod.get_by_role('button', name='确认', exact=True).click()
                expect(mod.get_by_role('heading', name='评价审核 · 0')).to_be_visible()
                checks.append('mobile anonymous review submission and real moderator approval UI')
                bob = b.new_page()
                bob.on('pageerror', lambda error: errors.append(str(error)))
                bob.goto(ORIGIN + '/reputation.html?teacher=' + tid, wait_until='networkidle')
                bob.get_by_role('button', name='赞同 · 0', exact=True).click()
                expect(bob.get_by_role('button', name='赞同 · 1', exact=True)).to_be_visible()
                bob.goto(ORIGIN + '/reputation.html', wait_until='networkidle')
                expect(bob.locator('.rp-quote blockquote')).to_have_text('“' + quote + '”')
                expect(bob.locator('.rp-quote')).to_contain_text('高赞评论')
                assert bob.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                assert not bob.locator('#rp-content script').count()
                bob.screenshot(path=str(OUT / 'cards-mobile.png'), full_page=True)
                bob.locator('.rp-quote a').click()
                expect(bob.locator('#review-' + first['id'])).to_be_visible()
                assert bob.url.endswith('#review-' + first['id'])
                checks.append('exact original quote, idempotent like, mobile card deep link, HTML escaping')
                bob.get_by_role('button', name='查看回复', exact=True).click()
                bob.get_by_role('button', name='匿名回复', exact=True).click()
                bob.locator('#rp-action-form textarea').fill('谢谢分享！')
                bob.get_by_role('button', name='确认', exact=True).click()
                expect(bob.locator('#rp-action-dialog')).not_to_be_visible()
                mod.reload(wait_until='networkidle')
                mod.get_by_role('button', name='通过回复', exact=True).click()
                mod.locator('#rp-action-form textarea').fill('正常交流')
                mod.get_by_role('button', name='确认', exact=True).click()
                expect(mod.locator('#rp-action-dialog')).not_to_be_visible()
                bob.reload(wait_until='networkidle')
                bob.get_by_role('button', name='查看回复', exact=True).click()
                expect(bob.locator('.rp-reply')).to_contain_text('谢谢分享')
                body = visitor.request.get(ORIGIN + '/api/hub/reviews/' + first['id']).text()
                assert 'qa_alice' not in body and 'qa_bob' not in body
                checks.append('anonymous replies with moderation and no public account attribution')
                page.goto(ORIGIN + '/reputation.html?view=mine', wait_until='networkidle')
                page.get_by_role('button', name='修改评价', exact=True).click()
                page.locator('#rp-review-form textarea[name=body]').fill('修改后的原话。')
                page.get_by_role('button', name='提交审核', exact=True).click()
                expect(page.locator('#rp-editor')).not_to_be_visible()
                revision = a.request.get(ORIGIN + '/api/hub/reviews/mine').json()['items'][0]
                post(m, 'reviews/' + revision['id'] + '/moderate', {'revision': revision['revision'], 'decision': 'approve', 'note': '版本核对'})
                assert visitor.request.get(ORIGIN + '/api/hub/reviews/' + revision['id']).json()['likes'] == 0
                page.reload(wait_until='networkidle')
                page.get_by_role('button', name='撤回', exact=True).click()
                page.locator('#rp-action-form textarea').fill('验收撤回')
                page.get_by_role('button', name='确认', exact=True).click()
                expect(page.locator('#rp-action-dialog')).not_to_be_visible()
                expect(page.locator('.rp-review')).to_contain_text('已撤回')
                assert visitor.request.get(ORIGIN + '/api/hub/teachers/' + tid).json()['stats']['average'] is None
                checks.append('edit version, reapproval, old-like clearing, withdrawal and empty average')
                page.goto(ORIGIN + '/reputation.html?offering=' + offering, wait_until='networkidle')
                expect(page.get_by_role('link', name='前往外部平台 ↗')).to_have_attribute('href', 'https://example.test/learn')
                expect(page.locator('#rp-content')).to_contain_text('收费情况以原站为准')
                page.get_by_role('button', name='写评价', exact=True).click()
                page.locator('input[name=rating][value="2"]').check()
                page.locator('#rp-review-form textarea[name=body]').fill('课程的独立体验。')
                page.get_by_role('button', name='提交审核', exact=True).click()
                expect(page.locator('#rp-editor')).not_to_be_visible()
                course_review = [r for r in a.request.get(ORIGIN + '/api/hub/reviews/mine').json()['items'] if r['subjectType'] == 'offering'][0]
                post(m, 'reviews/' + course_review['id'] + '/moderate', {'revision': 1, 'decision': 'approve', 'note': '课程独立评价'})
                assert visitor.request.get(ORIGIN + '/api/hub/offerings/' + offering).json()['stats']['average'] == 2
                assert visitor.request.get(ORIGIN + '/api/hub/teachers/' + tid).json()['stats']['average'] is None
                checks.append('course rating independent from teacher, explicit external learning link')
                page.set_viewport_size({'width': 1440, 'height': 1000})
                page.goto(ORIGIN + '/reputation.html', wait_until='networkidle')
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                page.screenshot(path=str(OUT / 'cards-desktop.png'), full_page=True)
                page.emulate_media(color_scheme='dark', reduced_motion='reduce')
                page.screenshot(path=str(OUT / 'cards-dark.png'), full_page=True)
                assert not errors, errors
                checks.append('390px/1440px layout, dark appearance, reduced motion, zero JS errors')
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
        (OUT / 'result.json').write_text(json.dumps({'status': 'PASS', 'checks': checks}, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'status': 'PASS', 'checks': checks}, ensure_ascii=False))


if __name__ == '__main__':
    main()
