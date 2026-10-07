import base64
import hashlib
import json
import tempfile
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from django.test import Client, TestCase, override_settings
from django.utils import timezone
from .core import Problem
from .models import Entry, ExternalCache, Member, MirrorAsset, Notification, StudioDay
from .github_guides import cache_key
from .test_github_crawler import details
from . import project_catalog as catalog, project_summaries as summaries, supervisor, mirror


def fixture():
    d=details('fixture/robot');d['topics']=['robotics','esp32'];d['description']='Robot firmware for embedded controllers'
    d['evidence']=[{'id':'repository','url':d['url'],'text':d['description']},{'id':'readme-1','url':d['readmeUrl'],'text':'Robot firmware, MIT license. Use a microcontroller.'}]
    return d


def model_guide():
    return {'oneLiner':'机器人控制器参考项目','sections':[{'id':key,'heading':label,'text':'这是依据公开项目说明整理的中文内容。原项目未说明的部分需要实际核对。','evidenceIds':['readme-1']} for key,label in summaries.CHAPTERS],
            'unknowns':['尚未实测'],'suggestedShelf':'potential','selectionReason':'可用于了解控制器'}


class ProjectRepositoryTests(TestCase):
    def setUp(self):
        self.staff=Member.objects.create_user('robot-owner','robot-owner@example.test',is_staff=True,email_verified=True)
        self.reader=Member.objects.create_user('robot-reader','robot-reader@example.test',email_verified=True)
        self.client.force_login(self.staff)
        self.data=fixture()
        ExternalCache.objects.create(pk=cache_key('fixture/robot'),data=self.data,success=timezone.now())
        self.cfg={'summary_provider':'codex','summary_model':'test-model','owner_id':self.staff.pk,'daily_cny':Decimal('5'),'codex_daily_calls':2}

    def test_multilabel_explanations_and_unknown_category(self):
        result=catalog.classify(self.data)
        self.assertEqual({x['id'] for x in result['labels']},{'mech','embedded'})
        self.assertTrue(all(x['reasons'] for x in result['labels']))
        self.assertEqual(catalog.classify({'repository':'someone/thing','description':'Unspecified'})['primary'],'unclassified')

    def test_classification_preserves_editor_and_does_not_invalidate_guide(self):
        before=catalog.fingerprint(self.data)
        catalog.organize_repository('fixture/robot')
        d=ExternalCache.objects.get(pk=cache_key('fixture/robot')).data
        self.assertEqual(catalog.fingerprint(d),before)
        d['classification']={'method':'maintainer','primary':'course','labels':[{'id':'course','name':'课程'}]}
        ExternalCache.objects.filter(pk=cache_key('fixture/robot')).update(data=d)
        catalog.organize_repository('fixture/robot')
        self.assertEqual(ExternalCache.objects.get(pk=cache_key('fixture/robot')).data['classification']['primary'],'course')

    def test_motor_control_topic_not_mistaken_for_coding_exercises(self):
        result=catalog.classify({'repository':'simplefoc/Arduino-FOC','topics':['arduino','foc-algorithm'],'description':'A BLDC motor control library','evidence':[]})
        self.assertEqual(result['primary'],'embedded')
        self.assertNotIn('algo',[label['id'] for label in result['labels']])

    def test_download_platform_is_explicit_and_zip_is_not_installer(self):
        self.assertEqual(catalog.download_hint({'name':'tool-win-arm64.exe'})['platform'],'windows')
        self.assertEqual(catalog.download_hint({'name':'tool.zip'})['platform'],'unknown')
        self.assertFalse(catalog.download_hint({'name':'windows.zip','kind':'source-archive'})['installable'])

    def test_directory_hides_candidates_and_supports_classification_search(self):
        with patch('hub.maintenance.public_data',return_value=Path('/nonexistent')):
            self.assertEqual(Client().get('/api/hub/repositories').json()['total'],0)
            self.assertEqual(Client().get('/api/hub/repositories?includePending=1').status_code,403)
            result=self.client.get('/api/hub/repositories?includePending=1&category=embedded&q=机器人').json()
            self.assertEqual(result['total'],1)
            self.assertEqual(self.client.get('/api/hub/repositories?includePending=1&download=local').json()['total'],0)
            self.assertEqual(self.client.get('/api/hub/repositories?category=nonsense').status_code,400)

    def test_model_output_is_cited_reviewed_separately_and_cached(self):
        with patch.object(summaries,'provider_config',return_value=self.cfg),patch.object(summaries,'call_model',return_value=(model_guide(),'test-model',{})) as call:
            guide=summaries.generate('fixture/robot','qa1')
            summaries.generate('fixture/robot','qa2')
            self.assertEqual(call.call_count,1)
        self.assertEqual(guide['reviewState'],'pending')
        self.assertEqual(StudioDay.objects.get().codex_calls,1)
        self.assertEqual(Client().get('/api/hub/github/project?repository=fixture/robot').json()['guide']['state'],'awaiting-review')
        summaries.review(self.staff,{'repository':'fixture/robot','sourceFingerprint':guide['sourceFingerprint'],'approve':True,'note':'已逐章核对'})
        public=Client().get('/api/hub/github/project?repository=fixture/robot').json()
        self.assertEqual(len(public['guide']['sections']),10)
        d=ExternalCache.objects.get(pk=cache_key('fixture/robot'));d.data['downloads'].append({'name':'new','url':'https://github.com/fixture/robot/releases'});d.save()
        with self.assertRaises(Problem): summaries.review(self.staff,{'repository':'fixture/robot','sourceFingerprint':guide['sourceFingerprint'],'approve':True,'note':'outdated'})

    def test_failed_model_call_not_retried_and_budget_shared(self):
        value=model_guide();value['sections'][0]['evidenceIds']=['invented']
        with patch.object(summaries,'provider_config',return_value=self.cfg),patch.object(summaries,'call_model',return_value=(value,'test-model',{})) as call:
            with self.assertRaises(Problem): summaries.generate('fixture/robot','failed')
            with self.assertRaises(Problem): summaries.generate('fixture/robot','failed')
            self.assertEqual(call.call_count,1)
            self.assertEqual(StudioDay.objects.get().codex_calls,1)
            StudioDay.objects.all().update(codex_calls=2)
            with self.assertRaises(Problem): summaries.generate('fixture/robot','new')
            self.assertEqual(call.call_count,1)

    def test_model_use_requires_owner_not_ordinary_registered_user(self):
        self.client.force_login(self.reader)
        with patch.object(summaries,'provider_config',return_value=self.cfg):
            self.assertEqual(self.client.post('/api/hub/github/summarize',json.dumps({'repository':'fixture/robot'}),content_type='application/json').status_code,403)

    @patch.dict('os.environ', {'HUB_BEIKUANG':'0'})
    def test_supervisor_asks_and_owner_answer_does_not_publish(self):
        d=ExternalCache.objects.get(pk=cache_key('fixture/robot'));d.data['license']=None;d.save()
        catalog.organize_repository('fixture/robot')
        result=supervisor.inspect_all()
        self.assertEqual(result['questions'],['fixture/robot'])
        case=supervisor.status()['cases'][0]
        self.assertTrue(any('许可' in q for q in case['questions']))
        inbox=self.client.get('/api/hub/notifications').json()
        self.assertEqual(inbox['items'][0]['action']['kind'],'review-supervisor')
        supervisor.answer(self.staff,{'id':case['id'],'answer':'先保留原站链接，不镜像。'})
        self.assertEqual(supervisor.status()['cases'],[])
        self.assertFalse(Entry.objects.filter(state='published').exists())
        self.assertFalse(supervisor.inspect_all()['questions'])

    @patch.dict('os.environ', {'HUB_BEIKUANG':'1'})
    def test_supervisor_escalation_reaches_beikuang_without_ordinary_notice(self):
        from . import beikuang
        from .models import BeikuangTask, Job
        d=ExternalCache.objects.get(pk=cache_key('fixture/robot'));d.data['license']=None;d.save()
        supervisor.inspect_all()
        self.assertFalse(Notification.objects.filter(user=self.staff,event='maintenance').exists())
        self.assertTrue(BeikuangTask.objects.filter(kind='notice',target__startswith='supervisor:').exists())
        self.assertTrue(Job.objects.filter(kind='maint-beikuang',state='queued').exists())
        result={'published':[],'escalated':[]}
        beikuang.review_cases(self.staff,result)
        self.assertEqual(len(result['escalated']),1)
        case=supervisor.status()['cases'][0]
        self.assertEqual(result['escalated'][0].target,case['id'])
        supervisor.answer(self.staff,{'id':case['id'],'answer':'仅提供原站链接，暂不镜像。'})
        beikuang.sweep()
        self.assertFalse(BeikuangTask.objects.filter(target=case['id'],state='escalated').exists())
        self.assertFalse(Entry.objects.filter(state='published').exists())

    def test_supervisor_announcement_is_grounded_draft_and_needs_answers(self):
        evidence=[{'id':'one','url':'https://github.com/fixture/robot','text':'新增一个项目说明'}]
        value={'title':'同学们，新的项目说明来了','body':'我是北矿娘。这次给大家整理了一份项目说明。','evidenceIds':['one'],'questions':['请确认说明适用范围。']}
        with patch.object(summaries,'provider_config',return_value=self.cfg),patch.object(summaries,'call_model',return_value=(value,'test-model',{})),patch.object(supervisor,'facts',return_value=evidence):
            result=supervisor.draft_announcement('qa-announcement')
        entry=Entry.objects.get(pk=result['entryId'])
        self.assertEqual(entry.state,'pending')
        self.assertIn('北矿娘',entry.draft['credit'])
        body={'revision':1,'decision':'approve','note':'核对事实'}
        response=self.client.post(f'/api/hub/entries/{entry.pk}/review',json.dumps(body),content_type='application/json')
        self.assertEqual(response.status_code,400)
        body['supervisorQuestionsResolved']=True
        self.assertEqual(self.client.post(f'/api/hub/entries/{entry.pk}/review',json.dumps(body),content_type='application/json').status_code,200)


