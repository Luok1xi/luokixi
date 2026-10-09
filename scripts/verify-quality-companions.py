"""Local, bounded original-runtime acceptance. Writes previews, never public posts."""
import hashlib
import json
import time
import uuid
from pathlib import Path
from hub.companion_bridge import call
from hub.content_pipeline import journal_facts
from hub.studio_config import config

out = Path('campus/.data/quality-20261009/companion-preview.json')
facts = journal_facts()
cfg = config()
rows = []
pending = {}
for seat in ('beikuang', 'codex'):
    row = {'seat': seat}
    rows.append(row)
    try:
        result = call('tools', {'name': 'campus_maintenance_read', 'arguments': {'operation': 'tools', 'arguments': {}}}, seat=seat)
        row['toolDiscovery'] = result
        ident = hashlib.sha256(('quality-preview:'+seat+':'+str(uuid.uuid4())).encode()).hexdigest()
        call('jobs', {'id': ident, 'owner': cfg['owner_id'], 'kind': 'report', 'text': '', 'report': facts}, seat=seat)
        pending[seat] = ident
        row['state'] = 'running'
    except Exception as exc:
        row['state'] = 'failed'
        row['error'] = str(exc)[:300]
    print(json.dumps({'seat': seat, 'state': row['state']}, ensure_ascii=False), flush=True)
deadline = time.monotonic()+360
while pending and time.monotonic() < deadline:
    for row in rows:
        seat = row['seat']
        if seat not in pending: continue
        result = call('jobs/'+pending[seat], seat=seat)
        if result['state'] not in ('done', 'failed'): continue
        del pending[seat]
        row['state'] = result['state']
        if result['state'] == 'failed': row['error'] = result.get('error')
        else:
            # No memory, private conversation or provider configuration in acceptance artifacts.
            value = result['result']
            row['text'] = value.get('text', '')
            row['messages'] = [{k: m[k] for k in ('type','text','expression','emotion','id') if k in m}
                               for m in value.get('messages', []) if isinstance(m, dict)]
            row['hasText'] = bool(row['text'].strip())
        print(json.dumps({'seat': seat, 'state': row['state'], 'hasText': row.get('hasText'), 'error': row.get('error')}, ensure_ascii=False), flush=True)
    out.write_text(json.dumps({'publicPreviewOnly': True, 'results': rows}, ensure_ascii=False, indent=2), encoding='utf-8')
    if pending: time.sleep(1)
for seat, ident in pending.items():
    call('cancel', {'id': ident}, seat=seat)
    next(row for row in rows if row['seat']==seat).update(state='timed-out')
out.write_text(json.dumps({'publicPreviewOnly': True, 'results': rows}, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'passed': all(row.get('hasText') for row in rows)}, ensure_ascii=False))
