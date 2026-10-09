"""Import Shinsekai .char data privately; never apply its identity or execute package code."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import zipfile

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / '.data/question-runtime'))
import yaml


def import_pack(source, destination):
    source, destination = Path(source), Path(destination).resolve()
    if destination.exists():
        raise ValueError('Destination already exists; preserve the previous import.')
    with zipfile.ZipFile(source) as archive:
        members = archive.infolist()
        if len(members) > 3000 or sum(i.file_size for i in members) > 3 * 1024**3:
            raise ValueError('Character archive exceeds import limits')
        seen = set()
        for item in members:
            name = item.filename.replace('\\', '/')
            path = PurePosixPath(name)
            if (path.is_absolute() or any(p in ('..', '') or ':' in p for p in path.parts)
                    or stat.S_ISLNK(item.external_attr >> 16) or name.casefold() in seen
                    or not (destination / name).resolve().is_relative_to(destination)):
                raise ValueError('Unsafe archive path')
            seen.add(name.casefold())
        info = archive.getinfo('character.yaml')
        if info.file_size > 128 * 1024:
            raise ValueError('Character metadata too large')
        data = yaml.safe_load(archive.read(info).decode('utf-8-sig'))
        card = data[0] if isinstance(data, list) and len(data) == 1 else data
        if not isinstance(card, dict):
            raise ValueError('Expected one character')
        references = {}
        for key, extension in [('gpt_model_path', '.ckpt'), ('sovits_model_path', '.pth'), ('refer_audio_path', '.wav')]:
            name = str(card.get(key, '')).replace('\\', '/')
            if name.casefold() not in seen or not name.endswith(extension):
                raise ValueError('Missing model/reference: ' + key)
            references[key] = str(destination / name)
        destination.mkdir(parents=True)
        # The source card and sprites are archived as data, never imported as executable prompts.
        for item in members:
            target = destination / item.filename.replace('\\', '/')
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as src, target.open('xb') as dst:
                    shutil.copyfileobj(src, dst)
    with source.open('rb') as raw:
        digest = hashlib.file_digest(raw, 'sha256').hexdigest()
    profile = {'name': card.get('name', source.stem), 'engine': 'gpt-sovits', 'ready': True,
               'ttsGptWeights': references['gpt_model_path'], 'ttsSovitsWeights': references['sovits_model_path'],
               'ttsRefAudio': references['refer_audio_path'], 'ttsPromptText': card.get('prompt_text', ''),
               'ttsPromptLang': card.get('prompt_lang', 'ja'), 'ttsSpeed': card.get('speech_speed', 1),
               'ttsBase': 'http://127.0.0.1:17863', 'sourceSha256': digest}
    (destination / 'import-receipt.json').write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding='utf-8')
    return profile


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    print(json.dumps(import_pack(args.source, args.destination), ensure_ascii=True))
