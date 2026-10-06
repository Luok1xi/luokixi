"""Explicit local CLI provisioning; never an HTTP registration privilege path."""
import json
import os
import re
import secrets
import subprocess
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from hub.models import Member, Audit
from hub.studio_config import config_path, find_codex


class Command(BaseCommand):
    help = 'Create a local-only developer superuser after explicit owner authorization.'

    def add_arguments(self, parser):
        parser.add_argument('--username', required=True)

    def handle(self, *args, **options):
        if settings.PRODUCTION:
            raise CommandError('Local bootstrap is unavailable in production.')
        username = options['username']
        if not re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,29}', username):
            raise CommandError('Invalid username.')
        if Member.objects.filter(username__iexact=username).exists():
            raise CommandError('Account exists; it was not modified or elevated.')
        target = settings.DATA / 'owner-private' / 'developer-account.txt'
        if target.exists() or config_path().exists():
            raise CommandError('Existing owner/configuration found; do not overwrite it.')
        executable = find_codex()
        if not executable:
            raise CommandError('Codex is not available on this computer.')
        password = secrets.token_urlsafe(24)
        email = username + '@localhost.invalid'
        private = settings.DATA / 'owner-private'
        private.mkdir(exist_ok=True)
        if os.name == 'nt':
            who = subprocess.run(['whoami', '/user', '/fo', 'csv', '/nh'], capture_output=True, check=True).stdout
            matched = re.search(rb'S-1-(?:[0-9]+-)*[0-9]+', who)
            if not matched:
                raise CommandError('Cannot identify the current Windows security identifier.')
            sid = matched.group().decode('ascii')
            # Restrict only the new credentials directory, never the whole project.
            subprocess.run(['icacls', str(private), '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        else:
            private.chmod(0o700)
        target = private / 'developer-account.txt'
        with transaction.atomic():
            member = Member.objects.create_superuser(username=username, email=email, password=password,
                display_name='Luokixi 开发者', email_verified=False)
            # A placeholder local login identifier, not a verified real mailbox.
            config_path().write_text(json.dumps({'enabled': True, 'owner_id': member.pk,
                'local_owner_bootstrap': True, 'daily_cny': '5', 'max_rounds': 6,
                'codex_daily_calls': 12, 'codex_executable': executable}, ensure_ascii=False, indent=2), encoding='utf-8')
            with target.open('x', encoding='utf-8') as output:
                output.write('Luokixi 本机开发者账号\n\n登录入口：http://127.0.0.1:17860/auth.html\n'
                    '用户名：' + username + '\n登录邮箱（仅本机占位）：' + email + '\n初始密码：' + password +
                    '\n\n权限：站点超级管理员 / 内容管理 / 本机 AI 工作室站主。\n'
                    '真实邮箱未验证；不是学校认证账号。\n'
                    '请在本机保存好密码。此文件只允许当前 Windows 用户访问，不要上传或转发。\n'
                    '修改密码：python campus/manage_hub.py changepassword ' + username + '\n')
            if os.name != 'nt':
                target.chmod(0o600)
            Audit.objects.create(actor=member, action='local-owner-created', target=str(member.pk),
                                 detail={'emailVerified': False, 'authorizedBy': 'local-console'})
        self.stdout.write(json.dumps({'created': username, 'superuser': True, 'emailVerified': False,
                                     'credentialsFile': str(target)}, ensure_ascii=False))
