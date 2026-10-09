"""Real providers only. No canned fallback on authentication/network/model failure."""
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from .core import Problem

EXPRESSIONS = ('neutral', 'composed', 'happy', 'angry', 'think', 'sad', 'awkward', 'curious', 'question', 'surprised')
STAGE_INSTRUCTION = ('expression 只选择当前发言适合的立绘表情：neutral/composed/happy/angry/think/sad/awkward/curious/question/surprised；'
                     '每条发言放进 messages 数组，元素为 {type:"text",text:"中文",speech:"意思一致的日语口语",expression:"表情"}；message 是中文全文。日语只作朗读，不添加新事实、不读网址。'
                     '没有明确情绪就 neutral 或 composed，不为演出强加情绪、不把表情标签写进台词。它不改变人格、关系或操作权限。')
SCHEMA = {'type': 'object', 'additionalProperties': False,
          'properties': {'message': {'type': 'string'},
                         'expression': {'type': 'string', 'enum': list(EXPRESSIONS)},
                         'messages': {'type':'array','items':{'type':'object','additionalProperties':False,'properties':{'type':{'type':'string','enum':['text']},'text':{'type':'string'},'speech':{'type':'string'},'expression':{'type':'string','enum':list(EXPRESSIONS)}},'required':['type','text','speech','expression']}},
                         'tasks': {'type': 'array', 'items': {'type': 'string'}},
                         'files': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False,
                                   'properties': {'path': {'type': 'string'}, 'content': {'type': 'string'}},
                                   'required': ['path', 'content']}}},
          'required': ['message', 'tasks', 'files', 'expression', 'messages']}


def reply_json(raw):
    try:
        value = json.loads(raw)
        if not isinstance(value, dict) or not {'message', 'tasks', 'files'} <= set(value) or set(value) - {'message', 'tasks', 'files', 'expression', 'messages'}:
            raise ValueError()
        if not isinstance(value['message'], str) or not value['message'].strip() or len(value['message']) > 15000:
            raise ValueError()
        if not isinstance(value['tasks'], list) or len(value['tasks']) > 12 or any(not isinstance(x, str) or len(x) > 1000 for x in value['tasks']):
            raise ValueError()
        if not isinstance(value['files'], list) or len(value['files']) > 8:
            raise ValueError()
        for file in value['files']:
            if not isinstance(file, dict) or set(file) != {'path', 'content'} or not all(isinstance(x, str) for x in file.values()):
                raise ValueError()
        parts = value.get('messages', [])
        if not isinstance(parts,list) or len(parts)>24:
            raise ValueError()
        for part in parts:
            if not isinstance(part,dict) or part.get('type')!='text' or not isinstance(part.get('text'),str) or not part['text'].strip() or len(part['text'])>15000:
                raise ValueError()
            if not isinstance(part.get('speech',''),str) or len(part.get('speech',''))>14000:
                raise ValueError()
            if part.get('expression') not in EXPRESSIONS: part['expression']='neutral'
        if parts:
            value['message']='\n\n'.join(p['text'] for p in parts)
            if len(value['message'])>15000: raise ValueError()
        # Older stored outputs remain valid. A bad decorative tag must not lose a real reply.
        if 'expression' in value and value['expression'] not in EXPRESSIONS:
            value['expression'] = 'neutral'
        return value
    except (ValueError, TypeError):
        raise Problem('模型没有返回有效的工作结果，本轮已停止；不会用假回复代替。', 502)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Problem('模型端点发生重定向，已停止以保护凭据。', 502)


def deepseek(prompt, cfg, stopped=lambda: False):
    if stopped():
        raise Problem('本轮已停止。', 409)
    payload = {'model': cfg['deepseek_model'], 'stream': False,
               'messages': [{'role': 'system', 'content': 'Follow the studio instruction. Return exactly one JSON object matching the supplied schema.'},
                            {'role': 'user', 'content': prompt}],
               'response_format': {'type': 'json_object'}, 'max_tokens': cfg['max_output_tokens'],
               'thinking': {'type': 'disabled'}}
    req = urllib.request.Request('https://api.deepseek.com/chat/completions',
                                 data=json.dumps(payload, ensure_ascii=False).encode(), method='POST',
                                 headers={'Authorization': 'Bearer ' + cfg['deepseek_api_key'], 'Content-Type': 'application/json'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=90) as response:
            raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError()
        data = json.loads(raw)
        if data['choices'][0].get('finish_reason') != 'stop':
            raise Problem('DeepSeek 输出未完整结束，已停止，未应用部分代码。', 502)
        value = reply_json(data['choices'][0]['message']['content'])
        usage = data.get('usage') or {}
        return value, str(data.get('model') or cfg['deepseek_model'])[:100], {
            k: max(0, int(usage.get(k, 0))) for k in ('prompt_tokens', 'completion_tokens', 'total_tokens')}
    except urllib.error.HTTPError as exc:
        raise Problem('DeepSeek 请求失败（HTTP ' + str(exc.code) + '），请检查本机密钥、余额或限额。', 502)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError):
        raise Problem('DeepSeek 连接或响应异常；不自动重试以避免重复扣费。', 502)


