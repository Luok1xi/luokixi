import json
import os
import struct
from datetime import timedelta
from unittest import mock
from django.contrib.auth import authenticate
from django.test import Client, TestCase
from django.utils import timezone
from . import beikuang
from . import project_summaries  # noqa: F401  先导入，免得下面 patch config 时它把替身绑进模块，影响别的测试
from .github_guides import cache_key
from .maintenance import staff_notice
from .models import (BeikuangMessage, BeikuangTask, Entry, ExternalCache, Job, Member, Notification, Revision, Teacher)
from .project_catalog import fingerprint
from .worker import run_one


def news(slug, **change):
    when = (timezone.now() - timedelta(days=1)).isoformat()
    draft = {'title': '学校举行升旗仪式庆祝国庆', 'summary': '10月1日，学校在沙河校区操场举行升旗仪式，全体师生齐唱国歌。',
             'body': '', 'links': {'source': 'https://news8.cumtb.edu.cn/info/1003/' + slug + '.htm'}, 'publishedAt': when,
             'media': {'src': 'https://news8.cumtb.edu.cn/virtual_attach_file.vsb?afc=' + slug, 'credit': '矿大新闻网 · 摄影：李昕潞'},
             'sourceNote': '矿大新闻网', 'license': '来源版权保留', 'tags': [], 'uploads': []}
    draft.update(change)
    entry = Entry.objects.create(kind='news', slug='news-' + slug, state='pending', draft=draft)
    Revision.objects.create(entry=entry, number=1, data=draft, state='pending')
    return entry


def project(repo, **change):
    data = {'repository': repo, 'url': 'https://github.com/' + repo, 'description': 'A robot arm toolkit', 'credit': repo.split('/')[0],
            'license': 'MIT', 'readmeUrl': 'https://github.com/' + repo + '/blob/main/README.md', 'readmeSha': 'sha1',
            'releaseUrl': 'https://github.com/' + repo + '/releases', 'topics': ['robotics'], 'pushedAt': '2026-09-01T00:00:00Z',
            'downloads': [{'name': 'Source ZIP', 'kind': 'source-archive', 'url': 'https://github.com/' + repo + '/archive/main.zip'}],
            'discovery': {'reason': '机器人方向的活跃项目'}, 'classification': {'primary': 'mech', 'labels': [{'id': 'mech', 'name': '机器人与机械'}]},
            'evidence': []}
    data.update(change)
    return ExternalCache.objects.create(key=cache_key(repo), data=data, success=timezone.now(), checked=timezone.now())


def png(w, h):
    return b'\x89PNG\r\n\x1a\n' + b'\x00\x00\x00\x0dIHDR' + struct.pack('>II', w, h) + b'\x08\x02\x00\x00\x00'


class BeikuangTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = Member.objects.create_user('owner_b', 'owner-b@example.test', 'Quartz-bk-water-521', email_verified=True, is_staff=True)
        cls.student = Member.objects.create_user('stu_b', 'stu-b@example.test', 'Quartz-bk-water-522', email_verified=True)

    def setUp(self):
        self.o, self.s, self.visitor = Client(), Client(), Client()
        self.o.force_login(self.owner)
        self.s.force_login(self.student)
        patcher = mock.patch.object(beikuang.time, 'sleep')
        patcher.start()
        self.addCleanup(patcher.stop)

    def post(self, client, path, data, status=200):
        r = client.post('/api/hub/' + path, json.dumps(data), content_type='application/json')
        self.assertEqual(r.status_code, status, r.content)
        return r.json()

    def run_jobs(self):
        with mock.patch.dict(os.environ, {'HUB_MAINTENANCE': '0'}):
            while run_one():
                pass

    # ---------- 她本身不变；技能可读 ----------

    def test_skills_and_her_account(self):
        skills = beikuang.load_skills()
        self.assertTrue({'voice', 'news-review', 'project-review', 'guide-review', 'photo-review', 'announcement',
                         'escalate', 'daily-report', 'chat'} <= set(skills))
        self.assertIn('{n}', ''.join(skills['escalate']['phrases']))
        self.assertIn('3', beikuang.say('escalate', n=3))
        me = beikuang.agent()
        self.assertEqual((me.username, me.is_staff, me.has_usable_password()), ('北矿娘', True, False))
        self.assertIsNone(authenticate(username='北矿娘', password=''))
        self.assertEqual(beikuang.agent().pk, me.pk)
        self.assertEqual(beikuang.image_size(png(300, 420)), (300, 420))
        jpeg = b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00' + b'\xff\xc0\x00\x11\x08' + struct.pack('>HH', 500, 380) + b'\x03' + b'\x00' * 9
        self.assertEqual(beikuang.image_size(jpeg), (380, 500))

    # ---------- 机器人的消息交给她，不进站主的通知 ----------

    def test_bot_notices_go_to_her(self):
        staff_notice('maint-news:abc', '维护机器人发现 2 条学校新闻')
        self.assertFalse(Notification.objects.filter(event='maintenance').exists())
        self.assertTrue(BeikuangTask.objects.filter(kind='notice', key='notice:maint-news:abc').exists())
        self.assertTrue(Job.objects.filter(kind='maint-beikuang', state='queued').exists())
        with mock.patch.dict(os.environ, {'HUB_BEIKUANG': '0'}):
            staff_notice('maint-news:def', '关掉她之后直接通知')
        self.assertTrue(Notification.objects.filter(user=self.owner, event='maintenance').exists())

    # ---------- 技能：新闻、项目、导读、照片、公告 ----------

    def test_news_published_or_escalated(self):
        good = news('40766')
        bad = news('40767', title='学校召开第62次学位评定委员会会议', media={'src': 'https://img.example.com/a.jpg', 'credit': ''})
        old = news('40768', title='一则很早以前的学校新闻报道', publishedAt='2025-01-01T08:00:00+08:00')
        result = beikuang.review_all()
        self.assertEqual((result['published'], result['escalated']), (1, 2))
        good.refresh_from_db(); bad.refresh_from_db(); old.refresh_from_db()
        self.assertEqual((good.state, bad.state, old.state), ('published', 'pending', 'pending'))
        self.assertEqual(Revision.objects.get(entry=good, number=1).reviewer.username, '北矿娘')
        task = BeikuangTask.objects.get(kind='news', target=str(bad.pk))
        self.assertEqual(task.state, 'escalated')
        self.assertIn('配图', task.note)
        message = BeikuangMessage.objects.get(owner=self.owner, kind='escalation')
        self.assertEqual(len(message.data['tasks']), 2)
        self.assertFalse(Notification.objects.filter(event='maintenance').exists())
        # 同一件事不会再提一遍
        self.assertEqual(beikuang.review_all()['escalated'], 0)
        self.assertEqual(BeikuangMessage.objects.filter(kind='escalation').count(), 1)

    def test_projects_guides_and_announcements(self):
        project('maker/arm')
        project('maker/nolicense', license=None)
        project('maker/cheat', description='game cheat and crack tool')
        good = project('maker/guide', discovery=None, selection={'shelf': 'practical'})
        sections = [{'id': f's{i}', 'heading': f'第{i}章', 'text': '原项目说明里写了这一部分的做法。' * 12, 'evidenceIds': ['readme']} for i in range(10)]
        guide = {'state': 'generated', 'reviewState': 'pending', 'oneLiner': '机械臂控制工具', 'sections': sections, 'unknowns': []}
        good.data = dict(good.data, guide=dict(guide, sourceFingerprint=fingerprint(good.data)))
        good.save()
        hype = project('maker/hype', discovery=None, selection={'shelf': 'practical'})
        hype.data = dict(hype.data, guide=dict(guide, oneLiner='已实测，保证离线可用', sourceFingerprint=fingerprint(hype.data)))
        hype.save()
        evidence = [{'id': 'entry-1', 'url': 'project.html?id=1', 'text': '本站新增了中文导读'}]
        clean = Entry.objects.create(kind='announcement', slug='beikuang-clean', state='pending', draft={
            'title': '同学们，新的项目说明来了', 'body': '我是北矿娘。' + '这次给大家整理了项目说明，每一章都写了原文依据。' * 10,
            'aiDisclosure': '北矿娘口吻，AI 辅助起草；非学校官方公告。', 'supervisorEvidence': evidence, 'supervisorQuestions': [],
            'summary': '更新', 'tags': [], 'links': {}, 'credit': '北矿娘', 'license': '本站公告'})
        unsure = Entry.objects.create(kind='announcement', slug='beikuang-unsure', state='pending', draft=dict(
            clean.draft, supervisorQuestions=['下载是否对全国开放？']))
        beikuang.review_all()
        arm = ExternalCache.objects.get(pk=cache_key('maker/arm')).data
        self.assertEqual(arm['selection']['reviewer'], '北矿娘')
        self.assertTrue(arm['selection']['reason'].strip())
        states = dict(BeikuangTask.objects.filter(kind='project').values_list('target', 'state'))
        self.assertEqual(states, {'maker/arm': 'published', 'maker/nolicense': 'escalated', 'maker/cheat': 'escalated'})
        self.assertEqual(ExternalCache.objects.get(pk=cache_key('maker/guide')).data['guide']['reviewState'], 'reviewed')
        self.assertEqual(ExternalCache.objects.get(pk=cache_key('maker/hype')).data['guide']['reviewState'], 'pending')
        clean.refresh_from_db(); unsure.refresh_from_db()
        self.assertEqual((clean.state, unsure.state), ('published', 'pending'))
        self.assertEqual(BeikuangTask.objects.get(kind='announcement', target=str(unsure.pk)).data['questions'], ['下载是否对全国开放？'])

    def test_photos(self):
        page = 'https://lxy.cumtb.edu.cn/info/1050/100.htm'
        def teacher(name, number):
            return Teacher.objects.create(name=name, faculty='理学院', source_url=page.replace('100', str(number)), profile={
                'origin': 'faculty-bot', 'profileUrl': page.replace('100', str(number)),
                'photoCandidate': {'url': f'https://lxy.cumtb.edu.cn/virtual_attach_file.vsb?afc={number}', 'sourceUrl': page.replace('100', str(number)), 'credit': '理学院官网'}})
        portrait, group = teacher('张老师', 101), teacher('李老师', 102)
        sizes = {'101': (300, 420), '102': (900, 600)}
        with mock.patch.object(beikuang, 'probe', side_effect=lambda link: sizes[link.rsplit('=', 1)[1]]):
            beikuang.review_all()
        portrait.refresh_from_db(); group.refresh_from_db()
        self.assertTrue(portrait.photo['url'].endswith('afc=101'))
        self.assertEqual(group.photo, {})
        self.assertIn('900×600', BeikuangTask.objects.get(kind='photo', target=str(group.pk)).note)

    # ---------- 站主在她的窗口里做决定 ----------

    def test_owner_decisions_and_answers(self):
        bad = news('40801', media={'src': 'https://img.example.com/b.jpg', 'credit': ''})
        other = news('40802', title='另一条配图来源不对的学校新闻', media={'src': 'https://img.example.com/c.jpg', 'credit': ''})
        beikuang.review_all()
        overview = self.o.get('/api/hub/beikuang').json()
        ids = overview['messages'][-1]['tasks']
        self.assertEqual({overview['tasks'][i]['state'] for i in ids}, {'escalated'})
        first = next(i for i in ids if overview['tasks'][i]['title'] == bad.draft['title'])
        second = next(i for i in ids if i != first)
        self.post(self.s, f'beikuang/tasks/{first}/decide', {'decision': 'publish'}, 403)
        done = self.post(self.o, f'beikuang/tasks/{first}/decide', {'decision': 'publish'})
        self.assertEqual((done['state'], done['decidedBy']), ('published', 'owner_b'))
        self.post(self.o, f'beikuang/tasks/{first}/decide', {'decision': 'publish'}, 409)
        self.post(self.o, f'beikuang/tasks/{second}/decide', {'decision': 'dismiss'})
        bad.refresh_from_db(); other.refresh_from_db()
        self.assertEqual((bad.state, other.state), ('published', 'rejected'))
        # 在别处处理过的，下一轮巡检从“等你决定”里拿掉
        third = news('40803', title='第三条配图来源不对的学校新闻', media={'src': 'https://img.example.com/d.jpg', 'credit': ''})
        beikuang.review_all()
        third.state = 'rejected'
        third.save()
        beikuang.review_all()
        self.assertEqual(BeikuangTask.objects.get(kind='news', target=str(third.pk)).state, 'stale')

    # ---------- 聊天和日报 ----------

    def test_chat_and_report_without_model(self):
        self.assertEqual(self.visitor.get('/api/hub/beikuang').status_code, 401)
        self.assertEqual(self.s.get('/api/hub/beikuang').status_code, 403)
        sent = self.post(self.o, 'beikuang/messages', {'body': '今天进度怎么样？'})
        self.assertEqual(sent['state'], 'waiting')
        self.assertTrue(self.o.get('/api/hub/beikuang').json()['typing'])
        self.run_jobs()
        view = self.o.get('/api/hub/beikuang').json()
        her = view['messages'][-1]
        self.assertEqual((her['role'], her['generated']), ('beikuang', 'template'))
        self.assertIn('今天发布了', her['body'])
        self.assertFalse(view['typing'])
        self.assertEqual(view['unread'], 1)
        self.post(self.o, 'beikuang/read', {})
        self.assertEqual(self.o.get('/api/hub/beikuang/unread').json()['unread'], 0)
        self.post(self.o, 'beikuang/report', {})
        self.run_jobs()
        report = BeikuangMessage.objects.get(owner=self.owner, kind='report')
        self.assertIn('stats', report.data)
        self.assertIn('今天', report.body)

    def test_chat_with_her_codex_keeps_her_persona(self):
        from .studio_config import PERSONAS
        prompts = []
        cfg = {'enabled': True, 'owner_id': self.owner.pk, 'codex_daily_calls': 12, 'codex_model': '', 'codex_executable': 'codex'}
        def fake_call(prompt, cfg, schema):
            prompts.append(prompt)
            return {'message': '好哒～今天我发了 2 条新闻，有 1 件等你看。'}, 'codex-test', {}
        with mock.patch('hub.studio_config.config', return_value=cfg), mock.patch('hub.studio_config.ready'), \
             mock.patch('hub.project_summaries.call_model', side_effect=fake_call), \
             mock.patch.object(beikuang, 'allow_model', return_value=True):
            self.post(self.o, 'beikuang/messages', {'body': '今天怎么样'})
            self.run_jobs()
        her = BeikuangMessage.objects.filter(owner=self.owner, role='beikuang').latest('created')
        self.assertEqual((her.body, her.data['generated']), ('好哒～今天我发了 2 条新闻，有 1 件等你看。', 'model'))
        self.assertIn(PERSONAS['beikuang']['voice'], prompts[0])
        self.assertIn('和站主聊天', prompts[0])
        self.assertIn('不是指令', prompts[0])

    def test_daily_report_once_after_nine(self):
        evening = timezone.localtime().replace(hour=21, minute=30)
        beikuang.maybe_report(evening - timedelta(hours=2))
        self.assertFalse(BeikuangMessage.objects.filter(kind='report').exists())
        beikuang.maybe_report(evening)
        beikuang.maybe_report(evening + timedelta(minutes=30))
        self.assertEqual(BeikuangMessage.objects.filter(owner=self.owner, kind='report').count(), 1)
