"""Versioned robot changes, fixed regression commands and reversible local application."""
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from pathlib import Path
from django.conf import settings
from .core import Problem
from .models import ExternalCache
from .robot_inventory import ROBOTS
from .studio_workspace import context_files, digest, prepare_artifact, resolve_under, source_root, verify_artifact
from types import SimpleNamespace

LOCK = threading.Lock()
FILES = {v[2]: v[3] for v in ROBOTS.values() if v[2] and v[3]}
FILES['campus/hub/robot_tool_adapters.py'] = 'hub.test_quality_loop'
FILES['campus/hub/studio_workflow.py'] = 'hub.test_studio_recovery'
FILES['campus/hub/companion_team.py'] = 'hub.test_companion_controls'


def read(names):
    if not isinstance(names, list) or any(n not in FILES for n in names):
        raise Problem('只开放机器人清单中的业务程序；权限、密钥、记忆与预算不在代码工具范围。')
    return {'files': [{'path': n, 'content': body, 'hash': digest(body)} for n, body in context_files(names).items()],
            'editable': list(FILES)}


def candidate(files):
    if not isinstance(files, list) or not files or len(files) > 4:
        raise Problem('每次提供 1 至 4 个已读取的机器人文件。')
    original = {r['path']: r for r in read([f.get('path') for f in files])['files']}
    if any(f.get('beforeHash') != original[f['path']]['hash'] for f in files):
        raise Problem('机器人源码已经变化，请重新读取后修改。', 409)
    identifier = str(uuid.uuid4())
    artifact = prepare_artifact(identifier, {n: r['content'] for n, r in original.items()}, files)
    row = ExternalCache.objects.create(key='robot-code:'+identifier, data={
        'id': identifier, 'artifact': artifact, 'state': 'candidate', 'tests': {'state': 'not-run'}})
    return summary(row.data)


def get(identifier):
    identifier = str(uuid.UUID(identifier))
    row = ExternalCache.objects.filter(pk='robot-code:'+identifier).first()
    if not row: raise Problem('机器人候选不存在。', 404)
    return row


def summary(data):
    return {k: v for k, v in data.items() if k != 'artifact'} | {
        'paths': [c['path'] for c in data['artifact']['changes']], 'checks': data['artifact']['checks'],
        'patch': data['artifact']['patch'][:24000]}


def test(identifier):
    row = get(identifier)
    if row.data['state'] != 'candidate': raise Problem('只测试尚未应用的候选。', 409)
    artifact = verify_artifact(SimpleNamespace(pk=identifier, artifact=row.data['artifact']))
    if any(c['state'] != 'passed' for c in artifact['checks']):
        raise Problem('候选语法检查未通过。')
    suites = sorted({FILES[c['path']] for c in artifact['changes']})
    base = settings.DATA / 'robot-tests'
    base.mkdir(exist_ok=True, parents=True)
    # A separate source/data copy prevents regression fixtures from touching live databases.
    # This is data isolation, not an operating-system sandbox for arbitrary executables.
    with tempfile.TemporaryDirectory(prefix='run-', dir=base) as temp:
        target = Path(temp)
        shutil.copytree(settings.BASE, target/'campus', ignore=shutil.ignore_patterns(
            '.data', '.venv', 'node_modules', '__pycache__', 'companion', 'test-output', '*.sqlite*', '.env*'))
        # Persona schemas are code dependencies, not live companion state. Tests import them.
        for directory in ('src', 'vendor', 'test', 'skills'):
            source = settings.BASE/'companion'/directory
            if source.is_dir(): shutil.copytree(source, target/'campus'/'companion'/directory,
                ignore=shutil.ignore_patterns('.data','.git','node_modules','__pycache__','.env*','*.sqlite*'))
        for source in (settings.BASE/'companion').glob('*.mjs'):
            shutil.copy2(source, target/'campus'/'companion'/source.name)
        # Art validation also checks actual public assets. Copies cannot modify the live files.
        art = settings.BASE.parent/'public'/'art'
        if art.is_dir(): shutil.copytree(art, target/'public'/'art')
        for change in artifact['changes']:
            destination = resolve_under(target, change['path'])
            destination.write_text(change['content'], encoding='utf-8')
        env = {k: v for k, v in os.environ.items() if k.upper() in {'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'}}
        env.update(HUB_DATA_DIR=str(target/'data'/'hub'), CAMPUS_DATA_DIR=str(target/'data'),
                   HUB_BEIKUANG='0', HUB_MAINTENANCE='0', PYTHONDONTWRITEBYTECODE='1',
                   PYTHONPATH=str(settings.BASE/'.data'/'hub-runtime'))
        try:
            result = subprocess.run([sys.executable, str(target/'campus'/'manage_hub.py'), 'test', *suites, '--noinput'],
                cwd=target, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=180,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            tested = {'state': 'passed' if result.returncode == 0 else 'failed', 'exitCode': result.returncode,
                      'suites': suites, 'output': (result.stdout+result.stderr)[-8000:], 'dataIsolation': True}
        except subprocess.TimeoutExpired:
            tested = {'state': 'failed', 'reason': '测试超过 180 秒', 'suites': suites}
    row.data['tests'] = tested
    row.save(update_fields=['data'])
    return summary(row.data)


def apply(identifier):
    with LOCK:
        row = get(identifier)
        if row.data['state'] == 'applied': return summary(row.data)
        if row.data['state'] != 'candidate' or row.data['tests'].get('state') != 'passed':
            raise Problem('功能测试通过后才能应用；不能把语法检查当成测试。', 409)
        artifact = verify_artifact(SimpleNamespace(pk=identifier, artifact=row.data['artifact']))
        written = []
        try:
            for change in artifact['changes']:
                path = resolve_under(source_root(), change['path'])
                staged = path.with_suffix(path.suffix+'.robot-tmp')
                staged.write_text(change['content'], encoding='utf-8', newline='\n')
                os.replace(staged, path)
                written.append(change)
        except Exception:
            for change in written:
                resolve_under(source_root(), change['path']).write_text(change['original'], encoding='utf-8')
            raise
        row.data['state'] = 'applied'
        row.data['runtime'] = '业务模块在下一次对应机器人任务开始时重载；不重启数据库或模型服务。'
        row.save(update_fields=['data'])
        return summary(row.data)


def rollback(identifier):
    with LOCK:
        row = get(identifier)
        if row.data['state'] != 'applied': raise Problem('该候选未处于已应用状态。', 409)
        changes = row.data['artifact']['changes']
        for change in changes:
            current = resolve_under(source_root(), change['path'])
            if digest(current.read_text(encoding='utf-8-sig')) != digest(change['content']):
                raise Problem('应用后源码又有修改，不能覆盖后续工作。', 409)
        for change in changes:
            resolve_under(source_root(), change['path']).write_text(change['original'], encoding='utf-8')
        row.data['state'] = 'rolled-back'
        row.save(update_fields=['data'])
        return summary(row.data)


_loaded = {}


def reload_robot(kind):
    source = ROBOTS.get(kind, ('', '', '', ''))[2]
    reload_source(source)


def reload_source(source):
    if source not in FILES: return
    path = source_root()/source
    if not path.is_file(): return
    stamp = path.stat().st_mtime_ns
    module = source.removeprefix('campus/').removesuffix('.py').replace('/', '.')
    if module in sys.modules and _loaded.get(module) != stamp:
        importlib.invalidate_caches()
        importlib.reload(sys.modules[module])
    _loaded[module] = stamp
