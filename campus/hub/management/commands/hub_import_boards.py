from django.core.management.base import BaseCommand
from hub.circle import DEFAULT_BOARDS
from hub.models import CampusBoard


class Command(BaseCommand):
    help = 'Create missing campus boards; no users, posts, likes or fabricated activity.'

    def handle(self, *args, **options):
        count = 0
        for slug, name, description in DEFAULT_BOARDS:
            _, created = CampusBoard.objects.get_or_create(pk=slug, defaults={'name': name, 'description': description,
                'rules': '围绕本吧主题分享；注明来源和适用背景；讨论观点与经历；不公开他人隐私。'})
            count += created
        self.stdout.write(f'Created {count} empty campus boards. Existing boards unchanged.')
