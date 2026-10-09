"""教师资料机器人：从各学院官网的师资页读取公开资料，自动更新口碑页的教师目录。

读什么：姓名、职称、学院、系、研究方向、主讲课程，以及官网个人页上的照片地址。
怎么读：
- 只读 campus/faculty-sources.json 里列出的学院官网目录（prefix 限定在师资栏目里翻页），不碰新闻、站外链接；
- 每个站点先读 robots.txt（404 视为允许），请求之间至少间隔 1.5 秒；单次运行最多翻 24 个名单页、读 40 个个人页，
  其余留到下一轮（优先没读过的，其次 30 天没核对过的）；
- 抓取统一走 discovery.fetch_public：固定 DNS、只连公网、限制大小与重定向。
什么时候读：每个学院是一条 Source（kind='faculty'），worker 按 interval_hours（默认 168 小时）自动调度；
维护者可以在口碑审核页立即运行。HUB_FACULTY_CRAWL=0 时跳过。
怎么用：
- 文字资料自动更新，标明来源页和核对时间；维护者手工核对过的姓名、职称、照片不会被覆盖；
- 照片记录官网原地址，交给北矿娘核对署名个人页与正文配图后自动提交；拒绝过的地址不会再提；老师本人可申请撤下；
- 从名单里消失的老师不自动删除，只记录 missingSince，避免一次解析失败就把评价藏起来。
"""
import json
import os
import re
import time
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser
from django.db import transaction
from django.utils import timezone
from .core import Problem
from .discovery import UA, fetch_public
from .models import Audit, ExternalCache, Source, Teacher

CONFIG = Path(__file__).resolve().parents[1] / 'faculty-sources.json'
DELAY = 1.5
MAX_LIST_PAGES = 24
MAX_PROFILES = 80
REFRESH_DAYS = 30

TITLE_WORDS = ('教授级高级工程师', '正高级工程师', '高级工程师', '高级实验师', '助理研究员', '副研究员', '研究员',
               '副教授', '教授', '讲师', '助教', '工程师', '实验师', '博士后', '院士')
TITLE = re.compile('(' + '|'.join(TITLE_WORDS) + ')')
NAME = re.compile(r'^[一-鿿]{2,4}$|^[一-鿿]{1,8}·[一-鿿]{1,10}$')
# 栏目名、按钮文字里的常见词；名字里含这些两字词的一律不当人名（“师资概况”“更多教师”）
NOT_NAMES = ('喜报', '通知', '公告', '简介', '更多', '首页', '新闻', '动态', '招聘', '讲座', '报告', '会议', '活动',
             '详情', '全文', '阅读', '返回', '下载', '师资', '队伍', '学院', '概况', '名录', '教师', '专家', '人才',
             '导师', '院士', '博士', '团队', '风采', '介绍', '列表', '首席', '学者', '中心', '实验', '办公')
DEPARTMENT = re.compile(r'(?:系|所|中心|教研室|教研部|实验室|研究院|研究所|办公室)$')


def name_like(value):
    return bool(NAME.match(value)) and not any(w in value for w in NOT_NAMES)
PROFILE = re.compile(r'/info/\d+/\d+\.htm$')
SPLIT = re.compile(r'[\s\-－—_:：（）()/|，,、]+')
INVISIBLE = dict.fromkeys(map(ord, '　\xa0​‌‍﻿'), ' ')


def clean(value):
    return re.sub(r'\s+', ' ', unescape(value).translate(INVISIBLE)).strip()


def squash(value):
    """姓名里常见全角空格占位（“李　杨”），比较前去掉所有空白。"""
    return re.sub(r'\s+', '', clean(value))


def load_config():
    data = json.loads(CONFIG.read_text(encoding='utf-8'))
    return data.get('intervalHours', 168), data['colleges']


# ---------- 抓取 ----------

