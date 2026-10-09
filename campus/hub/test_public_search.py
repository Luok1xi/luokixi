import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from django.test import Client, TestCase
from django.utils import timezone
from .models import ExternalCache, GuideCourse, Teacher


class PublicSearchTests(TestCase):
    def test_directory_alias_typo_and_identity_remain_separate(self):
        for code in ('linear-a', 'linear-b'):
            GuideCourse.objects.create(id=code, name='线性代数', faculty='数学学院')
        GuideCourse.objects.create(id='python-a', name='Python 入门 2024')
        GuideCourse.objects.create(id='python-b', name='Python 入门 2025')
        data = self.client.get('/api/hub/courses', {'q':'线代'}).json()
        self.assertEqual({row['id'] for row in data['items']}, {'linear-a','linear-b'})
        result = self.client.get('/api/hub/courses', {'q':'pyhton 2024'}).json()
        self.assertEqual([row['id'] for row in result['items']], ['python-a'])

    def test_inactive_teachers_do_not_appear_in_fuzzy_results(self):
        Teacher.objects.create(name='Python Research', faculty='CS', active=False)
        wanted = Teacher.objects.create(name='Python Research', faculty='CS', active=True)
        result = self.client.get('/api/hub/teachers', {'q':'pyhton'}).json()
        self.assertEqual([row['id'] for row in result['items']], [str(wanted.pk)])

    def test_repository_typo_rank_and_publication_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory)
            (base/'community.json').write_text(json.dumps({'projects':[{'slug':'notebook','repo':{'fullName':'student/notebook'}}]}),encoding='utf-8')
            for repository in ('student/notebook', 'draft/notebook'):
                ExternalCache.objects.create(key='github:'+repository,success=timezone.now(),data={
                    'repository':repository,'url':'https://github.com/'+repository,'description':'Daily notebook',
                    'topics':['productivity'],'downloads':[],'evidence':[],
                    'guide':{'reviewState':'pending','oneLiner':'private-search-secret'}})
            with patch('hub.maintenance.public_data',return_value=base):
                data=Client().get('/api/hub/repositories',{'q':'notebok'}).json()
                self.assertEqual([row['repository'] for row in data['items']], ['student/notebook'])
                self.assertEqual(Client().get('/api/hub/repositories',{'q':'private-search-secret'}).json()['total'],0)
