import io
import base64
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from django.test import TestCase, override_settings
from django.utils import timezone
from PIL import Image
from . import auto_media, circle, source_media
from .models import Entry, ExternalCache


class SourceMediaTests(TestCase):
    def test_institution_matching_never_uses_another_school_or_an_owner_avatar(self):
        self.assertFalse(source_media.matches_entity('清华大学课程', {'url':'https://www.pku.edu.cn/logo.png'}))
        self.assertFalse(source_media.matches_entity('清华大学课程', {'url':'https://github.com/PKUanonym.png', 'alt':'北京大学校徽'}))
        self.assertTrue(source_media.matches_entity('清华大学课程', {'url':'https://www.tsinghua.edu.cn/image/logo180.png'}))
        self.assertFalse(source_media.matches_entity('清华大学课程', {'url':'https://cdn.test/ambiguous-logo.png'}))
        # A username starting PKU does not determine the school of the resource.
        self.assertTrue(source_media.matches_entity('清华大学课程', {'url':'https://raw.githubusercontent.com/PKUanonym/REKCARC-TSC-UHT/main/course.png'}))

    def test_cached_readme_image_replaces_generated_cover_and_is_visible_in_circle(self):
        ExternalCache.objects.create(key='maint:project-media', data={'items':{'PKUanonym/REKCARC-TSC-UHT':{
            'image':'https://source.test/course.png','credit':'作者 README 原图','alt':'课程目录'}}})
        data={'title':'清华大学课程','links':{'repo':'https://github.com/PKUanonym/REKCARC-TSC-UHT'},'circle':{'board':'daily','format':'thread'}}
        data['autoMedia']={'url':'/api/hub/illustration/'+'a'*64,'method':'article-editorial-v2'}
        entry=Entry.objects.create(slug='source-course', state='published', published=data, draft=data)
        result=auto_media.sweep(source_limit=0); entry.refresh_from_db()
        self.assertEqual(result['sourceRecovered'],1)
        self.assertEqual(entry.published['autoMedia']['url'],'https://source.test/course.png')
        from django.contrib.auth.models import AnonymousUser
        self.assertEqual(circle.card(entry, AnonymousUser())['photos'],['https://source.test/course.png'])

    def test_real_image_download_is_bounded_cached_and_has_origin(self):
        data={'title':'来源文章','links':{'source':'https://source.test/news/1'}}
        raw=io.BytesIO(); Image.new('RGB',(1280,800),'red').save(raw,'PNG')
        page=b'<article><img src="/real.png" alt="Product screenshot"><img src="/more.png"></article>'
        with tempfile.TemporaryDirectory() as folder, override_settings(DATA=Path(folder)), patch('hub.maintenance.get_page', side_effect=[(page,data['links']['source']),(raw.getvalue(),'https://source.test/real.png')]) as fetch:
            media=source_media.resolve(data,refresh=True)
            self.assertEqual(fetch.call_count,2)
            self.assertTrue(media['url'].startswith('/api/hub/source-media/'))
            self.assertEqual(media['sourceUrl'],data['links']['source'])
            self.assertEqual(media['originalUrl'],'https://source.test/real.png')
            self.assertEqual(source_media.resolve(data,refresh=True),media)
            self.assertEqual(fetch.call_count,2)
            response=source_media.get(media['url'].split('/')[-1]); self.assertEqual(response['Content-Type'],'image/png'); response.close()

    def test_missing_source_keeps_generated_cover_records_failure_and_cooldown(self):
        data={'title':'科研进展','links':{'source':'https://source.test/news'}}
        entry=Entry.objects.create(slug='no-source',state='published',published=data,draft=data)
        with patch('hub.maintenance.get_page', side_effect=Exception('source unavailable')) as fetch:
            result=auto_media.sweep(source_limit=1)
            self.assertEqual(result['sourceChecks'],1); self.assertEqual(len(result['errors']),1)
            entry.refresh_from_db(); self.assertIn('非事件实拍',entry.published['autoMedia']['credit'])
            auto_media.sweep(source_limit=1); self.assertEqual(fetch.call_count,1)

    def test_extraction_ignores_navigation_and_mismatched_logo(self):
        raw=b'<nav><img src="/wrong-banner.jpg"></nav><article><img src="https://www.pku.edu.cn/logo.png"><img src="/correct.jpg"></article>'
        found=source_media.article_candidates(raw,'https://www.tsinghua.edu.cn/news/1','清华大学课程')
        self.assertEqual([x['url'] for x in found],['https://www.tsinghua.edu.cn/correct.jpg'])

    def test_uploaded_and_editor_media_remain_untouched(self):
        data={'title':'用户内容','uploads':['original'],'media':{'src':'https://owner.test/own.jpg'}}
        entry=Entry.objects.create(slug='manual',state='published',published=data)
        with patch('hub.maintenance.get_page') as fetch:
            self.assertEqual(auto_media.sweep()['preserved'],1); fetch.assert_not_called()
        entry.refresh_from_db(); self.assertEqual(entry.published,data)

    def test_local_cached_image_keeps_original_institution_validation(self):
        ExternalCache.objects.create(key='maint:project-media', data={'items':{'a/course':{
            'image':'/api/hub/source-media/'+'a'*64,
            'originalImage':'https://www.pku.edu.cn/logo.png','alt':'课程资源'}}})
        data={'title':'清华大学课程','links':{'repo':'https://github.com/a/course'}}
        self.assertIsNone(source_media.resolve(data))

    def test_static_projects_use_fresh_cache_without_starving_unchecked_projects(self):
        from . import project_media
        ExternalCache.objects.create(key='maint:project-media', data={'items':{'a/cached':{
            'resolverVersion':project_media.RESOLVER_VERSION,'checkedAt':timezone.now().isoformat(),
            'readmeSha':'known-commit','image':'https://source.test/cached.jpg','status':'ok'}}})
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            (root/'community.json').write_text(json.dumps({'projects':[
                {'title':'已缓存项目','repo':{'fullName':'a/cached'}},
                {'title':'新项目','repo':{'fullName':'a/new'}}]}),encoding='utf-8')
            info={'content':base64.b64encode(b'![screenshot](https://source.test/new.jpg)').decode(),'sha':'new-sha'}
            with patch('hub.maintenance.public_data',return_value=root), patch('hub.github_api.request',return_value=info) as fetch, patch('hub.project_media.probe',return_value={'cachedUrl':'/api/hub/source-media/'+'a'*64,'width':640,'height':400,'format':'PNG','bytes':128}):
                result=project_media.collect(limit=2)
            fetch.assert_called_once_with('/repos/a/new/readme')
            self.assertEqual(result['checked'],1)
            self.assertEqual(result['cached'],1)
            self.assertEqual(result['withImage'],2)
            self.assertEqual(result['status'],'ok')
