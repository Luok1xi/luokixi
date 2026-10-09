"""Pinned GitHub skill documents, evaluated then installed without executing downloads."""
import hashlib
import json
import re
import subprocess
import shutil
from pathlib import Path
from urllib.request import Request, build_opener, HTTPRedirectHandler
from django.conf import settings
from .core import Problem
from .models import ExternalCache
from .studio_workspace import digest


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Problem('技能来源发生重定向，未下载。')


def fetch(repository, commit, path):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository or '') or not re.fullmatch(r'[a-f0-9]{40}', commit or ''):
        raise Problem('技能来源必须是 GitHub 仓库和完整的 40 位提交号。')
    if not re.fullmatch(r'[A-Za-z0-9_./-]{1,200}', path or '') or any(p in ('', '.', '..') for p in path.split('/')):
        raise Problem('技能文件路径无效。')
    url = f'https://raw.githubusercontent.com/{repository}/{commit}/{path}'
    with build_opener(NoRedirect).open(Request(url, headers={'User-Agent': 'Luokixi-Skill-Review/1'}), timeout=20) as response:
        if response.url != url: raise Problem('技能下载发生重定向，未采用。')
        content = response.read(64001)
    if len(content) > 64000: raise Problem('技能文件超过 64 KB。')
    return content.decode('utf-8-sig'), url


def review(args):
    if not args.get('path', '').endswith('/SKILL.md') and args.get('path') != 'SKILL.md':
        raise Problem('这里只安装 SKILL.md 操作技能，不执行远程安装脚本。')
    content, url = fetch(args.get('repository'), args.get('commit'), args.get('path'))
    licence, _ = fetch(args['repository'], args['commit'], args.get('licensePath', 'LICENSE'))
    # Reuse the original parser as the acceptance contract instead of a second interpretation.
    node = shutil.which('node')
    if not node: raise Problem('缺少技能校验运行时。', 503)
    module = (settings.BASE/'companion'/'src'/'skills.mjs').as_uri()
    code = 'import {parseSkill} from '+json.dumps(module)+';let s="";for await(const b of process.stdin)s+=b;process.stdout.write(JSON.stringify(parseSkill(s)));'
    run = subprocess.run([node, '--input-type=module', '-e', code], input=content, capture_output=True,
        text=True, encoding='utf-8', timeout=10, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if run.returncode: raise Problem('技能未通过原版 SKILL.md 格式校验。')
    parsed = json.loads(run.stdout)
    fingerprint = hashlib.sha256(content.encode()).hexdigest()
    identifier = digest({'url': url, 'sha256': fingerprint})
    data = {'id': identifier, 'url': url, 'repository': args['repository'], 'commit': args['commit'],
        'sha256': fingerprint, 'name': parsed['name'], 'description': parsed['description'],
        'tools': parsed['tools'], 'body': parsed['body'], 'license': licence,
        'content': content, 'state': 'reviewed',
        'acceptance': '检查内容与许可、现有工具是否适用，再提交有具体理由的 install。技能不能自行扩大权限。'}
    ExternalCache.objects.update_or_create(key='robot-skill:'+identifier[:48], defaults={'data': data})
    return {k: v for k, v in data.items() if k != 'content'}


def install(args):
    identifier = args.get('id', '')
    if not re.fullmatch(r'[a-f0-9]{64}', identifier): raise Problem('技能评估编号无效。')
    row = ExternalCache.objects.filter(pk='robot-skill:'+identifier[:48]).first()
    if not row or row.data.get('id') != identifier: raise Problem('请先读取并评估这份技能。', 404)
    if not isinstance(args.get('assessment'), str) or not 20 <= len(args['assessment'].strip()) <= 1600:
        raise Problem('请具体说明技能用途、许可和所需工具是否适用（20 至 1600 字）。')
    if args.get('licenseAccepted') is not True: raise Problem('安装前需要核对许可。')
    data = row.data
    if hashlib.sha256(data['content'].encode()).hexdigest() != data['sha256']:
        raise Problem('技能内容变化，需要重新评估。', 409)
    root = (settings.BASE/'companion'/'skills').resolve()
    target = root/data['name']
    if target.is_symlink() or (hasattr(target, 'is_junction') and target.is_junction()) or not target.resolve().is_relative_to(root):
        raise Problem('技能目录无效。')
    if target.exists():
        manifest = target/'SOURCE.json'
        if manifest.is_file() and json.loads(manifest.read_text(encoding='utf-8')).get('sha256') == data['sha256']:
            return {'state': 'installed', 'name': data['name'], 'duplicate': True, 'sha256': data['sha256']}
        raise Problem('已有同名技能，保留原技能；请选择不同技能。', 409)
    target.mkdir(parents=True)
    try:
        (target/'SKILL.md').write_text(data['content'], encoding='utf-8')
        (target/'LICENSE').write_text(data['license'], encoding='utf-8')
        (target/'SOURCE.json').write_text(json.dumps({k: data[k] for k in ('url', 'commit', 'sha256')}, indent=2), encoding='utf-8')
    except Exception:
        for name in ('SKILL.md', 'LICENSE', 'SOURCE.json'): (target/name).unlink(missing_ok=True)
        target.rmdir()
        raise
    data.update(state='installed', assessment=args['assessment'])
    row.save(update_fields=['data'])
    return {'state': 'installed', 'name': data['name'], 'sha256': data['sha256'],
            'reload': '两位原版运行时下一次列出或加载技能时自动发现', 'executableCodeInstalled': False}
