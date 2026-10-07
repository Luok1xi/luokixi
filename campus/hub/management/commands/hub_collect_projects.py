"""Run the real bounded crawler locally, with the same durable job records as the UI."""
import json
import uuid
from django.core.management.base import BaseCommand
from django.utils import timezone
from hub.models import Job
from hub.maintenance import run


class Command(BaseCommand):
    help = 'Collect public GitHub candidates and/or project pictures; never auto-publish candidates.'
    def add_arguments(self, parser):
        parser.add_argument('--task',choices=('github','media','both'),default='both')
    def handle(self,*args,**options):
        tasks = ('github','media') if options['task']=='both' else (options['task'],)
        for task in tasks:
            job = Job.objects.create(key=f'collect:{task}:{uuid.uuid4()}',kind='maint-'+task,state='running',attempts=1,due=timezone.now())
            try:
                job.result = run(task)
                job.error = '；'.join(job.result.get('errors',[]))[:300]
                job.state = 'partial' if job.error else 'done'
            except Exception as exc:
                job.error,job.state = str(exc)[:300],'failed'
            job.save()
            self.stdout.write(json.dumps({'task':task,'state':job.state,'result':job.result,'error':job.error},ensure_ascii=False))
