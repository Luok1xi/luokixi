"""Ask the real original companion to choose and exercise a tool; no public edits."""
import hashlib
import json
import time
import uuid
from pathlib import Path
from hub.companion_bridge import call
from hub.studio_config import config

ident=hashlib.sha256(('tool-choice:'+str(uuid.uuid4())).encode()).hexdigest()
goal=('这次只做一次工具能力验收，不发布帖子、不改网站内容或源码：'
      '读取 tools 目录，自己选择适合识别 Markdown 标题、链接和代码的工具；若未就绪则安装并测试。'
      '然后真实调用所选工具读取这一小段文本：# 中文项目\n\n[出处](https://github.com/Luok1xi/luokixi)\n\n```python\nprint(1)\n```。'
      '拿到结果后说明识别到哪些结构；只讨论不调用不算完成，不需要找搭档。')
call('jobs',{'id':ident,'owner':config()['owner_id'],'kind':'work','text':'','material':{'goal':goal}},seat='beikuang')
deadline=time.monotonic()+240
while time.monotonic()<deadline:
    result=call('jobs/'+ident,seat='beikuang')
    if result['state'] in ('done','failed'):break
    time.sleep(1)
else:
    call('cancel',{'id':ident},seat='beikuang');result={'state':'timed-out'}
value=result.get('result') or {}
record={'state':result['state'],'error':result.get('error'),'text':value.get('text'),'execution':value.get('maintenance')}
Path('campus/.data/quality-20261009/tool-choice.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(record,ensure_ascii=False),flush=True)
