"""Deterministic candidate writer. Models cannot run shell commands or publish."""
import ast
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path, PurePosixPath
from django.conf import settings
from .core import Problem

EXTENSIONS = {'.py', '.js', '.mjs', '.json', '.md'}
ROOTS = {'campus', 'src', 'content', 'docs'}
SECRET = re.compile(r'(?i)(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|-----BEGIN .*PRIVATE KEY-----|(?:api[_-]?key|password|access[_-]?token)\s*[=:]\s*[\"\'][^\"\']{12,}[\"\'])')


def safe_path(value):
    if not isinstance(value, str) or len(value) > 240 or re.search(r'[\\:\x00-\x1f<>"|?*]', value):
        raise Problem('文件路径无效。')
    p = PurePosixPath(value)
    if p.is_absolute() or str(p) != value or any(x in ('', '.', '..') or x.startswith('.') for x in p.parts):
        raise Problem('只能使用允许目录中的相对文件路径。')
    if not p.parts or p.parts[0] not in ROOTS or p.suffix not in EXTENSIONS:
        raise Problem('本轮只支持 campus/src/content/docs 中的文本代码与资料。')
    if any(x.lower() in {'node_modules', '__pycache__', 'secrets', 'private', 'uploads', 'migrations'} for x in p.parts):
        raise Problem('该目录不提供给 AI 工作室。')
    if any(x.endswith((' ', '.')) or x.split('.')[0].upper() in {'CON','PRN','AUX','NUL',*[f'COM{i}' for i in range(1,10)],*[f'LPT{i}' for i in range(1,10)]} for x in p.parts):
        raise Problem('文件名不受支持。')
    if ('studio' in value.lower() and value != 'campus/hub/studio_workflow.py') or p.name.lower() in {'settings.py', 'auth.json', 'config.json'}:
        raise Problem('工作室不能修改自身权限、配置或凭据。')
    return p


def source_root():
    return settings.BASE.parent.resolve()


def resolve_under(root, name):
    relative = safe_path(name)
    root = Path(root).resolve()
    candidate = root.joinpath(*relative.parts)
    current = candidate
    while current != root:
        if current.is_symlink() or (hasattr(current, 'is_junction') and current.is_junction()):
            raise Problem('不读取或修改符号链接/目录联接。')
        current = current.parent
    if not candidate.resolve().is_relative_to(root):
        raise Problem('路径超出了工作副本。')
    return candidate


def checked_text(body):
    if not isinstance(body, str) or len(body.encode('utf-8')) > 80000 or '\x00' in body:
        raise Problem('文件内容过大或不是有效文本。')
    if SECRET.search(body):
        raise Problem('文本疑似含有凭据，请移除后再提交。')
    return body


def context_files(names):
    if not isinstance(names, list) or len(names) > 12 or len(names) != len(set(names)):
        raise Problem('每个房间最多选择 12 个不同文件。')
    result = {}
    for name in names:
        path = resolve_under(source_root(), name)
        if not path.is_file() or path.stat().st_size > 80000:
            raise Problem('上下文文件不存在或超过 80 KB。')
        result[name] = checked_text(path.read_text(encoding='utf-8-sig'))
    if sum(len(v.encode('utf-8')) for v in result.values()) > 90000:
        raise Problem('本轮共享文件合计不可超过 90 KB。')
    return result


def digest(data):
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def artifact_dir(run_id):
    return settings.DATA / 'studio-artifacts' / str(run_id)


def prepare_artifact(run_id, originals, files):
    if not isinstance(files, list) or not 1 <= len(files) <= 8:
        raise Problem('一次工作最多生成 8 个文件。')
    seen, changes, total = set(), [], 0
    for file in files:
        name, body = file['path'], checked_text(file['content'])
        path = resolve_under(source_root(), name)
        folded = name.casefold()
        if folded in seen:
            raise Problem('修改列表包含重复文件。')
        seen.add(folded)
        total += len(body.encode('utf-8'))
        if total > 120000:
            raise Problem('本轮修改合计过大。')
        if path.exists() and name not in originals:
            raise Problem('修改已有文件前，必须先把它加入房间的共享上下文。')
        old = originals.get(name, '')
        if old == body:
            continue
        changes.append({'path': name, 'content': body, 'original': old,
                        'existed': name in originals, 'beforeHash': digest(old)})
    if not changes:
        raise Problem('没有可保存的实际改动。')
    root = artifact_dir(run_id)
    if root.exists():
        raise Problem('这轮工作已产生文件，请创建新轮次，不能覆盖待审核产物。', 409)
    root.mkdir(parents=True)
    checks = []
    for change in changes:
        path = resolve_under(root, change['path'])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(change['content'], encoding='utf-8', newline='\n')
        status, detail = 'passed', ''
        try:
            if path.suffix == '.py':
                ast.parse(change['content'], filename=change['path'])
            elif path.suffix == '.json':
                json.loads(change['content'])
            elif path.suffix in {'.js', '.mjs'}:
                node = shutil.which('node')
                if not node:
                    status, detail = 'unavailable', '未找到 Node.js。'
                else:
                    # Parse stdin as ESM, without loading generated modules/config/hooks.
                    env = {k: v for k, v in os.environ.items() if k.upper() in {'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP'}}
                    output = subprocess.run([node, '--input-type=module', '--check'], input=change['content'],
                                            text=True, encoding='utf-8', capture_output=True, timeout=15, env=env,
                                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    if output.returncode:
                        status, detail = 'failed', 'JavaScript 语法检查未通过。'
            else:
                status, detail = 'not-applicable', '文档无可执行语法检查。'
        except (SyntaxError, ValueError, subprocess.TimeoutExpired):
            status, detail = 'failed', '语法或 JSON 格式检查未通过。'
        checks.append({'path': change['path'], 'kind': 'syntax', 'state': status, 'detail': detail})
    patch = ''
    for change in changes:
        for line in difflib.unified_diff(change['original'].splitlines(True), change['content'].splitlines(True),
                fromfile='a/' + change['path'] if change['existed'] else '/dev/null', tofile='b/' + change['path']):
            patch += line if line.endswith('\n') else line + '\n\\ No newline at end of file\n'
    result = {'changes': changes, 'checks': checks, 'patch': patch,
              'functionalTests': 'not-run', 'browserTests': 'not-run', 'published': False}
    result['hash'] = digest(result)
    (root / 'artifact.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return result


def verify_artifact(run):
    data = run.artifact
    if not data or digest({k: v for k, v in data.items() if k != 'hash'}) != data.get('hash'):
        raise Problem('产物记录已变化，请重新检查。', 409)
    for change in data['changes']:
        candidate = resolve_under(artifact_dir(run.pk), change['path'])
        if not candidate.is_file() or candidate.read_text(encoding='utf-8') != change['content']:
            raise Problem('工作副本已变化，原确认已失效。', 409)
        current = resolve_under(source_root(), change['path'])
        if change['existed']:
            if not current.is_file() or digest(current.read_text(encoding='utf-8-sig')) != change['beforeHash']:
                raise Problem('原网站文件已被更新，需重新生成改动以避免覆盖 Opus 的工作。', 409)
        elif current.exists():
            raise Problem('原网站已出现同名文件，需重新检查冲突。', 409)
    return data
