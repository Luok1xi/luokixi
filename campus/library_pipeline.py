"""Persistent provenance and a browsable shelf for already collected university resources."""
import hashlib
import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit


@contextmanager
def connect(folder):
    path = Path(folder)/'library.sqlite3'
    if not path.is_file(): raise ValueError('真实资料库不存在，停止整理，未新建空库。')
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE IF NOT EXISTS material_records (id TEXT PRIMARY KEY, source_hash TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL)')
    try:
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def classify(course, title='', school=''):
    text = course+' '+title
    discipline = next((name for name, pattern in [
        ('数学', r'数学|高数|线性|概率|统计|代数|微积分'), ('外语', r'英语|四六级|六级|四级|CET'),
        ('计算机', r'计算机|程序|算法|数据结构|软件|网络|Internet|人工智能|操作系统'),
        ('电子与电气', r'电路|电子|电气|信号|嵌入式|通信'), ('物理', r'物理|力学|热学'),
        ('化学与材料', r'化学|材料'), ('人文与通识', r'心理|历史|文学|哲学|思想|通识')]
        if re.search(pattern, text, re.I)), course if course and course not in ('unknown', '未分类') else '待归类')
    return {'schools': [school] if school else [], 'discipline': discipline,
            'priority': '考试复习' if re.search(r'期末|期中|试卷|真题|exam|六级|四级', text, re.I) else '课程学习',
            'classificationMethod': '目录与标题规则；不推断本学期适用性'}


def sync(folder):
    folder = Path(folder); now = datetime.now(timezone.utc).isoformat()
    records, errors = [], []
    university = folder/'university-sources.json'
    if university.is_file():
        data = json.loads(university.read_text(encoding='utf-8'))
        schools = {s['id']: s['name'] for s in data.get('schools', [])}
        sources = {s['id']: s for s in data.get('sources', [])}
        for item in data.get('resources', []):
            source = sources.get(item.get('sourceId'), {})
            url = item.get('url', '')
            if not source or not item.get('id') or not item.get('title') or urlsplit(url).scheme != 'https':
                errors.append({'id': item.get('id'), 'reason': '目录缺少来源、标题或公开网址'}); continue
            course = item.get('courseCanonical') or item.get('course') or '待归类'
            school = schools.get(item.get('schoolId'), item.get('schoolName', ''))
            records.append({'id': item['id'], 'title': item['title'], 'course': course, 'year': item.get('year') or '',
                'kind': {'exam': '试卷', 'answer': '答案', 'note': '笔记'}.get(item.get('kind'), '课程资料'),
                'format': item.get('format') or 'link', 'source': url, 'url': url, 'external': True,
                'scope': '跨校资料', 'uploadedAt': item.get('downloadedAt') or item.get('indexedAt') or source.get('checkedAt'),
                'uploader': source.get('name') or source.get('repo') or '公开来源采集机器人',
                'reviewedBy': '资料归类机器人', 'reviewedAt': now, 'reviewState': 'source-checked',
                'note': '已检查来源与分类；原件在来源站。答案、课程适用性未作学科复核。',
                'rights': item.get('rights', {}).get('license') or '原作者保留权利',
                'revision': item.get('commit') or source.get('commit') or '', **classify(course, item['title'], school)})
    with connect(folder) as db:
        local = db.execute('SELECT id,title,course,scope,origin,created,source_url,file_path,sha256,kind FROM documents').fetchall()
        for item in local:
            if item['file_path'] and not Path(item['file_path']).is_file():
                errors.append({'id': item['id'], 'reason': '原件文件缺失，未记为审核通过'}); continue
            records.append({'id': item['id'], 'uploadedAt': item['created'], 'uploader': item['origin'] or '历史导入（原上传者未记录）',
                'reviewedBy': '资料归类机器人', 'reviewedAt': now, 'reviewState': 'source-checked',
                'revision': item['sha256'], **classify(item['course'], item['title'], '中国矿业大学（北京）' if item['scope']=='本校资料' else '')})
        added = changed = 0
        for record in records:
            previous = db.execute('SELECT data FROM material_records WHERE id=?', (record['id'],)).fetchone()
            if previous:
                first_seen = json.loads(previous['data']).get('uploadedAt')
                if first_seen: record['uploadedAt'] = first_seen
            stable = {k: v for k, v in record.items() if k != 'reviewedAt'}
            fingerprint = hashlib.sha256(json.dumps(stable, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            old = db.execute('SELECT source_hash FROM material_records WHERE id=?', (record['id'],)).fetchone()
            if old and old['source_hash'] == fingerprint: continue
            added += not bool(old); changed += bool(old)
            db.execute('INSERT INTO material_records VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_hash=excluded.source_hash,data=excluded.data,updated=excluded.updated',
                (record['id'], fingerprint, json.dumps(record, ensure_ascii=False), now))
        total = db.execute('SELECT count(*) FROM material_records').fetchone()[0]
    return {'classified': len(records), 'collected': added, 'refreshed': changed, 'catalogued': total,
            'errors': [e['reason']+': '+str(e['id']) for e in errors[:10]], 'at': now}


def catalogue(folder):
    with connect(folder) as db:
        records = [json.loads(r[0]) for r in db.execute('SELECT data FROM material_records ORDER BY updated DESC')]
    return {'items': [r for r in records if r.get('external')],
            'provenance': {r['id']: r for r in records if not r.get('external')},
            'total': len(records), 'note': '来源目录与本地文件分开标记；来源审核不代表答案正确性已核验。'}
