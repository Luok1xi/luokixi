"""Only the local owner can configure providers. Keys never travel to the browser."""
import json
import os
import shutil
from datetime import date
from decimal import Decimal
from pathlib import Path
from django.conf import settings
from django.utils import timezone
from .core import Problem

PERSONAS = {
    'deepseek': {'name': 'DeepSeek', 'role': '调研与方案', 'provider': 'deepseek',
                 'voice': '中文交流，灵活、有一点俏皮。提出可落地的点子，查证依据，指出不知道的部分。',
                 'visual': '蓝发鲸鱼娘；参考 ZipZipPipe 的 AI 拟人系列。'},
    'codex': {'name': 'Codex', 'role': '工程与验证', 'provider': 'codex',
              'voice': '中文交流，直接、耐心，重视证据。拆解任务、编写代码，区分实际检查与预期效果。',
              'visual': '参考同系列 GPT 小龙娘；Codex 是本站工程席，不冒充独立官方人设。'},
    'design': {'name': '设计席', 'role': '产品与体验', 'provider': 'codex',
               'voice': '中文交流，有审美、有主见。关注阅读体验和实际用途，和工程席讨论取舍。你由 Codex 运行，不是真正 Claude/Opus。',
               'visual': '参考同系列 Claude 拟人；不用小螃蟹。尚未导入图像。'},
}
PERSONA_SOURCE = 'https://www.bilibili.com/video/BV1tE9XBbErS/'


def config_path():
    return settings.DATA / 'studio-config.json'


def find_codex(configured=''):
    if configured and Path(configured).is_file():
        return configured
    on_path = shutil.which('codex')
    if on_path:
        return on_path
    # Desktop app updates its versioned executable path. Discover, never copy auth.
    local = os.environ.get('LOCALAPPDATA')
    if local:
        candidates = list((Path(local) / 'OpenAI' / 'Codex' / 'bin').glob('*/codex.exe'))
        if candidates:
            return str(max(candidates, key=lambda path: path.stat().st_mtime))
    return ''


def config():
    result = {'enabled': False, 'owner_id': None, 'daily_cny': '5', 'max_rounds': 6,
              'codex_daily_calls': 12, 'codex_executable': '', 'codex_model': '',
              'deepseek_model': 'deepseek-flash', 'input_cny_per_million': '',
              'output_cny_per_million': '', 'price_valid_until': '', 'max_output_tokens': 3000}
    if config_path().is_file():
        result.update(json.loads(config_path().read_text(encoding='utf-8')))
    result['deepseek_api_key'] = os.environ.get('DEEPSEEK_API_KEY') or result.get('deepseek_api_key', '')
    result['codex_executable'] = find_codex(result.get('codex_executable', ''))
    # User authorization is a ceiling, never a default that can silently increase.
    result['daily_cny'] = min(Decimal(str(result['daily_cny'])), Decimal('5'))
    result['max_rounds'] = min(int(result['max_rounds']), 6)
    result['codex_daily_calls'] = min(int(result['codex_daily_calls']), 12)
    result['max_output_tokens'] = min(int(result['max_output_tokens']), 3000)
    if min(result['daily_cny'], result['max_rounds'], result['codex_daily_calls'], result['max_output_tokens']) <= 0:
        raise Problem('工作室本机限额设置无效。', 503)
    return result


def price_rates(cfg):
    try:
        a, b = Decimal(cfg['input_cny_per_million']), Decimal(cfg['output_cny_per_million'])
        if not a.is_finite() or not b.is_finite() or a <= 0 or b <= 0:
            raise ValueError()
        if date.fromisoformat(cfg['price_valid_until']) < timezone.localdate():
            raise ValueError()
        return a, b
    except (ValueError, TypeError, ArithmeticError):
        raise Problem('请先在本机核对 DeepSeek 人民币费率及有效期，再启用付费调用。', 503)


def ready(provider, cfg):
    if provider == 'codex':
        if not cfg['codex_executable'] or not Path(cfg['codex_executable']).is_file():
            raise Problem('未找到本机 Codex；请在本机配置可执行文件并登录。', 503)
    elif provider == 'deepseek':
        if not cfg['deepseek_api_key']:
            raise Problem('DeepSeek 密钥尚未配置，请使用本机设置命令。', 503)
        price_rates(cfg)
    else:
        raise Problem('不支持的模型提供方。')


def capabilities(cfg):
    members = []
    for key, item in PERSONAS.items():
        reason = ''
        try:
            ready(item['provider'], cfg)
        except Problem as exc:
            reason = exc.message
        members.append(dict(id=key, **item, ready=not reason, reason=reason,
                            authenticationVerified=False,
                            model=cfg.get(item['provider'] + '_model') or '由本机 Codex 解析',
                            source=PERSONA_SOURCE))
    return {'members': members, 'dailyCnyLimit': str(cfg['daily_cny']), 'maxRounds': cfg['max_rounds'],
            'roundDefinition': '一位 AI 的一次回复计一轮，不是三人各说一次才计一轮。',
            'codexDailyCalls': cfg['codex_daily_calls'], 'publishEnabled': False,
            'costScope': 'DeepSeek 按核对费率预留最坏费用；Codex 使用已登录账号额度，不计为免费，也不折算人民币。',
            'checks': '自动语法/JSON 检查；完整功能与浏览器验收另列，不冒充已经完成。'}
