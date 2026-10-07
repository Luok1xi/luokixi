import json
import os
import tempfile
from pathlib import Path
from unittest import mock
from django.test import Client, TestCase, override_settings
from .models import BeikuangTask, CampusBoard, Entry, Job, Member, MirrorAsset, Notification
from . import maintenance, mirror

NEWS_LIST = """<html><body><ul>
<li><a href="info/1003/40766.htm" title="学校举行升旗仪式庆祝中华人民共和国成立77周年">学校举行升旗仪式…</a><span>2026/10/01</span></li>
<li><a href="info/1003/40736.htm">学校召开校第62次学位评定委员会会议</a><span>2026/09/30</span></li>
<li><a href="index.htm">首页</a></li>
</ul></body></html>""".encode()

ARTICLE = """<html><head><title>学校举行升旗仪式庆祝中华人民共和国成立77周年-中国矿业大学(北京) 新闻网</title></head>
<body><div class="meta">发布时间：2026-10-01 08:30:00 作者：张三 来源：党委武装部</div>
<div class="v_news_content"><p>10月1日，学校在沙河校区操场举行升旗仪式。全体师生齐唱国歌。</p>
<p><img src="/virtual_attach_file.vsb?afc=abc&amp;e=.jpg"></p><p>（文/党委武装部 图/李昕潞）</p></div></body></html>""".encode()


