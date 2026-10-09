"""Local authenticated community, served by Waitress; no public exposure by default."""
import argparse
import threading
import manage_hub
import django
django.setup()
from django.core.management import call_command
from hub.wsgi import application


if __name__=='__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=17861)
    parser.add_argument('--host',default='127.0.0.1')
    parser.add_argument('--no-worker',action='store_true')
    parser.add_argument('--review-mode',action='store_true',help='Local acceptance: run backups, restoration checks and explicit local question jobs')
    args = parser.parse_args()
    call_command('migrate',interactive=False,verbosity=0)
    stop = threading.Event()
    if not args.no_worker:
        from hub.worker import loop_review
        threading.Thread(target=loop_review, args=(stop,), daemon=True).start()
    from hub.operations import worker_mode, loop as operations_loop, review_loop
    worker_mode(not args.no_worker, ('site-backup', 'site-backup-check', 'question-process', 'beikuang-chat', 'beikuang-report', 'maint-beikuang') if args.review_mode else None)
    if args.review_mode and not args.no_worker:
        threading.Thread(target=review_loop,args=(stop,),daemon=True).start()
        # Interactive jobs are explicitly requested by the owner, even in review mode.
        from hub.worker import loop_interactive
        threading.Thread(target=loop_interactive,args=(stop,),daemon=True).start()
    elif not args.no_worker:
        from hub.worker import loop, loop_interactive
        threading.Thread(target=loop,args=(stop,),daemon=True).start()
        threading.Thread(target=loop_interactive,args=(stop,),daemon=True).start()
        from hub.clips import loop as clip_loop
        threading.Thread(target=clip_loop,args=(stop,),daemon=True).start()
        threading.Thread(target=operations_loop,args=(stop,),daemon=True).start()
    if not args.no_worker:
        from hub.content_pipeline import loop as content_loop
        threading.Thread(target=content_loop, args=(stop,), daemon=True).start()
        from hub.studio_worker import loop as studio_loop
        threading.Thread(target=studio_loop, args=(stop,), daemon=True).start()
    from waitress import serve
    print(f'Luokixi community ready: http://{args.host}:{args.port}/hub/',flush=True)
    try:
        serve(application,host=args.host,port=args.port,threads=8,max_request_body_size=201*1024*1024,
              expose_tracebacks=False,channel_timeout=120)
    finally:
        stop.set()
