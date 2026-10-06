import io
import json
import tempfile
from datetime import timedelta
from pathlib import Path
from urllib.parse import parse_qs,urlsplit
from PIL import Image
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client,TestCase,override_settings
from django.utils import timezone
from .models import Contribution,Entry,Member


class PlaceTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = Member.objects.create_user('map_author','map-author@example.test',email_verified=True)
        cls.other = Member.objects.create_user('map_reader','map-reader@example.test',email_verified=True)
        cls.mod = Member.objects.create_user('map_mod','map-mod@example.test',is_staff=True,email_verified=True)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        settings = override_settings(MEDIA_ROOT=Path(self.temp.name))
        settings.enable()
        self.addCleanup(settings.disable)
        self.a,self.b,self.m,self.anon = [Client() for _ in range(4)]
        for c,u in ((self.a,self.owner),(self.b,self.other),(self.m,self.mod)):
            c.force_login(u)
        image = Image.new('RGB',(1500,900),'green')
        exif = Image.Exif()
        exif[315] = 'PRIVATE TEST METADATA'
        raw = io.BytesIO()
        image.save(raw,'JPEG',exif=exif)
        response = self.a.post('/api/hub/uploads',{'file':SimpleUploadedFile('test-photo.jpg',raw.getvalue(),'image/jpeg')})
        self.assertEqual(response.status_code,200,response.content)
        self.uid = response.json()['id']
        now = timezone.now()
        self.payload = {'title':'Test temporary discovery','summary':'A disposable place fixture','license':'CC BY 4.0',
            'rightsConfirmed':True,'campus':'shahe','placeType':'discovery','duration':'temporary',
            'location':{'lat':40.1,'lng':116.2,'coordinateSystem':'wgs84','accuracyMeters':10},
            'addressHint':'Test-only public square','observedAt':now.isoformat(),
            'expiresAt':(now+timedelta(hours=1)).isoformat(),'uploads':[self.uid],
            'photoCredit':'Test author','publicLocationConfirmed':True}

    def post(self,client,path,body,code=200):
        response = client.post('/api/hub/'+path,data=json.dumps(body),content_type='application/json')
        self.assertEqual(response.status_code,code,response.content[:400])
        return response.json()

    def publish(self):
        draft = self.post(self.a,'entries',{'kind':'place','data':self.payload})
        self.post(self.a,f"entries/{draft['id']}/submit",{'revision':1})
        self.post(self.m,f"entries/{draft['id']}/review",{'revision':1,'decision':'approve','note':'checked fixture','locationChecked':True})
        return draft['id']

    def test_location_needs_moderation_and_uses_explicit_coordinates(self):
        draft = self.post(self.a,'entries',{'kind':'place','data':self.payload})
        self.assertEqual(self.anon.get('/api/hub/map/places').json()['total'],0)
        self.post(self.a,f"entries/{draft['id']}/submit",{'revision':1})
        self.post(self.m,f"entries/{draft['id']}/review",{'revision':1,'decision':'approve','note':'not checked yet'},400)
        self.post(self.m,f"entries/{draft['id']}/review",{'revision':1,'decision':'approve','note':'coordinates checked','locationChecked':True})
        feature = self.anon.get('/api/hub/map/places?campus=shahe&type=discovery').json()['features'][0]
        self.assertEqual(feature['geometry']['coordinates'],[116.2,40.1])
        params = parse_qs(urlsplit(feature['properties']['navigation']['url']).query)
        self.assertEqual(params['coord_type'],['wgs84'])
        self.assertEqual(params['location'],['40.1,116.2'])
        self.assertEqual(Contribution.objects.filter(user=self.owner,active=True).count(),1)

    def test_public_photo_has_no_exif_and_original_stays_private(self):
        eid = self.publish()
        self.assertEqual(self.anon.get(f'/api/hub/uploads/{self.uid}/file').status_code,404)
        response = self.anon.get(f'/api/hub/uploads/{self.uid}/photo')
        self.assertEqual(response.status_code,200)
        content = b''.join(response.streaming_content)
        response.close()
        with Image.open(io.BytesIO(content)) as preview:
            self.assertLessEqual(max(preview.size),1280)
            self.assertEqual(len(preview.getexif()),0)
        self.assertNotIn(b'PRIVATE TEST METADATA',content)
        original = self.a.get(f'/api/hub/uploads/{self.uid}/file')
        self.assertEqual(original.status_code,200)
        original.close()
        self.post(self.a,f'entries/{eid}/withdraw',{'reason':'Remove test photo'})
        self.assertEqual(self.anon.get(f'/api/hub/uploads/{self.uid}/photo').status_code,404)

    def test_expiry_and_observation_are_not_fake_verification_or_contributions(self):
        eid = self.publish()
        route = f'map/places/{eid}/observe'
        self.post(self.a,route,{'status':'still-there'},400)
        for _ in range(2):
            response = self.post(self.b,route,{'status':'still-there'})
        self.assertEqual(response['observations']['stillThere'],1)
        self.assertFalse(response['contributionAwarded'])
        response = self.post(self.b,route,{'status':'gone'})
        self.assertEqual(response['observations']['stillThere'],0)
        self.assertEqual(response['observations']['gone'],1)
        self.assertEqual(Contribution.objects.filter(user=self.other).count(),0)
        entry = Entry.objects.get(pk=eid)
        entry.published['expiresAt']=(timezone.now()-timedelta(seconds=1)).isoformat()
        entry.save()
        self.assertEqual(self.anon.get('/api/hub/map/places').json()['total'],0)
        archive=self.anon.get('/api/hub/map/places?includeExpired=1').json()['features'][0]
        self.assertTrue(archive['properties']['expired'])
        self.assertIsNone(archive['properties']['navigation']['url'])
        self.post(self.b,route,{'status':'still-there'},409)

    def test_bad_coordinates_foreign_photos_and_excess_lifetime_rejected(self):
        for location in ({'lat':float('nan'),'lng':116,'coordinateSystem':'wgs84'},
                         {'lat':40,'lng':116,'coordinateSystem':'gcj02'},
                         {'lat':91,'lng':116,'coordinateSystem':'wgs84'}):
            self.post(self.a,'entries',{'kind':'place','data':dict(self.payload,location=location)},400)
        self.post(self.b,'entries',{'kind':'place','data':self.payload},403)
        self.post(self.a,'entries',{'kind':'place','data':dict(self.payload,expiresAt=(timezone.now()+timedelta(days=9)).isoformat())},400)
        self.assertEqual(self.anon.get('/api/hub/map/places?bbox=nan,0,1,2').status_code,400)
