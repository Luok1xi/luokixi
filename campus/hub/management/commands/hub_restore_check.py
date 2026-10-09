import json
from django.core.management.base import BaseCommand, CommandError
from hub.backup import BackupError, restore_backup


class Command(BaseCommand):
    help = 'Verify and restore a backup into a NEW isolated private directory, never the live database.'

    def add_arguments(self, parser):
        parser.add_argument('backup_id')
        parser.add_argument('--destination', help='Optional NEW private directory; existing destinations are refused.')

    def handle(self, *args, **options):
        try:
            result, directory = restore_backup(options['backup_id'], destination=options.get('destination'))
            self.stdout.write(json.dumps({'privateRestoreDirectory': str(directory), 'result': result}, ensure_ascii=False))
        except (BackupError, OSError) as exc:
            raise CommandError(str(exc)) from None
