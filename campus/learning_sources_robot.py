"""Bounded official-source indexing for general electives and licensed study text.

CLI: python campus/learning_sources_robot.py --refresh
GET readers only read the cache. No accounts, hidden endpoints, PDF republication,
school-course name matching, browser automation or recurring job is created.
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import hashlib
from html.parser import HTMLParser
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import time
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree as ET

SCHEMA_VERSION = 1
UA = 'LuokixiLibrarySources/1.0 (bounded public educational index)'
SCHOOL_ROOT = 'https://jwc.cumtb.edu.cn'
SCHOOL_INDEX = SCHOOL_ROOT + '/jxyx/txk.htm'
# Exact public attachments discovered on the 2026-09-17 official notice.
SCHOOL_COURSE_NOTICE = SCHOOL_ROOT + '/info/1133/6535.htm'
SCHOOL_ATTACHMENTS = {
    'catalogue': SCHOOL_ROOT + '/system/_content/download.jsp?urltype=news.DownloadAttachUrl&owner=1429548415&wbfileid=68D6F32685BF116FD175920AD93D4588',
    'introductions': SCHOOL_ROOT + '/system/_content/download.jsp?urltype=news.DownloadAttachUrl&owner=1429548415&wbfileid=20E3444EA640A73CF8986DBFBA8A456B',
}
REPOSITORY = 'https://github.com/openstax/osbooks-psychology'
COMMIT_URL = 'https://api.github.com/repos/openstax/osbooks-psychology/commits/main'
RAW_ROOT = 'https://raw.githubusercontent.com/openstax/osbooks-psychology/'
LICENSE_URL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/'
CACHE_NAME = 'learning-sources.json'
MAX_REQUESTS = 24
MAX_TOTAL_BYTES = 6 * 1024 * 1024
MAX_QUESTIONS = 24
MAX_TERMS = 40
NS = {'c': 'http://cnx.rice.edu/cnxml', 'col': 'http://cnx.rice.edu/collxml', 'md': 'http://cnx.rice.edu/mdml'}


class SourceError(ValueError):
    def __init__(self, code, status=None):
        super().__init__(code)
        self.code, self.http_status = code, status


def validate_target(target):
    p = urlsplit(target)
    if p.scheme != 'https' or p.port not in (None, 443) or p.username or p.password or p.fragment:
        raise SourceError('unsupported-url')
    if p.hostname == 'jwc.cumtb.edu.cn':
        allowed = (not p.query and (p.path in ('/robots.txt', '/index.htm', '/jxyx/txk.htm') or re.fullmatch(r'/info/\d{4}/\d+\.htm', p.path))) or target in SCHOOL_ATTACHMENTS.values()
    elif p.hostname == 'api.github.com':
        allowed = not p.query and p.path in ('/robots.txt', '/repos/openstax/osbooks-psychology/commits/main')
    elif p.hostname == 'raw.githubusercontent.com':
        allowed = not p.query and (p.path == '/robots.txt' or re.fullmatch(r'/openstax/osbooks-psychology/[a-f0-9]{40}/(?:LICENSE|collections/psychology-2e\.collection\.xml|modules/m\d+/index\.cnxml)', p.path))
    else:
        allowed = False
    if not allowed:
        raise SourceError('source-not-allowlisted')
    return p


def fetch_public(target, limit=1024 * 1024):
    """Pin public DNS addresses and revalidate each redirect; no cookie/auth headers."""
    for _ in range(4):
        p = validate_target(target)
        addresses = socket.getaddrinfo(p.hostname, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(addr[4][0].split('%')[0]).is_global for addr in addresses):
            raise SourceError('non-public-address')
        connection = http.client.HTTPSConnection(p.hostname, 443, timeout=15)
        try:
            sock = socket.create_connection((addresses[0][4][0], 443), timeout=15)
            try:
                connection.sock = ssl.create_default_context().wrap_socket(sock, server_hostname=p.hostname)
            except BaseException:
                sock.close()
                raise
            connection.request('GET', (p.path or '/') + ('?' + p.query if p.query else ''), headers={'User-Agent': UA, 'Accept': 'text/html,application/xml,application/json,text/plain;q=0.9'})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                redirected = urljoin(target, response.getheader('Location', ''))
                validated = validate_target(redirected)
                if validated.hostname != p.hostname:
                    raise SourceError('cross-origin-redirect')
                target = redirected
                continue
            if response.status != 200:
                raise SourceError('http-' + str(response.status), response.status)
            if int(response.getheader('Content-Length', '0')) > limit:
                raise SourceError('source-too-large')
            raw = response.read(limit + 1)
            if len(raw) > limit:
                raise SourceError('source-too-large')
            return raw, target
        finally:
            connection.close()
    raise SourceError('too-many-redirects')


class PublicCollector:
    def __init__(self, fetcher=fetch_public, delay=0.15):
        self.fetcher, self.delay = fetcher, delay
        self.count, self.total = 0, 0
        self.robots, self.receipts = {}, []

    def _request(self, target, limit):
        validate_target(target)
        if self.count >= MAX_REQUESTS:
            raise SourceError('request-budget-exhausted')
        self.count += 1
        if self.delay and self.count > 1:
            time.sleep(self.delay)
        raw, final_url = self.fetcher(target, limit=limit)
        validate_target(final_url)
        self.total += len(raw)
        if self.total > MAX_TOTAL_BYTES:
            raise SourceError('byte-budget-exhausted')
        return raw, final_url

    def get(self, target, limit=1024 * 1024):
        p = validate_target(target)
        origin = 'https://' + p.hostname
        if origin not in self.robots:
            parser = RobotFileParser()
            try:
                raw, _ = self._request(origin + '/robots.txt', 128 * 1024)
                parser.parse(raw.decode('utf-8', errors='replace').splitlines())
            except SourceError as exc:
                if exc.http_status != 404:
                    raise
                parser.parse([])
            self.robots[origin] = parser
        if not self.robots[origin].can_fetch(UA, target):
            raise SourceError('robots-disallowed')
        raw, final_url = self._request(target, limit)
        # A redirect may cross to another allowlisted origin; do not treat its robots as checked.
        if urlsplit(final_url).hostname != p.hostname:
            raise SourceError('cross-origin-redirect')
        self.receipts.append({'url': final_url, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
        return raw, final_url


class MetadataParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links, self.text, self.current, self.hidden = [], [], None, 0
        self.titles, self.in_title = [], False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('script', 'style', 'noscript'):
            self.hidden += 1
        if tag == 'title':
            self.in_title = True
        if tag == 'a' and not self.hidden:
            self.current = {'href': attrs.get('href', ''), 'title': attrs.get('title', ''), 'text': []}

    def handle_data(self, value):
        if not self.hidden:
            self.text.append(value)
            if self.current is not None:
                self.current['text'].append(value)
            if self.in_title:
                self.titles.append(value)

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript'):
            self.hidden = max(0, self.hidden - 1)
        if tag == 'title':
            self.in_title = False
        if tag == 'a' and self.current is not None:
            link = self.current
            link['title'] = ' '.join((link['title'] or ''.join(link.pop('text'))).split())
            link.pop('text', None)
            self.links.append(link)
            self.current = None


def parse_school_links(raw, origin=SCHOOL_INDEX):
    page = MetadataParser(); page.feed(raw.decode('utf-8', errors='replace'))
    found = {}
    for link in page.links:
        title = link['title']
        target = urljoin(origin, link['href'])
        p = urlsplit(target)
        if '通识教育选修课' not in title or p.hostname != 'jwc.cumtb.edu.cn' or not re.fullmatch(r'/info/\d{4}/\d+\.htm', p.path):
            continue
        found.setdefault(target, {'title': title, 'url': target})
    if not found:
        raise SourceError('school-notice-selector-empty')
    return list(found.values())[:6]


def _semester(today):
    if today.month >= 8:
        return f'{today.year}-{today.year + 1}', '第一学期'
    if today.month == 1:
        return f'{today.year - 1}-{today.year}', '第一学期'
    return f'{today.year - 1}-{today.year}', '第二学期'


def parse_school_notice(raw, target, fallback_title='', today=None):
    page = MetadataParser(); page.feed(raw.decode('utf-8', errors='replace'))
    title = ' '.join(page.titles).split('-中国矿业大学')[0].strip() or fallback_title
    if '通识教育选修课' not in title:
        raise SourceError('not-an-elective-notice')
    text = ' '.join(page.text)
    published = re.search(r'日期\s*[：:]?\s*(\d{4}-\d{2}-\d{2})', text)
    semester = re.search(r'(\d{4}-\d{4})学年第([一二])学期', title)
    current = _semester(today or date.today())
    academic_year = semester[1] if semester else ''
    term = f'第{semester[2]}学期' if semester else ''
    candidates = []
    # Only an explicit course title immediately accompanied by its official code is
    # admitted from notice prose. Contact people and similar names are not teachers.
    for match in re.finditer(r'《([^《》]{1,100})》\s*[（(]课程代码\s*[:：]\s*([A-Z][A-Z0-9]{3,30})\s*[）)]', text):
        name, code = match.groups()
        candidates.append({'id': f'cumtb-elective-{academic_year}-{term}-{code}',
            'name': name, 'officialCode': code, 'teacher': '', 'academicYear': academic_year, 'term': term,
            'school': '中国矿业大学（北京）', 'courseId': '', 'scope': 'school-official-catalogue',
            'sourceUrl': target, 'noticeUrl': target, 'intro': '', 'introSourceUrl': '',
            'mappingStatus': 'unlinked', 'evidenceType': 'explicit-notice-course-code'})
    attachments = [{'kind': kind, 'url': url, 'access': 'not-fetched'} for kind, url in SCHOOL_ATTACHMENTS.items()
                   if any(urljoin(target, link['href']) == url for link in page.links)]
    count = re.search(r'(?:课程|网络课程)\s*(\d{1,3})\s*门', text)
    return {'id': 'notice-' + hashlib.sha256(target.encode()).hexdigest()[:16], 'title': title,
            'url': target, 'publishedAt': published[1] if published else '', 'academicYear': academic_year,
            'term': term, 'currentTerm': (academic_year, term) == current if semester else None,
            'scope': 'school-official-notice', 'school': '中国矿业大学（北京）', 'courseId': '',
            'access': 'link-only', 'license': '来源版权保留；仅收录通知标题、日期和原站链接',
            'schoolCourseCandidates': candidates, 'catalogueAttachments': attachments,
            'announcedCourseCount': int(count[1]) if count else None}


def safe_xml(raw):
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise SourceError('xml-entities-disallowed')
    return ET.fromstring(raw)


def _content(node):
    return ' '.join(''.join(node.itertext()).split()) if node is not None else ''


def parse_chapter_modules(raw):
    root = safe_xml(raw)
    license_node = root.find('./col:metadata/md:license', NS)
    if license_node is None or 'creativecommons.org/licenses/by-nc-sa/4.0' not in license_node.get('url', ''):
        raise SourceError('book-license-unverified')
    chapter = root.find('./col:content/col:subcollection', NS)
    if chapter is None:
        raise SourceError('book-chapter-missing')
    title = _content(chapter.find('md:title', NS))
    modules = [node.get('document', '') for node in chapter.findall('./col:content/col:module', NS)]
    if not modules or len(modules) > 6 or any(not re.fullmatch(r'm\d+', value) for value in modules):
        raise SourceError('book-chapter-outside-bounds')
    return title, modules


def parse_psychology_module(raw, source_url, module_id):
    root = safe_xml(raw)
    section_title = _content(root.find('c:title', NS))
    questions, terms = [], []
    for section in root.findall('.//c:section', NS):
        if 'review-questions' not in section.get('class', '').split():
            continue
        for exercise in section.findall('c:exercise', NS):
            problem = exercise.find('c:problem', NS)
            if problem is None:
                continue
            prompt = ' '.join(_content(node) for node in problem.findall('c:para', NS))
            choices = problem.findall('c:list/c:item', NS)
            answer = _content(exercise.find('c:solution', NS)).strip()
            if not prompt or not 2 <= len(choices) <= 8:
                continue
            options = [{'id': chr(65 + index), 'text': _content(node)} for index, node in enumerate(choices)]
            verified_answer = answer if answer in {option['id'] for option in options} else ''
            # Only plain CNXML text/list markup is lossless under itertext(). MathML,
            # media, figures, tables and unfamiliar structures keep manual review.
            plain_tags = {'exercise', 'problem', 'para', 'list', 'item', 'solution', 'emphasis', 'term', 'link'}
            literal_text = all(node.tag.startswith('{' + NS['c'] + '}') and node.tag.split('}', 1)[1] in plain_tags for node in exercise.iter())
            questions.append({'id': 'openstax-psychology2e-' + module_id + '-' + exercise.get('id', str(len(questions))),
                              'type': 'single-choice', 'question': prompt, 'options': options,
                              'answer': verified_answer, 'answerStatus': 'source-provided' if verified_answer else 'missing',
                              'literalText': literal_text,
                              'sourceUrl': source_url + '#' + exercise.get('id', ''),
                              'sourceSection': section_title, 'sourceModule': module_id, 'language': 'en',
                              'license': 'CC BY-NC-SA 4.0', 'schoolCourseId': ''})
    for definition in root.findall('./c:glossary/c:definition', NS):
        term, meaning = _content(definition.find('c:term', NS)), _content(definition.find('c:meaning', NS))
        if term and meaning:
            terms.append({'term': term, 'definition': meaning, 'sourceUrl': source_url + '#' + definition.get('id', ''), 'sourceSection': section_title})
    return questions, terms


def collect_school(collector, checked_at):
    raw, origin = collector.get(SCHOOL_INDEX)
    notices = []
    for entry in parse_school_links(raw, origin):
        content, target = collector.get(entry['url'])
        notice = parse_school_notice(content, target, entry['title'])
        notice['checkedAt'] = checked_at
        for candidate in notice['schoolCourseCandidates']:
            candidate['checkedAt'] = checked_at
        notices.append(notice)
    return {'id': 'cumtb-general-electives', 'title': '矿大（北京）通识选修课官方通知',
            'scope': 'school-official-notice', 'status': 'ready', 'url': SCHOOL_INDEX, 'checkedAt': checked_at,
            'license': '来源版权保留；仅建立通知索引', 'items': notices, 'courseCount': None,
            'schoolCourseCandidates': [candidate for notice in notices for candidate in notice['schoolCourseCandidates']],
            'note': '通知与学期已区分；未读取登录后的选课结果，也未把通知当作课程题库。'}


def collect_openstax(collector, checked_at):
    raw, _ = collector.get(COMMIT_URL)
    commit = json.loads(raw).get('sha', '')
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise SourceError('book-commit-unverified')
    base = RAW_ROOT + commit + '/'
    license_raw, _ = collector.get(base + 'LICENSE', 128 * 1024)
    if b'Attribution-NonCommercial-ShareAlike 4.0 International' not in license_raw[:300]:
        raise SourceError('book-license-changed')
    raw, _ = collector.get(base + 'collections/psychology-2e.collection.xml', 128 * 1024)
    chapter, modules = parse_chapter_modules(raw)
    questions, terms = [], []
    for module in modules:
        raw, _ = collector.get(base + 'modules/' + module + '/index.cnxml')
        source_url = REPOSITORY + '/blob/' + commit + '/modules/' + module + '/index.cnxml'
        module_questions, module_terms = parse_psychology_module(raw, source_url, module)
        questions.extend(module_questions); terms.extend(module_terms)
    questions, terms = questions[:MAX_QUESTIONS], terms[:MAX_TERMS]
    if not questions:
        raise SourceError('book-questions-empty')
    bank = {'id': 'openstax-psychology2e-ch1', 'title': 'Psychology 2e · Chapter 1: ' + chapter,
            'topic': 'psychology', 'scope': 'general-topic', 'schoolCourseId': '', 'language': 'en',
            'license': 'CC BY-NC-SA 4.0', 'licenseUrl': LICENSE_URL,
            'attribution': 'OpenStax, Rice University, Psychology 2e. 来源保留署名；CC BY-NC-SA 4.0。',
            'changes': 'Extracted chapter 1 review questions and key terms into structured text; whitespace normalized. No translation, answer generation, images or cover extraction.',
            'sourceUrl': REPOSITORY, 'readerUrl': 'https://openstax.org/books/psychology-2e/pages/1-introduction',
            'commit': commit, 'checkedAt': checked_at, 'questions': questions, 'keyTerms': terms,
            'notice': '英语通识学习材料；不代表矿大本学期开设此课程，也不属于本校真题。'}
    source = {'id': 'openstax-psychology', 'title': 'OpenStax Psychology 2e', 'scope': 'general-topic',
              'status': 'ready', 'url': REPOSITORY, 'checkedAt': checked_at, 'license': bank['license'],
              'licenseUrl': LICENSE_URL, 'questionCount': len(questions), 'termCount': len(terms),
              'bankId': bank['id'], 'commit': commit, 'note': bank['notice']}
    return source, bank


def get_learning_sources(data_dir):
    """Read only: endpoint callers never trigger network requests."""
    target = Path(data_dir) / CACHE_NAME
    try:
        if target.stat().st_size > 4 * 1024 * 1024:
            raise ValueError('cache-too-large')
        value = json.loads(target.read_text(encoding='utf-8'))
        if value.get('schemaVersion') != SCHEMA_VERSION or not isinstance(value.get('sources'), list) or not isinstance(value.get('questionBanks'), list):
            raise ValueError('unsupported-cache')
        return value
    except (OSError, ValueError, TypeError, AttributeError):
        return {'schemaVersion': SCHEMA_VERSION, 'checkedAt': None, 'sources': [], 'questionBanks': [],
                'report': {'state': 'not-collected', 'sourceCount': 0, 'questionCount': 0, 'scheduled': False}}


def refresh_learning_sources(data_dir, fetcher=fetch_public, delay=0.15):
    existing = get_learning_sources(data_dir)
    previous = {item['id']: item for item in existing['sources'] if isinstance(item, dict) and item.get('id')}
    old_banks = {item['id']: item for item in existing['questionBanks'] if isinstance(item, dict) and item.get('id')}
    checked_at = datetime.now(timezone.utc).isoformat()
    collector = PublicCollector(fetcher, delay)
    sources, banks, failures = [], [], []
    for identifier in ('cumtb-general-electives', 'openstax-psychology'):
        try:
            if identifier == 'cumtb-general-electives':
                sources.append(collect_school(collector, checked_at))
            else:
                source, bank = collect_openstax(collector, checked_at)
                sources.append(source); banks.append(bank)
        except (SourceError, OSError, ValueError, ET.ParseError) as exc:
            code = exc.code if isinstance(exc, SourceError) else type(exc).__name__
            failures.append({'sourceId': identifier, 'errorCode': code})
            prior = previous.get(identifier)
            sources.append(dict(prior, status='stale', lastAttempt=checked_at, errorCode=code) if prior else
                {'id': identifier, 'title': '矿大（北京）通识选修课官方通知' if identifier.startswith('cumtb') else 'OpenStax Psychology 2e',
                 'scope': 'school-official-notice' if identifier.startswith('cumtb') else 'general-topic',
                 'url': SCHOOL_INDEX if identifier.startswith('cumtb') else REPOSITORY,
                 'status': 'error', 'checkedAt': None, 'lastAttempt': checked_at, 'errorCode': code})
            if identifier == 'openstax-psychology' and 'openstax-psychology2e-ch1' in old_banks:
                banks.append(dict(old_banks['openstax-psychology2e-ch1'], stale=True))
    sources.append({'id': 'icpc-official', 'title': 'ICPC 官方比赛入口', 'scope': 'competition',
                    'status': 'link-only', 'url': 'https://icpc.global/', 'checkedAt': None,
                    'license': '版权保留；仅提供原站入口', 'note': '未批量复制赛题；比赛资格、赛程与题目以原站为准。'})
    candidates = [candidate for source in sources for candidate in source.get('schoolCourseCandidates', [])]
    # Preserve explicit access checks from a separate bounded catalogue inspection.
    # They are timestamped evidence, not permission to bypass a verification page.
    catalogue_check = existing.get('schoolCourseCatalog', {})
    result = {'schemaVersion': SCHEMA_VERSION, 'checkedAt': checked_at, 'sources': sources, 'questionBanks': banks,
              'schoolCourseCandidates': candidates, 'schoolCourseCatalog': catalogue_check,
              'report': {'state': 'partial' if failures else 'ready', 'sourceCount': len(sources),
                         'questionCount': sum(len(bank['questions']) for bank in banks),
                         'noticeCount': sum(len(source.get('items', [])) for source in sources),
                         'requests': collector.count, 'bytes': collector.total, 'failures': failures, 'receipts': collector.receipts,
                         'scheduled': False, 'scope': 'existing-library-first; general-elective-official-links; licensed-general-study'}}
    folder = Path(data_dir); folder.mkdir(parents=True, exist_ok=True)
    destination = folder / CACHE_NAME
    temporary = folder / (CACHE_NAME + '.tmp')
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, destination)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=Path(os.environ.get('CAMPUS_DATA_DIR', Path(__file__).resolve().parent / '.data')))
    parser.add_argument('--refresh', action='store_true', help='Run one bounded fetch; no recurring schedule is installed')
    args = parser.parse_args(argv)
    result = refresh_learning_sources(args.data_dir) if args.refresh else get_learning_sources(args.data_dir)
    report = {key: value for key, value in result['report'].items() if key != 'receipts'}
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0 if report['state'] in ('ready', 'partial') else 1


if __name__ == '__main__':
    raise SystemExit(main())
