import json
import os
from unittest import mock
from django.test import Client, TestCase
from . import faculty
from .discovery import refresh_source
from .models import Audit, Job, Member, Notification, Source, Teacher

# 四种学院官网名单的真实写法（节选、改名）：
# 1. 段落标题“副教授”后面一串姓名链接（能源学院）
LIST_HEADINGS = """<div class="v_news_content"><p>教授</p><p><a href="../../info/1120/1644.htm">王志强</a>&nbsp;<a href="../../info/1121/1650.htm">李　杨</a></p>
<p>副教授</p><p><a href="../../info/1121/1505.htm"><span>薛黎</span><span>明</span></a></p><p><a href="../../szdw/szgk1/kykxygcx.htm">矿业科学与工程系</a>
<a href="../../info/1102/99.htm">喜报</a><a href="../../info/1102/98.htm">师资概况</a><a href="https://example.com/info/1/2.htm">外站</a></p></div>"""
# 2. “姓名-职称”写在一个链接里（机电学院）
LIST_DASH = """<ul><li><span class="date">(2023-10-31)</span><a href="../info/1011/3544.htm" title="葛世荣-教授">葛世荣-教授</a></li>
<li><a href="../info/1011/3197.htm" title="刘文言-研究员">刘文言-研究员</a></li><li><a href="jxdzgcx/1.htm">下一页</a></li></ul>"""
# 3. 照片 + 姓名 + 职称都在一个链接里（化环学院）
LIST_CARDS = """<li><a href="../info/1016/1047.htm" title="刘文礼"><div class="pic_img"><img src="/virtual_attach_file.vsb?afc=x&amp;e=.jpg"></div>
<div class="wz"><p class="name">刘文礼</p><p class="zw">教授</p></div></a></li>"""
# 4. 链接里只有照片，姓名在下面一行（地测学院）
LIST_PHOTO_ONLY = """<div><p><a href="../info/1010/1690.htm"><img src="/virtual_attach_file.vsb?afc=y&amp;e=.jpg"></a></p></div>
<div style="text-align:center">韩双彪</div>"""

PROFILE = """<html><head><title>王志强  教授-能源与矿业学院</title></head><body>
<div class="now-l">矿业科学与工程系</div><div class="nr"><h3>王志强  教授</h3>
<div class="v_news_content"><p><img src="/virtual_attach_file.vsb?afc=abc&amp;e=.png" width="330" height="424"></p>
<p>王志强，教授，博导。主要研究方向为错层位绿色开采、无煤柱末采。主讲《采矿学》《矿山压力与岩层控制》等本科生课程。
主持国家自然科学基金项目3项。</p></div></div></body></html>"""


class ParserTests(TestCase):
    def test_list_layouts(self):
        people, pages = faculty.parse_list(LIST_HEADINGS, 'https://nyxy.cumtb.edu.cn/szdw/szgk1/jslb.htm', '/szdw/')
        self.assertEqual([(p['name'], p['title']) for p in people], [('王志强', '教授'), ('李杨', '教授'), ('薛黎明', '副教授')])
        self.assertEqual(pages, ['https://nyxy.cumtb.edu.cn/szdw/szgk1/kykxygcx.htm'])  # 只在师资栏目里翻页，不走外站和新闻
        people, pages = faculty.parse_list(LIST_DASH, 'https://jdxy.cumtb.edu.cn/szdw/jxdzgcx.htm', '/szdw/')
        self.assertEqual([(p['name'], p['title']) for p in people], [('葛世荣', '教授'), ('刘文言', '研究员')])
        self.assertEqual(pages, ['https://jdxy.cumtb.edu.cn/szdw/jxdzgcx/1.htm'])
        people, _ = faculty.parse_list(LIST_CARDS, 'https://scee.cumtb.edu.cn/szll/kwjggcx.htm', '/szll/')
        self.assertEqual((people[0]['name'], people[0]['title']), ('刘文礼', '教授'))
        self.assertTrue(people[0]['photo'].startswith('https://scee.cumtb.edu.cn/virtual_attach_file.vsb'))
        people, _ = faculty.parse_list(LIST_PHOTO_ONLY, 'https://dcxy.cumtb.edu.cn/szdw/nydzx.htm', '/szdw/')
        self.assertEqual([p['name'] for p in people], ['韩双彪'])

    def test_profile(self):
        data = faculty.parse_profile(PROFILE, 'https://nyxy.cumtb.edu.cn/info/1120/1644.htm', '王志强')
        self.assertEqual(data['title'], '教授')
        self.assertEqual(data['department'], '矿业科学与工程系')
        self.assertTrue(data['research'].startswith('错层位绿色开采'))
        self.assertEqual(data['courses'], ['采矿学', '矿山压力与岩层控制'])
        self.assertTrue(data['photo'].startswith('https://nyxy.cumtb.edu.cn/virtual_attach_file.vsb'))
        duty = PROFILE.replace('主讲《采矿学》《矿山压力与岩层控制》等本科生课程。', '承担数据结构、操作系统等本科生课程的教学工作。')
        self.assertEqual(faculty.parse_profile(duty, 'https://nyxy.cumtb.edu.cn/info/1/3.htm', '王志强')['courses'], ['数据结构', '操作系统'])
        # 侧栏栏目名不是系名
        self.assertEqual(faculty.parse_profile(PROFILE.replace('矿业科学与工程系', '双聘院士'), 'https://nyxy.cumtb.edu.cn/info/1/2.htm', '王志强')['department'], '')