class Fetcher:
    """一次运行里共用：按站点缓存 robots.txt，请求之间保持间隔。"""

    def __init__(self):
        self.robots, self.last = {}, 0.0

    def allowed(self, target):
        p = urlsplit(target)
        key = f'{p.scheme}://{p.netloc}'
        if key not in self.robots:
            rules = RobotFileParser()
            try:
                raw, _, _, _ = fetch_public(key + '/robots.txt', 256 * 1024)
                rules.parse(raw.decode('utf-8', errors='replace').splitlines())
            except Problem as exc:
                if 'HTTP 404' not in str(exc):
                    raise
                rules.parse([])
            self.robots[key] = rules
        return self.robots[key].can_fetch(UA, target)

    def get(self, target):
        if not self.allowed(target):
            raise Problem(f'{urlsplit(target).netloc} 的 robots.txt 不允许读取这一页。')
        wait = self.last + DELAY - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            raw, _, final, _ = fetch_public(target, 2 * 1024 * 1024)
        finally:
            self.last = time.monotonic()
        return decode(raw), final


def decode(raw):
    m = re.search(rb'charset=["\']?([\w-]+)', raw[:4000])
    encoding = m.group(1).decode('ascii', 'ignore') if m else 'utf-8'
    try:
        return raw.decode(encoding, errors='replace')
    except LookupError:
        return raw.decode('utf-8', errors='replace')


# ---------- 解析（纯函数，测试直接喂 HTML） ----------

