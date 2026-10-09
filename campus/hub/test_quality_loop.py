import hashlib
import io
import json
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch
from django.test import TestCase, override_settings
from .core import Problem
from .models import Entry, ExternalCache
from . import robot_tools, auto_media, editorial_art


class QualityLoopTests(TestCase):
    def test_tool_download_test_and_real_call_use_same_version(self):
        with tempfile.TemporaryDirectory() as folder, override_settings(DATA=Path(folder)):
            stream=io.BytesIO()
            with zipfile.ZipFile(stream,'w') as z: z.writestr('module.py','value=1')
            wheel=stream.getvalue(); digest=hashlib.sha256(wheel).hexdigest()
            meta={'urls':[{'filename':'a-py3-none-any.whl','url':'https://files.pythonhosted.org/a.whl','digests':{'sha256':digest}}]}
            def download(url,limit): return json.dumps(meta).encode() if url.endswith('/json') else wheel
            args={'id':'markdown-reader','assessment':'用于阅读开源项目的 Markdown 文档，采用 MIT 许可并用固定样例校验。'}
            with patch.object(robot_tools,'read_url',side_effect=download),patch.object(robot_tools,'execute',return_value={'tokens':['heading']}):
                result=robot_tools.install(args);self.assertEqual(result['state'],'ready')
                self.assertEqual(len(result['packages']),2)
                self.assertTrue(robot_tools.install(args)['duplicate'])
                self.assertEqual(robot_tools.run({'id':'markdown-reader','text':'# 中文项目'})['state'],'done')
            self.assertEqual(robot_tools.catalogue()['items'][0]['state'],'ready')
            from . import robot_tool_adapters as adapters
            with patch.object(adapters,'PROBE',adapters.PROBE+'\n# new probe'):
                self.assertEqual(robot_tools.catalogue()['items'][0]['state'],'needs-test')

    def test_bad_hash_is_never_activated(self):
        with tempfile.TemporaryDirectory() as folder, override_settings(DATA=Path(folder)):
            meta={'urls':[{'filename':'a-py3-none-any.whl','url':'https://files.pythonhosted.org/a.whl','digests':{'sha256':'0'*64}}]}
            with patch.object(robot_tools,'read_url',side_effect=[json.dumps(meta).encode(),b'wrong']),patch.object(robot_tools,'execute') as probe:
                with self.assertRaises(Problem): robot_tools.install({'id':'pdf-reader','assessment':'验证 PDF 文本工具适用于学校资料，使用 BSD 许可，不替代扫描识别。'})
                probe.assert_not_called()
            self.assertEqual(ExternalCache.objects.get(pk='robot-tool:pdf-reader').data['state'],'failed')

    def test_archive_cannot_escape_or_install_startup_hooks(self):
        with tempfile.TemporaryDirectory() as folder:
            for name in ('../outside.py','/absolute.py','drive:C.py','..\\outside.py','startup.pth'):
                raw=io.BytesIO()
                with zipfile.ZipFile(raw,'w') as z:z.writestr(name,'x')
                with self.assertRaises(Problem):robot_tools.unpack(raw.getvalue(),Path(folder))
            self.assertEqual(list(Path(folder).iterdir()),[])

    def test_unknown_tool_and_non_official_download_are_rejected(self):
        with self.assertRaises(Problem):robot_tools.recipe_id('../anything')
        with self.assertRaises(Problem):robot_tools.read_url('http://127.0.0.1/secret',100)

    def test_adapters_can_be_extended_but_installer_policy_cannot_be_edited(self):
        from .robot_workbench import read
        source=robot_tools.catalogue()['adapterSource']
        self.assertEqual(read([source])['files'][0]['path'],source)
        with self.assertRaises(Problem): read(['campus/hub/robot_tools.py'])
        from . import robot_tool_adapters as adapters
        robot_tools.refresh_adapters()
        before=robot_tools.recipe_id('markdown-reader')
        with patch.object(adapters,'PROBE',adapters.PROBE+'\n# changed experiment'):
            self.assertNotEqual(robot_tools.recipe_id('markdown-reader'),before)
        with patch.dict(adapters.RECIPES,{'../outside':adapters.RECIPES['markdown-reader']}):
            with self.assertRaises(Problem):robot_tools.recipe_id('../outside')

    def test_unique_covers_escape_titles_and_retain_original_pictures(self):
        a=auto_media.choose({'title':'人工智能科研 <script>alert(1)</script>','credit':'原始来源'})
        b=auto_media.choose({'title':'人工智能科研 第二篇','credit':'原始来源'})
        self.assertNotEqual(a['url'],b['url']);self.assertIn('非事件实拍',a['credit'])
        response=editorial_art.get(a['url'].split('/')[-1]);self.assertNotIn(b'<script>',response.content)
        self.assertIn(b'&lt;script&gt;',response.content)
        entry=Entry.objects.create(slug='keep-photo',state='published',published={'title':'原文图片','media':{'src':'https://example.org/photo.jpg'}})
        self.assertEqual(auto_media.sweep()['preserved'],1);entry.refresh_from_db();self.assertEqual(entry.published['media']['src'],'https://example.org/photo.jpg')
