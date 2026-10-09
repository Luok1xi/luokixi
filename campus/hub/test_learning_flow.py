import json
from unittest.mock import patch
from django.test import TestCase
from .models import Member, GuideCourse, Entry, Source, ExternalCache
from .core import canonical_key, Problem
from .discovery import parse_source, refresh_source

class LearningFlowTests(TestCase):
    def setUp(self):
        self.user = Member.objects.create(username='asker', email='asker@example.test', email_verified=True)
        GuideCourse.objects.create(id='linalg', name='线性代数')
        self.client.force_login(self.user)

    def test_help_requires_explicit_public_confirmation(self):
        data={'title':'线代资料','body':'已经看过课本，想找带过程的习题。','courseId':'linalg'}
        response=self.client.post('/api/hub/learning/questions', json.dumps(data), content_type='application/json')
        self.assertEqual(response.status_code,400)
        self.assertFalse(Entry.objects.exists())
        response=self.client.post('/api/hub/learning/questions', json.dumps(dict(data,confirmPublic=True)), content_type='application/json')
        self.assertEqual(response.status_code,200,response.content)
        entry=Entry.objects.get()
        self.assertEqual(entry.state,'pending')
        self.assertEqual(entry.draft['learning']['courseId'],'linalg')
        self.assertEqual(entry.public_revision,0)
        self.assertTrue(entry.watch_set.filter(user=self.user).exists())
        self.client.logout()
        self.assertEqual(self.client.get('/api/hub/entries/'+str(entry.pk)).status_code,404)

    def test_canonical_preserves_distinct_versions(self):
        a={'links':{'source':'https://example.edu/notes'},'learning':{'courseId':'linalg','version':'2025'}}
        b={**a,'learning':{'courseId':'linalg','version':'2026'}}
        self.assertNotEqual(canonical_key('resource',a),canonical_key('resource',b))
        self.assertEqual(canonical_key('resource',a),canonical_key('resource',dict(a)))

    def test_only_maintainer_can_view_sources(self):
        self.assertEqual(self.client.get('/api/hub/learning/sources').status_code,403)
        self.user.is_staff=True;self.user.save()
        self.assertEqual(self.client.get('/api/hub/learning/sources').status_code,200)

    def test_invalid_feed_is_not_an_empty_success(self):
        with self.assertRaises(Problem):parse_source(b'<html><body>login</body></html>','rss','https://example.edu')
        self.assertEqual(parse_source(b'<rss><channel/></rss>','rss','https://example.edu'),[])
        with self.assertRaises(Problem):parse_source(b'<rss><channel><item><title>missing link</title></item></channel></rss>','rss','https://example.edu')

    def test_html_zero_candidates_keeps_last_success_and_flags_failure(self):
        source=Source.objects.create(name='test source',url='https://example.edu/news',kind='html')
        def fetch(target,*args,**kwargs):
            return (b'User-agent: *\nAllow: /' if target.endswith('robots.txt') else b'<html>Empty</html>',{},target,200)
        with patch('hub.discovery.fetch_public',side_effect=fetch),patch('hub.discovery.parse_source',return_value=[]):
            with self.assertRaises(Problem):refresh_source(source.pk)
        source.refresh_from_db();self.assertIsNone(source.last_success);self.assertTrue(source.error)

    def test_empty_rss_and_not_modified_are_distinct_valid_results(self):
        source=Source.objects.create(name='test rss',url='https://example.edu/rss')
        def fetch(target,*args,**kwargs):
            return (b'User-agent: *\nAllow: /' if target.endswith('robots.txt') else b'<rss><channel/></rss>',{},target,200)
        with patch('hub.discovery.fetch_public',side_effect=fetch):self.assertEqual(refresh_source(source.pk)['status'],'empty')
        def unmodified(target,*args,**kwargs):return (b'User-agent: *\nAllow: /',{},target,200) if target.endswith('robots.txt') else (b'',{},target,304)
        with patch('hub.discovery.fetch_public',side_effect=unmodified):self.assertEqual(refresh_source(source.pk)['status'],'unchanged')
        self.assertEqual(ExternalCache.objects.get(key='source-health:'+str(source.pk)).data['status'],'unchanged')
