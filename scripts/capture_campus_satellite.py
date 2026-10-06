"""截取两个校区的卫星影像，给 Codex 重绘迪士尼风格插画做底稿。

用法（需要 Pillow）：
    python scripts/capture_campus_satellite.py                 # 两个校区，z18 和 z19
    python scripts/capture_campus_satellite.py --campus shahe --zoom 19

输出到 campus/.data/map-capture/（被 Git 忽略）：
    luokixi-<校区>-satellite-z<级别>.png          干净的卫星底图
    luokixi-<校区>-outline-z<级别>.png            叠加 OSM 校园边界、楼轮廓和楼名，对位用
    luokixi-<校区>-z<级别>.json                   对位信息：四角经纬度、投影、像素原点、尺寸、来源

范围和投影与网站地图一致（EPSG:3857，校园轮廓外扩约 60 米），重绘图按同样范围交回来就能直接叠上地图。
卫星影像版权归 Esri、Maxar 等提供方：只用于本机对位和重绘参考，不进仓库、不公开发布。
"""
import argparse
import json
import math
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'public' / 'data' / 'campus-map'
OUT = ROOT / 'campus' / '.data' / 'map-capture'
TILE = 256
URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
UA = 'luokixi-campus-capture/0.1 (local tracing reference for a student site)'
PAD = 0.0006  # 和页面“整个校区”截图一样，校园外留一圈边
NAMES = {'xueyuanlu': '学院路校区', 'shahe': '沙河校区'}


def project(lat, lng, z):
    """经纬度 → 某一级别下的全球像素坐标（Web 墨卡托）。"""
    size = TILE * 2 ** z
    s = math.sin(math.radians(max(-85.05, min(85.05, lat))))
    return (lng + 180) / 360 * size, (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * size


def fetch(z, x, y):
    cache = OUT / 'tiles' / str(z) / str(x) / f'{y}.jpg'
    if cache.exists():
        return Image.open(cache).convert('RGB')
    cache.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        try:
            req = urllib.request.Request(URL.format(z=z, x=x, y=y), headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                cache.write_bytes(r.read())
            return Image.open(cache).convert('RGB')
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return None


def font(size):
    for name in ('msyhbd.ttc', 'msyh.ttc', 'simhei.ttf'):
        path = Path('C:/Windows/Fonts') / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def rings(geom):
    if geom['type'] == 'Polygon':
        return geom['coordinates']
    if geom['type'] == 'MultiPolygon':
        return [r for poly in geom['coordinates'] for r in poly]
    return [geom['coordinates']]


def capture(campus, z):
    data = json.loads((DATA / f'{campus}.json').read_text(encoding='utf-8'))
    ring = data['boundary']['coordinates'][0]
    west, east = min(p[0] for p in ring) - PAD, max(p[0] for p in ring) + PAD
    south, north = min(p[1] for p in ring) - PAD, max(p[1] for p in ring) + PAD
    x0, y0 = project(north, west, z)
    x1, y1 = project(south, east, z)
    width, height = math.ceil(x1 - x0), math.ceil(y1 - y0)
    tx0, ty0, tx1, ty1 = int(x0 // TILE), int(y0 // TILE), int(x1 // TILE), int(y1 // TILE)
    jobs = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
    canvas = Image.new('RGB', ((tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE), (119, 119, 119))
    # 公共影像服务：最多 6 个并发，下载过的瓦片缓存在本机，重跑不再请求
    with ThreadPoolExecutor(6) as pool:
        tiles = list(pool.map(lambda j: (j, fetch(z, *j)), jobs))
    missing = 0
    for (tx, ty), img in tiles:
        if img is None:
            missing += 1
            continue
        canvas.paste(img, ((tx - tx0) * TILE, (ty - ty0) * TILE))
    ox, oy = x0 - tx0 * TILE, y0 - ty0 * TILE
    clean = canvas.crop((round(ox), round(oy), round(ox) + width, round(oy) + height))

    base = f'luokixi-{campus}'
    clean.save(OUT / f'{base}-satellite-z{z}.png', optimize=True)

    # 对位图：白色校园边界、黄色楼轮廓、楼名（白字黑边）
    outline = clean.copy()
    draw = ImageDraw.Draw(outline)
    scale = 2 ** (z - 17)
    px = lambda c: (project(c[1], c[0], z)[0] - x0, project(c[1], c[0], z)[1] - y0)
    draw.line([px(c) for c in ring], fill=(255, 255, 255), width=max(2, int(2 * scale)), joint='curve')
    buildings = [f for f in data['features'] if f['properties']['kind'] == 'building']
    for f in buildings:
        for r in rings(f['geometry']):
            draw.line([px(c) for c in r], fill=(255, 201, 60), width=max(2, int(1.2 * scale)), joint='curve')
    label_font = font(int(min(30, max(12, 11 * scale))))
    for f in buildings:
        name = f['properties'].get('name')
        if name:
            x, y = px(f['properties']['center'])
            draw.text((x, y), name, font=label_font, fill='white', anchor='mm', stroke_width=3, stroke_fill='black')
    for p in data.get('pois', []):
        if p['properties']['kind'] == 'gate':
            x, y = px(p['geometry']['coordinates'])
            r = 4 * scale
            draw.rectangle((x - r, y - r, x + r, y + r), outline=(255, 90, 110), width=3)
    outline.save(OUT / f'{base}-outline-z{z}.png', optimize=True)

    lat_mid = math.radians((north + south) / 2)
    meta = {
        'version': 1,
        'campus': campus,
        'campusName': NAMES.get(campus, campus),
        'capturedAt': datetime.now(timezone.utc).isoformat(),
        'zoom': z,
        'projection': 'EPSG:3857（Web 墨卡托，和网站地图相同）',
        'coordinateSystem': 'WGS84',
        'bounds': {'north': north, 'south': south, 'east': east, 'west': west},
        'leafletBounds': [[south, west], [north, east]],
        'pixelOrigin': [round(x0, 2), round(y0, 2)],
        'width': width,
        'height': height,
        'metersPerPixel': round(156543.03392 * math.cos(lat_mid) / 2 ** z, 3),
        'files': {'clean': f'{base}-satellite-z{z}.png', 'outline': f'{base}-outline-z{z}.png'},
        'sources': [
            {'name': 'Esri World Imagery', 'credit': '影像 © Esri、Maxar、Earthstar Geographics', 'missingTiles': missing},
            {'name': 'OpenStreetMap', 'credit': '© OpenStreetMap 贡献者', 'license': 'ODbL 1.0', 'usedFor': '对位图上的边界、楼轮廓、楼名和校门'},
        ],
        'notice': '卫星影像版权归影像提供方。只用于本机对位和重绘参考，不进仓库、不公开发布；网站上的插画必须是重新绘制的。',
    }
    (OUT / f'{base}-z{z}.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{campus} z{z}: {width}×{height}，{len(jobs)} 张瓦片，缺 {missing} 张')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--campus', choices=list(NAMES), action='append')
    ap.add_argument('--zoom', type=int, action='append', choices=[17, 18, 19])
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    for campus in args.campus or list(NAMES):
        for z in args.zoom or [18, 19]:
            capture(campus, z)
