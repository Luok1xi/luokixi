import base64
import io
from datetime import timedelta
from unittest import mock
from urllib.error import HTTPError
from django.test import Client, TestCase
from django.utils import timezone
from PIL import Image
from . import github_api, github_crawler, github_guides, project_media, maintenance
from .core import Problem
from .models import ExternalCache, Job, Member


def details(repo='maker/robot'):
    return {'repository':repo,'url':'https://github.com/'+repo,'description':'A robot arm toolkit',
            'credit':repo.split('/')[0], 'stars':500,'license':'MIT','archived':False,'pushedAt':'2026-09-01T00:00:00Z',
            'readme':'# Robot\n'+('A detailed hardware assembly guide.\n'*10),'readmeSha':'sha1','readmeUrl':'https://github.com/'+repo+'/blob/main/README.md',
            'releaseUrl':'https://github.com/'+repo+'/releases','downloads':[{'name':'Source ZIP','kind':'source-archive','url':'https://github.com/'+repo+'/archive/refs/heads/main.zip'}],
            'topics':['robotics'],'checks':{'readme':True},'evidence':[],'verifiedAt':timezone.now().isoformat()}


class GithubCrawlerTests(TestCase):
    def test_manual_success_and_running_jobs_prevent_duplicate_scheduling(self):
        Job.objects.create(kind='maint-github',key='manual-github',state='done',due=timezone.now())
        Job.objects.create(kind='maint-media',key='manual-media',state='running',due=timezone.now())
        with mock.patch.dict('os.environ',{'HUB_MAINTENANCE':'1','HUB_GITHUB_CRAWL':'1'}):
            maintenance.schedule_jobs()
        self.assertEqual(Job.objects.filter(kind='maint-github').count(),1)
        self.assertEqual(Job.objects.filter(kind='maint-media').count(),1)

    def test_api_caches_and_revalidates_etag(self):
        reply = (b'{"full_name":"maker/robot"}',{'ETag':'abc'},'https://api.github.com/repos/maker/robot',200)
        with mock.patch.object(github_api,'fetch_public',return_value=reply) as fetch:
            github_api.request('/repos/maker/robot')
            github_api.request('/repos/maker/robot')
            self.assertEqual(fetch.call_count,1)
        with mock.patch.object(github_api,'fetch_public',return_value=(b'',{},'',304)) as fetch:
            result = github_api.request('/repos/maker/robot',ttl=0)
        self.assertEqual(result['full_name'],'maker/robot')
        self.assertEqual(fetch.call_args.args[2]['If-None-Match'],'abc')

    def test_rate_limit_pauses_next_call_and_retains_cache(self):
        error = Problem('limited'); error.http_status=429; error.headers={'Retry-After':'120'}
        with mock.patch.object(github_api,'fetch_public',side_effect=error) as fetch:
            with self.assertRaises(Problem): github_api.request('/repos/a/b')
            with self.assertRaises(Problem): github_api.request('/repos/a/c')
        self.assertEqual(fetch.call_count,1)
        self.assertGreater(ExternalCache.objects.get(pk='gh-api:backoff').data['until'],timezone.now().timestamp())

    def test_api_rejects_private_repo(self):
        with mock.patch.object(github_api,'fetch_public',return_value=(b'{"private":true}',{},'',200)):
            with self.assertRaises(Problem): github_api.request('/repos/a/private')
        self.assertFalse(ExternalCache.objects.filter(key__startswith='gh-api:').exists())

    def test_discovery_filters_deduplicates_and_does_not_publish(self):
        repo={'full_name':'maker/robot','description':'robot','stargazers_count':500,'license':{'spdx_id':'MIT'}}
        for change in ({'archived':True},{'private':True},{'fork':True},{'license':None},{'stargazers_count':1}):
            self.assertFalse(github_crawler.eligible(dict(repo,**change)))
        cfg={'activeDays':730,'minStars':100,'maxInspect':8,'sources':[{'name':'Robots','query':'topic:robotics','category':'mech'}]}
        def inspect(name):
            data=details(name)
            ExternalCache.objects.create(pk=github_guides.cache_key(name),data=data,success=timezone.now(),checked=timezone.now())
            return data
        with mock.patch.object(github_crawler,'config',return_value=cfg), mock.patch.object(github_api,'request',return_value={'items':[repo,repo],'total_count':2}), mock.patch.object(github_guides,'inspect',side_effect=inspect):
            first=github_crawler.crawl(); second=github_crawler.crawl()
        self.assertEqual(first['created'],['maker/robot'])
        self.assertEqual(second['created'],[])
        self.assertEqual(len(github_crawler.candidates()),1)
        self.assertTrue(Job.objects.filter(kind='maint-media').exists())
        self.assertEqual(Client().get('/api/hub/feed').json()['total'],0)

    def test_candidate_can_be_reviewed_and_cover_reaches_feed(self):
        data=details();data['discovery']={'reason':'Robot tooling','category':'mech'}
        ExternalCache.objects.create(pk=github_guides.cache_key('maker/robot'),data=data,success=timezone.now())
        ExternalCache.objects.create(pk='maint:project-media',data={'items':{'maker/robot':{'image':'https://example.org/screen.png','credit':'maker/robot'}}},success=timezone.now())
        staff=Member.objects.create_user('reviewer-crawl','reviewer-crawl@example.test',is_staff=True,email_verified=True)
        visitor=Client(); self.assertEqual(visitor.get('/api/hub/maintenance/status').status_code,401)
        user=Member.objects.create_user('reader-crawl','reader-crawl@example.test',email_verified=True)
        with self.assertRaises(Problem): github_guides.curate(user,{'repository':'maker/robot'})
        with self.assertRaises(Problem): github_guides.curate(staff,{'repository':'maker/robot','shelf':'practical','reason':'Helpful'})
        github_guides.curate(staff,{'repository':'maker/robot','shelf':'practical','reason':'Robot assembly learning','checks':dict.fromkeys(('sourceRead','licenseChecked','downloadsChecked'),True)})
        result=visitor.get('/api/hub/feed').json()
        self.assertEqual(result['total'],1)
        self.assertEqual(result['items'][0]['cover'],'https://example.org/screen.png')
        self.assertFalse(result['items'][0]['tested'])
        self.assertEqual(github_crawler.candidates(),[])


