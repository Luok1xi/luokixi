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
from .core import Problem, validate_payload
from .models import Contribution,Entry,Member
from .places import EVENT_FIELDS


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

    def event_payload(self,**fields):
        payload = dict(self.payload,placeType='event',duration='permanent')
        payload.pop('observedAt')
        payload.pop('expiresAt')
        payload.update(fields)
        return payload

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

    def test_legacy_places_and_events_do_not_invent_activity_fields(self):
        for payload in (self.payload,self.event_payload()):
            draft = self.post(self.a,'entries',{'kind':'place','data':payload})
            saved = Entry.objects.get(pk=draft['id']).draft
            self.assertFalse(EVENT_FIELDS.intersection(saved))
            self.assertEqual(saved['observedAt'],payload.get('observedAt'))
            self.assertEqual(saved['expiresAt'],payload.get('expiresAt'))
        # Even a dated temporary event still has no inferred activity schedule.
        temporary = validate_payload('place',dict(self.payload,placeType='event'),self.owner)
        self.assertTrue(temporary['observedAt'])
        self.assertTrue(temporary['expiresAt'])
        self.assertNotIn('startsAt',temporary)
        self.assertNotIn('endsAt',temporary)

    def test_event_details_survive_draft_submission_review_and_public_map(self):
        start = timezone.now()+timedelta(days=2)
        building = {'campus':'shahe','osm':'way:123','name':'测试教学楼','center':[116.2,40.1]}
        fields = {'startsAt':start.isoformat(),'endsAt':(start+timedelta(hours=2)).isoformat(),
                  'building':building,'registrationURL':'https://example.test/register?event=fixture',
                  'reminderMinutes':30}
        draft = self.post(self.a,'entries',{'kind':'place','data':self.event_payload(
            **fields,links={'source':'https://example.test/official-event'})})
        eid = draft['id']
        entry = Entry.objects.get(pk=eid)
        for key,value in fields.items():
            self.assertEqual(entry.draft[key],value)
        self.assertNotIn('locationReviewedAt',entry.draft)
        self.assertEqual(self.anon.get(f'/api/hub/entries/{eid}').status_code,404)
        self.post(self.a,f'entries/{eid}/submit',{'revision':1})
        self.post(self.m,f'entries/{eid}/review',{'revision':1,'decision':'approve','note':'fixture without coordinate confirmation'},400)
        self.post(self.m,f'entries/{eid}/review',{'revision':1,'decision':'approve','note':'reviewed event fixture','locationChecked':True})
        public = self.anon.get(f'/api/hub/entries/{eid}').json()['data']
        feature = self.anon.get('/api/hub/map/places?campus=shahe&type=event').json()['features'][0]
        self.assertEqual(feature['id'],eid)
        for key,value in fields.items():
            self.assertEqual(public[key],value)
            self.assertEqual(feature['properties']['data'][key],value)
        self.assertEqual(public['links']['source'],'https://example.test/official-event')
        self.assertTrue(public['locationReviewedAt'])
        self.assertIsNone(public['observedAt'])
        self.assertIsNone(public['expiresAt'])

    def test_activity_fields_are_rejected_for_every_non_event_classification(self):
        fields = {'startsAt':'2026-10-08T09:00:00+08:00','endsAt':'2026-10-08T10:00:00+08:00',
                  'building':None,'registrationURL':'','reminderMinutes':0}
        for kind in ('facility','study','food','sports','scenery','discovery'):
            for key,value in fields.items():
                with self.subTest(kind=kind,field=key),self.assertRaises(Problem):
                    validate_payload('place',dict(self.payload,placeType=kind,**{key:value}),self.owner)
        self.post(self.a,'entries',{'kind':'place','data':dict(self.payload,reminderMinutes=0)},400)

    def test_activity_time_pairs_are_strict_and_failed_edits_preserve_draft(self):
        start = timezone.now()+timedelta(days=2)
        good = {'startsAt':start.isoformat(),'endsAt':(start+timedelta(hours=1)).isoformat()}
        invalid = [
            {'startsAt':good['startsAt']},{'endsAt':good['endsAt']},
            {'startsAt':None,'endsAt':None},{'startsAt':'','endsAt':''},
            {'startsAt':'2026-10-08T09:00:00','endsAt':'2026-10-08T10:00:00'},
            {'startsAt':'2026-02-30T09:00:00+08:00','endsAt':good['endsAt']},
            {'startsAt':'2026-10-08 09:00:00+08:00','endsAt':good['endsAt']},
            {'startsAt':'2026-10-08T09:00+08:00','endsAt':good['endsAt']},
            {'startsAt':'2026-10-08T09:00:00+00:60','endsAt':good['endsAt']},
            {'startsAt':good['startsAt'],'endsAt':good['startsAt']},
            {'startsAt':good['endsAt'],'endsAt':good['startsAt']},
            {'startsAt':(timezone.now()+timedelta(days=731)).isoformat(),'endsAt':(timezone.now()+timedelta(days=732)).isoformat()},
            {'startsAt':good['startsAt'],'endsAt':(timezone.now()+timedelta(days=731)).isoformat()},
        ]
        for fields in invalid:
            with self.subTest(fields=fields),self.assertRaises(Problem):
                validate_payload('place',self.event_payload(**fields),self.owner)
        draft = self.post(self.a,'entries',{'kind':'place','data':self.event_payload(**good)})
        original = Entry.objects.get(pk=draft['id']).draft
        self.post(self.a,f"entries/{draft['id']}/save",{'revision':1,'data':self.event_payload(startsAt=good['startsAt'])},400)
        unchanged = Entry.objects.get(pk=draft['id'])
        self.assertEqual(unchanged.revision,1)
        self.assertEqual(unchanged.draft,original)

    def test_activity_building_url_and_reminder_require_valid_explicit_values(self):
        valid = {'campus':'shahe','osm':'way:123','name':'教学楼','center':[116.2,40.1]}
        for building in ({**valid,'campus':'xueyuanlu'},{**valid,'osm':''},{**valid,'osm':'x'*41},
                         {**valid,'center':[181,40]},{**valid,'center':[116,91]},
                         {**valid,'center':[True,40]},{**valid,'center':[116,float('nan')]},'教学楼'):
            with self.subTest(building=building),self.assertRaises(Problem):
                validate_payload('place',self.event_payload(building=building),self.owner)
        for value in ('ftp://example.test/', 'javascript:alert(1)', 'https://user:password@example.test/',
                      'https://@example.test/', 'https://example.test:bad/', 'https://[invalid/',
                      'https://example.test/\npath','https://example.test/'+'x'*1000,None):
            with self.subTest(url=value),self.assertRaises(Problem):
                validate_payload('place',self.event_payload(registrationURL=value),self.owner)
        for value in (-1,121,1.5,True,'15',None):
            with self.subTest(reminder=value),self.assertRaises(Problem):
                validate_payload('place',self.event_payload(reminderMinutes=value),self.owner)
        for reminder in (0,120):
            normalized = validate_payload('place',self.event_payload(building=None,registrationURL='',reminderMinutes=reminder),self.owner)
            self.assertIsNone(normalized['building'])
            self.assertEqual(normalized['registrationURL'],'')
            self.assertEqual(normalized['reminderMinutes'],reminder)
            self.assertNotIn('startsAt',normalized)
        normalized = validate_payload('place',self.event_payload(building={**valid,'center':None,'extra':'discard'}),self.owner)
        self.assertEqual(normalized['building'],{**valid,'center':None})

    def test_timezones_compare_instants_and_activity_fields_do_not_bypass_place_rules(self):
        # UTC and an explicit Shanghai offset denote the same instant.
        with self.assertRaises(Problem):
            validate_payload('place',self.event_payload(startsAt='2026-10-08T09:00:00+08:00',endsAt='2026-10-08T01:00:00Z'),self.owner)
        good = self.event_payload(startsAt='2026-10-08T09:00:00+08:00',endsAt='2026-10-08T02:00:00Z')
        normalized = validate_payload('place',good,self.owner)
        self.assertEqual(normalized['startsAt'],'2026-10-08T09:00:00+08:00')
        self.assertEqual(normalized['endsAt'],'2026-10-08T02:00:00+00:00')
        for changed in ({'location':None},{'uploads':[]},{'publicLocationConfirmed':False}):
            with self.subTest(changed=changed),self.assertRaises(Problem):
                validate_payload('place',dict(good,**changed),self.owner,submit=True)
        with self.assertRaises(Problem):
            validate_payload('place',dict(good,duration='temporary'),self.owner,submit=True)
