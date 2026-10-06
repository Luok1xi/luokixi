import json, uuid
from datetime import timedelta
from django.test import TestCase, Client
from django.utils import timezone
from .models import Member, SeatPlan, Notification
from .bookings import advance

class SeatTests(TestCase):
    def setUp(self):
        self.a=Member.objects.create_user('seat-a','seat-a@example.test','Test-seat-A-password12')
        self.b=Member.objects.create_user('seat-b','seat-b@example.test','Test-seat-B-password12')
        self.c=Client();self.c.force_login(self.a)
        n=timezone.now();self.body={'requestKey':str(uuid.uuid4()),'campus':'xueyuanlu','starts':(n+timedelta(days=1)).isoformat(),'ends':(n+timedelta(days=1,hours=2)).isoformat(),'remindAt':(n+timedelta(hours=1)).isoformat(),'preference':'靠窗'}
    def post(self,url,body):return self.c.post('/api/hub/'+url,json.dumps(body),content_type='application/json')
    def test_ownership_and_retries(self):
        p=self.post('bookings',self.body).json()
        self.assertEqual(self.post('bookings',self.body).json()['id'],p['id']);self.assertEqual(SeatPlan.objects.count(),1)
        self.c.force_login(self.b)
        self.assertEqual(self.c.get('/api/hub/bookings').json()['items'],[])
        self.assertEqual(self.c.get('/api/hub/bookings/'+p['id']+'/calendar').status_code,404)
        self.assertEqual(self.post('bookings/'+p['id']+'/action',{'version':1,'action':'cancel'}).status_code,404)
        self.c.logout();self.assertEqual(self.c.get('/api/hub/bookings').status_code,401)
    def test_reminders_idempotent_and_cancellation(self):
        p=self.post('bookings',self.body).json()
        SeatPlan.objects.filter(pk=p['id']).update(remind_at=timezone.now()-timedelta(seconds=1))
        advance();advance();self.assertEqual(Notification.objects.filter(user=self.a,event='reservation').count(),1)
        task=SeatPlan.objects.get(pk=p['id']);self.assertEqual(task.state,'action_required')
        self.body['requestKey']=str(uuid.uuid4());p2=self.post('bookings',self.body).json()
        self.assertEqual(self.post('bookings/'+p2['id']+'/action',{'version':1,'action':'cancel'}).status_code,200)
        SeatPlan.objects.filter(pk=p2['id']).update(remind_at=timezone.now()-timedelta(seconds=1));advance()
        self.assertEqual(Notification.objects.count(),1)
    def test_confirmation_versions_and_calendar(self):
        p=self.post('bookings',self.body).json();u='bookings/'+p['id']+'/action'
        self.assertEqual(self.post(u,{'version':1,'action':'reserved'}).status_code,400)
        r=self.post(u,{'version':1,'action':'reserved','confirmedByOwner':True}).json()
        self.assertFalse(r['providerConfirmed']);self.assertEqual(r['state'],'reported_reserved')
        self.assertEqual(self.post(u,{'version':1,'action':'cancel'}).status_code,409)
        cal=self.c.get('/api/hub/bookings/'+p['id']+'/calendar');self.assertIn(b'BEGIN:VALARM',cal.content);self.assertIn('no-store',cal['Cache-Control'])
        self.assertEqual(self.post(u,{'version':2,'action':'checkin','confirmedByOwner':True}).json()['state'],'checked_in')
    def test_dates_expiry_and_no_provider_calls(self):
        self.assertFalse(self.c.get('/api/hub/bookings/capabilities').json()['automaticSubmission'])
        bad={**self.body,'starts':'2026-10-07T08:00:00'};self.assertEqual(self.post('bookings',bad).status_code,400)
        p=self.post('bookings',self.body).json();SeatPlan.objects.filter(pk=p['id']).update(ends=timezone.now()-timedelta(minutes=1))
        advance();self.assertEqual(SeatPlan.objects.get(pk=p['id']).state,'expired');self.assertEqual(Notification.objects.count(),0)
