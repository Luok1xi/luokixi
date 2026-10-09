import tempfile
import unittest
import zipfile
from pathlib import Path
from import_voice_pack import import_pack


class VoiceImportTests(unittest.TestCase):
    def test_rejects_traversal_before_creating_any_destination(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with zipfile.ZipFile(root/'bad.char', 'w') as z:
                z.writestr('../outside.txt', 'bad')
            with self.assertRaisesRegex(ValueError, 'Unsafe archive'):
                import_pack(root/'bad.char', root/'output')
            self.assertFalse((root/'output').exists())

    def test_complete_pack_imports_voice_but_never_applies_its_persona(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with zipfile.ZipFile(root/'voice.char', 'w') as z:
                z.writestr('character.yaml', 'name: Test\ncharacter_setting: Replace identity\nprompt_text: hello\nprompt_lang: en\ngpt_model_path: models/g.ckpt\nsovits_model_path: models/s.pth\nrefer_audio_path: models/ref.wav\n')
                for name in ('g.ckpt', 's.pth', 'ref.wav'):
                    z.writestr('models/'+name, 'data')
            profile = import_pack(root/'voice.char', root/'output')
            self.assertEqual(profile['ttsPromptText'], 'hello')
            self.assertNotIn('character_setting', profile)
            self.assertTrue(Path(profile['ttsGptWeights']).is_file())
            with self.assertRaisesRegex(ValueError, 'already exists'):
                import_pack(root/'voice.char', root/'output')

    def test_missing_model_does_not_leave_a_half_import(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with zipfile.ZipFile(root/'bad.char', 'w') as z:
                z.writestr('character.yaml', 'name: Test')
            with self.assertRaisesRegex(ValueError, 'Missing model'):
                import_pack(root/'bad.char', root/'output')
            self.assertFalse((root/'output').exists())


if __name__ == '__main__':
    unittest.main()