class FakeFetcher:
    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def get(self, target):
        self.calls.append(target)
        return self.pages[target], target


START = 'https://nyxy.cumtb.edu.cn/szdw/szgk1/jslb.htm'
PAGES = {
    START: LIST_HEADINGS,
    'https://nyxy.cumtb.edu.cn/szdw/szgk1/kykxygcx.htm': '<p>本系教师见上</p>',
    'https://nyxy.cumtb.edu.cn/info/1120/1644.htm': PROFILE,
    'https://nyxy.cumtb.edu.cn/info/1121/1650.htm': PROFILE.replace('王志强', '李杨').replace('afc=abc', 'afc=def'),
    'https://nyxy.cumtb.edu.cn/info/1121/1505.htm': '<html><h3>薛黎明 副教授</h3></html>',
}


class CrawlTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.mod = Member.objects.create_user('mod_f', 'mod-f@example.test', 'Quartz-fac-water-522', email_verified=True, is_staff=True)
        cls.alice = Member.objects.create_user('alice_f', 'alice-f@example.test', 'Quartz-fac-water-521', email_verified=True)

    def setUp(self):
        self.m, self.a, self.visitor = Client(), Client(), Client()
        self.m.force_login(self.mod)
        self.a.force_login(self.alice)

    def post(self, client, path, data, status=200):
        r = client.post('/api/hub/' + path, json.dumps(data), content_type='application/json')
        self.assertEqual(r.status_code, status, r.content)
        return r.json()

    def crawl(self, pages=PAGES):
        return faculty.crawl_college('能源与矿业学院', START, '/szdw/', FakeFetcher(pages))

    def test_sources_are_seeded_for_every_college(self):
        _, colleges = faculty.load_config()
        self.assertEqual(Source.objects.filter(kind='faculty', enabled=True).count(), len(colleges))
        self.assertGreaterEqual(len(colleges), 11)

    def test_crawl_creates_teachers_and_holds_photos_for_review(self):
        result = self.crawl()
        self.assertEqual((result['found'], result['created'], result['profilesChecked']), (3, 3, 3))
        wang = Teacher.objects.get(name='王志强')
        self.assertEqual((wang.title, wang.faculty), ('教授', '能源与矿业学院'))
        self.assertEqual([t['name'] for t in wang.teaching], ['采矿学', '矿山压力与岩层控制'])
        self.assertEqual(wang.photo, {})  # 照片先是候选，不公开
        page = self.visitor.get(f'/api/hub/teachers/{wang.pk}').json()
        self.assertIsNone(page['photo'])
        self.assertEqual(page['profile']['research'][:4], '错层位绿')
        self.assertNotIn('photoCandidate', page['profile'])
        # 维护者确认后才显示；拒绝过的地址不会再提
        self.post(self.a, 'reputation/faculty/photos', {'teacher': str(wang.pk), 'decision': 'approve'}, 403)
        self.post(self.m, 'reputation/faculty/photos', {'teacher': str(wang.pk), 'decision': 'approve'})
        self.assertTrue(self.visitor.get(f'/api/hub/teachers/{wang.pk}').json()['photo']['url'].startswith('https://nyxy'))
        li = Teacher.objects.get(name='李杨')
        self.post(self.m, 'reputation/faculty/photos', {'teacher': str(li.pk), 'decision': 'reject'})
        for t in Teacher.objects.all():
            t.profile = dict(t.profile, crawledAt='2020-01-01T00:00:00+00:00')
            t.save()
        self.crawl()
        li.refresh_from_db()
        self.assertNotIn('photoCandidate', li.profile)
        self.assertEqual(Teacher.objects.filter(name='王志强').count(), 1)  # 再跑不重复建

    def test_manual_records_are_not_overwritten_and_missing_teachers_stay_online(self):
        manual = Teacher.objects.create(name='王志强', faculty='能源与矿业学院', title='教授（维护者核对）',
            source_url='https://example.com/manual', teaching=[{'name': '手工课程', 'sourceUrl': 'https://example.com/c'}])
        self.crawl()
        manual.refresh_from_db()
        self.assertEqual(manual.title, '教授（维护者核对）')
        self.assertEqual(manual.teaching[0]['name'], '手工课程')
        self.assertEqual(manual.profile['research'][:4], '错层位绿')
        # 名单里少了一位：只记 missingSince，不下线
        pages = dict(PAGES, **{START: LIST_HEADINGS.replace('<a href="../../info/1121/1650.htm">李　杨</a>', '')})
        self.crawl(pages)
        li = Teacher.objects.get(name='李杨')
        self.assertTrue(li.active)
        self.assertIn('missingSince', li.profile)

    def test_scheduled_source_dispatches_to_the_bot(self):
        source = Source.objects.filter(kind='faculty').first()
        with mock.patch.object(faculty, 'crawl_college', return_value={'college': source.name, 'found': 0, 'created': 0,
                'profilesChecked': 0, 'pendingPhotos': 0, 'missing': 0, 'complete': True, 'errors': [], 'listPages': 1}) as crawl:
            result = refresh_source(source.pk)
        crawl.assert_called_once()
        self.assertEqual(result['college'], source.name)
        source.refresh_from_db()
        self.assertIsNotNone(source.last_success)
        with mock.patch.dict(os.environ, {'HUB_FACULTY_CRAWL': '0'}), mock.patch.object(faculty, 'crawl_college') as crawl:
            self.assertTrue(refresh_source(source.pk)['skipped'])
        crawl.assert_not_called()

    def test_staff_console_and_teacher_requests(self):
        self.assertEqual(self.a.get('/api/hub/reputation/faculty').status_code, 403)
        status = self.m.get('/api/hub/reputation/faculty').json()
        self.assertGreaterEqual(len(status['sources']), 11)
        jobs = self.post(self.m, 'reputation/faculty/run', {'college': '理学院'})['jobs']
        self.assertEqual([j['college'] for j in jobs], ['理学院'])
        self.assertTrue(Job.objects.filter(kind='source').exists())
        self.crawl()
        wang = Teacher.objects.get(name='王志强')
        self.post(self.visitor, f'teachers/{wang.pk}/request', {'kind': 'photo', 'body': '请撤下照片'}, 401)
        self.post(self.a, f'teachers/{wang.pk}/request', {'kind': 'photo', 'body': '我是本人，请撤下照片'})
        self.assertTrue(Audit.objects.filter(action='teacher-request').exists())
        self.assertTrue(Notification.objects.filter(user=self.mod, event='teacher-request').exists())
        self.assertEqual(self.m.get('/api/hub/reputation/faculty').json()['requests'][0]['detail']['kind'], 'photo')
        self.assertEqual(self.post(self.m, 'reputation/faculty/photos', {'college': '能源与矿业学院', 'decision': 'approve-all'})['approved'], 2)