@override_settings(MEDIA_ROOT=Path(tempfile.mkdtemp()))
class MaintenanceTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = Member.objects.create_user('alice_m', 'alice-m@example.test', 'Quartz-maint-water-521', email_verified=True)
        cls.mod = Member.objects.create_user('mod_m', 'mod-m@example.test', 'Quartz-maint-water-522', email_verified=True, is_staff=True)

    def setUp(self):
        self.a, self.m, self.visitor = Client(), Client(), Client()
        self.a.force_login(self.alice)
        self.m.force_login(self.mod)

    def post(self, client, path, data, status=200):
        r = client.post('/api/hub/' + path, json.dumps(data), content_type='application/json')
        self.assertEqual(r.status_code, status, r.content)
        return r.json()

    # ---------- 解析 ----------

    def test_news_list_and_article_parsing(self):
        items = maintenance.parse_news_list(NEWS_LIST, 'https://news8.cumtb.edu.cn/zhyw.htm')
        self.assertEqual([i['url'] for i in items], ['https://news8.cumtb.edu.cn/info/1003/40766.htm', 'https://news8.cumtb.edu.cn/info/1003/40736.htm'])
        self.assertEqual(items[0]['date'], '2026-10-01')
        self.assertEqual(items[0]['title'], '学校举行升旗仪式庆祝中华人民共和国成立77周年')
        a = maintenance.parse_article(ARTICLE, 'https://news8.cumtb.edu.cn/info/1003/40766.htm')
        self.assertEqual(a['title'], '学校举行升旗仪式庆祝中华人民共和国成立77周年')
        self.assertEqual(a['publishedAt'], '2026-10-01T08:30:00+08:00')
        self.assertTrue(a['image'].startswith('https://news8.cumtb.edu.cn/virtual_attach_file.vsb'))
        self.assertIn('李昕潞', a['credit'])
        self.assertTrue(a['summary'].startswith('10月1日'))

    def test_library_text_and_readme_image(self):
        items = maintenance.parse_library_text('通知公告\n2026年图书馆暑假开馆安排\n2026-07-09 12:19\n图书馆2026年毕业季系列活动\n2026-06-12 14:42\n')
        self.assertEqual(items[0], {'title': '2026年图书馆暑假开馆安排', 'date': '2026-07-09'})
        md = '![build](https://img.shields.io/badge/x.svg)\n# Arm\n![photo](docs/arm.jpg)\n'
        self.assertEqual(maintenance.readme_image(md, 'peng/arm'), 'https://raw.githubusercontent.com/peng/arm/HEAD/docs/arm.jpg')
        self.assertEqual(maintenance.readme_image('<img src="https://github.com/a/b/blob/main/p.png">', 'a/b'), 'https://raw.githubusercontent.com/a/b/main/p.png')

    # ---------- 新闻：进待审核，维护者通过后公开 ----------

    def test_school_news_creates_pending_entries_for_review(self):
        def fake(target, limit=0):
            return (ARTICLE if '/info/' in target else NEWS_LIST), target
        with mock.patch.object(maintenance, 'get_page', side_effect=fake):
            result = maintenance.school_news()
            again = maintenance.school_news()
        self.assertEqual(len(result['created']), 2)
        self.assertEqual(again['created'], [])  # 同一篇不会重复建
        entry = Entry.objects.get(pk=result['created'][0]['id'])
        self.assertEqual((entry.kind, entry.state, entry.owner), ('news', 'pending', None))
        self.assertIn('virtual_attach_file', entry.draft['media']['src'])
        # 机器人的消息交给北矿娘，不再进维护者的通知（beikuang.receive）
        self.assertFalse(Notification.objects.filter(user=self.mod, event='maintenance').exists())
        self.assertTrue(BeikuangTask.objects.filter(kind='notice', key__startswith='notice:maint-news:').exists())
        self.assertTrue(Job.objects.filter(kind='maint-beikuang').exists())
        # 公开目录里还看不到
        self.assertEqual(self.visitor.get('/api/hub/catalogue?kind=news').json()['total'], 0)
        self.post(self.m, f'entries/{entry.pk}/review', {'revision': entry.revision, 'decision': 'approve', 'note': '核对原文与配图署名'})
        news = self.visitor.get('/api/hub/catalogue?kind=news').json()
        self.assertEqual(news['total'], 1)
        self.assertEqual(news['items'][0]['data']['media']['credit'][:5], '矿大新闻网')

    def test_status_and_run_are_staff_only(self):
        self.assertEqual(self.a.get('/api/hub/maintenance/status').status_code, 403)
        self.assertEqual(self.m.get('/api/hub/maintenance/status').status_code, 200)
        self.post(self.a, 'maintenance/run', {'task': 'news'}, 403)
        jobs = self.post(self.m, 'maintenance/run', {'task': 'all'})['jobs']
        self.assertEqual({j['kind'] for j in jobs}, {'maint-github', 'maint-news', 'maint-notices', 'maint-links', 'maint-media', 'maint-mirror','maint-organize','maint-supervisor','maint-beikuang'})
        self.post(self.m, 'maintenance/run', {'task': 'rm -rf'}, 400)

    def test_schedule_skips_mirror_unless_enabled(self):
        with mock.patch.dict(os.environ, {'HUB_MAINTENANCE': '1'}):
            os.environ.pop('HUB_MIRROR_AUTO', None)
            maintenance.schedule_jobs()
        kinds = set(Job.objects.values_list('kind', flat=True))
        self.assertIn('maint-news', kinds)
        self.assertNotIn('maint-mirror', kinds)

    # ---------- 本站下载：只镜像允许再分发的许可证 ----------

    def test_mirror_blocks_repositories_without_a_license(self):
        with mock.patch.object(mirror, 'github_json', return_value={'license': None, 'html_url': 'https://github.com/a/b'}), \
             mock.patch.object(mirror, 'stream_public') as stream:
            state = mirror.mirror_repository('a/b')
        self.assertEqual(state['status'], 'license-blocked')
        stream.assert_not_called()
        self.assertFalse(MirrorAsset.objects.exists())

    def test_mirror_stores_release_assets_and_serves_them(self):
        def api(path):
            if '/commits/' in path: return {'sha':'a'*40}
            if '/license?' in path:
                return {'license':{'spdx_id':'MIT'},'content':__import__('base64').b64encode(b'MIT License - fixture').decode()}
            if path.endswith('/releases/latest'):
                return {'tag_name': 'v1.2.0', 'published_at': '2026-09-01T00:00:00Z', 'html_url': 'https://github.com/a/b/releases/tag/v1.2.0',
                        'assets': [{'name': 'firmware.hex', 'size': 12, 'browser_download_url': 'https://github.com/a/b/releases/download/v1.2.0/firmware.hex'},
                                   {'name': 'notes.txt', 'size': 3, 'browser_download_url': 'https://github.com/a/b/x.txt'}]}
            return {'license': {'spdx_id': 'MIT'}, 'html_url': 'https://github.com/a/b', 'default_branch': 'main'}

        def stream(target, destination, limit):
            destination.write_bytes(b'hello-world!')
            return 12, __import__('hashlib').sha256(b'hello-world!').hexdigest(), target

        with mock.patch.object(mirror, 'github_json', side_effect=api), mock.patch.object(mirror, 'stream_public', side_effect=stream):
            state = mirror.mirror_repository('https://github.com/a/b')
            again = mirror.mirror_repository('a/b')
        self.assertEqual(state['status'], 'ok')
        self.assertEqual([m['name'] for m in state['mirrored']], ['b-aaaaaaaaaaaa.zip','firmware.hex'])
        self.assertEqual(again['mirrored'], [])
        listing = self.visitor.get('/api/hub/mirror?repository=a/b').json()
        self.assertEqual(listing['items'][0]['license'], 'MIT')
        r = self.visitor.get(listing['items'][0]['url'])
        self.assertEqual(r.status_code, 200)
        self.assertIn('attachment', r['Content-Disposition'])
        self.assertEqual(b''.join(r.streaming_content), b'hello-world!')
        self.assertEqual(MirrorAsset.objects.get(pk=listing['items'][0]['id']).downloads, 1)
        self.post(self.a, 'mirror/refresh', {'repository': 'a/b'}, 403)
        self.assertEqual(self.post(self.m, 'mirror/refresh', {'repository': 'a/b'})['job']['kind'], 'mirror-repo')
        self.assertEqual(self.visitor.get('/api/hub/mirror?repository=../../etc').status_code, 400)


class BoardProposalTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = Member.objects.create_user('alice_b', 'alice-b@example.test', 'Quartz-board-water-521', email_verified=True)
        cls.mod = Member.objects.create_user('mod_b', 'mod-b@example.test', 'Quartz-board-water-522', email_verified=True, is_staff=True)
        CampusBoard.objects.create(id='daily', name='矿大日常')

    def setUp(self):
        self.a, self.m = Client(), Client()
        self.a.force_login(self.alice)
        self.m.force_login(self.mod)

    def post(self, client, path, data, status=200):
        r = client.post('/api/hub/' + path, json.dumps(data), content_type='application/json')
        self.assertEqual(r.status_code, status, r.content)
        return r.json()

    def test_student_proposes_board_and_maintainer_opens_it(self):
        made = self.post(self.a, 'circle/board-proposals', {'name': '沙河考研吧', 'description': '一起备考，分享真题和作息', 'rules': '不发广告'})
        self.assertEqual(made['state'], 'pending')
        self.post(self.a, 'circle/board-proposals', {'name': '沙河考研', 'description': '重复'}, 409)
        self.post(self.a, 'circle/board-proposals', {'name': '矿大日常', 'description': '同名'}, 409)
        # 审核前不出现在吧列表里
        self.assertNotIn(made['id'], [b['id'] for b in self.a.get('/api/hub/circle/boards').json()['items']])
        self.assertEqual(self.a.get('/api/hub/circle/board-proposals').status_code, 403)
        pending = self.m.get('/api/hub/circle/board-proposals').json()['items']
        self.assertEqual((pending[0]['name'], pending[0]['proposer']['username']), ('沙河考研', 'alice_b'))
        self.assertTrue(Notification.objects.filter(user=self.mod, event='board-proposal').exists())
        self.post(self.m, 'circle/boards', {'id': made['id'], 'name': '沙河考研吧', 'description': pending[0]['description'], 'active': True})
        self.assertIn(made['id'], [b['id'] for b in self.a.get('/api/hub/circle/boards').json()['items']])
        self.assertTrue(Notification.objects.filter(user=self.alice, key=f"board-approved:{made['id']}").exists())

    def test_maintainer_rejects_with_reason(self):
        made = self.post(self.a, 'circle/board-proposals', {'name': '代课吧', 'description': '找人代课'})
        self.post(self.a, f"circle/board-proposals/{made['id']}/reject", {'reason': '违反校规'}, 403)
        self.post(self.m, f"circle/board-proposals/{made['id']}/reject", {'reason': '代课违反校规'})
        self.assertFalse(CampusBoard.objects.filter(pk=made['id']).exists())
        self.assertIn('违反校规', Notification.objects.get(user=self.alice, key=f"board-rejected:{made['id']}").text)