class Tokens(HTMLParser):
    """把 HTML 摊平成 (类型, 标签/文字, 属性) 的序列，跳过脚本和样式。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        self.out.append(('start', tag, dict(attrs)))

    def handle_startendtag(self, tag, attrs):
        self.out.append(('start', tag, dict(attrs)))

    def handle_endtag(self, tag):
        if tag in ('script', 'style') and self.skip:
            self.skip -= 1
        self.out.append(('end', tag, None))

    def handle_data(self, data):
        if self.skip:
            return
        value = clean(data)
        if value:
            self.out.append(('text', value, None))


def tokens(html):
    parser = Tokens()
    parser.feed(html)
    parser.close()
    return parser.out


def split_person(value):
    """“葛世荣-教授”“韦鲁滨 教授”“王志强  教授”→（姓名, 职称）。"""
    name, title = '', ''
    for part in SPLIT.split(clean(value)):
        part = part.strip()
        if not part:
            continue
        found = TITLE.search(part)
        if found and not title:
            title = found.group(1)
            rest = squash(part[:found.start()])
            if not name and name_like(rest):
                name = rest
            continue
        candidate = squash(part)
        if not name and name_like(candidate):
            name = candidate
    if not name:
        candidate = squash(value)
        if name_like(candidate):
            name = candidate
    return name, title


def heading_title(value):
    """名单里单独一行的“副教授”“讲 师”“教授（含研究员）”当作后面名字的职称。"""
    compact = squash(value)
    if len(compact) > 14:
        return ''
    found = TITLE.match(compact)
    return found.group(1) if found else ''


def parse_list(html, base, prefix):
    """返回 (people, pages)：people 是 {url, name, title, photo}；pages 是同一栏目下还可以翻的名单页。"""
    host = urlsplit(base).netloc
    stream = tokens(html)
    people, pages, current = {}, [], ''
    i = 0
    while i < len(stream):
        kind, tag, attrs = stream[i]
        if kind == 'text':
            current = heading_title(tag) or current
            i += 1
            continue
        if kind != 'start' or tag != 'a' or not (attrs.get('href') or '').strip():
            i += 1
            continue
        href = urljoin(base, attrs['href'].strip()).split('#')[0]
        p = urlsplit(href)
        # 收集这个链接里面的文字和图片
        texts, photo, j = [], '', i + 1
        while j < len(stream) and not (stream[j][0] == 'end' and stream[j][1] == 'a') and not (stream[j][0] == 'start' and stream[j][1] == 'a'):
            if stream[j][0] == 'text':
                texts.append(stream[j][1])
            elif stream[j][0] == 'start' and stream[j][1] == 'img' and not photo:
                photo = urljoin(base, (stream[j][2].get('src') or '').strip())
            j += 1
        if p.netloc == host and PROFILE.search(p.path):
            name, title = split_person(attrs.get('title') or '')
            # 先把链接里的文字连起来再拆（“高红<span>科</span>”“<p>刘文礼</p><p>教授</p>”），不行再逐段找
            n, t = split_person(''.join(texts)) if texts else ('', '')
            name, title = name or n, title or t
            for value in texts:
                if name and title:
                    break
                n, t = split_person(value)
                name, title = name or n, title or t
            if not name and not texts:
                # 只有照片的链接：名字在链接后面紧跟的文字里（例如照片下面一行姓名）
                k = j + 1
                while k < len(stream) and k < j + 8 and not (stream[k][0] == 'start' and stream[k][1] == 'a'):
                    if stream[k][0] == 'text':
                        n, t = split_person(stream[k][1])
                        if n:
                            name, title = n, title or t
                            break
                    k += 1
            if name and href not in people:
                people[href] = {'url': href, 'name': name, 'title': title or current, 'photo': photo if photo.startswith('https://') else ''}
        elif p.netloc == host and p.path.startswith(prefix) and p.path.endswith('.htm') and '/info/' not in p.path:
            clean_url = f'{p.scheme}://{p.netloc}{p.path}'
            if clean_url not in pages:
                pages.append(clean_url)
        i = j if j > i else i + 1
    return list(people.values()), pages


RESEARCH = re.compile(r'(?:主要)?(?:研究方向|研究领域|研究兴趣)(?:主要)?(?:为|是|包括|有|涉及)?[：:\s]*([^。；;\n]{2,90})')
RESEARCH_STOP = re.compile(r'[，,]\s*(?=提出|获|主持|发表|先后|曾|现任|兼任|担任|出版|承担|参与|近年|作为|已|共|多次|荣获|入选)')
COURSES = re.compile(r'(?:(?:主讲|讲授|开设)(?:的)?(?:本科生?|研究生|本科和研究生|本科生和研究生)?(?:课程|核心课程)?|(?:教学|主要|任课|承担)课程)(?:有|包括|为)?[：:\s]*([^。；;\n]{2,140})')
# “承担《采矿学》《矿山压力》等课程的教学工作”“负责数据结构、操作系统课程的讲授”
COURSES_DUTY = re.compile(r'(?:承担|负责|教授)(?:了)?([^。；;\n]{2,80}?)等?(?:多门)?(?:本科生?|研究生)?(?:课程|课)的?(?:教学|讲授)')
# 课程名里不会出现的词：奖项、项目、单位、荣誉
NOT_COURSE = re.compile(r'项目|基金|论文|专利|奖|教师|教委|学院|大学|优秀|荣誉|称号|主持|负责|委员|学会|北京市|教育部|国家级|省部级|年度|获得|工作')
COURSE_TAIL = re.compile(r'(?:等)?(?:多门|多个)?(?:本科生?|研究生)?(?:专业)?(?:核心)?(?:课程|教学工作|教学|课)$')


def extract_courses(segment):
    names = re.findall(r'《([^》]{2,30})》', segment)
    if not names:
        names = re.split(r'[、，,；;和及与]|以及', segment)
    result = []
    for value in names:
        value = squash(value).strip('“”"\'')
        value = COURSE_TAIL.sub('', value)
        value = re.sub(r'^(?:课程|本科生?|研究生)[：:]?', '', value)
        if 2 <= len(value) <= 24 and len(re.findall(r'[一-鿿]', value)) >= 2 and not NOT_COURSE.search(value):
            if value not in result:
                result.append(value)
    return result[:10]


def parse_profile(html, base, name=''):
    """个人页：职称、系、研究方向、主讲课程、照片地址。读不到的字段留空，不猜。"""
    stream = tokens(html)
    content, depth, photo, in_content = [], 0, '', False
    title, department, page_title, heading = '', '', '', ''
    in_title = in_now = False
    for kind, tag, attrs in stream:
        if kind == 'start':
            classes = (attrs.get('class') or '').split()
            if not in_content and 'v_news_content' in classes:
                in_content, depth = True, 0
            elif in_content and tag in ('div', 'section', 'article'):
                depth += 1
            if 'now-l' in classes:
                in_now = True
            if tag == 'title':
                in_title = True
            if in_content and tag == 'img' and not photo:
                src = urljoin(base, (attrs.get('src') or '').strip())
                small = any(str(attrs.get(k, '')).strip().isdigit() and int(attrs[k]) < 60 for k in ('width', 'height'))
                if src.startswith('https://') and not small and re.search(r'virtual_attach_file|\.(?:jpe?g|png|webp)(?:$|\?)', src, re.I):
                    photo = src
        elif kind == 'end':
            if tag == 'title':
                in_title = False
            if in_now and tag == 'div':
                in_now = False
            if in_content and tag in ('div', 'section', 'article'):
                if depth == 0:
                    in_content = False
                else:
                    depth -= 1
        else:
            if in_title:
                page_title += tag
            if in_now and not department:
                department = tag
            if in_content:
                content.append(tag)
            elif name and not heading and squash(tag).startswith(squash(name)) and len(tag) <= 40:
                heading = tag
    for source in (heading, page_title.split('-')[0]):
        found = TITLE.search(source or '')
        if found:
            title = found.group(1)
            break
    text = '\n'.join(content)
    research = RESEARCH.search(text)
    courses = []
    for m in [*COURSES.finditer(text), *COURSES_DUTY.finditer(text)]:
        courses += [c for c in extract_courses(m.group(1)) if c not in courses]
    department = squash(department)
    research = research.group(1).strip('，, ：:') if research else ''
    # 研究方向后面常接着“提出…”“获得…”“主持…”，在这类逗号处截断，再去掉结尾的“等 / 等方面”
    research = RESEARCH_STOP.split(research, 1)[0]
    research = re.sub(r'(?:等方面|等领域|等方向|等研究|等)$', '', research.strip('，, '))
    return {'title': title,
            # 页面侧栏的栏目名（“双聘院士”“优秀人才”）不是系名，只收以“系 / 所 / 中心 / 教研室”等结尾的
            'department': department if 2 <= len(department) <= 30 and DEPARTMENT.search(department) else '',
            'research': research[:90] if len(re.findall(r'[一-鿿]', research)) >= 4 else '',
            'courses': courses[:10], 'photo': photo}


# ---------- 写入 ----------

def upsert(college, person, now):
    teacher = Teacher.objects.filter(source_url=person['url']).first() or \
        Teacher.objects.filter(name=person['name'], faculty=college).first()
    created = teacher is None
    if created:
        teacher = Teacher(name=person['name'], faculty=college, title=person.get('title', ''),
                          source_url=person['url'], active=True, profile={'origin': 'faculty-bot'})
    profile = dict(teacher.profile or {})
    bot = profile.get('origin') == 'faculty-bot'
    profile.update(college=college, profileUrl=person['url'], seenAt=now.isoformat())
    profile.pop('missingSince', None)
    if bot and person.get('title') and not teacher.title:
        teacher.title = person['title']
    if person.get('photo') and not profile.get('listPhoto'):
        profile['listPhoto'] = person['photo']
    teacher.profile = profile
    teacher.save()
    return teacher, created


def apply_profile(teacher, data, now):
    profile = dict(teacher.profile or {})
    bot = profile.get('origin') == 'faculty-bot'
    if bot and data['title']:
        teacher.title = data['title']
    for key in ('department', 'research'):
        if data[key]:
            profile[key] = data[key]
    if data['courses']:
        profile['courses'] = data['courses']
        # 手工整理过授课信息的老师不覆盖；机器人建的老师按官网更新
        if bot or not teacher.teaching:
            teacher.teaching = [{'name': c, 'sourceUrl': profile.get('profileUrl') or teacher.source_url} for c in data['courses']]
    photo = data['photo'] or profile.get('listPhoto', '')
    current = (teacher.photo or {}).get('url')
    if photo and photo != current and photo not in profile.get('photoRejected', []):
        profile['photoCandidate'] = {'url': photo, 'sourceUrl': profile.get('profileUrl') or teacher.source_url,
                                     'credit': f'{profile.get("college") or teacher.faculty}官网', 'foundAt': now.isoformat()}
    elif photo == current:
        profile.pop('photoCandidate', None)
    profile['crawledAt'] = now.isoformat()
    teacher.profile = profile
    teacher.save()


def due(teacher, now):
    stamp = (teacher.profile or {}).get('crawledAt')
    if not stamp:
        return True
    try:
        from datetime import datetime
        return (now - datetime.fromisoformat(stamp)).days >= REFRESH_DAYS
    except ValueError:
        return True


def crawl_college(college, start, prefix, fetcher=None):
    fetcher = fetcher or Fetcher()
    now = timezone.now()
    queue, seen, people, errors = [start], set(), {}, []
    while queue and len(seen) < MAX_LIST_PAGES:
        page = queue.pop(0)
        if page in seen:
            continue
        seen.add(page)
        try:
            html, final = fetcher.get(page)
        except Problem as exc:
            errors.append(f'{page}：{exc}')
            continue
        found, more = parse_list(html, final, prefix)
        for person in found:
            person['listUrl'] = final
            people.setdefault(person['url'], person)
        queue += [u for u in more if u not in seen and u not in queue]
    complete = not queue and not errors
    created = 0
    teachers = []
    for person in people.values():
        with transaction.atomic():
            teacher, new = upsert(college, person, now)
        created += new
        teachers.append(teacher)
    checked = 0
    for teacher in sorted((t for t in teachers if due(t, now)), key=lambda t: (t.profile or {}).get('crawledAt') or '')[:MAX_PROFILES]:
        target = (teacher.profile or {}).get('profileUrl') or teacher.source_url
        try:
            html, final = fetcher.get(target)
            apply_profile(teacher, parse_profile(html, final, teacher.name), now)
            checked += 1
        except Problem as exc:
            errors.append(f'{teacher.name}：{exc}')
    missing = 0
    if complete and people:
        for teacher in Teacher.objects.filter(faculty=college, profile__origin='faculty-bot'):
            if (teacher.profile or {}).get('profileUrl') not in people and not teacher.profile.get('missingSince'):
                teacher.profile = dict(teacher.profile, missingSince=now.isoformat())
                teacher.save(update_fields=['profile'])
                missing += 1
    pending_photos = sum(1 for t in Teacher.objects.filter(faculty=college) if (t.profile or {}).get('photoCandidate'))
    return {'college': college, 'listPages': len(seen), 'found': len(people), 'created': created,
            'profilesChecked': checked, 'pendingPhotos': pending_photos, 'missing': missing,
            'complete': complete, 'errors': errors[:10], 'checkedAt': now.isoformat()}


def crawl_source(source):
    """discovery.refresh_source 遇到 kind='faculty' 时转到这里。"""
    source.last_attempt = timezone.now()
    source.save(update_fields=['last_attempt'])
    if os.environ.get('HUB_FACULTY_CRAWL', '1') == '0':
        return {'skipped': True, 'source': source.name, 'reason': 'HUB_FACULTY_CRAWL=0'}
    _, colleges = load_config()
    item = next((c for c in colleges if c['start'] == source.url), None)
    prefix = item['prefix'] if item else urlsplit(source.url).path.rsplit('/', 1)[0] + '/'
    try:
        result = crawl_college(source.name, source.url, prefix)
    except Exception as exc:
        source.error = str(exc)[:300]
        source.save(update_fields=['error'])
        raise
    source.last_success = timezone.now()
    source.error = '；'.join(result['errors'])[:300]
    source.save(update_fields=['last_success', 'error'])
    ExternalCache.objects.update_or_create(key=f'faculty:{source.name}', defaults={'data': result, 'error': source.error})
    if result['errors']:
        result['partial'] = True
    return result


def ensure_sources(enabled=True):
    """按配置文件建立或更新每个学院的 Source；配置里删掉的学院停用，不删除记录。"""
    hours, colleges = load_config()
    known = set()
    for item in colleges:
        known.add(item['start'])
        Source.objects.update_or_create(url=item['start'], defaults={
            'name': item['college'], 'kind': 'faculty', 'entry_kind': 'faculty',
            'enabled': enabled, 'interval_hours': hours})
    Source.objects.filter(kind='faculty').exclude(url__in=known).update(enabled=False)
    return Source.objects.filter(kind='faculty').order_by('name')


def status():
    caches = {c.key.removeprefix('faculty:'): c.data for c in ExternalCache.objects.filter(key__startswith='faculty:')}
    sources = [{'id': str(s.pk), 'college': s.name, 'url': s.url, 'enabled': s.enabled, 'intervalHours': s.interval_hours,
                'lastAttempt': s.last_attempt, 'lastSuccess': s.last_success, 'error': s.error, 'last': caches.get(s.name)}
               for s in Source.objects.filter(kind='faculty').order_by('name')]
    pending = []
    for t in Teacher.objects.exclude(profile={}).order_by('faculty', 'name'):
        candidate = (t.profile or {}).get('photoCandidate')
        if candidate:
            pending.append({'teacher': str(t.pk), 'name': t.name, 'college': t.faculty, 'title': t.title,
                            'url': candidate['url'], 'sourceUrl': candidate['sourceUrl'], 'current': (t.photo or {}).get('url')})
    requests = [{'id': a.pk, 'teacher': a.target.removeprefix('teacher:'), 'detail': a.detail, 'created': a.created}
                for a in Audit.objects.filter(action='teacher-request').order_by('-created')[:50]]
    bot = Teacher.objects.filter(profile__origin='faculty-bot')
    return {'sources': sources, 'pendingPhotos': pending[:200], 'pendingPhotoCount': len(pending),
            'botTeachers': bot.count(), 'missing': sum(1 for t in bot if (t.profile or {}).get('missingSince')),
            'requests': requests,
            'policy': '只读学院官网公开师资页；robots.txt 允许、请求间隔 1.5 秒；文字资料自动更新；北矿娘核对官网个人页署名与配图后自动提交，异常候选暂存或驳回。'}


def decide_photo(user, teacher, decision):
    profile = dict(teacher.profile or {})
    candidate = profile.get('photoCandidate')
    if not candidate:
        raise Problem('这位老师没有待确认的照片。', 409)
    if decision == 'approve':
        teacher.photo = {'url': candidate['url'], 'sourceUrl': candidate['sourceUrl'], 'credit': candidate['credit'],
                         'approvedAt': timezone.now().isoformat()}
    elif decision == 'reject':
        profile['photoRejected'] = (profile.get('photoRejected', []) + [candidate['url']])[-10:]
    else:
        raise Problem('请选择确认或不用。')
    profile.pop('photoCandidate', None)
    teacher.profile = profile
    teacher.save()
    Audit.objects.create(actor=user, action='teacher-photo-' + decision, target=f'teacher:{teacher.pk}', detail={'url': candidate['url']})
    return {'teacher': str(teacher.pk), 'decision': decision}
