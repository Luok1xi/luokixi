"""Bounded, resumable public university-course collection. No login or model service.

Run: python campus/university_sources_robot.py --registry campus/university-sources.json
     --max-sources 4 --max-requests 24 --download --max-downloads 4
GET endpoints only read the resulting cache; a request never starts this collector.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import fnmatch
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import ssl
import sys
import time
from urllib.parse import quote, unquote, urljoin, urlsplit
from urllib.robotparser import RobotFileParser

# Reuse the existing local-only PDF runtime; never install or contact a service here.
_question_runtime = Path(__file__).resolve().parent / '.data' / 'question-runtime'
if _question_runtime.is_dir():
    sys.path.insert(0, str(_question_runtime))

from source_classification import VERSION as CLASSIFICATION_VERSION, classify, link_suites

VERSION = 1
UA = 'LuokixiUniversitySources/1.0 (bounded educational metadata and private study)'
FORMATS = {'pdf', 'txt', 'md', 'mdx', 'doc', 'docx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg'}
EXTRACT_FORMATS = {'pdf', 'txt', 'md', 'mdx'}
REPO_PATTERN = r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'
SHA_PATTERN = r'[a-f0-9]{40}'


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


class CollectorError(ValueError):
    def __init__(self, code, status=None):
        super().__init__(code)
        self.code, self.status = code, status


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    os.replace(temporary, path)


@contextmanager
def run_lock(folder):
    """One writer per checkpoint directory, automatically released on process exit."""
    path = Path(folder) / 'run.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise CollectorError('collector-already-running')
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def safe_relative(path):
    value = str(path or '')
    p = PurePosixPath(value)
    if not value or p.is_absolute() or '\\' in value or any(part in ('', '.', '..') for part in value.split('/')) or any(ord(ch) < 32 for ch in value):
        raise CollectorError('invalid-source-path')
    return value


def load_registry(path):
    payload = read_json(path, None)
    if not isinstance(payload, dict) or payload.get('version') != VERSION or not isinstance(payload.get('sources'), list):
        raise CollectorError('invalid-registry')
    seen = set()
    for source in payload['sources']:
        if not isinstance(source, dict) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,79}', source.get('id', '')) or source['id'] in seen:
            raise CollectorError('invalid-source-id')
        seen.add(source['id'])
        if source.get('type') not in ('github', 'official-page') or (source.get('type') == 'github' and not re.fullmatch(REPO_PATTERN, source.get('repo', ''))):
            raise CollectorError('unsupported-source-type')
        school = source.get('school', {})
        if not isinstance(school, dict) or not school.get('id') or not school.get('name'):
            raise CollectorError('missing-registered-school')
        rights = source.get('rights', {})
        if rights.get('access') not in (None, 'public') or rights.get('mode', 'metadata-only') not in ('metadata-only', 'private-study', 'download-allowed'):
            raise CollectorError('unsupported-source-rights')
        branch = source.get('branch', '')
        if branch and (not re.fullmatch(r'[A-Za-z0-9_./-]{1,160}', branch) or '..' in branch):
            raise CollectorError('invalid-branch')
        for sample in source.get('sampleFiles', []):
            safe_relative(sample['path'])
    return payload


class RegisteredTargets:
    """Strict endpoint allowlist derived only from maintained registry entries."""
    def __init__(self, sources):
        self.repos = {source['repo'].casefold() for source in sources if source.get('type') == 'github'}
        self.exact_urls = {url for source in sources if source.get('type') == 'official-page'
                           for url in [source.get('url')] + [f.get('downloadUrl') or f.get('url') for f in source.get('sampleFiles', [])]
                           if isinstance(url, str)}
        self.official_hosts = {urlsplit(url).hostname for url in self.exact_urls}

    def validate(self, target):
        p = urlsplit(target)
        if p.scheme != 'https' or p.port not in (None, 443) or p.username or p.password or p.fragment:
            raise CollectorError('unsupported-url')
        if p.hostname not in ('api.github.com', 'raw.githubusercontent.com') and p.hostname not in self.official_hosts:
            raise CollectorError('source-not-registered')
        if p.path == '/robots.txt' and not p.query:
            return p
        if p.hostname in self.official_hosts:
            if target not in self.exact_urls:
                raise CollectorError('source-not-registered')
            return p
        path = unquote(p.path)
        if '%2f' in p.path.lower() or '%5c' in p.path.lower():
            raise CollectorError('encoded-path-separator')
        if p.hostname == 'api.github.com':
            match = re.fullmatch(r'/repos/(' + REPO_PATTERN + r')(?:/(commits)/([^?]+)|/git/trees/(' + SHA_PATTERN + r'))?', path)
            if not match or match[1].casefold() not in self.repos:
                raise CollectorError('source-not-registered')
            if match[2] and (not re.fullmatch(r'[A-Za-z0-9_./-]{1,160}', match[3]) or '..' in match[3]):
                raise CollectorError('invalid-ref')
            if p.query and (not match[4] or p.query != 'recursive=1'):
                raise CollectorError('unsupported-query')
        else:
            match = re.fullmatch(r'/(' + REPO_PATTERN + r')/(' + SHA_PATTERN + r')/(.+)', path)
            if not match or match[1].casefold() not in self.repos or p.query:
                raise CollectorError('source-not-registered')
            safe_relative(match[3])
        return p


def read_response(response, connection, limit, deadline, clock=time.monotonic):
    """read1 makes each socket receive observe the absolute deadline, including drips."""
    data = bytearray()
    while True:
        remaining = deadline - clock()
        if remaining <= 0:
            raise CollectorError('response-time-budget-exhausted')
        if connection.sock is not None:
            connection.sock.settimeout(min(18, remaining))
        chunk = response.read1(min(64 * 1024, limit + 1 - len(data)))
        if not chunk:
            return bytes(data)
        data.extend(chunk)
        if len(data) > limit:
            raise CollectorError('response-too-large')


def fetch_public(target, *, policy, limit, headers=None, deadline=None):
    """Pin public DNS, verify TLS and validate redirects. No environment proxy or auth."""
    deadline = deadline if deadline is not None else time.monotonic() + 60
    for _ in range(4):
        p = policy.validate(target)
        if time.monotonic() >= deadline:
            raise CollectorError('response-time-budget-exhausted')
        addresses = socket.getaddrinfo(p.hostname, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(item[4][0].split('%')[0]).is_global for item in addresses):
            raise CollectorError('non-public-address')
        connection = http.client.HTTPSConnection(p.hostname, timeout=18)
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CollectorError('response-time-budget-exhausted')
            sock = socket.create_connection((addresses[0][4][0], 443), timeout=min(18, remaining))
            try:
                connection.sock = ssl.create_default_context().wrap_socket(sock, server_hostname=p.hostname)
            except BaseException:
                sock.close()
                raise
            request_headers = {'User-Agent': UA, 'Accept': 'application/vnd.github+json, text/plain;q=0.8, */*;q=0.5'}
            if headers and headers.get('If-None-Match'):
                request_headers['If-None-Match'] = headers['If-None-Match']
            connection.request('GET', p.path + ('?' + p.query if p.query else ''), headers=request_headers)
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                next_target = urljoin(target, response.getheader('Location', ''))
                redirected = policy.validate(next_target)
                if redirected.hostname != p.hostname:
                    raise CollectorError('cross-origin-redirect')
                target = next_target
                continue
            response_headers = {key.lower(): value for key, value in response.getheaders()}
            if response.status == 304:
                return b'', response_headers, target, 304
            if int(response.getheader('Content-Length', '0') or 0) > limit:
                raise CollectorError('response-too-large')
            raw = read_response(response, connection, limit, deadline)
            return raw, response_headers, target, response.status
        finally:
            connection.close()
    raise CollectorError('too-many-redirects')


class Collector:
    def __init__(self, sources, state_dir, *, max_requests=30, max_bytes=32*1024*1024,
                 max_seconds=180, delay=0.6, fetcher=fetch_public, sleep=time.sleep, clock=time.monotonic):
        self.policy, self.folder = RegisteredTargets(sources), Path(state_dir)
        self.cache_dir = self.folder / 'http-cache'
        self.cache = read_json(self.folder / 'http-index.json', {})
        self.fetcher, self.sleep, self.clock = fetcher, sleep, clock
        self.started, self.max_seconds = clock(), max_seconds
        self.max_requests, self.max_bytes, self.delay = max_requests, max_bytes, delay
        self.count = self.total = self.cache_hits = self.retries = 0
        self.host_last, self.host_delays, self.robots = {}, {}, {}

    def save(self):
        atomic_json(self.folder / 'http-index.json', self.cache)

    def _request(self, target, limit, headers=None):
        p = self.policy.validate(target)
        if self.count >= self.max_requests:
            raise CollectorError('request-budget-exhausted')
        if self.clock() - self.started >= self.max_seconds:
            raise CollectorError('time-budget-exhausted')
        remaining = self.max_bytes - self.total
        if remaining <= 0:
            raise CollectorError('byte-budget-exhausted')
        wait = max(self.delay, self.host_delays.get(p.hostname, 0)) - (self.clock() - self.host_last.get(p.hostname, -1e9))
        if wait > 0:
            if wait >= self.max_seconds - (self.clock() - self.started):
                raise CollectorError('time-budget-exhausted')
            self.sleep(wait)
        self.count += 1
        self.host_last[p.hostname] = self.clock()
        deadline = min(self.started + self.max_seconds, self.clock() + 60)
        raw, response_headers, final, status = self.fetcher(target, policy=self.policy, limit=min(limit, remaining), headers=headers or {}, deadline=deadline)
        self.policy.validate(final)
        if urlsplit(final).hostname != p.hostname:
            raise CollectorError('cross-origin-redirect')
        self.total += len(raw)
        if self.total > self.max_bytes:
            raise CollectorError('byte-budget-exhausted')
        return raw, response_headers, final, status

    def _retried(self, target, limit, headers=None):
        for attempt in range(3):
            try:
                value = self._request(target, limit, headers)
            except (TimeoutError, OSError, http.client.HTTPException):
                if attempt == 2:
                    raise CollectorError('network-unavailable')
                value = None
            if value is not None:
                status = value[3]
                if status not in (429, 500, 502, 503, 504):
                    return value
                if attempt == 2:
                    return value
                retry = value[1].get('retry-after', '')
                if retry.isdigit() and int(retry) > 8:
                    raise CollectorError('retry-deferred', status)
            self.retries += 1
            self.sleep(min(4, 0.5 * 2**attempt))
        raise CollectorError('network-unavailable')

    def get(self, target, limit=12*1024*1024, *, immutable=False, robots=True):
        p = self.policy.validate(target)
        if robots and p.hostname not in self.robots:
            rules = RobotFileParser()
            try:
                raw, _ = self.get('https://' + p.hostname + '/robots.txt', 128*1024, robots=False)
                rules.parse(raw.decode('utf-8', errors='replace').splitlines())
            except CollectorError as error:
                if error.status != 404:
                    raise
                rules.parse([])
            self.robots[p.hostname] = rules
            crawl_delay = rules.crawl_delay(UA) or rules.crawl_delay('*')
            if crawl_delay:
                self.host_delays[p.hostname] = crawl_delay
        if robots and not self.robots[p.hostname].can_fetch(UA, target):
            raise CollectorError('robots-disallowed')
        key = hashlib.sha256(target.encode()).hexdigest()
        entry = self.cache.get(key, {})
        cached = self.cache_dir / key
        existing = cached.is_file() and entry.get('sha256') == hashlib.sha256(cached.read_bytes()).hexdigest()
        if immutable and existing:
            self.cache_hits += 1
            return cached.read_bytes(), entry['finalUrl']
        headers = {'If-None-Match': entry['etag']} if existing and entry.get('etag') else {}
        raw, response_headers, final, status = self._retried(target, limit, headers)
        if status == 304:
            if not existing:
                raise CollectorError('cache-body-missing')
            self.cache_hits += 1
            return cached.read_bytes(), entry['finalUrl']
        if status != 200:
            raise CollectorError('http-' + str(status), status)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(raw)
        self.cache[key] = {'url': target, 'finalUrl': final, 'etag': response_headers.get('etag', ''),
                           'sha256': hashlib.sha256(raw).hexdigest(), 'checkedAt': now()}
        self.save()
        return raw, final

    def json(self, target, *, immutable=False):
        raw, _ = self.get(target, immutable=immutable)
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError):
            raise CollectorError('invalid-source-json')
        if not isinstance(result, dict):
            raise CollectorError('invalid-source-json')
        return result


def matches_path(path, source):
    safe_relative(path)
    included = source.get('include') or ['**']
    excluded = source.get('exclude') or []
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in included) and not any(fnmatch.fnmatchcase(path, pattern) for pattern in excluded)


def auxiliary_asset(path):
    """Do not turn bundled software docs, training images and application icons into exams."""
    parts = [part.casefold() for part in PurePosixPath(path).parts]
    if any(part in {'node_modules', '.git', '.github', 'site-packages', '__pycache__', '.venv',
                    'dataset', 'datasets', 'static_files', '.idea', '.vscode'} for part in parts[:-1]):
        return True
    if PurePosixPath(path).suffix.casefold() in ('.png', '.jpg', '.jpeg') and any(part in {'assets', 'icons', 'png'} for part in parts[:-1]):
        return True
    if any(parts[index] == 'docs' and parts[index + 1] in {'howto', 'releases', 'ref', 'topics', 'internals', 'intro', 'faq'} for index in range(len(parts) - 2)):
        return True
    return False


def apply_file_metadata(resource, sample):
    explicit_kind = {'sample-exam': 'exam', 'final-exam': 'exam', 'midterm-exam': 'exam',
                     'exam': 'exam', 'exercise': 'exercise', 'answer': 'answer', 'notes': 'notes'}.get(sample.get('materialType'))
    for field, value in [('course', sample.get('course')), ('college', sample.get('college')), ('kind', explicit_kind)]:
        if value:
            resource[field] = value
            resource['confidence'][field] = 0.95
            resource['classificationEvidence'].append({'field': field, 'value': value, 'matched': value,
                'origin': 'registered-file-metadata', 'confidence': 0.95})
    year = str(sample.get('year', ''))
    academic = re.fullmatch(r'((?:19|20)\d{2})[-–—]((?:19|20)\d{2})', year)
    if academic and int(academic[2]) == int(academic[1]) + 1:
        resource['year'], resource['academicYear'] = int(academic[1]), academic[1] + '-' + academic[2]
    elif re.fullmatch(r'(?:19|20)\d{2}', year):
        resource['year'] = int(year)
    term = {'1': '第一学期', '2': '第二学期'}.get(str(sample.get('term', '')))
    if term:
        resource['term'] = term
    if resource.get('year') and year:
        resource['classificationEvidence'].append({'field': 'year', 'value': resource['year'], 'matched': year,
            'origin': 'registered-file-metadata', 'confidence': 0.95})
    if sample.get('bundleKey') and resource.get('course') != 'unknown' and resource.get('year') and resource.get('term'):
        identity = '|'.join(str(resource.get(k,'')) for k in ('schoolId','sourceId','course','academicYear','year','term')) + '|' + sample['bundleKey']
        resource['suiteKey'] = hashlib.sha256(identity.encode()).hexdigest()[:24]
        resource['classificationEvidence'].append({'field': 'suiteKey', 'value': resource['suiteKey'],
            'matched': sample['bundleKey'], 'origin': 'registered-file-pair', 'confidence': 0.95})
    return resource


def resource_from_entry(entry, source, commit, previous=None):
    path = safe_relative(entry['path'])
    if auxiliary_asset(path):
        return None
    extension = PurePosixPath(path).suffix.lower().lstrip('.')
    if PurePosixPath(path).name.casefold() in ('readme.md', 'readme.txt', 'license.md', 'license.txt', 'requirements.txt'):
        return None
    if extension not in FORMATS or not matches_path(path, source) or entry.get('type') != 'blob' or not re.fullmatch(SHA_PATTERN, entry.get('sha', '')):
        return None
    identity = source['id'] + '\0' + path
    identifier = 'ur-' + hashlib.sha256(identity.encode()).hexdigest()[:24]
    encoded = quote(path, safe='/')
    sample = next((item for item in source.get('sampleFiles', []) if item.get('path') == path), {})
    filename = PurePosixPath(path)
    title = filename.parent.name if filename.stem.casefold() == 'index' else filename.stem
    result = {'id': identifier, 'sourceId': source['id'], 'path': path, 'schoolName': source['school']['name'],
              'attribution': source['name'], 'title': sample.get('title') or title, 'url': 'https://github.com/' + source['repo'] + '/blob/' + commit + '/' + encoded,
              'sourceUrl': 'https://github.com/' + source['repo'] + '/blob/' + commit + '/' + encoded,
              'rawUrl': 'https://raw.githubusercontent.com/' + source['repo'] + '/' + commit + '/' + encoded,
              'commit': commit, 'gitBlobSha': entry['sha'], 'sha256': None, 'format': extension,
              'size': max(0, int(entry.get('size') or 0)), 'rights': dict(source.get('rights', {}), **sample.get('rights', {})),
              'state': 'indexed', 'indexedAt': now(), 'questionCount': 0, 'bankId': None,
              'publication': 'restricted', 'relatedResourceIds': []}
    result.update(classify(path, source))
    apply_file_metadata(result, sample)
    if previous and previous.get('gitBlobSha') == entry['sha']:
        for field in ('sha256', 'state', 'downloadedPath', 'textPath', 'downloadedAt', 'hasOriginal', 'extractedAt', 'extractionIssues', 'questionCount', 'bankId', 'extractorVersion'):
            if field in previous:
                result[field] = previous[field]
    return result


def extract_text(path, extension):
    if extension in ('txt', 'md', 'mdx'):
        raw = Path(path).read_bytes()
        for encoding in ('utf-8-sig', 'gb18030'):
            try:
                return raw.decode(encoding)[:800000], []
            except UnicodeError:
                pass
        return '', ['text-encoding-unknown']
    if extension == 'pdf':
        try:
            import pypdfium2 as pdfium
        except ImportError:
            pdfium = None
        if pdfium is not None:
            try:
                with pdfium.PdfDocument(str(path)) as document:
                    chunks = []
                    for index in range(min(len(document), 24)):
                        with closing(document[index]) as page:
                            with closing(page.get_textpage()) as textpage:
                                chunks.append(textpage.get_text_range()[:200000].replace('\x00', ''))
                    text = '\n\n'.join(chunks)[:800000]
                    issues = ['pdf-layout-needs-review']
                    if len(document) > 24:
                        issues.append('pdf-page-budget-reached')
                    if not text.strip():
                        issues.append('image-pdf-needs-ocr')
                    return text, issues
            except Exception:
                return '', ['pdf-extraction-failed']
        try:
            from pypdf import PdfReader
        except ImportError:
            return '', ['pdf-extractor-unavailable']
        try:
            reader = PdfReader(str(path))
            if reader.is_encrypted:
                return '', ['encrypted-pdf']
            text = '\n\n'.join((page.extract_text() or '') for page in reader.pages[:24])[:800000]
            issues = ['pdf-layout-needs-review']
            if len(reader.pages) > 24:
                issues.append('pdf-page-budget-reached')
            if not text.strip():
                issues.append('image-pdf-needs-ocr')
            return text, issues
        except Exception:
            return '', ['pdf-extraction-failed']
    return '', ['format-needs-ocr-or-conversion']


def extractor_version():
    try:
        from university_question_bank import EXTRACTOR_VERSION
        return int(EXTRACTOR_VERSION)
    except (ImportError, ValueError, TypeError):
        return 1


class UniversityRobot:
    def __init__(self, registry, output, state_dir, *, collector=None, max_sources=6, max_resources=5000,
                 max_downloads=8, max_extractions=24, download=False, reclassify_only=False, reextract=False,
                 max_file_bytes=12*1024*1024, source_ids=None):
        self.registry, self.output, self.folder = registry, Path(output), Path(state_dir)
        unknown_ids = set(source_ids or []) - {s['id'] for s in registry['sources']}
        if unknown_ids:
            raise CollectorError('unknown-source-id:' + ','.join(sorted(unknown_ids)))
        self.sources = [s for s in registry['sources'] if not source_ids or s['id'] in source_ids]
        self.collector = collector or Collector(self.sources, self.folder)
        self.max_sources, self.max_resources, self.max_downloads = max_sources, max_resources, max_downloads
        self.max_extractions = max_extractions
        self.reclassify_only, self.reextract = reclassify_only, reextract
        if download and (reclassify_only or reextract):
            raise CollectorError('offline-mode-cannot-download')
        self.download, self.max_file_bytes = download, max_file_bytes
        self.checkpoint = read_json(self.folder / 'checkpoint.json', {'sources': {}, 'failures': []})
        self.payload = read_json(self.output, {'version': VERSION, 'sources': [], 'resources': [], 'questionBanks': []})
        registered = {s['id'] for s in registry['sources']}
        self.resources = {r['id']: r for r in self.payload.get('resources', []) if r.get('sourceId') in registered}
        self.source_state = {s['id']: s for s in self.payload.get('sources', []) if s.get('id') in registered}
        self.banks = {b['id']: b for b in self.payload.get('questionBanks', []) if b.get('sourceId') in registered}
        self.stats = {'indexed': 0, 'downloaded': 0, 'extracted': 0, 'unchangedSources': 0, 'deduplicated': 0,
                      'processedSources': 0, 'partialSources': 0, 'budgetStopped': False,
                      'reclassified': 0, 'removedByRules': 0, 'extractionAttempts': 0,
                      'mode': 'offline' if reclassify_only or reextract else 'collect'}
        self.failures = [f for f in self.checkpoint.get('failures', []) if f.get('sourceId') in registered]

    def save(self):
        # Rights revocations apply immediately, even to schools outside this run's budget.
        registry_by_id = {source['id']: source for source in self.registry['sources']}
        for resource in self.resources.values():
            registered = registry_by_id[resource['sourceId']]
            sample = next((item for item in registered.get('sampleFiles', []) if item.get('path') == resource['path']), {})
            resource['rights'] = dict(registered.get('rights', {}), **sample.get('rights', {}))
            if resource['rights'].get('mode', 'metadata-only') == 'metadata-only' or resource['rights'].get('access') not in (None, 'public'):
                if resource.get('bankId'):
                    self.banks.pop(resource['bankId'], None)
                resource.update(questionCount=0, bankId=None)
        resources = link_suites(sorted(self.resources.values(), key=lambda r: (r['schoolId'], r['course'], r['path'])))
        schools = {}
        for source in self.registry['sources']:
            school = source['school']
            row = schools.setdefault(school['id'], dict(school, sourceIds=[], resourceCount=0))
            row['groups'] = school.get('groups', source.get('groups', [school.get('tier')] if school.get('tier') else []))
            row['sourceIds'].append(source['id'])
        for resource in resources:
            if resource['schoolId'] in schools:
                schools[resource['schoolId']]['resourceCount'] += 1
        for source in self.registry['sources']:
            state = self.source_state.setdefault(source['id'], self.source_summary(source))
            selected = [r for r in resources if r['sourceId'] == source['id']]
            state['counts'] = dict(Counter(r['state'] for r in selected))
            state['resourceCount'] = len(selected)
            state['questionCount'] = sum(r.get('questionCount', 0) for r in selected)
        self.stats.update(requests=self.collector.count, bytes=self.collector.total,
                          cacheHits=self.collector.cache_hits, retries=self.collector.retries,
                          elapsedSeconds=round(self.collector.clock() - self.collector.started, 3))
        self.payload = {'version': VERSION, 'generatedAt': now(), 'schools': list(schools.values()),
                        'sources': list(self.source_state.values()), 'resources': resources,
                        'questionBanks': list(self.banks.values()), 'runStats': dict(self.stats),
                        'failures': self.failures, 'classificationVersion': CLASSIFICATION_VERSION}
        atomic_json(self.output, self.payload)
        self.checkpoint['failures'] = self.failures
        atomic_json(self.folder / 'checkpoint.json', self.checkpoint)
        self.collector.save()

    @staticmethod
    def source_summary(source):
        return {'id': source['id'], 'schoolId': source['school']['id'], 'name': source['name'],
                'type': source['type'], 'repo': source.get('repo'), 'url': 'https://github.com/' + source['repo'] if source.get('repo') else source.get('url', ''),
                'rights': source.get('rights', {}), 'provenance': source.get('provenance', 'student-maintained'),
                'status': 'pending', 'counts': {}, 'checkedAt': None, 'commit': None}

    def failure(self, source_id, phase, error, resource_id=None):
        code = error.code if isinstance(error, CollectorError) else 'source-processing-failed'
        prior = next((f for f in self.failures if f.get('sourceId') == source_id and f.get('phase') == phase and f.get('resourceId') == resource_id), {})
        attempts = prior.get('attempts', 0) + 1
        self.clear_failure(source_id, phase, resource_id)
        delay = min(3600, 15 * 2**min(attempts - 1, 8))
        self.failures.append({'sourceId': source_id, 'phase': phase, 'resourceId': resource_id,
                              'code': code, 'checkedAt': now(), 'attempts': attempts,
                              'retryAfterSeconds': delay, 'retryAt': time.time() + delay})
        if 'budget' in code:
            self.stats['budgetStopped'] = True
        return code

    def clear_failure(self, source_id, phase, resource_id=None):
        self.failures[:] = [f for f in self.failures if (f.get('sourceId'), f.get('phase'), f.get('resourceId')) != (source_id, phase, resource_id)]

    def retry_due(self, source_id, phase, resource_id=None):
        return not any((f.get('sourceId'), f.get('phase'), f.get('resourceId')) == (source_id, phase, resource_id)
                       and f.get('retryAt', 0) > time.time() and 'budget' not in f.get('code', '') for f in self.failures)

    def index_source(self, source):
        if source.get('type') != 'github':
            summary = self.source_summary(source)
            for sample in source.get('sampleFiles', []):
                path = safe_relative(sample['path'])
                target = sample.get('downloadUrl') or sample.get('url')
                self.collector.policy.validate(target)
                identifier = 'ur-' + hashlib.sha256((source['id'] + '\0' + path).encode()).hexdigest()[:24]
                resource = {'id': identifier, 'sourceId': source['id'], 'path': path,
                            'schoolName': source['school']['name'], 'attribution': source['name'],
                            'title': sample.get('title', PurePosixPath(path).stem), 'url': target, 'sourceUrl': target,
                            'rawUrl': target, 'commit': None, 'gitBlobSha': None, 'sha256': None,
                            'format': sample.get('format') or PurePosixPath(path).suffix.lstrip('.'), 'size': 0,
                            'rights': dict(source.get('rights', {}), **sample.get('rights', {})),
                            'state': 'indexed', 'indexedAt': now(), 'questionCount': 0, 'bankId': None,
                            'publication': 'restricted', 'relatedResourceIds': [], 'evidenceUrl': sample.get('evidenceUrl', source['url'])}
                resource.update(classify(path + ' ' + resource['title'], source))
                apply_file_metadata(resource, sample)
                previous = self.resources.get(identifier)
                if previous and previous.get('rawUrl') == target:
                    for field in ('sha256', 'state', 'downloadedPath', 'textPath', 'downloadedAt', 'hasOriginal', 'extractedAt', 'extractionIssues', 'questionCount', 'bankId', 'extractorVersion'):
                        if field in previous:
                            resource[field] = previous[field]
                self.resources[identifier] = resource
                self.stats['indexed'] += 1
            summary.update(status='indexed' if source.get('sampleFiles') else 'registered', checkedAt=now(),
                           notice='registered-files-only; no-unbounded-html-crawl')
            self.source_state[source['id']] = summary
            return
        api = 'https://api.github.com/repos/' + source['repo']
        branch = source.get('branch')
        if not branch:
            branch = self.collector.json(api).get('default_branch')
        if not branch or '..' in branch:
            raise CollectorError('invalid-source-branch')
        commit_data = self.collector.json(api + '/commits/' + quote(branch, safe='/'))
        commit = commit_data.get('sha', '')
        tree_sha = commit_data.get('commit', {}).get('tree', {}).get('sha', '')
        if not re.fullmatch(SHA_PATTERN, commit) or not re.fullmatch(SHA_PATTERN, tree_sha):
            raise CollectorError('invalid-commit-sha')
        state = self.checkpoint['sources'].get(source['id'], {})
        config_hash = hashlib.sha256(json.dumps({'source': source, 'classificationVersion': CLASSIFICATION_VERSION, 'assetFilterVersion': 1}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        summary = self.source_summary(source)
        summary.update(commit=commit, checkedAt=now(), status='indexed')
        self.source_state[source['id']] = summary
        if state.get('commit') == commit and state.get('complete') and state.get('configHash') == config_hash:
            self.stats['unchangedSources'] += 1
            return
        tree = self.collector.json(api + '/git/trees/' + tree_sha + '?recursive=1', immutable=True)
        if not isinstance(tree.get('tree'), list):
            raise CollectorError('invalid-git-tree')
        if tree.get('truncated'):
            # Keep an honest partial result; do not claim a recursive tree covered all files.
            summary['status'] = 'partial'
            summary['notice'] = 'github-tree-truncated'
        entries = [entry for entry in tree['tree'] if entry.get('type') == 'blob']
        cursor = state.get('cursor', 0) if state.get('commit') == commit and state.get('configHash') == config_hash else 0
        seen_paths = {entry.get('path') for entry in entries}
        if not tree.get('truncated'):
            removed = [key for key, resource in self.resources.items() if resource['sourceId'] == source['id'] and resource['path'] not in seen_paths]
            for key in removed:
                old = self.resources.pop(key)
                if old.get('bankId'):
                    self.banks.pop(old['bankId'], None)
        previous_by_path = {r['path']: r for r in self.resources.values() if r['sourceId'] == source['id']}
        added = 0
        while cursor < len(entries):
            entry = entries[cursor]
            cursor += 1
            resource = resource_from_entry(entry, source, commit, previous_by_path.get(entry['path']))
            if resource:
                previous = previous_by_path.get(entry['path'], {})
                if previous.get('gitBlobSha') != resource['gitBlobSha'] and previous.get('bankId'):
                    self.banks.pop(previous['bankId'], None)
                self.resources[resource['id']] = resource
                added += 1
                self.stats['indexed'] += 1
            elif entry['path'] in previous_by_path:
                old = previous_by_path[entry['path']]
                self.resources.pop(old['id'], None)
                if old.get('bankId'):
                    self.banks.pop(old['bankId'], None)
            if added >= self.max_resources:
                break
        complete = cursor >= len(entries) and not tree.get('truncated')
        self.checkpoint['sources'][source['id']] = {'commit': commit, 'tree': tree_sha, 'cursor': cursor, 'complete': complete, 'configHash': config_hash}
        if not complete:
            summary['status'] = 'partial'
            self.stats['partialSources'] += 1

    def download_resource(self, resource, source):
        rights = resource.get('rights', source.get('rights', {}))
        if rights.get('mode', 'metadata-only') == 'metadata-only' or rights.get('access') not in (None, 'public'):
            return
        if resource['size'] > self.max_file_bytes:
            resource['extractionIssues'] = ['file-budget-exceeded']
            return
        duplicate = next((other for other in self.resources.values() if resource.get('gitBlobSha') and other.get('gitBlobSha') == resource['gitBlobSha']
                          and other.get('sha256') and other.get('downloadedPath')), None)
        raw, final = None, resource['rawUrl']
        if duplicate:
            duplicate_path = (self.folder / safe_relative(duplicate['downloadedPath'])).resolve()
            if duplicate_path.is_relative_to(self.folder.resolve()) and duplicate_path.is_file():
                duplicate_raw = duplicate_path.read_bytes()
                if hashlib.sha256(duplicate_raw).hexdigest() == duplicate['sha256']:
                    raw = duplicate_raw
        if raw is None:
            raw, final = self.collector.get(resource['rawUrl'], self.max_file_bytes, immutable=True)
        # Verify the downloaded bytes against the indexed Git blob object, not just its URL.
        git_hash = hashlib.sha1(('blob ' + str(len(raw)) + '\0').encode() + raw).hexdigest()
        if resource.get('gitBlobSha') and git_hash != resource['gitBlobSha']:
            raise CollectorError('git-blob-hash-mismatch')
        digest = hashlib.sha256(raw).hexdigest()
        originals = self.folder / 'originals'
        originals.mkdir(parents=True, exist_ok=True)
        original = originals / (digest + '.' + resource['format'])
        if original.exists():
            if hashlib.sha256(original.read_bytes()).hexdigest() != digest:
                raise CollectorError('stored-hash-mismatch')
            self.stats['deduplicated'] += 1
        else:
            original.write_bytes(raw)
        resource.update(sha256=digest, downloadedPath=str(original.relative_to(self.folder)).replace('\\', '/'),
                        downloadedAt=now(), hasOriginal=True, state='downloaded', fetchedUrl=final)
        self.stats['downloaded'] += 1
        if self.stats['extractionAttempts'] < self.max_extractions:
            self.extract_resource(resource, source, original)

    def extract_resource(self, resource, source, original=None):
        if self.stats['extractionAttempts'] >= self.max_extractions:
            raise CollectorError('extraction-budget-exhausted')
        self.stats['extractionAttempts'] += 1
        if original is None:
            original = (self.folder / safe_relative(resource['downloadedPath'])).resolve()
            if not original.is_relative_to(self.folder.resolve()) or not original.is_file():
                raise CollectorError('stored-original-missing')
            if hashlib.sha256(original.read_bytes()).hexdigest() != resource['sha256']:
                raise CollectorError('stored-hash-mismatch')
        digest = resource['sha256']
        text, issues = extract_text(original, resource['format'])
        resource['extractionIssues'] = issues
        if text.strip():
            text_dir = self.folder / 'texts'
            text_dir.mkdir(exist_ok=True)
            text_file = text_dir / (digest + '.txt')
            text_file.write_text(text, encoding='utf-8')
            resource.update(textPath=str(text_file.relative_to(self.folder)).replace('\\', '/'), extractedAt=now(), state='extracted')
            course_before = resource['course']
            resource.update(classify(resource['path'] + (' ' + resource['title'] if source['type'] == 'official-page' else ''), source, text))
            sample_course = next((sample.get('course') for sample in source.get('sampleFiles', []) if sample.get('path') == resource['path']), None)
            if sample_course or (source['type'] == 'official-page' and course_before != 'unknown'):
                course_before = sample_course or course_before
                resource['course'] = course_before
                resource['confidence']['course'] = 0.95
                resource['classificationEvidence'].append({'field': 'course', 'value': course_before,
                    'matched': course_before, 'origin': 'registered-file-metadata', 'confidence': 0.95})
            sample = next((sample for sample in source.get('sampleFiles', []) if sample.get('path') == resource['path']), {})
            apply_file_metadata(resource, sample)
            self.stats['extracted'] += 1
        if issues or resource.get('classificationIssues'):
            resource['state'] = 'needs-review'
        # Optional pure conversion hook. It never imports a user paper or accesses a database.
        try:
            from university_question_bank import extract_bank
        except ImportError:
            resource['extractorVersion'] = 0
            return
        bank = extract_bank(resource, original)
        resource['extractorVersion'] = 0 if 'pdf-extractor-unavailable' in issues else extractor_version()
        # A newer parser can reject a previously accepted answer fragment. Never retain it.
        if resource.get('bankId') and (not bank or bank['id'] != resource['bankId']):
            self.banks.pop(resource['bankId'], None)
        resource.update(bankId=None, questionCount=0)
        if bank:
            bank['sourceId'] = source['id']
            bank['schoolName'] = source['school']['name']
            bank['attribution'] = source['name']
            self.banks[bank['id']] = bank
            resource.update(bankId=bank['id'], questionCount=len(bank.get('questions', [])), state='needs-review')

    def reclassify_cached(self):
        source_map = {source['id']: source for source in self.sources}
        for resource in list(self.resources.values()):
            source = source_map.get(resource['sourceId'])
            if source is None:
                continue
            if self.collector.clock() - self.collector.started >= self.collector.max_seconds:
                self.stats['budgetStopped'] = True
                break
            sample = next((item for item in source.get('sampleFiles', []) if item.get('path') == resource['path']), {})
            excluded = auxiliary_asset(resource['path']) or (source['type'] == 'github' and not matches_path(resource['path'], source))
            if source['type'] == 'official-page' and not sample:
                excluded = True
            if excluded:
                self.resources.pop(resource['id'], None)
                if resource.get('bankId'):
                    self.banks.pop(resource['bankId'], None)
                self.stats['removedByRules'] += 1
                continue
            text = ''
            if resource.get('textPath'):
                cached_text = (self.folder / safe_relative(resource['textPath'])).resolve()
                if cached_text.is_relative_to(self.folder.resolve()) and cached_text.is_file() and cached_text.stat().st_size <= 4*1024*1024:
                    text = cached_text.read_text(encoding='utf-8', errors='replace')[:800000]
            resource.update(classify(resource['path'] + (' ' + resource['title'] if source['type'] == 'official-page' else ''), source, text))
            apply_file_metadata(resource, sample)
            resource.update(schoolName=source['school']['name'], attribution=source['name'], reclassifiedAt=now(),
                            rights=dict(source.get('rights', {}), **sample.get('rights', {})))
            bank = self.banks.get(resource.get('bankId'))
            if bank:
                for field in ('course', 'college', 'year', 'term', 'schoolId', 'schoolName', 'rights', 'attribution'):
                    bank[field] = resource.get(field)
            self.stats['reclassified'] += 1

    def run_offline(self):
        """Only local catalogue/original files. This branch never calls Collector.get/json."""
        if self.reclassify_only:
            self.reclassify_cached()
            self.save()
        if self.reextract and not self.stats['budgetStopped']:
            source_map = {source['id']: source for source in self.sources}
            candidates = []
            for resource in self.resources.values():
                source = source_map.get(resource['sourceId'])
                if not source or not resource.get('sha256') or not resource.get('downloadedPath'):
                    continue
                sample = next((item for item in source.get('sampleFiles', []) if item.get('path') == resource['path']), {})
                rights = dict(source.get('rights', {}), **sample.get('rights', {}))
                if rights.get('mode', 'metadata-only') == 'metadata-only' or rights.get('access') not in (None, 'public'):
                    continue
                if auxiliary_asset(resource['path']) or (source['type'] == 'github' and not matches_path(resource['path'], source)):
                    continue
                resource['rights'] = rights
                candidates.append(resource)
            candidates.sort(key=lambda resource: resource['id'])
            cursor = int(self.checkpoint.get('extractionCursor', 0)) % max(1, len(candidates))
            ordered = candidates[cursor:] + candidates[:cursor]
            for resource in ordered[:self.max_extractions]:
                if self.collector.clock() - self.collector.started >= self.collector.max_seconds:
                    self.stats['budgetStopped'] = True
                    break
                try:
                    self.extract_resource(resource, source_map[resource['sourceId']])
                    self.clear_failure(resource['sourceId'], 'extract', resource['id'])
                except Exception as error:
                    self.failure(resource['sourceId'], 'extract', error, resource['id'])
                self.checkpoint['extractionCursor'] = (candidates.index(resource) + 1) % max(1, len(candidates))
                self.save()
        self.save()
        return self.payload

    def run(self):
        self.folder.mkdir(parents=True, exist_ok=True)
        if self.reclassify_only or self.reextract:
            return self.run_offline()
        # Rotating source cursor prevents a small per-run budget from starving later schools.
        offset = int(self.checkpoint.get('sourceCursor', 0)) % max(1, len(self.sources))
        ordered = self.sources[offset:] + self.sources[:offset]
        for source in ordered[:self.max_sources]:
            if not self.retry_due(source['id'], 'index'):
                continue
            try:
                self.index_source(source)
                self.clear_failure(source['id'], 'index')
                self.stats['processedSources'] += 1
            except Exception as error:
                code = self.failure(source['id'], 'index', error)
                summary = self.source_state.setdefault(source['id'], self.source_summary(source))
                summary.update(status='deferred' if 'budget' in code else 'failed', checkedAt=now(), failure=code)
                self.save()
                if self.stats['budgetStopped']:
                    break
                self.checkpoint['sourceCursor'] = (self.sources.index(source) + 1) % max(1, len(self.sources))
            else:
                self.checkpoint['sourceCursor'] = (self.sources.index(source) + 1) % max(1, len(self.sources))
                self.save()
        if self.download and not self.stats['budgetStopped']:
            source_map = {source['id']: source for source in self.sources}
            sample_paths = {(source['id'], sample['path']) for source in self.sources for sample in source.get('sampleFiles', [])}
            candidates = [r for r in self.resources.values() if r['sourceId'] in source_map
                          and (not r.get('sha256') or r.get('extractorVersion', 0) < extractor_version())
                          and r.get('rights', {}).get('mode', 'metadata-only') != 'metadata-only'
                          and self.retry_due(r['sourceId'], 'download', r['id'])
                          and 'file-budget-exceeded' not in r.get('extractionIssues', [])]
            candidates.sort(key=lambda r: ((r['sourceId'], r['path']) not in sample_paths,
                                          r['kind'] not in ('exam', 'exercise', 'answer'), r['format'] not in EXTRACT_FORMATS,
                                          r['size'], r['id']))
            # Round-robin schools/sources: one busy repository cannot consume the whole run.
            queues = {}
            for resource in candidates:
                queues.setdefault(resource['sourceId'], []).append(resource)
            fair = []
            while any(queues.values()):
                for source in ordered:
                    queue = queues.get(source['id'], [])
                    if queue:
                        fair.append(queue.pop(0))
            candidates = fair
            attempted = 0
            for resource in candidates:
                if resource.get('sha256') and self.stats['extractionAttempts'] >= self.max_extractions:
                    continue
                if not resource.get('sha256'):
                    if attempted >= self.max_downloads:
                        continue
                    attempted += 1
                try:
                    if resource.get('sha256'):
                        self.extract_resource(resource, source_map[resource['sourceId']])
                    else:
                        self.download_resource(resource, source_map[resource['sourceId']])
                    self.clear_failure(resource['sourceId'], 'download', resource['id'])
                except Exception as error:
                    self.failure(resource['sourceId'], 'download', error, resource['id'])
                self.save()
                if self.stats['budgetStopped']:
                    break
        self.save()
        return self.payload


def get_university_sources(folder=None):
    base = Path(folder or os.environ.get('CAMPUS_DATA_DIR', Path(__file__).resolve().parent / '.data'))
    return read_json(base / 'university-sources.json', {'version': VERSION, 'schools': [], 'sources': [],
                                                     'resources': [], 'questionBanks': [], 'failures': [], 'runStats': {}})


def main(argv=None):
    base = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registry', type=Path, default=base / 'university-sources.json')
    parser.add_argument('--output', type=Path, default=base / '.data/university-sources.json')
    parser.add_argument('--state', type=Path, default=base / '.data/university-crawler')
    parser.add_argument('--max-sources', type=int, default=6)
    parser.add_argument('--max-requests', type=int, default=30)
    parser.add_argument('--max-resources', type=int, default=5000)
    parser.add_argument('--max-downloads', type=int, default=8)
    parser.add_argument('--max-extractions', type=int, default=24)
    parser.add_argument('--reclassify-only', action='store_true', help='Offline: reclassify existing catalogue only; may combine with --reextract.')
    parser.add_argument('--reextract', action='store_true', help='Offline: re-extract existing originals with the current parser; never download.')
    parser.add_argument('--max-bytes', type=int, default=32*1024*1024)
    parser.add_argument('--max-seconds', type=int, default=180)
    parser.add_argument('--delay', type=float, default=0.6)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--source', action='append', dest='source_ids')
    parser.add_argument('--resume', action='store_true', help='Checkpoints are always resumed; accepted for explicit scripts.')
    args = parser.parse_args(argv)
    if any(getattr(args, field) < 1 for field in ('max_sources', 'max_requests', 'max_resources', 'max_bytes', 'max_seconds')) or args.max_downloads < 0 or args.max_extractions < 0 or args.delay < 0:
        parser.error('Budgets must be positive; downloads and delay may be zero.')
    if args.download and (args.reclassify_only or args.reextract):
        parser.error('--download cannot be combined with offline --reclassify-only or --reextract.')
    registry = load_registry(args.registry)
    unknown_ids = set(args.source_ids or []) - {source['id'] for source in registry['sources']}
    if unknown_ids:
        parser.error('Unknown registered source ID: ' + ', '.join(sorted(unknown_ids)))
    with run_lock(args.state):
        collector = Collector(registry['sources'], args.state, max_requests=args.max_requests, max_bytes=args.max_bytes,
                              max_seconds=args.max_seconds, delay=args.delay)
        result = UniversityRobot(registry, args.output, args.state, collector=collector,
                                 max_sources=args.max_sources, max_resources=args.max_resources,
                                 max_downloads=args.max_downloads, max_extractions=args.max_extractions,
                                 download=args.download, reclassify_only=args.reclassify_only,
                                 reextract=args.reextract, source_ids=args.source_ids).run()
    print(json.dumps({'output': str(args.output), 'schools': len(result['schools']), 'sources': len(result['sources']),
                      'resources': len(result['resources']), 'questionBanks': len(result['questionBanks']),
                      'runStats': result['runStats'], 'failures': result['failures']}, ensure_ascii=False))
    return 2 if result['failures'] and not result['resources'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
