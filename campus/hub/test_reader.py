import hashlib
import io
import json
import tempfile
import uuid
import zipfile
from pathlib import Path
from django.test import Client, TestCase, override_settings
from django.core.files.uploadedfile import SimpleUploadedFile
from .models import Asset, Entry, Member, MirrorAsset, Reply, Upload


class DeveloperAndReaderTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.settings = override_settings(MEDIA_ROOT=self.root)
        self.settings.enable(); self.addCleanup(self.settings.disable)
        self.dev = Member.objects.create_superuser('developer', 'dev@localhost.invalid', 'Test-only-strong-739', email_verified=False)
        self.normal = Member.objects.create_user('normal', 'normal@example.test', 'Test-only-strong-739', email_verified=False)
        self.mod = Member.objects.create_user('moderator', 'mod@example.test', 'Test-only-strong-739', is_staff=True, email_verified=False)
        self.client.force_login(self.dev)
        self.public = Entry.objects.create(owner=self.normal, slug='public-reader', kind='topic', state='published',
            public_revision=1, revision=2, published={'title':'公开内容','body':'可以阅读的正文'}, draft={'title':'secret draft','body':'DO NOT LEAK'})

    def test_unverified_developer_replies_uploads_without_faking_mailbox(self):
        user=self.client.get('/api/hub/auth/session').json()['user']
        self.assertTrue(user['canParticipate']); self.assertTrue(user['developer']); self.assertFalse(user['emailVerified'])
        r=self.client.post(f'/api/hub/entries/{self.public.pk}/replies',json.dumps({'body':'开发者测试'}),content_type='application/json')
        self.assertEqual(r.status_code,200,r.content); self.assertEqual(r.json()['state'],'published')
        r=self.client.post('/api/hub/uploads',{'file':SimpleUploadedFile('note.txt','测试文件'.encode())})
        self.assertEqual(r.status_code,200,r.content)
        self.dev.refresh_from_db(); self.assertFalse(self.dev.email_verified)

    def test_regular_accounts_and_nicknames_cannot_grant_developer_bypass(self):
        for member in [self.normal,self.mod]:
            member.display_name='开发者'; member.save()
            self.client.force_login(member)
            self.assertFalse(self.client.get('/api/hub/auth/session').json()['user']['canParticipate'])
            r=self.client.post(f'/api/hub/entries/{self.public.pk}/replies','{"body":"test"}',content_type='application/json')
            self.assertEqual(r.status_code,403)
        self.client.force_login(self.normal)
        self.client.post('/api/hub/auth/profile','{"developer":true,"canParticipate":true,"is_superuser":true}',content_type='application/json')
        self.normal.refresh_from_db();self.assertFalse(self.normal.is_superuser)
        from .core import can_participate
        self.dev.is_active=False;self.assertFalse(can_participate(self.dev))

    def upload(self,name,raw):
        sha=hashlib.sha256(raw).hexdigest(); path=sha+Path(name).suffix
        (self.root/path).write_bytes(raw)
        asset=Asset.objects.create(sha256=sha,size=len(raw),extension=Path(name).suffix,path=path)
        return Upload.objects.create(owner=self.normal,asset=asset,name=name)

    def test_reader_and_inline_keep_private_files_private(self):
        u=self.upload('private.pdf',b'%PDF-1.4\nprivate')
        for tail in ['', '/inline']:
            self.assertEqual(Client().get(f'/api/hub/reader/upload/{u.pk}'+tail).status_code,404)
        self.client.force_login(self.normal)
        r=self.client.get(f'/api/hub/reader/upload/{u.pk}/inline')
        self.assertEqual(r.status_code,200);self.assertEqual(r['X-Frame-Options'],'SAMEORIGIN')
        self.assertEqual(r['Content-Type'],'application/pdf');r.close()

    def test_exports_only_published_revision_and_public_replies(self):
        Reply.objects.create(entry=self.public,author=self.normal,body='PUBLIC REPLY',state='published')
        Reply.objects.create(entry=self.public,author=self.normal,body='PRIVATE REPLY',state='pending')
        r=Client().get(f'/api/hub/reader/entry/{self.public.pk}/download')
        self.assertEqual(r.status_code,200);body=r.content.decode()
        self.assertIn('PUBLIC REPLY',body);self.assertNotIn('PRIVATE REPLY',body);self.assertNotIn('DO NOT LEAK',body)
        self.public.public_revision=0;self.public.save()
        self.assertEqual(Client().get(f'/api/hub/reader/entry/{self.public.pk}').status_code,404)

    def test_public_photo_reader_uses_existing_sanitized_derivative(self):
        from PIL import Image
        raw=io.BytesIO(); Image.new('RGB',(80,80),'red').save(raw,format='JPEG')
        photo=self.upload('photo.jpg',raw.getvalue())
        self.public.published={'title':'公开图片','circle':'daily','uploads':[str(photo.pk)]};self.public.save()
        r=Client().get(f'/api/hub/reader/upload/{photo.pk}')
        self.assertEqual(r.status_code,200,r.content)
        self.assertEqual(r.json()['mode'],'image')
        self.assertTrue(r.json()['downloadUrl'].endswith('/photo'))

    def test_archive_reads_selected_code_without_extracting_or_reading_traversal(self):
        folder=self.root/'mirror';folder.mkdir()
        path=folder/(uuid.uuid4().hex+'.zip')
        with zipfile.ZipFile(path,'w') as z:
            z.writestr('repo/README.md','# Read me');z.writestr('../secret.txt','secret');z.writestr('repo/app.exe',b'bin')
            z.writestr('repo/large.txt',b'a'*(256*1024+1))
        asset=MirrorAsset.objects.create(repository='owner/repo',tag='v1',name='source.zip',path=path.name,size=path.stat().st_size,
            sha256=hashlib.sha256(path.read_bytes()).hexdigest(),license='MIT',source_url='https://example.test/source.zip')
        url=f'/api/hub/reader/mirror/{asset.pk}'
        r=Client().get(url);self.assertEqual(r.status_code,200,r.content)
        self.assertEqual(r.json()['fileCount'],3)
        self.assertEqual(Client().get(url,{'member':'repo/README.md'}).json()['text'],'# Read me')
        self.assertEqual(Client().get(url,{'member':'../secret.txt'}).status_code,404)
        self.assertEqual(Client().get(url,{'member':'repo/large.txt'}).status_code,422)
        self.assertEqual(Client().get(url,{'member':'repo/app.exe'}).status_code,422)
        path.write_bytes(b'not a zip');asset.size=path.stat().st_size;asset.save()
        broken=Client().get(url);self.assertEqual(broken.status_code,200)
        self.assertEqual(broken.json()['mode'],'download')
        self.assertTrue(broken.json()['downloadUrl'].endswith('/file'))
