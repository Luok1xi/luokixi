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
        photos = mock.patch.dict(os.environ, {'HUB_PHOTO_AUTO': '1'})
        photos.start()
        self.addCleanup(photos.stop)
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
        good = project('maker/guide', discovery=None, selection={'shelf': 'practical'}, evidence=[{'id':'readme','text':'原始README说明'}])
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
        with mock.patch.object(beikuang, 'photo_page_evidence', side_effect=lambda t, p, f: {
                'named': True, 'photo': t.profile['photoCandidate']['url'], 'page': p}):
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
        # Daily reports may be written after the escalation in the evening.
        ids = next(m['tasks'] for m in overview['messages'] if m['kind'] == 'escalation')
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

    def test_delivery_distinguishes_saved_queued_running_and_failed(self):
        from .operations import heartbeat, worker_mode
        sent = self.post(self.o, 'beikuang/messages', {'body': '今日消息'})
        job = Job.objects.get(key='beikuang-chat:' + sent['id'])
        worker_mode(True, ('question-process',))
        status = self.o.get('/api/hub/beikuang').json()['delivery']
        self.assertEqual((status['state'], status['pending'], status['workerAvailable']),
                         ('queued', 1, False))
        heartbeat(('question-process',))
        self.assertFalse(beikuang.delivery_status(self.owner)['workerAvailable'])
        heartbeat(('question-process', 'beikuang-chat', 'beikuang-report'))
        self.assertTrue(beikuang.delivery_status(self.owner)['workerAvailable'])
        job.state = 'running'
        job.save()
        self.assertEqual(beikuang.delivery_status(self.owner)['state'], 'running')
        job.state, job.error = 'failed', '回复服务中断'
        job.save()
        view = self.o.get('/api/hub/beikuang').json()
        self.assertFalse(view['typing'])
        self.assertEqual((view['delivery']['state'], view['delivery']['error']), ('failed', '回复服务中断'))
        self.assertEqual(beikuang.delivery_status(self.student)['state'], 'idle')

    def test_interactive_job_failure_is_visible_without_automatic_model_retry(self):
        sent = self.post(self.o, 'beikuang/messages', {'body': '今日消息'})
        with mock.patch.object(beikuang, 'reply', side_effect=RuntimeError('服务中断')):
            self.assertTrue(run_one(('beikuang-chat', 'beikuang-report')))
        job = Job.objects.get(key='beikuang-chat:' + sent['id'])
        self.assertEqual((job.state, job.attempts), ('failed', 1))
        self.assertFalse(run_one(('beikuang-chat', 'beikuang-report')))

    def test_model_fallback_explains_failure(self):
        with mock.patch.object(beikuang, 'allow_model', return_value=True), \
             mock.patch.object(beikuang, 'write', side_effect=beikuang.Problem('模型额度不足', 503)):
            self.post(self.o, 'beikuang/messages', {'body': '今日消息'})
            run_one(('beikuang-chat', 'beikuang-report'))
        her = BeikuangMessage.objects.filter(owner=self.owner, role='beikuang').latest('created')
        self.assertEqual(her.data['generated'], 'template')
        self.assertEqual(her.data['fallback'], '模型额度不足')

    def test_latest_character_and_casual_context(self):
        from .studio_config import CHARACTER_CARD_SOURCE
        identity = beikuang.character_identity()
        self.assertIn('温柔', json.dumps(identity, ensure_ascii=False))
        from .studio_config import CHARACTER_CARD
        self.assertTrue(CHARACTER_CARD['self'])
        self.assertEqual(CHARACTER_CARD['identityVersion'], 3)
        self.assertEqual(CHARACTER_CARD_SOURCE['branch'], 'claude/nice-cerf-b24x36')
        with mock.patch.object(beikuang, 'allow_model', return_value=True):
            self.post(self.o, 'beikuang/messages', {'body': '在吗'})
        with mock.patch.object(beikuang, 'write', return_value=('嗯，我在。', 'test-model')) as writer:
            run_one(('beikuang-chat',))
        context = writer.call_args.args[1]
        self.assertIsNone(context['today'])
        self.assertEqual(context['waiting'], [])
        self.assertEqual(context['ownerId'], self.owner.pk)

    def test_review_skips_already_escalated_news_before_batch_limit(self):
        for i in range(41):
            entry = news(f'old-{i}', media={'src': 'https://bad.example/a.jpg', 'credit': ''})
            BeikuangTask.objects.create(kind='news', key=f'news:{entry.pk}:{entry.revision}',
                target=str(entry.pk), state='escalated', data={'revision': entry.revision})
        good = news('new-available')
        beikuang.review_all()
        good.refresh_from_db()
        self.assertEqual(good.state, 'published')

    def test_critical_notice_survives_sweep_and_is_not_repeated(self):
        staff_notice('link-down', '官方链接打不开，连接超时')
        staff_notice('link-down', '官方链接打不开，连接超时')
        task = BeikuangTask.objects.get(key='notice:link-down')
        beikuang.sweep()
        task.refresh_from_db()
        self.assertEqual(task.state, 'escalated')
        messages = [m for m in BeikuangMessage.objects.filter(owner=self.owner)
                    if str(task.pk) in m.data.get('tasks', [])]
        self.assertEqual(len(messages), 1)
        self.post(self.o, f'beikuang/tasks/{task.pk}/decide', {'decision': 'publish'}, 400)
        self.post(self.o, f'beikuang/tasks/{task.pk}/decide', {'decision': 'dismiss'})
        task.refresh_from_db()
        self.assertEqual(task.state, 'dismissed')

    def test_emotion_is_private_and_decays(self):
        ExternalCache.objects.create(key=f'beikuang:feeling:{self.owner.pk}',
            data={'name': 'happy', 'intensity': .8}, checked=timezone.now() - timedelta(hours=2))
        self.assertAlmostEqual(beikuang.emotion_state(self.owner)['intensity'], .4, places=2)
        self.assertEqual(beikuang.emotion_state(self.student)['name'], 'neutral')

    def test_report_contains_source_failures_and_private_export(self):
        Job.objects.create(kind='source-index', key='failed-source-test', state='failed', error='来源超时', due=timezone.now())
        Job.objects.create(kind='maint-media', key='partial-media-test', state='partial', error='一张图片未读取', due=timezone.now())
        with mock.patch.object(beikuang, 'model_ready', return_value=(True, '')):
            with mock.patch.object(beikuang, 'write', return_value=('今天整理过资料，仍有两处故障。', 'test-model')) as writer:
                report = beikuang.write_report(self.owner)
        context = writer.call_args.args[1]
        self.assertEqual(context['today']['botFailures'], 2)
        self.assertEqual(len(context['today']['failures']), 2)
        route = f'/api/hub/beikuang/reports/{report.pk}/text'
        response = self.o.get(route)
        self.assertEqual(response.status_code, 200)
        text = response.content.decode('utf-8')
        self.assertIn('来源超时', text)
        self.assertIn('一张图片未读取', text)
        self.assertIn('test-model', text)
        self.assertIn('private', response['Cache-Control'])
        other = Member.objects.create_user('other_staff', 'other-staff@example.test', 'Quartz-water-588', is_staff=True)
        client = Client()
        client.force_login(other)
        self.assertEqual(client.get(route).status_code, 404)
        self.assertEqual(self.visitor.get(route).status_code, 401)

    def test_report_double_click_queues_one_job(self):
        self.post(self.o, 'beikuang/report', {})
        second = self.post(self.o, 'beikuang/report', {})
        self.assertTrue(second['alreadyQueued'])
        self.assertEqual(Job.objects.filter(kind='beikuang-report', state='queued').count(), 1)

    def test_explicitly_disabled_photo_submission_is_held_quietly(self):
        page = 'https://lxy.cumtb.edu.cn/info/1050/101.htm'
        teacher = Teacher.objects.create(name='待核对老师', faculty='理学院', source_url=page, profile={
            'origin': 'faculty-bot', 'profileUrl': page,
            'photoCandidate': {'url': 'https://lxy.cumtb.edu.cn/photo.jpg', 'sourceUrl': page, 'credit': '理学院官网'}})
        with mock.patch.dict(os.environ, {'HUB_PHOTO_AUTO': '0'}):
            with mock.patch.object(beikuang, 'photo_page_evidence', return_value={'named': True, 'photo': 'https://lxy.cumtb.edu.cn/photo.jpg'}):
                with mock.patch.object(beikuang, 'probe', return_value=(300, 420)):
                    beikuang.review_all()
        teacher.refresh_from_db()
        self.assertEqual(teacher.photo, {})
        self.assertEqual(BeikuangTask.objects.get(kind='photo', target=str(teacher.pk)).state, 'held')

    def test_implicit_mirror_respects_disabled_flag(self):
        project('maker/mirror-disabled')
        with mock.patch.dict(os.environ, {'HUB_MIRROR_AUTO': '0'}):
            beikuang.review_all()
            self.assertFalse(Job.objects.filter(key__startswith='mirror-after-curate:').exists())
            old = Job.objects.create(kind='mirror-repo', key='mirror-after-curate:old-disabled',
                payload={'repository': 'maker/mirror-disabled'}, due=timezone.now())
            with mock.patch('hub.mirror.mirror_repository') as downloader:
                run_one(('mirror-repo',))
            downloader.assert_not_called()
        old.refresh_from_db()
        self.assertEqual(old.state, 'done')

    def test_reserved_character_names_do_not_create_a_second_identity(self):
        from .accounts import checked_display_name
        with self.assertRaises(beikuang.Problem):
            checked_display_name('北矿娘')
        with self.assertRaises(beikuang.Problem):
            checked_display_name('小煤渣')
        self.assertEqual(checked_display_name('北矿娘', beikuang.agent()), '北矿娘')

    def test_explicit_flash_choice_overrides_old_pro_config(self):
        from . import studio_config
        path = mock.Mock()
        path.is_file.return_value = True
        path.read_text.return_value = json.dumps({'deepseek_model': 'deepseek-v4-pro', 'beikuang_provider': 'codex'})
        with mock.patch.object(studio_config, 'config_path', return_value=path):
            with mock.patch.object(studio_config, 'find_codex', return_value=''):
                cfg = studio_config.config()
        self.assertEqual(cfg['deepseek_model'], 'deepseek-flash')
        self.assertEqual(cfg['beikuang_provider'], 'deepseek')
        self.assertLessEqual(cfg['daily_cny'], 5)

    def test_report_worker_recovery_does_not_write_again(self):
        with mock.patch.object(beikuang, 'model_ready', return_value=(False, '测试离线')):
            first = beikuang.report_job(self.owner.pk, 'journal-test-key')
            second = beikuang.report_job(self.owner.pk, 'journal-test-key')
        self.assertEqual(first['message'], second['message'])
        self.assertEqual(second['skipped'], 'already-written')
        self.assertEqual(BeikuangMessage.objects.filter(owner=self.owner, kind='report').count(), 1)

    def test_all_open_cases_remain_open_beyond_panel_limit(self):
        for i in range(35):
            key = f'supervisor-case:case-{i}'
            ExternalCache.objects.create(key=key, data={'state': 'needs-owner', 'repository': f'maker/case{i}'})
            BeikuangTask.objects.create(kind='case', key=f'case:{key}', target=key, state='escalated')
        from django.db import connection
        from django.test.utils import CaptureQueriesContext
        with CaptureQueriesContext(connection) as queries:
            beikuang.sweep()
        self.assertLessEqual(len(queries), 6)
        self.assertEqual(BeikuangTask.objects.filter(kind='case', state='escalated').count(), 35)

    def test_flash_transport_disables_extra_thinking_and_records_actual_model(self):
        import io
        from . import studio_config
        cfg = {'enabled': True, 'owner_id': self.owner.pk, 'beikuang_provider': 'deepseek',
               'deepseek_model': 'deepseek-flash', 'deepseek_api_key': 'isolated-placeholder',
               'max_output_tokens': 3000}
        answer = {'model': 'deepseek-v4.1-flash-test', 'choices': [
            {'finish_reason': 'stop', 'message': {'content': json.dumps({
                'message': '嗯，我在。', 'feeling': {'name': 'happy', 'intensity': .6, 'evidence': '我在'}})}}],
            'usage': {'total_tokens': 42}}
        ledger = ExternalCache.objects.create(key='isolated-flash-ledger', data={})
        response = io.BytesIO(json.dumps(answer).encode())
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(studio_config, 'config', return_value=cfg):
            with mock.patch.object(studio_config, 'ready'):
                with mock.patch('hub.project_summaries.reserve', return_value=ledger):
                    with mock.patch('urllib.request.build_opener', return_value=opener):
                        body, model = beikuang.write('chat', {'ownerId': self.owner.pk}, 'isolated-chat')
        payload = json.loads(opener.open.call_args.args[0].data)
        self.assertEqual(payload['model'], 'deepseek-flash')
        self.assertEqual(payload['thinking']['type'], 'disabled')
        self.assertLessEqual(payload['max_tokens'], 1800)
        self.assertEqual(body, '嗯，我在。')
        self.assertEqual(model, 'deepseek-v4.1-flash-test')
        self.assertEqual(beikuang.emotion_state(self.owner)['name'], 'happy')
        ledger.refresh_from_db()
        self.assertEqual(ledger.data['usage']['total_tokens'], 42)

    def test_report_attributes_owner_and_agent_work_separately(self):
        now = timezone.now()
        for key, state, actor in [('auto', 'published', beikuang.AGENT_USERNAME),
                                  ('escalated', 'escalated', beikuang.AGENT_USERNAME),
                                  ('owner', 'published', self.owner.username), ('old', 'stale', '')]:
            BeikuangTask.objects.create(key='attribution:' + key, kind='news', target=key,
                                       state=state, decided_by=actor, decided=now)
        stats = beikuang.today_stats()
        self.assertEqual(stats['seen'], 2)
        self.assertEqual(stats['published'], 1)
        self.assertEqual(stats['ownerDecided'], 1)
        self.assertEqual(stats['clearedStale'], 1)

    def test_daily_report_once_after_nine(self):
        evening = timezone.localtime().replace(hour=21, minute=30)
        beikuang.maybe_report(evening - timedelta(hours=2))
        self.assertFalse(BeikuangMessage.objects.filter(kind='report').exists())
        beikuang.maybe_report(evening)
        beikuang.maybe_report(evening + timedelta(minutes=30))
        self.run_jobs()
        self.assertEqual(BeikuangMessage.objects.filter(owner=self.owner, kind='report').count(), 1)

    def photo_teacher(self, name='照片老师', image='https://lxy.cumtb.edu.cn/teacher.png'):
        page = 'https://lxy.cumtb.edu.cn/info/1050/701.htm'
        return Teacher.objects.create(name=name, faculty='理学院', source_url=page, profile={
            'profileUrl': page, 'photoCandidate': {'url': image, 'sourceUrl': page, 'credit': '理学院官网'}})

    def test_photo_only_notifications_archived_without_losing_chat(self):
        task = BeikuangTask.objects.create(key='old-photo', kind='photo', state='escalated')
        chat = BeikuangMessage.objects.create(owner=self.owner, role='owner', body='我还在这里', read=True)
        for n in range(65):
            BeikuangMessage.objects.create(owner=self.owner, role='beikuang', kind='escalation', body='照片要确认', data={'tasks': [str(task.pk)]})
        view = self.o.get('/api/hub/beikuang').json()
        self.assertEqual([m['id'] for m in view['messages']], [str(chat.pk)])
        self.assertEqual(view['unread'], 0)
        self.assertEqual(BeikuangMessage.objects.filter(state='archived').count(), 65)
        self.assertTrue(BeikuangTask.objects.filter(pk=task.pk).exists())
        beikuang.tell_escalations([task])
        self.assertEqual(BeikuangMessage.objects.count(), 66)

    def test_mixed_notification_keeps_fault_and_removes_photo(self):
        photo = BeikuangTask.objects.create(key='mixed-photo', kind='photo', state='escalated')
        fault = BeikuangTask.objects.create(key='mixed-fault', kind='notice', state='escalated')
        message = BeikuangMessage.objects.create(owner=self.owner, role='beikuang', kind='escalation', data={'tasks':[str(photo.pk),str(fault.pk)]})
        view = self.o.get('/api/hub/beikuang').json()
        self.assertEqual(view['messages'][0]['tasks'], [str(fault.pk)])
        self.assertEqual(view['unread'], 1)
        message.refresh_from_db()
        self.assertEqual(message.data['originalTasks'], [str(photo.pk),str(fault.pk)])
        self.assertEqual([x['kind'] for x in beikuang.waiting(self.owner)], ['机器人消息'])

    def test_old_escalated_photo_is_reexamined_and_submitted_once(self):
        import hashlib
        t=self.photo_teacher()
        key=f'photo:{t.pk}:'+hashlib.sha256(t.profile['photoCandidate']['url'].encode()).hexdigest()[:20]
        BeikuangTask.objects.create(key=key, kind='photo', target=str(t.pk), state='escalated', data={'image':t.profile['photoCandidate']['url']})
        with mock.patch.object(beikuang,'photo_page_evidence',return_value={'named':True,'photo':t.profile['photoCandidate']['url']}):
            with mock.patch.object(beikuang,'probe',return_value=(300,420)) as probe:
                run={'published':[],'escalated':[]}
                beikuang.review_photos(beikuang.agent(),run)
                beikuang.review_photos(beikuang.agent(),run)
        t.refresh_from_db()
        self.assertEqual(t.photo['reviewMode'],'official-profile')
        self.assertEqual(BeikuangTask.objects.get(key=key).state,'published')
        self.assertEqual(probe.call_count,1)

    def test_foreign_source_is_rejected_without_fetching_or_chat(self):
        t=self.photo_teacher(image='https://example.com/stranger.jpg')
        with mock.patch.object(beikuang,'probe') as probe:
            run={'published':[],'escalated':[]}
            beikuang.review_photos(beikuang.agent(),run)
        probe.assert_not_called()
        t.refresh_from_db()
        self.assertEqual(t.photo,{})
        self.assertEqual(BeikuangTask.objects.get(kind='photo').state,'dismissed')
        self.assertIn('https://example.com/stranger.jpg',t.profile['photoRejected'])
        self.assertEqual(run['escalated'],[])

    def test_shared_logo_is_rejected_for_both_teachers(self):
        self.photo_teacher('甲老师')
        self.photo_teacher('乙老师')
        with mock.patch.object(beikuang,'photo_page_evidence') as page:
            beikuang.review_photos(beikuang.agent(),{'published':[],'escalated':[]})
        page.assert_not_called()
        self.assertEqual(BeikuangTask.objects.filter(state='dismissed').count(),2)

    def test_photo_network_error_has_cooldown_and_three_attempt_limit(self):
        self.photo_teacher()
        with mock.patch.object(beikuang,'photo_page_evidence',side_effect=beikuang.Problem('来源暂时超时')) as fetch:
            run={'published':[],'escalated':[]}
            beikuang.review_photos(beikuang.agent(),run)
            beikuang.review_photos(beikuang.agent(),run)
            self.assertEqual(fetch.call_count,1)
            for i in range(2):
                task=BeikuangTask.objects.get(kind='photo')
                task.data['retryAfter']=(timezone.now()-timedelta(minutes=1)).isoformat()
                task.save(update_fields=['data'])
                beikuang.review_photos(beikuang.agent(),run)
            beikuang.review_photos(beikuang.agent(),run)
        task.refresh_from_db()
        self.assertEqual(task.state,'held')
        self.assertEqual(task.data['attempts'],3)
        self.assertEqual(fetch.call_count,3)
        self.assertEqual(run['escalated'],[])

    def test_photo_page_evidence_uses_name_and_body_and_cache(self):
        t=self.photo_teacher('张老师')
        page=t.source_url
        fetcher=mock.Mock()
        fetcher.get.return_value=('<title>张老师-理学院</title><img src="/logo.png"><div class="v_news_content"><img src="/teacher.png"></div>',page)
        first=beikuang.photo_page_evidence(t,page,fetcher)
        second=beikuang.photo_page_evidence(t,page,fetcher)
        self.assertTrue(first['named'])
        self.assertEqual(first['photo'],'https://lxy.cumtb.edu.cn/teacher.png')
        self.assertEqual(first,second)
        fetcher.get.assert_called_once()

    def test_project_metadata_fix_reopens_old_review_without_repeating_unchanged_work(self):
        cache=project('maker/repaired',license=None)
        beikuang.review_projects(beikuang.agent(),{'published':[],'escalated':[]})
        self.assertEqual(BeikuangTask.objects.get(kind='project').state,'escalated')
        self.assertEqual(beikuang.candidates(),[])
        cache.refresh_from_db()
        cache.data=dict(cache.data,license='MIT')
        cache.save(update_fields=['data'])
        beikuang.review_projects(beikuang.agent(),{'published':[],'escalated':[]})
        self.assertEqual(BeikuangTask.objects.get(kind='project').state,'published')
        self.assertEqual(beikuang.candidates(),[])

    def test_guide_with_nonexistent_evidence_cannot_pass_automatic_review(self):
        cache=project('maker/bogus-guide',discovery=None,selection={'shelf':'practical'},evidence=[{'id':'real','text':'实际来源'}])
        guide={'state':'generated','reviewState':'pending','oneLiner':'测试导读','unknowns':[],
            'sections':[{'id':str(n),'text':'原文说明'*40,'evidenceIds':['invented']} for n in range(10)]}
        cache.data=dict(cache.data,guide=dict(guide,sourceFingerprint=fingerprint(cache.data)))
        cache.save(update_fields=['data'])
        run={'published':[],'escalated':[]}
        beikuang.review_guides(beikuang.agent(),run)
        self.assertEqual(run['published'],[])
        self.assertIn('不存在',run['escalated'][0].note)

    def test_chat_instructions_are_never_used_as_fallback_phrases(self):
        skill=beikuang.load_skills()['chat']
        self.assertIn('tools',skill['instructions'])
        self.assertEqual(len(skill['phrases']),1)
        report=beikuang.load_skills()['daily-report']
        self.assertIn('自主审核',report['instructions'])
        self.assertEqual(len(report['phrases']),2)
