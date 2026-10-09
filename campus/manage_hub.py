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
question_runtime = Path(__file__).resolve().parent / '.data' / 'question-runtime'
if question_runtime.is_dir():
    sys.path.insert(0, str(question_runtime))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hub.settings')
if __name__ == '__main__':
    # Isolate configuration as well as the Django database. Otherwise test code
    # can discover the live companion bridge and accidentally call a real AI.
    if len(sys.argv) > 1 and sys.argv[1] == 'test':
        import tempfile
        with tempfile.TemporaryDirectory(prefix='luokixi-test-config-') as isolated:
            os.environ['HUB_DATA_DIR'] = isolated
            from django.core.management import execute_from_command_line
            execute_from_command_line(sys.argv)
    else:
        from django.core.management import execute_from_command_line
        execute_from_command_line(sys.argv)
