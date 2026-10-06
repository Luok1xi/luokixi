import time
from django.core.management.base import BaseCommand, CommandError
from django.conf import settings
from hub.studio_worker import run_one, recover_interrupted


class Command(BaseCommand):
    help = 'Run the local, owner-only AI studio worker. No automatic publish or retry.'

    def add_arguments(self, parser):
        parser.add_argument('--once', action='store_true')
        parser.add_argument('--recover-interrupted', action='store_true')

    def handle(self, *args, **options):
        if settings.PRODUCTION:
            raise CommandError('AI studio is local-only in this version.')
        if options['recover_interrupted']:
            self.stdout.write(f'Interrupted runs marked: {recover_interrupted()}')
        if options['once']:
            self.stdout.write('Processed one run.' if run_one() else 'No queued work.')
            return
        self.stdout.write('Local AI studio worker started. Ctrl+C stops it; no automatic retries.')
        try:
            while True:
                if not run_one():
                    time.sleep(2)
        except KeyboardInterrupt:
            self.stdout.write('Stopped.')
