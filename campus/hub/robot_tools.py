"""Owner-authorized, versioned tools. Download -> verify -> isolated probe -> activate.

Only reviewed wheel recipes execute here, never shell snippets from a web page.
The model chooses a recipe and an experiment; receipts are shared by both seats.
"""
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import PurePosixPath
from urllib.parse import urlsplit
from urllib.request import Request, build_opener
from django.conf import settings
from django.utils import timezone
from .core import Problem
from .models import ExternalCache
from .robot_skills import NoRedirect

from . import robot_tool_adapters as adapters
LOCK = threading.Lock()
_adapter_stamp = None


def refresh_adapters():
    global _adapter_stamp
    stamp = os.stat(adapters.__file__).st_mtime_ns
    if stamp != _adapter_stamp:
        import importlib
        importlib.invalidate_caches()
        importlib.reload(adapters)
        _adapter_stamp = stamp


def tool_root():
    root = (settings.DATA/'robot-tools').resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def recipe_id(name):
    refresh_adapters()
    if not isinstance(name, str) or not re.fullmatch('[a-z][a-z0-9-]{1,60}',name) or name not in adapters.RECIPES:
        raise Problem('没有这个已适配工具。新项目可先评估技能或提交机器人候选代码。')
    recipe = adapters.RECIPES[name]
    if recipe.get('input') not in ('text','document') or not 1<=len(recipe.get('packages',[]))<=12:
        raise Problem('工具需要声明文本或资料输入，以及完整的固定版本依赖。')
    for package, version in recipe['packages']:
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}',package) or not re.fullmatch(r'[0-9][A-Za-z0-9.+_-]{0,59}',version):
            raise Problem('工具依赖名称或固定版本无效。')
    return hashlib.sha256(json.dumps([3,adapters.RECIPES[name],adapters.PROBE]).encode()).hexdigest()[:16]


def target(name):
    root = tool_root(); path = root/(name+'-'+recipe_id(name))
    if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()) or not path.resolve().is_relative_to(root):
        raise Problem('工具目录不是独立的本机目录。')
    return path


def catalogue(args=None):
    refresh_adapters()
    query = str((args or {}).get('query', '')).strip().lower()
    rows = []
    for key, recipe in adapters.RECIPES.items():
        receipt = ExternalCache.objects.filter(pk='robot-tool:'+key).first()
        record = receipt.data if receipt else {}
        installed = record.get('state') == 'ready' and record.get('version') == recipe_id(key) and (target(key)/'RECEIPT.json').is_file()
        state = 'ready' if installed else 'needs-test' if record.get('state')=='ready' else record.get('state','available')
        rows.append({'id': key, **recipe, 'state': state,
            'recommended': bool(query and any(t in (recipe['keywords']+' '+recipe['purpose']).lower() for t in query.split())),
            'receipt': record})
    return {'items': rows, 'adapterSource': 'campus/hub/robot_tool_adapters.py', 'workflow': 'tool_install{id,assessment} 会下载并测试；成功后 tool_run{id,text或documentId} 直接调用；失败记录原因，不覆盖原环境。'}


def read_url(url, limit):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in ('pypi.org','files.pythonhosted.org') or parsed.username or parsed.password or parsed.port not in (None,443):
        raise Problem('工具包地址不属于已核对的官方分发源。')
    with build_opener(NoRedirect).open(Request(url, headers={'User-Agent':'Luokixi-Tool-Installer/1'}), timeout=25) as r:
        data = r.read(limit+1)
    if len(data)>limit: raise Problem('工具包超过下载上限。')
    return data


def unpack(raw, folder):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        members = archive.infolist()
        if len(members)>3000 or sum(x.file_size for x in members)>32*1024*1024: raise Problem('工具包展开大小异常。')
        for member in members:
            name = PurePosixPath(member.filename)
            if name.is_absolute() or '..' in name.parts or chr(92) in member.filename or ':' in member.filename or member.filename.lower().endswith('.pth') or ((member.external_attr >> 16) & 0o170000) == 0o120000:
                raise Problem('工具包含越界路径或启动钩子，未安装。')
        for member in members:
            dest = folder/member.filename
            if member.is_dir(): dest.mkdir(parents=True,exist_ok=True)
            else:
                dest.parent.mkdir(parents=True,exist_ok=True); dest.write_bytes(archive.read(member))


