"""Django management commands; dependencies may be installed in the project-local runtime."""
import os
import sys
from pathlib import Path

runtime = Path(__file__).resolve().parent / '.data' / 'hub-runtime'
if runtime.is_dir():
    sys.path.insert(0, str(runtime))
video_runtime = Path(__file__).resolve().parent / '.data' / 'hub-video-runtime'
if video_runtime.is_dir():
    sys.path.insert(0, str(video_runtime))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hub.settings')
if __name__ == '__main__':
    from django.core.management import execute_from_command_line
    execute_from_command_line(sys.argv)