class ProjectMediaTests(TestCase):
    def test_sponsor_section_waitlist_and_contributor_montage_are_not_covers(self):
        md='![screenshot](/screen.png)\n## Sponsors\n<img src="paid-ad.png">\n### Partner\n![banner](paid.png)\n## Usage\n![photo](docs/product.jpg)\n![waitlist](waitlist.png)\n<img src="https://contrib.rocks/image?repo=a/b">'
        urls=[i['url'] for i in project_media.image_candidates(md,'a/b','main','docs/README.md')]
        self.assertEqual(urls,['https://raw.githubusercontent.com/a/b/main/screen.png','https://raw.githubusercontent.com/a/b/main/docs/docs/product.jpg'])

    def test_nested_readme_references_html_badges_and_order(self):
        md='![badge](https://img.shields.io/badge/green)\n![logo](logo.png)\n![overview][shot]\n[shot]: images/demo.png\n<img src="../photo.jpg" alt="robot">\n![evil](http://127.0.0.1/a.png)'
        urls=[i['url'] for i in project_media.image_candidates(md,'a/b','main','docs/README.md')]
        self.assertIn('https://raw.githubusercontent.com/a/b/main/docs/images/demo.png',urls)
        self.assertIn('https://raw.githubusercontent.com/a/b/main/photo.jpg',urls)
        self.assertEqual(len(urls),2)

    def test_probe_validates_real_pixels_not_extension(self):
        out=io.BytesIO();Image.new('RGB',(640,400)).save(out,format='PNG')
        with mock.patch.object(maintenance,'get_page',return_value=(out.getvalue(),'https://example.org/a.png')):
            self.assertEqual(project_media.probe('https://example.org/a.png')['width'],640)
        with mock.patch.object(maintenance,'get_page',return_value=(b'<script>alert(1)</script>','https://example.org/a.png')):
            with self.assertRaises(Exception): project_media.probe('https://example.org/a.png')
        out=io.BytesIO();Image.new('RGB',(40,40)).save(out,format='PNG')
        with mock.patch.object(maintenance,'get_page',return_value=(out.getvalue(),'https://example.org/tiny.png')):
            with self.assertRaises(Problem): project_media.probe('https://example.org/tiny.png')

    def test_failed_refresh_preserves_previous_cover_and_timestamp(self):
        old={'image':'https://example.org/old.png','lastSuccess':'2026-01-01T00:00:00Z'}
        ExternalCache.objects.create(pk='maint:project-media',data={'items':{'maker/robot':old}},success=timezone.now())
        data=details();data['discovery']={ 'state':'candidate' }; data['readme']='![screenshot](https://example.org/new.png)'
        ExternalCache.objects.create(pk=github_guides.cache_key('maker/robot'),data=data,success=timezone.now())
        with mock.patch.object(maintenance,'public_data') as base, mock.patch.object(project_media,'probe',side_effect=Problem('offline')):
            (base.return_value.__truediv__.return_value.read_text).return_value='{"projects":[]}'
            result=project_media.collect()
        kept=ExternalCache.objects.get(pk='maint:project-media').data['items']['maker/robot']
        self.assertEqual(kept['image'],old['image']);self.assertEqual(kept['lastSuccess'],old['lastSuccess'])
        self.assertTrue(kept['stale']);self.assertEqual(result['status'],'partial')

    def test_shared_public_fetch_rejects_local_image(self):
        from .discovery import fetch_public
        with self.assertRaises(Problem): fetch_public('https://127.0.0.1/secret.png')

    def test_worker_does_not_label_partial_collection_done(self):
        from .worker import run_one
        job=Job.objects.create(kind='maint-media',key='media-test',due=timezone.now())
        with mock.patch.object(maintenance,'run',return_value={'errors':['offline'],'status':'partial'}): run_one()
        job.refresh_from_db();self.assertEqual(job.state,'partial')
