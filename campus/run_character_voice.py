"""Local adapter around the imported engine; its code remains private and unmodified."""
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
ENGINE = ROOT / '.data/voice-runtime/engine/GPT-SoVITS-v2pro-20250604-nvidia50'
os.chdir(ENGINE)
sys.path.insert(0, str(ENGINE))
sys.path.append(str(ENGINE / 'GPT_SoVITS'))
import yaml
import torch
from utils import HParams
# Legacy packages pickle this plain configuration container. Allow that exact class,
# while retaining weights-only deserialization for every checkpoint.
torch.serialization.add_safe_globals([HParams])

registry = json.loads((ROOT / '.data/voices/profiles.json').read_text(encoding='utf-8'))
profile = registry['profiles'][registry['seats']['beikuang']]
config = yaml.safe_load((ENGINE / 'GPT_SoVITS/configs/tts_infer.yaml').read_text(encoding='utf-8'))
config['custom'].update(t2s_weights_path=profile['ttsGptWeights'], vits_weights_path=profile['ttsSovitsWeights'], device='cuda', is_half=True)
config_path = ROOT / '.data/voice-runtime/active-infer.yaml'
config_path.write_text(yaml.safe_dump(config, allow_unicode=True), encoding='utf-8')
sys.argv = ['api_v2.py', '-a', '127.0.0.1', '-p', '17863', '-c', str(config_path)]
import api_v2
from fastapi.responses import JSONResponse

@api_v2.APP.middleware('http')
async def local_only(request, call_next):
    if request.headers.get('origin') or request.headers.get('sec-fetch-site'):
        return JSONResponse({'error': 'Use the authenticated website voice endpoint.'}, status_code=403)
    if request.url.path == '/control':
        return JSONResponse({'error': 'Control disabled.'}, status_code=403)
    if request.url.path in ('/set_gpt_weights', '/set_sovits_weights'):
        allowed = {p.get(key) for p in registry['profiles'].values() for key in ('ttsGptWeights', 'ttsSovitsWeights')}
        if request.query_params.get('weights_path') not in allowed:
            return JSONResponse({'error': 'Unknown imported model.'}, status_code=403)
    return await call_next(request)

@api_v2.APP.get('/luokixi-health')
def health():
    return {'app': 'luokixi-character-voice', 'local': True, 'gpu': True}

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(api_v2.APP, host='127.0.0.1', port=17863, workers=1)
