"""开源广场的本站下载：保存有明确再分发依据的官方附件与源码。

规矩：
- 只镜像允许再分发的开源许可证（ALLOWED_LICENSES）；仓库没声明许可证或许可不允许再分发的，只给原站链接
- 源码固定到提交；只取官方 Release 附件，不把源码当安装包
- 每个文件不超过 MAX_ASSET_BYTES，整站镜像不超过 MAX_TOTAL_BYTES；边下边算 SHA-256，页面上公开校验值
- 下载复用 HTTPX 连接池：只连 GitHub 官方公开地址、钉死 DNS、逐跳校验重定向
"""
import os
from pathlib import Path
from django.conf import settings
from .core import Problem

# SPDX 编号。都是允许再分发（附带许可证和署名）的开源许可证
ALLOWED_LICENSES = {
    'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Zlib', 'BSL-1.0', 'Unlicense', '0BSD',
    'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'AGPL-3.0', 'MPL-2.0', 'EPL-2.0', 'CC0-1.0',
    'CC-BY-4.0', 'CC-BY-SA-4.0', 'CERN-OHL-S-2.0', 'CERN-OHL-W-2.0', 'CERN-OHL-P-2.0', 'GPL-2.0-only', 'GPL-3.0-only',
    'GPL-2.0-or-later', 'GPL-3.0-or-later', 'LGPL-2.1-only', 'LGPL-3.0-only', 'AGPL-3.0-only',
}
MAX_ASSET_BYTES = int(os.environ.get('HUB_MIRROR_MAX_ASSET', 150 * 1024 * 1024))
MAX_TOTAL_BYTES = int(os.environ.get('HUB_MIRROR_MAX_TOTAL', 2 * 1024 * 1024 * 1024))
MAX_ASSETS_PER_RELEASE = 6
EXTENSIONS = ('.zip', '.7z', '.tar.gz', '.tgz', '.tar.xz', '.tar.bz2', '.jar', '.whl', '.apk', '.deb', '.rpm',
              '.appimage', '.dmg', '.msi', '.exe', '.hex', '.bin', '.uf2', '.elf', '.pdf', '.stl', '.step', '.stp')
EXECUTABLE = ('.exe', '.msi', '.dmg', '.appimage', '.apk', '.deb', '.rpm')
API = 'https://api.github.com'


def mirror_root():
    root = Path(settings.MEDIA_ROOT) / 'mirror'
    root.mkdir(parents=True, exist_ok=True)
    return root


def repository_name(value):
    value = str(value or '').strip().removeprefix('https://github.com/').strip('/')
    parts = value.split('/')
    if len(parts) != 2 or not all(p and len(p) <= 100 and all(c.isalnum() or c in '-_.' for c in p) for p in parts):
        raise Problem('仓库应写成 owner/repo。')
    return '/'.join(parts)


def extension_of(name):
    lower = name.lower()
    return next((e for e in sorted(EXTENSIONS, key=len, reverse=True) if lower.endswith(e)), '')


def github_json(path):
    from .github_api import request
    return request(path)


def stream_public(target, destination, limit):
    from .github_transport import stream_file
    return stream_file(target, destination, limit)


def license_of(info):
    spdx = (info.get('license') or {}).get('spdx_id') or ''
    return spdx if spdx and spdx != 'NOASSERTION' else ''


def mirror_repository(repository):
    from .mirror_store import collect
    return collect(repository)


def serialize(asset):
    from .mirror_store import serialize as details
    return details(asset)
