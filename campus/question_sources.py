"""Trusted, read-only local catalog sources. No caller-supplied filesystem paths."""
import hashlib
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from urllib.parse import urlsplit

BASE=Path(__file__).resolve().parent
def local_library_enabled():
    from django.conf import settings
    return urlsplit(settings.PUBLIC_ORIGIN).hostname in ('127.0.0.1','localhost','::1')

def resolve_document_source(document_id):
    from hub.core import Problem
    if not local_library_enabled():
        raise Problem('本站未启用本机资料识别，请上传你自己的资料。',403)
    if not isinstance(document_id,str) or len(document_id)>100:
        raise Problem('资料编号不正确。')
    db=Path(os.environ.get('QUESTION_LIBRARY_DB',str(BASE/'.data'/'library.sqlite3'))).resolve()
    if not db.is_file():raise Problem('本机资料库尚未连接。',503)
    with closing(sqlite3.connect(db.as_uri()+'?mode=ro',uri=True)) as conn:
        conn.row_factory=sqlite3.Row
        row=conn.execute('SELECT * FROM documents WHERE id=? AND status=?',(document_id,'ready')).fetchone()
    if not row:raise Problem('资料不存在或尚未核对。',404)
    if row['format'] not in ('pdf','png','jpg','jpeg','webp','txt','md'):
        raise Problem('请选择试卷、讲义或图片；音频不能用于图片识题。')
    path=Path(row['file_path']).resolve()
    if not path.is_file() or path.stat().st_size>50*1024*1024:
        raise Problem('原件不可读取，或超过 50 MB，请拆分后上传。')
    digest=hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda:source.read(1024*1024),b''):digest.update(chunk)
    if not row['sha256'] or digest.hexdigest()!=row['sha256']:
        raise Problem('原件已发生变化，请重新核对资料库后再识别。',409)
    return {'path':str(path),'name':row['title'],'title':row['title'],'documentId':row['id'],
            'sha256':row['sha256'],'format':row['format'],'course':row['course'],
            'sourceUrl':row['source_url'],'rights':row['rights'],'scope':row['scope'],
            'url':'/api/file/'+row['id'],'pages':row['pages']}
