import json
from django.core.management.base import BaseCommand, CommandError
from hub.backup import BackupError, backup_root, create_backup, list_backups


class Command(BaseCommand):
    help = 'Create a private, consistent full-site backup without stopping or changing the live database.'

    def add_arguments(self, parser):
        parser.add_argument('--no-library', action='store_true')
        parser.add_argument('--no-public-files', action='store_true')
        parser.add_argument('--retain', type=int, default=7)
        parser.add_argument('--list', action='store_true')

    def handle(self, *args, **options):
        try:
            result = list_backups() if options['list'] else create_backup(
                include_library=not options['no_library'], include_public_files=not options['no_public_files'],
                retain=options['retain'])
            self.stdout.write(json.dumps({'privateDirectory': str(backup_root()), 'result': result}, ensure_ascii=False))
        except (BackupError, OSError) as exc:
            raise CommandError(str(exc)) from None
