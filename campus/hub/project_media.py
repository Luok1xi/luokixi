"""Find verifiable project pictures, keep attribution, and retain good data on failure."""
import base64
import io
import json
import re
import warnings
from html import unescape
from html.parser import HTMLParser
from urllib.parse import quote, urljoin, urlsplit, urlunsplit
from django.utils import timezone
from PIL import Image, UnidentifiedImageError
from . import github_api, github_guides
from .core import Problem
from .models import ExternalCache

RESOLVER_VERSION = 2
BAD = re.compile(r'shields\.io|badge|badgen|travis|codecov|actions/workflows|visitor|sponsor|donat|logo|avatar|icon|star-history|buymeacoffee|paypal|waitlist|contrib\.rocks|qrcodes?', re.I)
GOOD = re.compile(r'screenshot|screen-shot|preview|demo|showcase|robot|hardware|overview|example|interface|features|animation|截图|演示|效果', re.I)


class Images(HTMLParser):
    def __init__(self):
        super().__init__()
        self.items = []
    def handle_starttag(self, tag, attrs):
        data = dict(attrs)
        if tag == 'img':
            self.items.append((data.get('src') or data.get('data-src',''), data.get('alt','')))


def image_candidates(markdown, repository, branch='HEAD', readme_path='README.md'):
    markdown = re.sub(r'```[\s\S]*?```|~~~[\s\S]*?~~~', '', markdown)
    # README sponsorship banners can be larger than the actual product pictures.
    lines, hidden_level = [], None
    for line in markdown.splitlines():
        heading = re.match(r'^\s{0,3}(#{1,6})\s+(.+)',line)
        if heading:
            level = len(heading[1])
            if hidden_level is not None and level <= hidden_level:
                hidden_level = None
            if re.search(r'sponsor|donat|support us|赞助|捐赠|支持作者|贡献者',heading[2],re.I):
                hidden_level = level
        if hidden_level is None:
            lines.append(line)
    markdown = '\n'.join(lines)
    parser = Images()
    parser.feed(markdown)
    found = [(m[2],m[1]) for m in re.finditer(r'!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+["\'][^"\']*["\'])?\s*\)', markdown)] + parser.items
    references = {m[1].strip().lower():m[2] for m in re.finditer(r'^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?', markdown, re.M)}
    for m in re.finditer(r'!\[([^\]]*)\]\[([^\]]*)\]', markdown):
        found.append((references.get((m[2] or m[1]).lower(),''),m[1]))
    base = f'https://raw.githubusercontent.com/{repository}/{quote(branch,safe="")}/{quote(readme_path,safe="/")}'
    results = {}
    for src, alt in found:
        src = unescape(src).strip()
        if not src or BAD.search(src+' '+alt):
            continue
        if src.startswith('//'):
            src = 'https:'+src
        elif not urlsplit(src).scheme:
            src = urljoin(f'https://raw.githubusercontent.com/{repository}/{quote(branch,safe="")}/',src.lstrip('/')) if src.startswith('/') else urljoin(base,src)
        src = re.sub(r'^https://github\.com/([^/]+/[^/]+)/blob/', r'https://raw.githubusercontent.com/\1/', src)
        p = urlsplit(src)
        if p.scheme != 'https' or not p.hostname or p.username or p.password or p.port not in (None,443):
            continue
        if p.path.lower().endswith(('.svg','.pdf','.html','.js')):
            continue
        src = urlunsplit((p.scheme,p.netloc,p.path,p.query,''))
        results.setdefault(src, {'url':src,'alt':alt[:200], 'score':10 if GOOD.search(src+' '+alt) else 0})
    return sorted(results.values(),key=lambda x:x['score'],reverse=True)[:6]