@override_settings(MEDIA_ROOT=Path(tempfile.mkdtemp()))
class MirrorIntegrityTests(TestCase):
    def api(self,path):
        if '/commits/' in path:return {'sha':'a'*40}
        if '/license?' in path:return {'license':{'spdx_id':'MIT'},'content':base64.b64encode(b'MIT License fixture').decode()}
        if path.endswith('/releases/latest'): return {'tag_name':'v1','html_url':'https://github.com/fixture/tool/releases/tag/v1',
             'assets':[{'id':1,'name':'tool-win-x64.exe','size':5,'updated_at':'2026-10-07','digest':'sha256:'+hashlib.sha256(b'bytes').hexdigest(),
                        'browser_download_url':'https://github.com/fixture/tool/releases/download/v1/tool-win-x64.exe'}]}
        return {'full_name':'fixture/tool','license':{'spdx_id':'MIT'},'default_branch':'main'}

    def stream(self,url,path,limit):
        content=b'source' if 'codeload' in url else b'bytes'
        path.write_bytes(content)
        return len(content),hashlib.sha256(content).hexdigest(),url

    def test_real_local_bytes_range_license_and_idempotence(self):
        with patch.object(mirror,'github_json',side_effect=self.api),patch.object(mirror,'stream_public',side_effect=self.stream) as stream:
            result=mirror.mirror_repository('fixture/tool');mirror.mirror_repository('fixture/tool')
        self.assertEqual(stream.call_count,2)
        self.assertEqual(result['status'],'ok')
        asset=MirrorAsset.objects.get(name='tool-win-x64.exe')
        info=mirror.serialize(asset)
        self.assertEqual(info['integrity'],'upstream-sha256-matched')
        response=self.client.get(info['url'],HTTP_RANGE='bytes=1-3')
        self.assertEqual(response.status_code,206);self.assertEqual(b''.join(response.streaming_content),b'yte')
        self.assertEqual(response['Content-Range'],'bytes 1-3/5')
        self.assertEqual(self.client.get(info['url'],HTTP_RANGE='bytes=9-').status_code,416)
        self.assertIn(b'MIT',self.client.get(info['licenseUrl']).content)
        from .mirror_store import local_path
        local_path(asset).unlink()
        self.assertFalse(mirror.serialize(asset)['available'])
        self.assertEqual(self.client.get(info['url']).status_code,410)

    def test_digest_mismatch_is_not_saved_and_quota_is_enforced(self):
        def corrupt(url,path,limit):
            content=b'wrong';path.write_bytes(content)
            return len(content),hashlib.sha256(content).hexdigest(),url
        with patch.object(mirror,'github_json',side_effect=self.api),patch.object(mirror,'stream_public',side_effect=corrupt):
            result=mirror.mirror_repository('fixture/tool')
        self.assertEqual(result['status'],'partial')
        self.assertFalse(MirrorAsset.objects.filter(name__endswith='.exe').exists())
        with patch.object(mirror,'MAX_TOTAL_BYTES',0),patch.object(mirror,'github_json',side_effect=self.api),patch.object(mirror,'stream_public') as stream:
            mirror.mirror_repository('fixture/tool');stream.assert_not_called()

    def test_license_mismatch_blocks_without_download(self):
        def api(path):
            d=self.api(path)
            if '/license?' in path: d['license']['spdx_id']='GPL-3.0'
            return d
        with patch.object(mirror,'github_json',side_effect=api),patch.object(mirror,'stream_public') as stream:
            self.assertEqual(mirror.mirror_repository('fixture/tool')['status'],'license-blocked')
            stream.assert_not_called()
