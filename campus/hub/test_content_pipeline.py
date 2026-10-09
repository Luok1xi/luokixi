import json
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch
from datetime import timedelta
from django.test import TestCase
from django.utils import timezone
from .models import Entry, ExternalCache, Job
from .core import Problem
from . import content_pipeline, frontier_news, auto_media
from library_pipeline import sync, catalogue


class ContentPipelineTests(TestCase):
    def test_honest_limitations_are_not_false_certification_claims(self):
        from .beikuang import unsupported_claim
        for line in ('不能保证完全离线可用。', '不代表项目已经实测、获得安全认证或通过本站严选。',
                     '本文也没有实测、完成安全认证，或验证全部代码示例。', '下载后是否可以完全离线阅读，原项目未说明。',
                     '本说明不声称已实测、安全认证或已获本站严选。', '未获得任何安全认证或本站严选背书。',
                     '原项目未说明安装后能否完全离线运行。', '任何“已实测”“已认证”的说法都不成立。',
                     '关于安全认证、稳定性保证，原项目未说明。', '未说明的内容包括：硬件要求、系统兼容、安全认证、离线部署方案。',
                     '如果你需要的是完全离线、零配置的软件，原项目没有给出这样的承诺。'):
            self.assertFalse(unsupported_claim(line), line)
        for line in ('本站严选，已经实测通过。', '这是安全认证产品。', '尚未联网测试，但是完全离线可用。', '没有联网问题，完全离线可用。'):
            self.assertTrue(unsupported_claim(line), line)

    def test_catalogue_preserves_originals_and_provenance_without_claiming_downloads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root/'original.pdf'; original.write_bytes(b'original')
            db = sqlite3.connect(root/'library.sqlite3')
            db.execute('CREATE TABLE documents(id,title,course,scope,origin,created,source_url,file_path,sha256,kind)')
            db.execute('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?)', ('local', '高数期末', '高数', '本校资料', '同学上传', '2025-10-01', '', str(original), 'original-hash', 'exam'))
            db.commit(); db.close()
            (root/'university-sources.json').write_text(json.dumps({'schools':[{'id':'zju','name':'浙江大学'}],
                'sources':[{'id':'s','name':'公开课程目录','checkedAt':'2025-10-01'}],
                'resources':[{'id':'remote','sourceId':'s','schoolId':'zju','title':'程序设计期末','course':'程序设计','url':'https://example.edu/exam.pdf'}]}), encoding='utf-8')
            first = sync(root); self.assertEqual(first['collected'], 2)
            records = catalogue(root); at = records['provenance']['local']['reviewedAt']
            self.assertEqual(records['items'][0]['schools'], ['浙江大学'])
            self.assertTrue(records['items'][0]['external'])
            self.assertEqual(records['items'][0]['reviewState'], 'source-checked')
            self.assertEqual(sync(root)['collected'], 0)
            self.assertEqual(catalogue(root)['provenance']['local']['reviewedAt'], at)
            self.assertEqual(original.read_bytes(), b'original')
            before = records['items'][0]['uploadedAt']
            source_path = root/'university-sources.json'
            updated = json.loads(source_path.read_text(encoding='utf-8'))
            updated['sources'][0]['checkedAt'] = '2025-10-09'
            source_path.write_text(json.dumps(updated), encoding='utf-8')
            sync(root)
            self.assertEqual(catalogue(root)['items'][0]['uploadedAt'], before)

    def test_coverage_survives_invalid_mirror_and_ignores_outdated_pending_review(self):
        from .models import MirrorAsset
        from .robot_inventory import publication_coverage
        MirrorAsset.objects.create(repository='owner/repo', tag='v1', name='broken.zip', size=2,
            sha256='a'*64, license='MIT', source_url='https://github.com/owner/repo', path='../outside.zip')
        ExternalCache.objects.create(key='github:owner/repo', data={'repository':'owner/repo', 'stars':42,
            'guide':{'reviewState':'reviewed','sections':[{}]*10}})
        ExternalCache.objects.create(key='pipeline-project:owner/repo', data={'repository':'owner/repo','guideError':'pending'})
        report = publication_coverage()
        self.assertEqual(report['chineseGuides'], 1)
        self.assertEqual(report['packages'], 0)
        self.assertEqual(report['items'][0]['error'], '')

    def test_missing_real_database_never_creates_empty_library(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError): sync(folder)
            self.assertFalse((Path(folder)/'library.sqlite3').exists())

    def test_feed_rejects_entities_and_requires_real_date(self):
        with self.assertRaises(Problem): frontier_news.parse(b'<!DOCTYPE rss><rss/>', 'x')
        raw = b'<rss><channel><item><title>new</title><link>https://example.edu/new</link></item><item><title>paper</title><link>http://arxiv.org/abs/123</link><pubDate>Wed, 07 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>'
        items = frontier_news.parse(raw, 'arXiv')
        self.assertEqual(len(items), 1); self.assertTrue(items[0]['preprint'])
        self.assertEqual(items[0]['url'], 'https://arxiv.org/abs/123')

    def test_news_is_chinese_on_site_deduplicated_and_dated(self):
        item = {'title':'Source announcement', 'url':'https://example.edu/news', 'source':'OpenAI',
                'summary':'Verified source text', 'publishedAt':timezone.now().isoformat(), 'preprint':False}
        with patch.object(frontier_news, 'feed', return_value=([item], None)), patch.object(frontier_news, 'translate', return_value=(
                {'title':'中文科研进展', 'summary':'依据原文的中文摘要', 'points':['可核对的进展'], 'limitations':'尚未独立复核'}, 'test-model')):
            self.assertEqual(frontier_news.run()['published'], 1)
            self.assertEqual(frontier_news.run()['published'], 0)
        post = Entry.objects.get(); self.assertEqual(post.published['circle']['board'], 'frontier')
        self.assertIn('中文摘要', post.published['body'])
        self.assertEqual(post.published['links']['source'], item['url'])
        self.assertEqual(post.versions.get().reviewer, post.owner)

    def test_future_and_old_news_never_presented_as_daily_news(self):
        rows = [{'title':'too old', 'url':'https://example.edu/old', 'source':'OpenAI', 'publishedAt':(timezone.now()-timedelta(days=30)).isoformat()},
                {'title':'future', 'url':'https://example.edu/future', 'source':'OpenAI', 'publishedAt':(timezone.now()+timedelta(days=1)).isoformat()}]
        with patch.object(frontier_news, 'feed', return_value=(rows, None)), patch.object(frontier_news, 'translate') as translate:
            self.assertEqual(frontier_news.run()['published'], 0); translate.assert_not_called()

    def test_failed_feed_is_visible_and_creates_no_fake_news(self):
        with patch.object(frontier_news, 'feed', return_value=([], 'source unavailable')):
            result = frontier_news.run()
        self.assertEqual(result['published'], 0); self.assertTrue(result['errors'])

    def test_automatic_art_is_topic_matched_and_does_not_overwrite_uploads(self):
        one = auto_media.choose({'title':'人工智能科研论文'})
        self.assertEqual(one['slot'], 'hero-open-research')
        self.assertIn('非事件实拍', one['credit'])
        entry = Entry.objects.create(slug='image', state='published', published={'title':'hello','uploads':['original']})
        result = auto_media.sweep()
        self.assertEqual(result['illustrated'], 0)
        self.assertEqual(result['preserved'], 1)
        entry.refresh_from_db(); self.assertEqual(entry.published['uploads'], ['original'])

    def test_schedule_respects_pause_and_does_not_duplicate_pending_jobs(self):
        with patch.object(content_pipeline, 'enabled', return_value=False): content_pipeline.schedule()
        self.assertEqual(Job.objects.count(), 0)
        with patch.object(content_pipeline, 'enabled', return_value=True):
            content_pipeline.schedule(); content_pipeline.schedule()
        self.assertEqual(Job.objects.count(), len(content_pipeline.KINDS))

    def test_journal_keeps_model_expression_separate_from_facts_and_deduplicates(self):
        facts={'unresolved':[{'robot':'资料归类','error':'test-only failure'}], 'periodDays':7}
        def bridge(route, body=None, **kwargs):
            return {'state':'done','result':{'text':'今天松了口气，明天继续。',
                'messages':[{'type':'text','text':'今天松了口气，明天继续。','expression':'happy','private':'never copy'}]}}
        with patch.object(content_pipeline,'journal_facts',return_value=facts),patch('hub.studio_config.config',return_value={'owner_id':1}),patch('hub.companion_bridge.call',side_effect=bridge):
            self.assertEqual(content_pipeline.journal()['published'],2)
            self.assertEqual(content_pipeline.journal()['published'],0)
        for entry in Entry.objects.all():
            self.assertEqual(entry.published['body'],'今天松了口气，明天继续。')
            self.assertEqual(entry.published['maintenanceFacts'],facts)
            expression=entry.published['journalExpression']['messages'][0]
            self.assertEqual(expression['expression'],'happy');self.assertNotIn('private',expression)

    def test_private_or_failed_report_never_becomes_public_fallback(self):
        with patch.object(content_pipeline,'journal_facts',return_value={'unresolved':[]}),patch('hub.studio_config.config',return_value={'owner_id':1}),patch('hub.companion_bridge.call',return_value={'state':'done','result':{'text':'私有路径 C:\\Users\\example'}}):
            result=content_pipeline.journal()
        self.assertEqual(result['published'],0);self.assertEqual(len(result['errors']),2)
        self.assertEqual(Entry.objects.count(),0)
