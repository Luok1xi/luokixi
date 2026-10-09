"""Provision independent Codex state; never copy the other character's database or identity."""
import json
import secrets
from pathlib import Path

def prepare(base=None):
    base=Path(base or Path(__file__).resolve().parent/'.data')
    folder=base/'codex-companion';folder.mkdir(parents=True,exist_ok=True)
    path=folder/'config.json'
    if not path.exists():
        path.write_text(json.dumps({'ttsProfilesPath':str(base/'voices/profiles.json'),'ttsEngine':'gpt-sovits',
            'agentEnabled':True,'webResearchEnabled':True,'languageLearningEnabled':True,
            'openaiEnabled':False,'publicSearchEnabled':True},indent=2),encoding='utf-8')
    hub=base/'hub/codex-companion-bridge.json'
    if not hub.exists():
        hub.write_text(json.dumps({'port':17864,'token':secrets.token_hex(32),'enabled':True,'work_autonomy':True}),encoding='utf-8')
    bridge=json.loads(hub.read_text(encoding='utf-8'))
    (folder/'bridge.json').write_text(json.dumps(bridge),encoding='utf-8')
    print('Codex independent runtime configured; existing records preserved.')

if __name__=='__main__': prepare()
