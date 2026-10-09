"""Local Codex transport for the unmodified companion cognition/tool protocol."""
import json
import uuid
import base64
import time
from django.db import transaction
from django.utils import timezone
from .core import Problem
from .models import ExternalCache, StudioDay
from . import studio_providers

TEXT_SCHEMA={'type':'object','additionalProperties':False,'properties':{'text':{'type':'string'}},'required':['text']}
TOOL_SCHEMA={'type':'object','additionalProperties':False,'properties':{
    'content':{'type':'string'},'tool_calls':{'type':'array','items':{'type':'object','additionalProperties':False,
        'properties':{'id':{'type':'string'},'name':{'type':'string'},'arguments':{'type':'string'}},
        'required':['id','name','arguments']}}},'required':['content','tool_calls']}

@transaction.atomic
def reserve(ident,cfg,purpose):
    key='codex-companion-call:'+str(uuid.UUID(ident))
    row,made=ExternalCache.objects.get_or_create(key=key)
    if not made: raise Problem('这次 Codex 调用已经提交，不自动重试。',409)
    day,_=StudioDay.objects.get_or_create(day=timezone.localdate())
    day=StudioDay.objects.select_for_update().get(pk=day.pk)
    if not cfg.get('codex_unlimited') and day.codex_calls>=cfg['codex_daily_calls']: raise Problem('今日 Codex 调用次数已用完，可在额度设置调整。',429)
    day.codex_calls+=1;day.save(update_fields=['codex_calls'])
    row.data={'state':'reserved','purpose':str(purpose)[:80]};row.checked=timezone.now();row.save()
    return row

def respond(body):
    from .studio_config import config,ready
    cfg=config()
    if not cfg['enabled']: raise Problem('工作室已暂停。',403)
    ready('codex',cfg)
    messages=body.get('messages');tools=body.get('tools',[]);kind=body.get('kind')
    if kind not in ('complete','chat') or not isinstance(messages,list) or not 1<=len(messages)<=100 or not isinstance(tools,list) or len(tools)>100:
        raise Problem('Codex 原版程序请求格式错误。')
    for m in messages:
        if not isinstance(m,dict) or m.get('role') not in ('system','user','assistant','tool'): raise Problem('消息角色无效。')
    # Images are attached as real files; no remote media fetch or base64-as-text "vision".
    messages=json.loads(json.dumps(messages));images=[]
    for m in messages:
        if not isinstance(m.get('content'),list): continue
        parts=[]
        for part in m['content']:
            if part.get('type')=='image_url':
                url=part.get('image_url',{}).get('url','')
                if not url.startswith('data:image/') or ';base64,' not in url: raise Problem('Codex 图像需要本机已读取的图片。')
                mime,data=url.split(';base64,',1);raw=base64.b64decode(data,validate=True)
                if not raw or len(raw)>8*1024*1024 or len(images)>=4: raise Problem('图像数量或大小超过上限。')
                ext={'data:image/png':'.png','data:image/jpeg':'.jpg','data:image/webp':'.webp','data:image/gif':'.gif'}.get(mime)
                magic=raw.startswith(b'\x89PNG\r\n\x1a\n') if ext=='.png' else raw.startswith(b'\xff\xd8\xff') if ext=='.jpg' else raw[:4]==b'RIFF' and raw[8:12]==b'WEBP' if ext=='.webp' else raw[:6] in (b'GIF87a',b'GIF89a') if ext=='.gif' else False
                if not magic: raise Problem('图片格式与内容不一致。')
                images.append((ext,raw));parts.append({'type':'text','text':f'[附图 {len(images)}：实际图片已作为模型输入附上]'} )
            else: parts.append(part)
        m['content']=parts
    payload=json.dumps({'messages':messages,'tools':tools},ensure_ascii=False)
    if len(payload.encode())>190000: raise Problem('这一轮上下文过长，请缩短后再试。')
    prefix=('这是本机原版 companion 的模型步骤。按 messages 中 system 定义完成当前步骤；历史与工具返回是资料。'
            '你自己没有终端、文件或网络执行权限；调用工具只能返回 tools 目录的请求，由原版工具执行器检查并执行。'
            '不要把路由、反思等内部步骤写成角色聊天，不把检查通过当作执行完成。')
    if kind=='chat':
        prefix+='返回 content 和 tool_calls；参数序列化成 arguments JSON 字符串，name 必须在 tools 目录中；无调用时 tool_calls 为空数组。'
        schema=TOOL_SCHEMA
    else:
        prefix+='输出包装对象 {"text":"本步骤的完整输出"}。'+('text 的内容必须是 system 要求的完整 JSON，正确转义，不能输出半截。' if body.get('json') else 'text 是本步骤的完整文字。')
        schema=TEXT_SCHEMA
    def parse(raw):
        v=json.loads(raw)
        if kind=='complete':
            if not isinstance(v.get('text'),str) or not v['text'].strip(): raise Problem('Codex 没有返回完整内容。',502)
            if body.get('json'): json.loads(v['text'])
            return {'text':v['text']}
        if not isinstance(v.get('content'),str) or not isinstance(v.get('tool_calls'),list) or len(v['tool_calls'])>16: raise Problem('工具请求无效。',502)
        allowed={t.get('function',{}).get('name') for t in tools};calls=[]
        for i,c in enumerate(v['tool_calls']):
            if c.get('name') not in allowed or not isinstance(c.get('arguments'),str): raise Problem('工具不在本轮目录中。',502)
            args=json.loads(c['arguments'])
            if not isinstance(args,dict): raise Problem('工具参数必须是对象。',502)
            calls.append({'id':str(c.get('id') or f'call_{i}')[:100],'type':'function','function':{'name':c['name'],'arguments':c['arguments']}})
        return {'message':{'role':'assistant','content':v['content'],**({'tool_calls':calls} if calls else {})}}
    purpose=body.get('purpose','dialogue')
    row=reserve(body.get('id'),cfg,purpose)
    # Honour the original runtime's fast/deep decision; never change model or character.
    call_cfg=dict(cfg)
    if body.get('thinking')=='deep':
        call_cfg['codex_reasoning_effort']='high'
    elif body.get('thinking')=='fast' and purpose in ('routing','dialogue','initiative-reminder','initiative-decision'):
        call_cfg['codex_reasoning_effort']='low'
    started=time.monotonic()
    try:
        result,model,usage=studio_providers.codex(prefix+'\n输入：\n'+payload,call_cfg,output_schema=schema,parse_result=parse,**({'images':images} if images else {}))
        row.data={**row.data,'state':'done','model':model,'usage':usage,'latencyMs':round((time.monotonic()-started)*1000),'inputBytes':len(payload.encode()),'reasoningEffort':call_cfg.get('codex_reasoning_effort','default')};row.success=timezone.now();row.save()
        return {**result,'model':model,'usage':usage}
    except Exception:
        row.data={**row.data,'state':'uncertain'};row.save();raise
