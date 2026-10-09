"""Choose an article image without inventing focal points or cropping source pixels."""
import io
import math
import re
import warnings
from urllib.parse import urljoin, urlsplit

from PIL import Image, UnidentifiedImageError

from .core import Problem

VERSION = 1
MAX_IMAGE_BYTES = 4 * 1024 * 1024
DECORATION = re.compile(r'(?:^|[/_.\-])(logo|icon|qrcode|spacer|loading|badge)(?:[/_.\-]|$)', re.I)


def candidates(content, origin):
    """Keep document order and original URLs; inspect only the article body."""
    found = {}
    for image in content.css('img'):
        attrs = image.attrib
        src = (attrs.get('data-original') or attrs.get('data-src') or attrs.get('src') or '').strip()
        if not src or src.startswith('data:'):
            continue
        url = urljoin(origin, src)
        parsed = urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            continue
        if DECORATION.search(parsed.path) or parsed.path.lower().endswith('.svg'):
            continue
        try:
            width, height = float(attrs.get('width', 0)), float(attrs.get('height', 0))
            if (0 < width < 80) or (0 < height < 60):
                continue
        except (ValueError, TypeError):
            pass
        found.setdefault(url, {'url': url, 'alt': str(attrs.get('alt') or '')[:200]})
    return list(found.values())[:6]


def metadata(raw):
    """Validate bytes and record the dimensions the browser will actually display."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                width, height = image.size
                if image.format not in ('JPEG', 'PNG', 'WEBP', 'GIF') or width * height > 20_000_000:
                    raise Problem('新闻图片格式或分辨率不适合展示。')
                fmt = image.format
                image.verify()
            # PNG getexif() may load pixels and close its verify stream. Read
            # orientation from a separate handle after validating the file.
            with Image.open(io.BytesIO(raw)) as image:
                orientation = image.getexif().get(274, 1)
                if orientation in (5, 6, 7, 8):
                    width, height = height, width
                if width < 240 or height < 160 or not .35 <= width / height <= 4:
                    raise Problem('新闻图片过小或比例异常，已跳过装饰图片。')
                image.load()
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise Problem('链接没有返回完整可验证的新闻图片。') from exc
    # Portrait pages/posters must remain legible. Never use brightness to cut
    # black borders: a dark region may be genuine news content or a caption.
    return {'width': width, 'height': height, 'format': fmt, 'bytes': len(raw),
            'fit': 'contain' if width / height < 1.05 else 'cover',
            'position': '50% 50%', 'selectionVersion': VERSION}


def select(items, fetch):
    """At most three bounded requests, stopping as soon as a good landscape exists."""
    selected, score, errors = None, -math.inf, []
    for candidate in items[:3]:
        try:
            raw, final = fetch(candidate['url'], MAX_IMAGE_BYTES)
            info = metadata(raw)
            ratio = info['width'] / info['height']
            value = 10 * min(1, min(info['width'], info['height']) / 600) - abs(math.log(ratio / 1.6)) * 8
            if value > score:
                selected, score = {**candidate, **info, 'resolvedUrl': final}, value
            if 1.2 <= ratio <= 2.2 and info['width'] >= 640 and info['height'] >= 360:
                break
        except Exception as exc:
            errors.append(str(exc)[:150])
    return selected, errors
