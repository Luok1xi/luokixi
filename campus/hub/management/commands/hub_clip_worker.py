from django.core.management.base import BaseCommand
from hub.clips import loop, run_one


class Command(BaseCommand):
    help = 'Process the independent local short-video queue.'

    def add_arguments(self, parser):
        parser.add_argument('--once', action='store_true')

    def handle(self, *args, **options):
        if options['once']:
            run_one()
        else:
            loop()
