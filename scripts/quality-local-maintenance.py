"""Explicit local verification/backfill. Run through manage_hub.py shell."""
import json
import sqlite3
from pathlib import Path
from django.conf import settings
from hub import auto_media, robot_tools
from hub.models import Entry
from hub.robot_inventory import publication_coverage

out=settings.BASE/'.data/quality-20261009'
out.mkdir(parents=True,exist_ok=True)
database=Path(settings.DATABASES['default']['NAME']).resolve()
snapshot=out/'hub-before-quality.sqlite3'
if not snapshot.exists():
    with sqlite3.connect(database.as_uri()+'?mode=ro',uri=True) as source, sqlite3.connect(snapshot) as dest:source.backup(dest)
report={'before':{'entries':Entry.objects.count(),'coverage':publication_coverage()},'tools':[]}
for name in ('markdown-reader','pdf-reader'):
    try:
        result=robot_tools.install({'id':name,'assessment':'本轮站主授权的接入验证：用于中文项目文档和 PDF 资料检查，核对官方分发来源与许可，并在独立目录试运行。'})
        report['tools'].append({k:result.get(k) for k in ('id','state','version','packages','durationMs','test')})
    except Exception as exc:report['tools'].append({'id':name,'state':'failed','error':str(exc)[:250]})
try:report['markdownExperiment']=robot_tools.run({'id':'markdown-reader','text':'# 资料审核\n\n这是一个**中文**项目。\n\n[原始来源](https://github.com/Luok1xi/luokixi)\n\n```python\nprint(1)\n```'})
except Exception as exc:report['markdownExperiment']={'error':str(exc)[:250]}
library=settings.BASE/'.data/library.sqlite3'
with sqlite3.connect(library.as_uri()+'?mode=ro',uri=True) as db:
    docs=db.execute('select id,file_path,format from documents').fetchall()
report['library']={'documents':len(docs),'originalsPresent':sum(bool(p and Path(p).is_file()) for _,p,_ in docs)}
pdf=next((i for i,p,f in docs if f=='pdf'),None)
try:
    result=robot_tools.run({'id':'pdf-reader','documentId':pdf})
    report['pdfExperiment']={**result,'result':{k:v for k,v in result['result'].items() if k!='text'}}
except Exception as exc:report['pdfExperiment']={'error':str(exc)[:250]}
report['art']=auto_media.sweep()
report['afterEntries']=Entry.objects.count()
(out/'maintenance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({**report,'before':{'entries':report['before']['entries'],'coverage':{k:v for k,v in report['before']['coverage'].items() if k!='items'}}},ensure_ascii=False))
