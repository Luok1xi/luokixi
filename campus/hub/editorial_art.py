"""Unique source-labelled editorial covers. These are diagrams, never event photos."""
import hashlib
import html
import json
import re
from django.http import HttpResponse
from .core import Problem
from .models import ExternalCache

VERSION = 2


def title_lines(title):
    """Keep Latin words together and account for narrower Latin glyphs."""
    lines, current, width = [], '', 0
    for token in re.findall(r'[A-Za-z0-9][A-Za-z0-9./:_+\-]*|.', title):
        size = sum(.56 if ord(c)<128 else 1 for c in token)
        if current and width+size>16:
            lines.append(current.rstrip()); current, width = '', 0
        for char in token:
            weight = .56 if ord(char)<128 else 1
            if width+weight>16:
                lines.append(current.rstrip()); current, width = '', 0
            current += char; width += weight
    if current: lines.append(current.rstrip())
    return lines[:3] if len(lines)<=3 else lines[:2]+[lines[2].rstrip()+'…']


def cover(data, slot):
    title = str(data.get('title') or '校园资料')[:160]
    credit = str(data.get('credit') or data.get('sourceNote') or '校园共建')[:55]
    stamp = str((data.get('provenance') or {}).get('sourcePublishedAt') or (data.get('provenance') or {}).get('uploadedAt') or '')[:10]
    seed = json.dumps([VERSION,title,credit,stamp,slot], ensure_ascii=False)
    digest = hashlib.sha256(seed.encode()).hexdigest()
    palette = {'hero-open-research':('#e9e5f7','#727baf','#4b3d75'), 'mat-cet':('#f7eee2','#d99a65','#77462b'),
               'project-software':('#e0ede9','#619a93','#265d5a'), 'mat-calc':('#e3eaf5','#759ace','#314d78')}
    bg,accent,ink = palette.get(slot,('#f0e8e4','#aa8f8b','#68504b'))
    # All dynamic text is escaped; SVG has no scripts, foreignObject or remote resources.
    e = lambda value: html.escape(str(value),quote=True)
    dated = re.search(r'\s*[·|｜]\s*(\d{4}-\d{2}-\d{2})$', title)
    if dated and not stamp: stamp = dated[1]
    lines = title_lines(title[:dated.start()] if dated else title)
    headings = ''.join(f'<tspan x="72" y="{196+i*60}">{e(line)}</tspan>' for i,line in enumerate(lines))
    offset = int(digest[:2],16)%45
    rings = ''.join(f'<ellipse cx="{907+offset}" cy="297" rx="{80+i*39}" ry="{176-i*17}" transform="rotate({-37+i*13} {907+offset} 297)"/>' for i in range(6))
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<defs><linearGradient id="paper" x2="1" y2="1"><stop stop-color="{bg}"/><stop offset="1" stop-color="#fbfaf8"/></linearGradient><radialGradient id="light"><stop stop-color="{accent}" stop-opacity=".28"/><stop offset="1" stop-color="{accent}" stop-opacity="0"/></radialGradient></defs>
<rect width="1280" height="720" fill="url(#paper)"/><circle cx="930" cy="300" r="350" fill="url(#light)"/>
<g fill="none" stroke="{accent}" stroke-width="2" opacity=".65">{rings}</g><circle cx="{925+offset}" cy="140" r="18" fill="{accent}"/>
<g font-family="Microsoft YaHei, PingFang SC, sans-serif" fill="{ink}"><text x="72" y="91" font-size="20" letter-spacing="5">校园共建 · 中文阅读</text><text font-size="44" font-weight="700">{headings}</text>
<rect x="72" y="539" width="1136" height="1" fill="{accent}" opacity=".35"/><text x="72" y="588" font-size="22">{e(credit)}</text><text x="72" y="635" font-size="17" opacity=".7">{e(stamp)} · 文章主题封面 / 非事件实拍</text><text x="1138" y="632" font-size="17" opacity=".65">{digest[:4].upper()}</text></g></svg>'''
    ExternalCache.objects.get_or_create(key='article-art:'+digest, defaults={'data':{'svg':svg,'version':VERSION,'title':title}})
    return {'url':'/api/hub/illustration/'+digest, 'kind':'editorial', 'alt':title+' · 文章主题封面', 'slot':slot,
            'credit':'本站自动排版 · 根据本文标题和来源生成，非事件实拍', 'method':f'article-editorial-v{VERSION}', 'sourceUrl':(data.get('links') or {}).get('source','')}


def get(identifier):
    if not re.fullmatch('[a-f0-9]{64}',identifier): raise Problem('配图编号无效。',404)
    row=ExternalCache.objects.filter(pk='article-art:'+identifier).first()
    if not row: raise Problem('配图不存在。',404)
    response=HttpResponse(row.data['svg'],content_type='image/svg+xml; charset=utf-8')
    response['Cache-Control']='public, max-age=31536000, immutable'
    response['Content-Security-Policy']="default-src 'none'; style-src 'unsafe-inline'; sandbox"
    response['X-Content-Type-Options']='nosniff'
    return response
