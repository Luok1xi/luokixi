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
    args = parser.parse_args()
    call_command('migrate',interactive=False,verbosity=0)
    stop = threading.Event()
    if not args.no_worker:
        from hub.worker import loop
        threading.Thread(target=loop,args=(stop,),daemon=True).start()
        from hub.clips import loop as clip_loop
        threading.Thread(target=clip_loop,args=(stop,),daemon=True).start()
    from waitress import serve
    print(f'Luokixi community ready: http://{args.host}:{args.port}/hub/',flush=True)
    try:
        serve(application,host=args.host,port=args.port,threads=8,max_request_body_size=201*1024*1024,
              expose_tracebacks=False,channel_timeout=120)
    finally:
        stop.set()
