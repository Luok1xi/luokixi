import time
from django.core.management.base import BaseCommand
from django.db import close_old_connections
from hub.bookings import advance

class Command(BaseCommand):
    help='Process reservation reminders without accessing university accounts.'
    def add_arguments(self,parser):parser.add_argument('--once',action='store_true')
    def handle(self,*args,**options):
        while True:
            close_old_connections()
            try: advance()
            except Exception:
                import logging
                logging.getLogger('hub').exception('Seat reminder pass failed')
                if options['once']:raise
            if options['once']:break
            time.sleep(15)
