import getpass
import json
import os
from datetime import date, timedelta
from pathlib import Path
from django.conf import settings
from django.utils import timezone
from django.core.management.base import BaseCommand, CommandError
from hub.models import Member
from hub.studio_config import config_path, find_codex


class Command(BaseCommand):
    help = 'Configure the studio locally; secret input is hidden and never returned over HTTP.'

    def add_arguments(self, parser):
        parser.add_argument('--owner', required=True, help='Existing verified staff username')
        parser.add_argument('--codex', default='', help='Optional executable override; otherwise discover desktop/CLI')
        parser.add_argument('--without-deepseek', action='store_true')
        parser.add_argument('--disable', action='store_true')

    def handle(self, *args, **options):
        if settings.PRODUCTION:
            raise CommandError('Only available on this computer.')
        member = Member.objects.filter(username=options['owner'], is_staff=True, is_active=True).first()
        if not member:
            raise CommandError('请先选择已注册、验证邮箱且有管理员权限的本人账号；不会自动提升他人权限。')
        previous = json.loads(config_path().read_text(encoding='utf-8')) if config_path().exists() else {}
        bootstrap = member.is_superuser and previous.get('owner_id') == member.pk and previous.get('local_owner_bootstrap') is True
        if not member.email_verified and not bootstrap:
            raise CommandError('该账号邮箱未验证，也不是本机初始化的开发者账号。')
        found = find_codex(options['codex'])
        if not found:
            raise CommandError('Codex executable not found.')
        executable = Path(found).resolve()
        if options['disable']:
            target = config_path()
            result = json.loads(target.read_text(encoding='utf-8')) if target.exists() else {}
            if result.get('owner_id') not in (None, member.pk):
                raise CommandError('This configuration belongs to another local owner.')
            result['enabled'] = False
            target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            self.stdout.write('工作室已停用；现有记录与密钥保留，未调用模型。')
            return
        result = {'enabled': not options['disable'], 'owner_id': member.pk, 'daily_cny': '5',
                  'max_rounds': 6, 'codex_daily_calls': 12, 'codex_executable': str(executable),
                  'codex_model': '', 'deepseek_model': 'deepseek-flash', 'max_output_tokens': 3000}
        result['local_owner_bootstrap'] = bool(bootstrap)
        if not options['without_deepseek'] and not options['disable']:
            result['deepseek_api_key'] = getpass.getpass('DeepSeek API key（仅保存在本站忽略目录，不回显）: ').strip()
            if not result['deepseek_api_key']:
                raise CommandError('密钥为空，配置没有保存。')
            self.stdout.write('请在 DeepSeek 控制台核对所选模型的人民币最高时段单价。不要填写美元价格。')
            result['input_cny_per_million'] = input('每百万输入 token 人民币（缓存未命中，最高时段）: ').strip()
            result['output_cny_per_million'] = input('每百万输出 token 人民币（最高时段）: ').strip()
            result['price_valid_until'] = (timezone.localdate() + timedelta(days=7)).isoformat()
            from hub.studio_config import price_rates
            price_rates(result)
        target = config_path()
        temporary = target.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        if os.name != 'nt':
            temporary.chmod(0o600)
        os.replace(temporary, target)
        self.stdout.write('本机配置已保存；每日 DeepSeek 上限 5 元，每次最多 6 轮，Codex 每日最多 12 次。未调用任何模型。')
