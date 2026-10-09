"""Exercise real snapshot/restore boundaries, including restored HTTP login/download."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from unittest.mock import patch
import zipfile

from django.test import SimpleTestCase, override_settings
from . import backup


class BackupTests(SimpleTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.project = self.base / 'project'
        self.campus = self.project / 'campus'
        self.data = self.campus / '.data' / 'hub'
        self.media = self.data / 'uploads'
        self.library = self.campus / '.data'
        self.private = self.base / 'private-backups'
        self.media.mkdir(parents=True)
        self.db = self.data / 'community.sqlite3'
        with closing(sqlite3.connect(self.db)) as db:
            db.executescript('CREATE TABLE hub_member(id INTEGER PRIMARY KEY, username TEXT);'
                             'CREATE TABLE hub_entry(id TEXT PRIMARY KEY, state TEXT);'
                             'CREATE TABLE hub_asset(path TEXT, sha256 TEXT, size INTEGER);'
                             'CREATE TABLE hub_mirrorasset(path TEXT, sha256 TEXT, size INTEGER);'
                             "INSERT INTO hub_member VALUES(1,'fixture-user');"
                             "INSERT INTO hub_entry VALUES('post','published');")
            db.commit()
        self.options = override_settings(BASE=self.campus, DATA=self.data, MEDIA_ROOT=self.media,
            SECRET_KEY='test-signing-key-not-an-api-key', DATABASES={'default': {
                'ENGINE': 'django.db.backends.sqlite3', 'NAME': self.db}})
        self.options.enable()
        self.addCleanup(self.options.disable)
        self.env = patch.dict(os.environ, {'HUB_BACKUP_DIR': str(self.private), 'CAMPUS_DATA_DIR': str(self.library)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def asset(self, value=b'Fixture uploaded data.', name='fixture.txt', mirror=False):
        folder = self.media / 'mirror' if mirror else self.media
        folder.mkdir(exist_ok=True)
        (folder / name).write_bytes(value)
        with closing(sqlite3.connect(self.db)) as db:
            table = 'hub_mirrorasset' if mirror else 'hub_asset'
            db.execute(f'INSERT INTO {table} VALUES(?,?,?)', (name, hashlib.sha256(value).hexdigest(), len(value)))
            db.commit()
        return value

    def test_snapshot_restores_accounts_reviews_orphan_assets_mirrors_and_public_files(self):
        uploaded = self.asset()
        self.asset(b'official-mirror', 'abc123.zip', mirror=True)
        with closing(sqlite3.connect(self.db)) as db:
            db.executescript("CREATE TABLE hub_audit(id INTEGER, action TEXT); INSERT INTO hub_audit VALUES(1,'entry-review');")
            db.commit()
        public = self.project / 'public' / 'files'
        public.mkdir(parents=True)
        (public / 'private-exam.txt').write_text('private exam', encoding='utf-8')
        (self.data / 'studio-config.json').write_text('{"api_key":"must-never-copy"}', encoding='utf-8')
        (self.media / 'studio-config.json').write_text('{"api_key":"must-never-copy"}', encoding='utf-8')
        (self.data / 'mail-preview').mkdir()
        (self.data / 'mail-preview' / 'reset.txt').write_text('private reset token', encoding='utf-8')
        item = backup.create_backup()
        archive = self.private / item['id']
        with zipfile.ZipFile(archive) as zip:
            names = zip.namelist()
            self.assertNotIn('hub/uploads/studio-config.json', names)
            self.assertFalse(any('mail-preview' in n for n in names))
            self.assertEqual(zip.read('hub/secret.key'), b'test-signing-key-not-an-api-key')
        result, restored = backup.restore_backup(item['id'])
        self.assertTrue(result['ok'])
        self.assertFalse(result['productionChanged'])
        self.assertNotIn('restoreRoot', result)
        self.assertEqual((restored / 'hub' / 'uploads' / 'fixture.txt').read_bytes(), uploaded)
        self.assertTrue((restored / 'public' / 'files' / 'private-exam.txt').exists())
        with closing(sqlite3.connect(restored / 'hub' / 'community.sqlite3')) as db:
            self.assertEqual(db.execute('SELECT action FROM hub_audit').fetchone()[0], 'entry-review')
        self.assertEqual(backup.status()['lastCheck']['verificationId'], result['verificationId'])

    def test_wal_snapshot_includes_committed_data_without_stopping_source(self):
        with closing(sqlite3.connect(self.db)) as writer:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute("INSERT INTO hub_member VALUES(2,'committed-during-running-service')")
            writer.commit()
            item = backup.create_backup()
            _, restored = backup.restore_backup(item['id'])
            with closing(sqlite3.connect(restored / 'hub' / 'community.sqlite3')) as restored_db:
                self.assertEqual(restored_db.execute('SELECT COUNT(*) FROM hub_member').fetchone()[0], 2)
            writer.execute("INSERT INTO hub_member VALUES(3,'still-writable')")
            writer.commit()

    def test_missing_or_changed_asset_fails_atomically(self):
        self.asset()
        (self.media / 'fixture.txt').write_bytes(b'changed attachment')
        with self.assertRaisesMessage(backup.BackupError, '附件或镜像缺失'):
            backup.create_backup()
        self.assertEqual(backup.list_backups(), [])
        self.assertEqual(list(self.private.glob('.luokixi-snapshot-*')), [])
        (self.media / 'fixture.txt').unlink()
        with self.assertRaises(backup.BackupError):
            backup.create_backup()

    def test_private_destination_and_existing_production_directories_are_refused(self):
        for directory in [self.project / 'public' / 'backups', self.project / 'dist', self.data / 'backups']:
            with patch.dict(os.environ, {'HUB_BACKUP_DIR': str(directory)}):
                with self.assertRaises(backup.BackupError):
                    backup.create_backup()
        item = backup.create_backup()
        existing = self.base / 'already-existing'
        existing.mkdir()
        (existing / 'do-not-change').write_text('keep', encoding='utf-8')
        with self.assertRaises(backup.BackupError):
            backup.restore_backup(item['id'], destination=existing)
        self.assertEqual((existing / 'do-not-change').read_text(), 'keep')
        with self.assertRaises(backup.BackupError):
            backup.restore_backup(item['id'], destination=self.data)

    def test_library_original_paths_are_relinked_to_isolated_restore(self):
        original = self.library / 'files' / 'exam.pdf'
        original.parent.mkdir()
        original.write_bytes(b'%PDF-library-fixture')
        with closing(sqlite3.connect(self.library / 'library.sqlite3')) as db:
            db.execute('CREATE TABLE documents(id TEXT, file_path TEXT, sha256 TEXT)')
            db.execute('INSERT INTO documents VALUES(?,?,?)', ('exam', str(original), hashlib.sha256(original.read_bytes()).hexdigest()))
            db.commit()
        item = backup.create_backup()
        result, restored = backup.restore_backup(item['id'])
        with closing(sqlite3.connect(restored / 'library' / 'library.sqlite3')) as db:
            linked = Path(db.execute('SELECT file_path FROM documents').fetchone()[0])
        self.assertEqual(linked, restored / 'library' / 'files' / 'exam.pdf')
        self.assertEqual(linked.read_bytes(), original.read_bytes())
        self.assertEqual(result['rewrittenLibraryPaths'], 1)
        with closing(sqlite3.connect(self.library / 'library.sqlite3')) as db:
            self.assertEqual(db.execute('SELECT file_path FROM documents').fetchone()[0], str(original))

    def test_legacy_external_pdf_and_audio_are_collected_without_changing_source(self):
        originals = self.base / 'original-local-library'
        originals.mkdir()
        values = {'exam.pdf': b'%PDF-external-exam', 'listening.mp3': b'ID3-external-listening'}
        with closing(sqlite3.connect(self.library / 'library.sqlite3')) as db:
            db.execute('CREATE TABLE documents(id TEXT, file_path TEXT, sha256 TEXT)')
            for name, content in values.items():
                path = originals / name
                path.write_bytes(content)
                db.execute('INSERT INTO documents VALUES(?,?,?)', (name, str(path), hashlib.sha256(content).hexdigest()))
            db.commit()
        item = backup.create_backup(include_public_files=False)
        result, restored = backup.restore_backup(item['id'])
        with closing(sqlite3.connect(restored / 'library' / 'library.sqlite3')) as db:
            for ident, path in db.execute('SELECT id,file_path FROM documents'):
                linked = Path(path)
                self.assertTrue(linked.is_relative_to(restored / 'library' / 'files'))
                self.assertEqual(linked.read_bytes(), values[ident])
        self.assertEqual(result['rewrittenLibraryPaths'], 2)
        with closing(sqlite3.connect(self.library / 'library.sqlite3')) as db:
            self.assertEqual(Path(db.execute("SELECT file_path FROM documents WHERE id='exam.pdf'").fetchone()[0]), originals / 'exam.pdf')

    def test_sensitive_external_configuration_is_not_treated_as_library_material(self):
        original = self.base / 'studio-config.json'
        original.write_text('{"api_key":"do-not-copy"}', encoding='utf-8')
        with closing(sqlite3.connect(self.library / 'library.sqlite3')) as db:
            db.execute('CREATE TABLE documents(id TEXT, file_path TEXT, sha256 TEXT)')
            db.execute('INSERT INTO documents VALUES(?,?,?)', ('mistake', str(original), hashlib.sha256(original.read_bytes()).hexdigest()))
            db.commit()
        with self.assertRaisesMessage(backup.BackupError, '误导入敏感配置'):
            backup.create_backup()
        self.assertEqual(backup.list_backups(), [])

    def test_last_check_receipt_must_match_archive_not_just_backup_id(self):
        item = backup.create_backup()
        result = backup.check_backup(item['id'])
        self.assertTrue(backup.list_backups()[0]['verifiedOkay'])
        check_path = self.private / (item['id'] + '.check.json')
        result['archiveSha256'] = '0' * 64
        check_path.write_text(json.dumps(result), encoding='utf-8')
        self.assertFalse(backup.list_backups()[0]['verifiedOkay'])
        self.assertIsNone(backup.status()['lastCheck'])

    def test_verified_archive_hash_is_memoized_for_polling_but_invalidated_on_change(self):
        item = backup.create_backup()
        backup.check_backup(item['id'])
        backup._VERIFIED_CACHE.clear()
        with patch.object(backup, '_sha_file', wraps=backup._sha_file) as sha:
            self.assertTrue(backup.status()['latest']['verifiedOkay'])
            self.assertTrue(backup.status()['latest']['verifiedOkay'])
            self.assertTrue(backup.list_backups()[0]['verifiedOkay'])
            self.assertEqual(sha.call_count, 1)
            path = self.private / item['id']
            with path.open('ab') as file:
                file.write(b'changed after restore check')
            self.assertFalse(backup.list_backups()[0]['verifiedOkay'])
            self.assertEqual(sha.call_count, 2)

    def repack(self, backup_id, transform):
        path = self.private / backup_id
        with zipfile.ZipFile(path) as zip:
            entries = [(info.filename, zip.read(info)) for info in zip.infolist()]
        entries = transform(entries)
        with zipfile.ZipFile(path, 'w') as zip:
            for name, value in entries:
                zip.writestr(name, value)

    def test_corruption_missing_member_and_path_traversal_are_refused_without_partial_restore(self):
        self.asset()
        for attack in ['corrupt', 'missing', 'traversal', 'duplicate']:
            item = backup.create_backup(retain=20)
            def change(entries):
                if attack == 'corrupt':
                    return [(name, b'wrong bytes' if name == 'hub/uploads/fixture.txt' else value) for name, value in entries]
                if attack == 'missing':
                    return [(name, value) for name, value in entries if name != 'hub/uploads/fixture.txt']
                if attack == 'duplicate':
                    return entries + [entries[-1]]
                return entries + [('../../escape', b'evil')]
            self.repack(item['id'], change)
            destination = self.base / ('restore-' + attack)
            with self.assertRaises(backup.BackupError):
                backup.restore_backup(item['id'], destination=destination)
            self.assertFalse(destination.exists())
            self.assertEqual(list(self.base.glob('.luokixi-restore-*')), [])
        self.assertFalse((self.base.parent / 'escape').exists())

    def test_size_limit_and_compression_bombs_are_refused(self):
        item = backup.create_backup()
        with patch.dict(os.environ, {'HUB_BACKUP_MAX_BYTES': '1024'}):
            with self.assertRaises(backup.BackupError):
                backup.check_backup(item['id'])
            with self.assertRaises(backup.BackupError):
                backup.create_backup()
        self.asset(b'0' * 4_000_000, 'compressed.txt')
        item = backup.create_backup()
        path = self.private / item['id']
        with zipfile.ZipFile(path) as archive:
            values = [(i.filename, archive.read(i)) for i in archive.infolist()]
        with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, value in values:
                archive.writestr(name, value)
        with self.assertRaisesMessage(backup.BackupError, '压缩比异常'):
            backup.check_backup(item['id'])

    def test_retention_removes_only_own_validated_archives(self):
        self.private.mkdir()
        unrelated = self.private / 'personal-backup.zip'
        unrelated.write_bytes(b'not ours')
        invalid = self.private / 'luokixi-backup-20200101T000000Z-000000000000.zip'
        invalid.write_bytes(b'not a generated archive')
        first = backup.create_backup(retain=2)
        backup.create_backup(retain=2)
        backup.create_backup(retain=2)
        self.assertEqual(len(backup.list_backups()), 2)
        self.assertFalse((self.private / first['id']).exists())
        self.assertTrue(unrelated.exists())
        self.assertTrue(invalid.exists())

    def test_archive_id_cannot_choose_arbitrary_paths_and_download_handle_is_verified(self):
        item = backup.create_backup()
        for attack in ['../../secret.key', str(self.db), 'file.zip', '']:
            with self.assertRaises(backup.BackupError):
                backup.get_backup_path(attack)
        with backup.open_backup(item['id']) as file:
            self.assertEqual(file.read(2), b'PK')
        file = backup.open_backup_file(item['id'])
        try:
            self.assertEqual(file.read(2), b'PK')
        finally:
            file.close()

    def test_windows_reserved_names_and_secret_paths_cannot_enter_an_archive(self):
        for name in ['hub/uploads/CON', 'hub/uploads/nul.txt', 'hub/uploads/dir./file',
                     'hub/uploads/dir /file', 'hub/uploads/.secrets/api-key', 'hub/uploads/.env.production',
                     'library/files/secret.key']:
            with self.assertRaises(backup.BackupError):
                backup._safe_name(name)
        self.assertEqual(backup._safe_name('hub/secret.key'), 'hub/secret.key')

    def test_symlink_outside_media_is_refused(self):
        outside = self.base / 'private-secret.txt'
        outside.write_bytes(b'must-not-leave-private-root')
        link = self.media / 'linked.txt'
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest('This Windows account cannot create symbolic links.')
        with self.assertRaises(backup.BackupError):
            backup.create_backup()


class RestoredSiteIntegrationTests(SimpleTestCase):
    def test_restored_site_really_logs_in_and_serves_post_review_and_attachment(self):
        campus = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / 'fixture-project'
            project.mkdir()
            data = base / 'fixture-live' / 'hub'
            private = base / 'private-backups'
            env = dict(os.environ, HUB_DATA_DIR=str(data), HUB_BACKUP_DIR=str(private),
                       CAMPUS_DATA_DIR=str(base / 'fixture-live'), HUB_BEIKUANG='0')
            env.pop('HUB_SECRET_KEY', None)
            env.pop('HUB_PRODUCTION', None)
            env.pop('HUB_MAINTENANCE_AUTO', None)
            migrate = subprocess.run([sys.executable, 'manage_hub.py', 'migrate', '--noinput'],
                                     cwd=campus, env=env, capture_output=True, text=True, timeout=90)
            self.assertEqual(migrate.returncode, 0, migrate.stderr[-1000:])
            seed = '''
import os,json,hashlib
import manage_hub
os.environ.setdefault('DJANGO_SETTINGS_MODULE','hub.settings')
import django;django.setup()
from django.test import Client
from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from hub.models import Member,Entry,Reply,Asset
a=Member.objects.create_user('restore-reader','restore-reader@example.test','Fixture-restore-password-748!',email_verified=True)
m=Member.objects.create_user('restore-moderator','restore-moderator@example.test','Fixture-review-password-812!',email_verified=True,is_staff=True)
c=Client();assert c.login(username=a.username,password='Fixture-restore-password-748!')
r=c.post('/api/hub/uploads',{'file':SimpleUploadedFile('restore.txt',b'restored attachment contents',content_type='text/plain')});assert r.status_code==200,r.content
u=r.json();payload={'title':'Restore fixture resource','summary':'This upload must survive restore','license':'CC-BY-4.0','rightsConfirmed':True,'body':'Review fixture details','uploads':[u['id']]}
r=c.post('/api/hub/entries',json.dumps({'kind':'resource','data':payload}),content_type='application/json');assert r.status_code==200,r.content
e=r.json();r=c.post('/api/hub/entries/'+e['id']+'/submit',json.dumps({'revision':e['editRevision']}),content_type='application/json');assert r.status_code==200,r.content
p=r.json();mod=Client();mod.force_login(m)
r=mod.post('/api/hub/entries/'+e['id']+'/review',json.dumps({'revision':p['editRevision'],'decision':'approve','note':'Fixture review evidence'}),content_type='application/json');assert r.status_code==200,r.content
entry=Entry.objects.get(pk=e['id']);reply=Reply.objects.create(entry=entry,author=a,body='Restored discussion reply',state='published')
raw=b'orphan-asset-without-upload-row';digest=hashlib.sha256(raw).hexdigest();path=digest+'.txt';(settings.MEDIA_ROOT/path).write_bytes(raw);Asset.objects.create(sha256=digest,size=len(raw),extension='.txt',path=path)
print(json.dumps({'entry':e['id'],'upload':u['id'],'reply':str(reply.pk),'orphan':path}))
'''
            seeded = subprocess.run([sys.executable, '-c', seed], cwd=campus, env=env,
                                    capture_output=True, text=True, timeout=90)
            self.assertEqual(seeded.returncode, 0, seeded.stderr[-1500:])
            identifiers = json.loads(seeded.stdout.strip().splitlines()[-1])
            with override_settings(BASE=project / 'campus', DATA=data, MEDIA_ROOT=data / 'uploads',
                                   SECRET_KEY=(data / 'secret.key').read_text(),
                                   DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': data / 'community.sqlite3'}}), \
                 patch.dict(os.environ, {'HUB_BACKUP_DIR': str(private), 'CAMPUS_DATA_DIR': str(base / 'fixture-live')}):
                snapshot = backup.create_backup()
                result, restored = backup.restore_backup(snapshot['id'])
            self.assertTrue(result['ok'])
            self.assertEqual((restored / 'hub' / 'uploads' / identifiers['orphan']).read_bytes(), b'orphan-asset-without-upload-row')
            env['HUB_DATA_DIR'] = str(restored / 'hub')
            env['RESTORE_FIXTURE_IDS'] = json.dumps(identifiers)
            probe = '''
import os,json
import manage_hub
os.environ.setdefault('DJANGO_SETTINGS_MODULE','hub.settings')
import django;django.setup()
from django.test import Client
from hub.models import Entry,Reply,Revision,Audit
ids=json.loads(os.environ['RESTORE_FIXTURE_IDS'])
c=Client();r=c.post('/api/hub/auth/login',json.dumps({'email':'restore-reader@example.test','password':'Fixture-restore-password-748!'}),content_type='application/json');assert r.status_code==200,r.content
assert r.json()['user']['username']=='restore-reader'
r=c.get('/api/hub/entries/'+ids['entry']);assert r.status_code==200,r.content;assert r.json()['data']['title']=='Restore fixture resource'
r=c.get('/api/hub/uploads/'+ids['upload']+'/file');assert r.status_code==200;assert b''.join(r.streaming_content)==b'restored attachment contents'
assert Reply.objects.get(pk=ids['reply']).body=='Restored discussion reply'
assert Revision.objects.filter(entry_id=ids['entry'],state='published',note='Fixture review evidence').exists()
assert Audit.objects.filter(target=ids['entry']).exists()
assert Entry.objects.get(pk=ids['entry']).state=='published'
print(json.dumps({'login':True,'publicPost':True,'attachment':True,'discussion':True,'reviewHistory':True}))
'''
            probed = subprocess.run([sys.executable, '-c', probe], cwd=campus, env=env,
                                    capture_output=True, text=True, timeout=90)
            self.assertEqual(probed.returncode, 0, probed.stderr[-1500:])
            self.assertTrue(all(json.loads(probed.stdout.strip().splitlines()[-1]).values()))
