"""Import owner-provided local archives. Never downloads or republishes them."""
import argparse
import hashlib
import json
import logging
import re
from pathlib import Path
from server import init_db, put_document, pdf_pages, connection, ROOT

logging.getLogger('pypdf').setLevel(logging.ERROR)

def import_file(path, metadata):
    if not path.is_file():raise FileNotFoundError(path)
    sha=hashlib.sha256(path.read_bytes()).hexdigest()
    with connection() as c:
        if c.execute('SELECT id FROM documents WHERE sha256=?',(sha,)).fetchone():return False
    fmt=path.suffix.lower().lstrip('.')
    chunks=[]; state='听力音频，搭配对应试卷使用。'
    if fmt=='pdf':
        try:
            chunks=pdf_pages(path)
            state='scan' if sum(len(t.strip()) for _,t in chunks)<40*len(chunks) else '正文可检索；公式与部分中文编码请以原卷为准。'
        except Exception as e:state='仅文件目录可检索，PDF 提取失败：'+str(e)[:120]
    _,created=put_document(dict(metadata,id='local-'+sha[:24],origin='本地导入',status='ready',sha256=sha,file_path=str(path.resolve()),body='\n'.join(t for _,t in chunks)[:500000],pages=len(chunks),format=fmt,extract_status=state,rights='用户本机已有资料；保留原作者权利，未授权公开转载。'),chunks)
    return created

def run(school_source,cet_source):
    init_db();added=0;errors=[];total=0
    if school_source:
        base=Path(school_source)
        raw=(base/'papers-data.js').read_text(encoding='utf-8-sig')
        entries=json.loads(raw[raw.index('['):raw.rindex(']')+1])
        for p in entries:
            total+=1
            try:
                course='线性代数' if p['subject']=='algebra' else '高等数学 '+p['course']
                added+=import_file(base/p['url'],dict(title=p['title'],course=course,year=p['year'],kind='试卷与答案' if p.get('hasAnswers') else '试卷',scope='本校资料',group_key=''))
            except Exception as e:errors.append({'file':p['url'],'error':str(e)})
    if cet_source:
        base=Path(cet_source)
        entries=json.loads((base/'资料索引.json').read_text(encoding='utf-8-sig'))['records']
        for p in entries:
            total+=1
            try:
                name=p['name'];match=re.search(r'cet([46])_(\d{4})_(\d{2})_(.+?)(?:_ans)?\.(pdf|mp3)$',name)
                label='英语四级' if int(p['level'])==4 else '英语六级'
                kind={'paper':'试卷','answer':'答案解析','audio':'听力音频'}[p['kind']]
                stem=Path(name).stem.removesuffix('_ans')
                title=f"{label} {p['year']}年 {kind}"
                if match:title=f"{label} {match[2]}年{int(match[3])}月 第{match[4]}套 {kind}"
                added+=import_file(base/p['path'],dict(title=title,course=label,year=str(p['year']),kind=kind,scope='通用考试',group_key=stem))
            except Exception as e:errors.append({'file':p['path'],'error':str(e)})
            if total%20==0:print(json.dumps({'processed':total,'added':added,'errors':len(errors)}),flush=True)
    with connection() as c:
        counts={r[0]:r[1] for r in c.execute('SELECT scope,count(*) FROM documents GROUP BY scope')}
        pages=c.execute('SELECT count(*) FROM chunks').fetchone()[0]
        scans=c.execute('SELECT count(*) FROM documents WHERE extract_status="scan"').fetchone()[0]
    result={'processed':total,'new':added,'counts':counts,'pages':pages,'scanned_documents':scans,'errors':errors}
    (ROOT/'.data'/'import-report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=True),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--school-source');p.add_argument('--cet-source');a=p.parse_args()
    if not a.school_source and not a.cet_source:p.error('Provide --school-source or --cet-source')
    run(a.school_source,a.cet_source)
