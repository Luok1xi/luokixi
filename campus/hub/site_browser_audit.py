import json
import os
import shutil
import subprocess
from django.conf import settings
from .core import Problem


def run():
    # No model-provided command, arguments, origin or executable path.
    root = settings.BASE.parent
    node = shutil.which('node')
    if not node:
        raise Problem('浏览器巡检未找到 Node。', 503)
    process = subprocess.run([node, str(root / 'scripts' / 'companion-browser-audit.mjs')],
        cwd=root, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=150,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if process.returncode:
        raise Problem('浏览器巡检未完成：' + process.stderr[-400:], 503)
    return json.loads(process.stdout)
