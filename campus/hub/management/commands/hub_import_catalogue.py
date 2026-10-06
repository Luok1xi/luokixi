import hashlib
import json
from pathlib import Path
from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import transaction
from hub.models import Entry, Revision

class Command(BaseCommand):
    help = 'Import public project catalogue without claiming user identities or importing private PDFs.'
    def add_arguments(self,parser):
        parser.add_argument('--file',default=str(settings.BASE.parent/'public/data/community.json'))
    def handle(self,*args,**options):
        data = json.loads(Path(options['file']).read_text(encoding='utf-8-sig'))
        count = 0
        for p in data.get('projects',[]):
            slug = p.get('slug') or hashlib.sha256(p['title'].encode()).hexdigest()[:20]
            if Entry.objects.filter(slug=slug).exists():
                continue
            payload = {'title':p['title'],'summary':p.get('summary',''),'body':'',
                'credit':p.get('credit') or '、'.join(p.get('authors',[])), 'links':p.get('links',{}),
                'license':(p.get('repo') or {}).get('license') or '许可待核，仅链接',
                'tags':p.get('tags',[]),'category':p.get('category',''),'year':str(p.get('year','')),
                'uploads':[],'sourceNote':'导入已有公开目录；成员账号尚未认领',
                'externalStats':p.get('repo'), 'legacyUrl':'projects.html'}
            if not isinstance(payload['license'],str):
                payload['license'] = json.dumps(payload['license'],ensure_ascii=False)
            repo = payload['links'].get('repo','').rstrip('/').removesuffix('.git')
            with transaction.atomic():
                entry = Entry.objects.create(kind='project',slug=slug,state='published',draft=payload,
                    published=payload,public_revision=1,canonical_key='project:'+repo if repo else '',
                    search_text=json.dumps(payload,ensure_ascii=False))
                Revision.objects.create(entry=entry,number=1,data=payload,state='published',note='导入原有公开目录，保留旧链接与署名。')
            count += 1
        self.stdout.write(f'Imported {count} public project references; no user identity or private library imported.')
