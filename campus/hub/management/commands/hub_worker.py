from django.core.management.base import BaseCommand
from hub.worker import loop, run_one, schedule

class Command(BaseCommand):
    help = 'Process durable jobs; --once performs one scheduler pass and drains due jobs.'
    def add_arguments(self,parser):
        parser.add_argument('--once',action='store_true')
    def handle(self,*args,**options):
        if options['once']:
            schedule()
            while run_one():
                pass
        else:
            loop()