def codex_command(executable, directory, schema, result, model='', reasoning_effort=''):
    # No user plugins, hooks, shell or web tools. Codex returns code as JSON;
    # the host validates and writes it into a separate candidate afterwards.
    command = [executable, 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
               '--sandbox', 'read-only', '--json', '--color', 'never', '-C', str(directory),
               '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
               '-c', 'features.shell_tool=false', '-c', 'features.apply_patch_freeform=false',
               '-c', 'features.multi_agent=false', '-c', 'features.apps=false',
               '-c', 'features.skills=false', '-c', 'mcp_servers={}',
               '--output-schema', str(schema), '-o', str(result)]
    if model:
        command += ['--model', model]
    if reasoning_effort in ('low','medium','high'):
        command += ['-c', 'model_reasoning_effort='+json.dumps(reasoning_effort)]
    return command + ['-']


def codex(prompt, cfg, stopped=lambda: False, *, output_schema=None, parse_result=None, images=None):
    if stopped():
        raise Problem('本轮已停止。', 409)
    # TEMP is outside the website: no repository config/hooks, no private files in context.
    with tempfile.TemporaryDirectory(prefix='luokixi-studio-') as tmp:
        root = Path(tmp)
        schema, result = root / 'schema.json', root / 'reply.json'
        schema.write_text(json.dumps(output_schema or SCHEMA), encoding='utf-8')
        command = codex_command(cfg['codex_executable'], root, schema, result, cfg['codex_model'],cfg.get('codex_reasoning_effort',''))
        for index,(extension,content) in enumerate(images or []):
            if extension not in ('.png','.jpg','.gif','.webp') or len(content)>8*1024*1024 or index>=4:
                raise Problem('图像附件无效。')
            image=root/f'input-{index}{extension}';image.write_bytes(content)
            command[-1:-1]=['--image',str(image)]
        env = {k: v for k, v in os.environ.items() if k.upper() in {
            'PATH', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
            'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'CODEX_HOME',
            'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'}}
        try:
            with (root / 'events.jsonl').open('w', encoding='utf-8') as out, (root / 'stderr.log').open('w', encoding='utf-8') as err:
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=out, stderr=err,
                                           env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                try:
                    process.stdin.write(prompt.encode('utf-8'))
                    process.stdin.close()
                    timeout = max(1, min(240, float(cfg.get('summary_timeout', 240 if output_schema else 180))))
                    deadline = time.monotonic() + timeout
                    while process.poll() is None:
                        if stopped() or time.monotonic() > deadline:
                            process.kill()
                            process.wait(timeout=10)
                            raise Problem('Codex 调用已取消或超时；不自动重试。', 409)
                        time.sleep(0.25)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=10)
            if process.returncode or not result.is_file():
                raise Problem('Codex 未完成调用，请在本机检查登录、账号额度或网络；不展示可能含隐私的原始日志。', 502)
            events = (root / 'events.jsonl').read_text(encoding='utf-8')
            usage, model = {}, cfg['codex_model'] or 'codex-cli-default'
            for line in events.splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get('type') in {'turn.failed', 'error'}:
                    raise Problem('Codex 报告执行失败，本轮结果未采用。', 502)
                item = event.get('item') or {}
                if item.get('type') in {'command_execution', 'mcp_tool_call', 'web_search', 'file_change'}:
                    raise Problem('Codex 出现本工作室未授权的工具调用，本轮结果未采用。', 502)
                if event.get('type') == 'turn.completed':
                    usage = {k: max(0, int(v)) for k, v in (event.get('usage') or {}).items() if isinstance(v, int)}
                if event.get('model'):
                    model = str(event['model'])[:100]
            if result.stat().st_size > 150000:
                raise Problem('Codex 结果过大，本轮已停止。', 502)
            return (parse_result or reply_json)(result.read_text(encoding='utf-8')), model, usage
        except (OSError, subprocess.SubprocessError):
            raise Problem('无法启动本机 Codex，请检查可执行文件和登录。', 503)