def probe(target):
    from .maintenance import get_page
    raw, final = get_page(target, 4*1024*1024)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as im:
                width, height = im.size
                if im.format not in ('PNG','JPEG','WEBP','GIF') or width<320 or height<160 or width*height>20_000_000 or not .6<=width/height<=3.6:
                    raise Problem('图片尺寸或格式不适合作为项目封面。')
                fmt = im.format
                im.verify()
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise Problem('链接没有返回可验证的图片，已跳过。') from exc
    return {'width':width,'height':height,'format':fmt,'bytes':len(raw),'resolvedUrl':final}


def collect(limit=24):
    from .maintenance import public_data, save_cache
    previous = ExternalCache.objects.filter(pk='maint:project-media').first()
    out = dict(previous.data.get('items',{}) if previous else {})
    targets = {}
    try:
        community = json.loads((public_data()/'community.json').read_text('utf-8'))
        for p in community.get('projects',[]):
            if (p.get('repo') or {}).get('fullName'):
                targets[github_guides.repository(p['repo']['fullName'])] = None
    except (OSError, ValueError):
        pass
    for cache in ExternalCache.objects.filter(key__startswith='github:').order_by('-checked'):
        if cache.success and (cache.data.get('discovery') or cache.data.get('selection')):
            targets[cache.data['repository']] = cache.data
    errors, checked, cached, found = [], 0, 0, 0
    for repo, data in list(targets.items())[:limit]:
        now = timezone.now().isoformat()
        old = out.get(repo,{})
        try:
            if old.get('resolverVersion') == RESOLVER_VERSION and old.get('checkedAt') and old.get('status') in ('ok','missing'):
                from django.utils.dateparse import parse_datetime
                age = timezone.now()-parse_datetime(old['checkedAt'])
                if age.total_seconds()<72*3600 and (not data or old.get('readmeSha')==data.get('readmeSha')):
                    cached += 1
                    continue
            checked += 1
            if data and data.get('readme'):
                text, readme, branch, path, sha = data['readme'],data['readmeUrl'],data.get('defaultBranch','HEAD'),data.get('readmePath','README.md'),data.get('readmeSha','')
            else:
                info = github_api.request(f'/repos/{repo}/readme')
                text = base64.b64decode(info.get('content','')).decode('utf-8',errors='replace')[:80000]
                readme, branch, path, sha = info.get('html_url',f'https://github.com/{repo}#readme'),'HEAD',info.get('path','README.md'),info.get('sha','')
            candidates = image_candidates(text,repo,branch,path)
            selected, failures = None, []
            for candidate in candidates[:3]:
                try:
                    metadata = probe(candidate['url'])
                    selected = {**candidate,**metadata}
                    break
                except Exception as exc:
                    failures.append(str(exc)[:120])
            if candidates and not selected and failures:
                raise Problem('候选图片未通过检查：'+'；'.join(failures))
            out[repo] = {'image':selected['url'] if selected else '', 'alt':selected['alt'] if selected else '',
                         'readme':readme,'readmeSha':sha,'sourceUrl':f'https://github.com/{repo}',
                         'credit':f'{repo} · 项目 README 原图',
                         'usage':'引用项目原图链接；图像权利归原作者，代码许可证不自动视为图片授权。',
                         'checkedAt':now,'lastSuccess':now,'stale':False,'error':'',
                         'resolverVersion':RESOLVER_VERSION,
                         'status':'ok' if selected else 'missing',
                         'dimensions':{k:selected[k] for k in ('width','height','format','bytes')} if selected else None}
            found += bool(selected)
        except Exception as exc:
            errors.append(f'{repo}：{exc}')
            out[repo] = {**old,'image':old.get('image',''),'checkedAt':now,'stale':True,'status':'error','error':str(exc)[:200]}
    save_cache('maint:project-media', {'items':out}, '；'.join(errors)[:300])
    return {'projects':len(targets),'checked':checked,'cached':cached,'withImage':sum(bool(out.get(r,{}).get('image')) for r in targets),
            'found':found,'errors':errors,'status':'partial' if errors else 'ok'}