def execute(name, folder, data):
    # -I ignores PYTHONPATH / user packages. No API keys or model-generated code.
    env = {k:v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','TEMP','TMP','PATH')}
    env['PYTHONIOENCODING']='utf-8'
    run = subprocess.run([sys.executable,'-I','-X','utf8','-c',adapters.PROBE,str(folder),name], input=json.dumps(data),
        capture_output=True,text=True,encoding='utf-8',errors='replace',cwd=folder,env=env,timeout=25,
        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if run.returncode: raise Problem('工具试运行失败：'+run.stderr[-300:])
    return json.loads(run.stdout)


def install(args):
    name=args.get('id'); version=recipe_id(name)
    assessment=str(args.get('assessment','')).strip()
    if not 20<=len(assessment)<=1600: raise Problem('请写明要解决什么问题、用途及许可判断（20 至 1600 字）。')
    if not LOCK.acquire(blocking=False): raise Problem('另一个工具正在安装，稍后查询 tools 状态。',409)
    started=time.monotonic(); row=None
    try:
        folder=target(name); folder.mkdir(parents=True,exist_ok=True)
        row,_=ExternalCache.objects.get_or_create(key='robot-tool:'+name)
        if row.data.get('state')=='ready' and row.data.get('version')==version and (folder/'RECEIPT.json').is_file():
            return dict(row.data,duplicate=True)
        row.data={'id':name,'version':version,'state':'installing','assessment':assessment,'startedAt':timezone.now().isoformat()};row.save()
        packages=[]
        for package,release in adapters.RECIPES[name]['packages']:
            meta=json.loads(read_url(f'https://pypi.org/pypi/{package}/{release}/json',1024*1024))
            wheel=next((x for x in meta['urls'] if x['filename'].endswith('-py3-none-any.whl') and not x.get('yanked')),None)
            if not wheel: raise Problem('指定版本没有可用的通用 wheel，保留未安装状态。')
            raw=read_url(wheel['url'],8*1024*1024); sha=hashlib.sha256(raw).hexdigest()
            if sha!=wheel['digests']['sha256']: raise Problem('下载校验失败，未启用。')
            unpack(raw,folder);packages.append({'name':package,'version':release,'sha256':sha,'source':wheel['url'],'bytes':len(raw)})
        result=execute(name,folder,{})
        row.data.update(state='ready',packages=packages,test={'passed':True,'result':result},durationMs=round((time.monotonic()-started)*1000),completedAt=timezone.now().isoformat())
        (folder/'RECEIPT.json').write_text(json.dumps(row.data,ensure_ascii=False),encoding='utf-8')
        row.save();return row.data
    except Exception as exc:
        if row:
            row.data.update(state='failed',error=str(exc)[:300],durationMs=round((time.monotonic()-started)*1000));row.save()
        raise
    finally: LOCK.release()


def run(args):
    name=args.get('id'); version=recipe_id(name)
    row=ExternalCache.objects.filter(pk='robot-tool:'+name).first()
    if not row or row.data.get('state')!='ready' or row.data.get('version')!=version: raise Problem('工具还未通过安装测试。')
    data={}
    if adapters.RECIPES[name]['input']=='text':
        data['text']=str(args.get('text',''))
        if not 1<=len(data['text'])<=60000: raise Problem('提供 1 至 60000 字的文档正文。')
    elif args.get('documentId'):
        import sqlite3
        ident=str(args['documentId'])
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',ident): raise Problem('资料编号无效。')
        with sqlite3.connect((settings.BASE/'.data/library.sqlite3').as_uri()+'?mode=ro',uri=True) as db:
            doc=db.execute('select file_path from documents where id=? and format=?',(ident,'pdf')).fetchone()
        if not doc: raise Problem('资料库中没有这份 PDF。',404)
        from pathlib import Path
        path=Path(doc[0]).resolve()
        if not path.is_file() or path.stat().st_size>40*1024*1024: raise Problem('资料不存在或超过本次检查的 40 MB 上限。')
        data['path']=str(path)
    else: raise Problem('请选择资料库中的 documentId。')
    started=time.monotonic(); result=execute(name,target(name),data)
    return {'id':name,'state':'done','durationMs':round((time.monotonic()-started)*1000),'result':result}
