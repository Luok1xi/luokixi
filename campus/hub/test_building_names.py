from django.test import TestCase, Client
from .models import Member, Workspace
from .building_names import buildings, KIND

class BuildingNameTests(TestCase):
    def setUp(self):
        self.a=Member.objects.create_user('name_alice','alice@example.test',email_verified=True)
        self.b=Member.objects.create_user('name_bob','bob@example.test',email_verified=True)
        self.client=Client();self.client.force_login(self.a)
        self.osm=next(iter(buildings('xueyuanlu')))
    def vote(self,name,**kw):
        return self.client.post('/api/hub/map/names',data={'campus':'xueyuanlu','osm':self.osm,'name':name,**kw},content_type='application/json')
    def test_one_vote_each_and_change_does_not_inflate(self):
        self.assertEqual(self.vote('一号楼').status_code,200)
        self.assertEqual(self.vote('一号楼').status_code,200)
        self.assertEqual(Workspace.objects.filter(kind=KIND).count(),1)
        self.client.force_login(self.b);self.assertEqual(self.vote('一号楼').status_code,200)
        data=self.client.get('/api/hub/map/names?campus=xueyuanlu').json()['buildings'][self.osm]
        self.assertEqual(data['names'],[{'name':'一号楼','votes':2}])
        self.assertNotIn('owner',data)
        self.vote('同学俗称');self.assertEqual(Workspace.objects.filter(kind=KIND).count(),2)
        self.vote('');self.assertEqual(Workspace.objects.filter(kind=KIND).count(),1)
    def test_validation_auth_and_unknown_building(self):
        self.assertEqual(self.vote('虚构楼',osm='way/not-real').status_code,400)
        self.assertEqual(self.vote('<script>').status_code,400)
        self.client.logout();self.assertEqual(self.vote('一号楼').status_code,401)
        self.assertEqual(self.client.get('/api/hub/map/names?campus=xueyuanlu').status_code,200)

    def test_verified_account_and_dedicated_write_path(self):
        self.a.email_verified=False;self.a.save(update_fields=['email_verified'])
        self.assertEqual(self.vote('一号楼').status_code,403)
        self.a.email_verified=True;self.a.save(update_fields=['email_verified'])
        self.assertEqual(self.vote('一号楼').status_code,200)
        row=Workspace.objects.get(owner=self.a,kind=KIND)
        response=self.client.post(f'/api/hub/workspaces/{row.id}',data={'kind':'personal-import','title':'伪造','version':row.version,'data':{}},content_type='application/json')
        self.assertEqual(response.status_code,400)
        row.refresh_from_db();self.assertEqual(row.kind,KIND)
        self.assertEqual(self.client.post('/api/hub/workspaces',data={'kind':KIND,'title':'伪造','data':{}},content_type='application/json').status_code,400)
