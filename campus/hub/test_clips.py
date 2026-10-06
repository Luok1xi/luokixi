import json
import os
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings
from . import clips
from .models import CampusClip, Member, Teacher


class ClipTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = Member.objects.create_user('clip_owner', 'clip@example.test', 'Quartz-river-clips-841', email_verified=True)
        cls.mod = Member.objects.create_user('clip_mod', 'clip-mod@example.test', 'Quartz-river-clips-842', email_verified=True, is_staff=True)
        cls.teacher = Teacher.objects.create(name='视频验收教师', source_url='https://example.test/teacher')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='luokixi-clip-unit-')
        self.addCleanup(self.temp.cleanup)
        self.override = override_settings(DATA=Path(self.temp.name))
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.a, self.m, self.anon = Client(), Client(), Client()
        self.a.force_login(self.owner)
        self.m.force_login(self.mod)

    def post(self, client, route, data, status=200):
        response = client.post('/api/hub/' + route, json.dumps(data), content_type='application/json')
        self.assertEqual(response.status_code, status, response.content)
        return response.json()

    def upload(self, data, status=200, **extra):
        fields = {'file': SimpleUploadedFile('clip.mp4', data, content_type='video/mp4'),
                  'title': '课程经验', 'transcript': '这是独立测试的视频文字稿。',
                  'subjectType': 'teacher', 'subjectId': str(self.teacher.pk), 'rightsConfirmed': 'true', **extra}
        response = self.a.post('/api/hub/clips', fields)
        self.assertEqual(response.status_code, status, response.content)
        return response.json()

    def fixture(self, duration='1', size='320x240'):
        if not clips.encoder():
            self.skipTest('FFmpeg unavailable; run with optional imageio-ffmpeg runtime to validate actual transcoding')
        path = Path(self.temp.name) / 'test-video.mp4'
        flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        subprocess.run([clips.encoder(), '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
            f'color=c=blue:size={size}:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050',
            '-t', duration, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata',
            'comment=private-test-metadata', str(path)], check=True, capture_output=True, timeout=30, **flags)
        return path.read_bytes()

    def test_real_transcode_review_range_and_withdrawal(self):
        uploaded = self.upload(self.fixture())
        self.assertEqual(uploaded['state'], 'queued')
        identifier = uploaded['id']
        stream = f'/api/hub/clips/{identifier}/stream'
        self.assertEqual(self.anon.get(stream).status_code, 404)
        self.assertTrue(clips.run_one())
        clip = CampusClip.objects.get(pk=identifier)
        self.assertEqual(clip.state, 'pending', clip.note)
        self.assertGreater(clip.duration, .8)
        self.assertLess(clip.duration, 1.5)
        self.assertTrue((clips.directory(clip) / 'poster.jpg').is_file())
        self.assertNotIn(b'private-test-metadata', (clips.directory(clip) / 'playback.mp4').read_bytes())
        response = self.a.get(stream, HTTP_RANGE='bytes=0-31')
        self.assertEqual(response.status_code, 206)
        self.assertEqual(len(b''.join(response.streaming_content)), 32)
        self.assertTrue(response['Content-Range'].startswith('bytes 0-31/'))
        self.assertEqual(self.anon.get(stream).status_code, 404)
        self.post(self.m, f'clips/{identifier}/moderate', {'decision': 'approve', 'note': '视频与文字稿已核对'})
        response = self.anon.get(stream, HTTP_RANGE='bytes=-16')
        self.assertEqual(response.status_code, 206)
        self.assertEqual(len(b''.join(response.streaming_content)), 16)
        self.assertEqual(self.anon.get(stream, HTTP_RANGE='bytes=999999999-').status_code, 416)
        self.assertEqual(self.anon.get(f'/api/hub/clips/{identifier}/source').status_code, 404)
        self.assertEqual(self.anon.get('/api/hub/clips?q=文字稿').json()['total'], 1)
        self.post(self.a, f'clips/{identifier}/withdraw', {'note': '作者撤回'})
        self.assertEqual(self.anon.get(stream).status_code, 404)
        self.assertEqual(self.anon.get('/api/hub/clips').json()['total'], 0)

    def test_invalid_video_rejected_by_actual_decoder(self):
        if not clips.encoder():
            self.skipTest('FFmpeg unavailable')
        item = self.upload(b'This is not a video. https://127.0.0.1/private')
        clips.run_one()
        clip = CampusClip.objects.get(pk=item['id'])
        self.assertEqual(clip.state, 'failed')
        self.assertIn('无法解码', clip.note)
        self.assertEqual(self.anon.get(f'/api/hub/clips/{clip.pk}/stream').status_code, 404)

    def test_three_minute_limit_rejects_instead_of_silently_trimming(self):
        item = self.upload(self.fixture(duration='182', size='16x16'))
        clips.run_one()
        clip = CampusClip.objects.get(pk=item['id'])
        self.assertEqual(clip.state, 'failed')
        self.assertIn('超过三分钟', clip.note)
        self.assertFalse((clips.directory(clip) / 'playback.mp4').exists())

    def test_rights_verification_ownership_and_limits(self):
        with patch('hub.clips.encoder', return_value='configured-encoder'):
            self.upload(b'fake', status=400, rightsConfirmed='false')
            self.upload(b'fake', status=400, transcript='')
            with patch('hub.clips.MAX_BYTES', 2):
                self.upload(b'fake', status=400)
            item = self.upload(b'fake')
        self.post(self.anon, f'clips/{item["id"]}/withdraw', {'note': '匿名'}, 401)
        self.post(self.a, f'clips/{item["id"]}/moderate', {'decision': 'approve', 'note': '自审'}, 403)
        self.owner.email_verified = False
        self.owner.save()
        self.upload(b'fake', status=403)

    def test_unconfigured_encoder_and_different_queue(self):
        with patch('hub.clips.encoder', return_value=None):
            self.assertFalse(self.anon.get('/api/hub/clips/capabilities').json()['available'])
            self.upload(b'fake', status=503)
        self.assertFalse(clips.run_one())
