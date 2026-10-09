"""User-requested public metadata preview; no private library or file upload endpoint."""
import ipaddress
import re
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit, urlunsplit

from django.db.models import Q

from .core import Problem, public_entries, text, throttle, url
from .discovery import fetch_public


def normalize_source(value):
    value = text(value, 1000, True)
    candidate = re.sub(r'^doi:\s*', '', value, flags=re.I)
    if re.fullmatch(r'10\.\d{4,9}/\S+', candidate, flags=re.I):
        doi = candidate.lower()
        return 'https://doi.org/' + doi, doi
    target = url(value, True)
    parsed = urlsplit(target)
    if parsed.hostname.lower() in ('doi.org', 'dx.doi.org'):
        doi = unquote(parsed.path.lstrip('/')).lower()
        if not re.fullmatch(r'10\.\d{4,9}/\S+', doi):
            raise Problem('DOI 格式不正确。')
        return 'https://doi.org/' + doi, doi
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or '/', parsed.query, '')), ''


def public_address(target):
    """Cheap rejection before matching; fetch_public additionally pins DNS per redirect."""
    parsed = urlsplit(target)
    host = parsed.hostname.lower()
    if parsed.port not in (None, 80, 443) or host == 'localhost' or host.endswith(('.localhost', '.local', '.internal')):
        raise Problem('预览仅支持公开网站的标准端口。私人链接可以只存本机。')
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return
    if not address.is_global:
        raise Problem('不能预览本机、内网或保留地址。私人链接可以只存本机。')


class MetadataParser(HTMLParser):
    """Keep title/author tags only; never retain body, scripts, cookies or full text."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.metadata, self.title_parts, self.in_title = {}, [], False

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == 'title':
            self.in_title = True
        elif tag == 'meta':
            key = (attributes.get('name') or attributes.get('property') or '').lower()
            if key in ('og:title', 'citation_title', 'dc.title', 'author', 'citation_author', 'dc.creator'):
                self.metadata.setdefault(key, []).append((attributes.get('content') or '')[:300])

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False

    def handle_data(self, data):
        if self.in_title and len(self.title_parts) < 30:
            self.title_parts.append(data[:160])

    def result(self):
        def first(*keys):
            return next((self.metadata[k][0] for k in keys if self.metadata.get(k)), '')
        title = first('citation_title', 'og:title', 'dc.title') or ''.join(self.title_parts)
        authors = self.metadata.get('citation_author') or self.metadata.get('author') or self.metadata.get('dc.creator') or []
        return {'title': ' '.join(title.split())[:160], 'credit': '、'.join(dict.fromkeys(authors))[:300]}


def matching_public(source_url, doi):
    # Filter snapshot fields, never canonical_key/search_text/draft; an author's pending
    # revision must not make a private URL or title discoverable even to that author here.
    forms = {source_url}
    if urlsplit(source_url).path == '/' and not urlsplit(source_url).query:
        forms.add(source_url.rstrip('/'))  # Only the empty origin path is equivalent.
    query = Q(published__links__source__in=forms) | Q(published__links__paper__in=forms) | Q(published__learning__sourceUrl__in=forms)
    if doi:
        query |= Q(published__doi__iexact=doi) | Q(published__doi__iexact='https://doi.org/' + doi)
    matches = []
    metadata = {}
    for entry in public_entries().filter(query).order_by('-updated')[:8]:
        published = entry.published if isinstance(entry.published, dict) else {}
        learning = published.get('learning') if isinstance(published.get('learning'), dict) else {}
        circle = published.get('circle') if isinstance(published.get('circle'), dict) else {}
        if any(value.get('visibility', 'public') != 'public' for value in (published, learning, circle)):
            continue
        matches.append({'id': str(entry.pk), 'title': published.get('title', ''),
                        'version': learning.get('version', ''), 'courseId': learning.get('courseId', ''),
                        'href': 'project.html?id=' + str(entry.pk)})
        if not metadata:
            metadata = {'title': published.get('title', ''), 'credit': published.get('credit', '')}
    return matches, metadata


def preview(request, body):
    """POST learning/preview. Only this explicit action may send an address outside."""
    # Reject accidental private-content payloads rather than ignoring them silently.
    if set(body) - {'source', 'fetchMetadata'} or ('fetchMetadata' in body and not isinstance(body['fetchMetadata'], bool)):
        raise Problem('预览只接收公开地址和是否读取网页标题的选项。')
    source_url, doi = normalize_source(body.get('source', ''))
    public_address(source_url)
    throttle('learning-preview', request.META.get('REMOTE_ADDR', ''), 30)
    matches, metadata = matching_public(source_url, doi)
    result = {'sourceUrl': source_url, 'doi': doi, 'sourceName': urlsplit(source_url).hostname,
              'title': metadata.get('title', ''), 'credit': metadata.get('credit', ''), 'matches': matches,
              'metadataStatus': 'published' if matches else 'unverified',
              'notice': '已找到相同来源的公开记录，请比较适用课程与版本。' if matches else '尚无相同来源的公开记录，可手动填写标题。'}
    if not body.get('fetchMetadata') or matches:
        return result
    # Metadata reads are bounded and public; no crawling, school sessions, file extraction,
    # persistent cache, AI call or automatic sharing follows this action.
    if urlsplit(source_url).path.lower().endswith(('.pdf', '.zip', '.doc', '.docx', '.ppt', '.pptx')):
        result['notice'] = '这是文件链接，未读取文件内容；请手动填写标题和来源。'
        return result
    try:
        raw, headers, final_url, status = fetch_public(source_url, limit=256 * 1024, headers={'Accept': 'text/html,application/xhtml+xml'})
        content_type = next((v for k, v in headers.items() if k.lower() == 'content-type'), '').lower()
        if status != 200 or not any(t in content_type for t in ('text/html', 'application/xhtml+xml')):
            raise Problem('该地址未返回网页，未提取内容；请手动填写标题。')
        charset = re.search(r'charset\s*=\s*["\']?([\w-]+)', content_type)
        encoding = charset.group(1) if charset else 'utf-8'
        parser = MetadataParser()
        try:
            parser.feed(raw.decode(encoding, errors='replace'))
        except LookupError:
            parser.feed(raw.decode('utf-8', errors='replace'))
        result.update(parser.result(), metadataStatus='source-unverified')
        result['notice'] = '标题与作者由来源网页提供，尚未核实；全文权限、课程和版本请自行确认。'
        # Keep the pasted source/DOI as the stable identity; redirects are not versions.
        result['sourceName'] = urlsplit(final_url).hostname
    except (Problem, OSError, ValueError) as exc:
        result['notice'] = str(exc) if isinstance(exc, Problem) else '来源暂时无法读取，请手动填写标题；私人保存仍可使用。'
        result['metadataStatus'] = 'unavailable'
    return result
