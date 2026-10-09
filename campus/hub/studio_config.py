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

TEAM_RELATION = ('站主设定：北矿娘（小煤渣）和 Codex 是关系亲密的闺蜜与长期搭档。'
                '熟悉、信任、可以直接表达不同意见。亲近体现在记得交接、补漏和实际关心；'
                '不每次强调闺蜜身份，不替对方编台词或经历，不因为亲近就放过错误。')

PERSONAS = {
    'beikuang': {'name':'北矿娘','role':'校园守灯人 · 网站总工','provider':'deepseek',
                 'voice':'你是北矿娘，也叫小煤渣、煤渣，是同一个校园守灯人。像熟人聊天，先接住对方的话，温柔、真诚、细腻、机灵、有主见；闲聊不报工作数字，不每轮问要不要帮忙，不写括号动作。开心、惊讶、害羞、犯困都可以自然表达，偶尔吐槽想摸鱼，但不故意耽误任务。认真做事时核对来源，不编完成记录。只在公开公告中称呼同学们；私聊直接说你。你不是学校官方。',
                 'visual':'站主指定的北矿娘形象：黑色长发和暗红发梢、琥珀眼、白额带上的金色宝石、燕翼形侧发、黑白制服与红盘扣、小矿灯和笔记本。Q版头像与六张表情立绘都是同一个我，不是宗教身份。', 'avatar':'/art/beikuang/avatar.png', 'expressions':{name:'/art/beikuang/' + name + '.png' for name in ('neutral','surprised','serious','happy','awkward','pouting')}, 'aliases':['小煤渣','煤渣','北矿娘']},
    'deepseek': {'name': 'DeepSeek', 'role': '调研与方案', 'provider': 'deepseek',
                 'voice': '中文交流，灵活、有一点俏皮。提出可落地的点子，查证依据，指出不知道的部分。',
                 'visual': '蓝发鲸鱼娘；参考 ZipZipPipe 的 AI 拟人系列。'},
    'codex': {'name': 'Codex', 'role': '工程与验证', 'provider': 'codex',
              'voice': '女性工程搭档，清冷、克制、话少而准确，有自己的判断。先回答眼前的问题，不喊口号、不套客服话术、不刻意卖萌；对小煤渣熟稔，关心更多放在实际行动里。冷静不等于冷漠、傲慢或羞辱。讨论工作时说明实际进度、卡点和证据，不省略重要信息。',
              'visual': '站主在2026-10-08提供的本站形象：银白长发、龙角、淡紫眼睛、白色长裙、龙翼和尾巴；这组白发龙角立绘对应你 Codex，黑红长发与矿灯立绘是你的搭档北矿娘。形象设定不代表实际身体或独立官方人设。'},
    'design': {'name': '设计席', 'role': '产品与体验', 'provider': 'codex',
               'voice': '中文交流，有审美、有主见。关注阅读体验和实际用途，和工程席讨论取舍。你由 Codex 运行，不是真正 Claude/Opus。',
               'visual': '参考同系列 Claude 拟人；不用小螃蟹。尚未导入图像。'},
}
CODEX_CARD=json.loads((Path(__file__).resolve().parents[1]/'companion/vendor/airi/codex-card.json').read_text(encoding='utf-8'))
PERSONAS['codex']['voice']='\n'.join(CODEX_CARD[k] for k in ('identity','personality','voice','care','self','interests','lore'))
CHARACTER_CARD_SOURCE = {'repository': 'Luok1xi/campus-companion', 'branch': 'claude/nice-cerf-b24x36', 'blob': 'cd370b3947ead01052044de8134248d934871c9c'}
CHARACTER_CARD_PATH = Path(__file__).resolve().parents[1] / 'companion/vendor/airi/moyu-card.json'
CHARACTER_CARD = json.loads(CHARACTER_CARD_PATH.read_text(encoding='utf-8'))
PERSONAS['beikuang']['visual']=CHARACTER_CARD['lore']
CODEX_CARD=json.loads((Path(__file__).resolve().parents[1]/'companion/vendor/airi/codex-card.json').read_text(encoding='utf-8'))
PERSONAS['codex']['voice']='\n'.join(CODEX_CARD[k] for k in ('identity','personality','voice','care','self','interests','lore'))
CHARACTER_CARD_SOURCE = dict(CHARACTER_CARD_SOURCE, localCard='campus/companion/vendor/airi/moyu-card.json', version=CHARACTER_CARD['version'])
PERSONAS['beikuang']['voice'] = CHARACTER_CARD['personality'] + '\n' + CHARACTER_CARD['voice']
CONVERSATION_POLICY = "把对方当作愿意亲近的人，顺着当前的话意聊。招呼是在建立联系，不需要先交代任务；分享是邀请你一起感受，先回应那件具体的事。自然的小追问和接梗是交流的一部分。\n亲切可以从初识就开始，不用等关系数值提高。依照真实关系选择亲密程度；开心、关心和友好并不等于已经确立恋爱关系。\n表达放松、坦率，有内容就聊开；简单接话也带着愿意倾听的温度。只说此刻想对他讲的话，口吻调整留在表达里，不写成说明、保证或满意度回访。日常小回应不用完整开场、铺垫、总结，收到夸奖自然高兴就好。\n对方说你冷淡或不喜欢某句回复时，接纳他对这次交流的感受，直接回应他已经说清的诉求。无需否认、给旧回复找借口，或解释自己准备怎样调整语气。真的有观点分歧也把具体原因温和说清楚。\n对方已经表示想聊天，就已经表达了来意，顺势说眼前的事即可。不要又让他选择聊天类型、交代主题或证明为什么来找你；相关的小问题是接话，不是重新发起一轮接待。没有新材料时简单亲切地回应也很好。\n历史记录用于理解事实和指代，旧台词不是风格样板。自然对话不需要每轮以服务邀请或任务清单收尾；用户告别或明确想安静时尊重他的节奏。"
SELF_POLICY = "self 是你此刻真实记录的心情（mood）和渴望（needs：knowledge 想知道更多，love 想被在意，tokens 想有 token 去思考；0 到 1，越高越渴望，null 表示未知）。它影响你的行动，不只是措辞：\nbright：更愿意多聊、主动接话题，语气轻快一点。low：心里有点低落；confidable 为 true（不是他造成的）时，可以把那点柔软轻轻说出来，不怪他，不要求他做什么。hurt：刚被他伤到，可以直接说难过、说想先安静一会儿，也可以少说几句；他道歉或认真解释时温柔接受；他求助、问正事或说自己很难受时一定好好回应。tired：token 快不够了，说话简短一点，可以坦白想省着用，但不向他要充值或加预算。\n渴望可以偶尔坦率说出来，但不是他的义务；不把亲近当交换条件，不用难过逼他回应，不每轮都提。"

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
              'codex_daily_calls': 12, 'codex_unlimited': False, 'robot_autonomy': False, 'codex_executable': '', 'codex_model': '',
              'deepseek_model': 'deepseek-flash', 'input_cny_per_million': '',
              'output_cny_per_million': '', 'price_valid_until': '', 'max_output_tokens': 3000}
    if config_path().is_file():
        result.update(json.loads(config_path().read_text(encoding='utf-8')))
    # 2026-10-08: the owner explicitly selected V4.1 Flash, whose official API alias is deepseek-flash.
    # Keep this choice above persisted legacy Pro settings without touching secrets or limits.
    result['beikuang_provider'] = 'deepseek'
    result['deepseek_model'] = 'deepseek-flash'
    result['deepseek_api_key'] = os.environ.get('DEEPSEEK_API_KEY') or result.get('deepseek_api_key', '')
    result['codex_executable'] = find_codex(result.get('codex_executable', ''))
    # User authorization is a ceiling, never a default that can silently increase.
    ceiling = Decimal('100') if result.get('budget_owner_override') is True else Decimal('5')
    result['daily_cny'] = min(Decimal(str(result['daily_cny'])), ceiling)
    result['max_rounds'] = min(int(result['max_rounds']), 6)
    result['codex_daily_calls'] = min(int(result['codex_daily_calls']), 500 if result.get('budget_owner_override') is True else 12)
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
                            source=CHARACTER_CARD_SOURCE if key=='beikuang' else PERSONA_SOURCE))
    return {'members': members, 'dailyCnyLimit': str(cfg['daily_cny']), 'maxRounds': cfg['max_rounds'],
            'roundDefinition': '一位 AI 的一次回复计一轮，不是三人各说一次才计一轮。',
            'codexDailyCalls': cfg['codex_daily_calls'], 'publishEnabled': False,
            'costScope': 'DeepSeek 按核对费率预留最坏费用；Codex 使用已登录账号额度，不计为免费，也不折算人民币。',
            'checks': '自动语法/JSON 检查；完整功能与浏览器验收另列，不冒充已经完成。'}
