"""One attributable catch-up run; normal periodic updates continue in the site worker."""
import json
import os
import sys
import time
from pathlib import Path
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root/'campus'))
import manage_hub
import django
django.setup()
from django.utils import timezone
from hub.models import Job
from hub.content_pipeline import run
from hub.robot_inventory import record_run
from hub.worker import job_lease
job = Job.objects.create(key='pipeline-project-catchup:'+str(time.time_ns()), kind='pipeline-projects',
    state='running', due=timezone.now(), attempts=1, payload={'limit':32,'actorSeat':'scheduler','purpose':'owner-requested-catalogue-completion'})
begun, at = time.monotonic(), timezone.now()
print('Catalogue catch-up started: '+str(job.pk), flush=True)
try:
    with job_lease(job):
        result = run('projects', job.payload)
    job.result, job.state = result, 'partial' if result.get('errors') else 'done'
    job.error = '；'.join(result.get('errors', []))[:600]
except Exception as exc:
    job.state, job.error = 'failed', str(exc)[:500]
finally:
    job.save(update_fields=['state','result','error','updated'])
    record_run(job, at, (time.monotonic()-begun)*1000)
print(json.dumps({'state':job.state,'result':job.result,'error':job.error},ensure_ascii=False),flush=True)
