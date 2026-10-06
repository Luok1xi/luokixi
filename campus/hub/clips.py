"""Bounded, local short-video ingestion; originals are never public."""
import os
import re
import shutil
import subprocess
import threading
from datetime import timedelta
from pathlib import Path
from django.conf import settings
from django.db import close_old_connections, transaction
from django.db.models import Q
from django.http import FileResponse, StreamingHttpResponse, HttpResponse
from django.utils import timezone
from .core import Problem, require, text, throttle, notify
from .models import CampusClip, Teacher, GuideCourse, Entry, Audit
from .reputation import one

MAX_BYTES = 200 * 1024 * 1024


def encoder():
    configured = os.environ.get('HUB_FFMPEG', '')
    if configured:
        return configured if Path(configured).is_file() else None
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError, AttributeError, OSError):
        return shutil.which('ffmpeg')


def capabilities():
    return {'available': bool(encoder()), 'maxBytes': MAX_BYTES, 'maxSeconds': 180,
            'formats': ['mp4', 'mov', 'webm']}


def directory(clip):
    return settings.DATA / 'clips' / str(clip.pk)


def public():
    return CampusClip.objects.filter(state='published').filter(
        Q(teacher__active=True) | Q(course__isnull=False) |
        (Q(project__public_revision__gt=0) & ~Q(project__state='withdrawn')))


def serialize(clip, private=False):
    kind = 'teacher' if clip.teacher_id else 'course' if clip.course_id else 'project'
    result = {'id': str(clip.pk), 'title': clip.title, 'transcript': clip.transcript,
              'subjectType': kind, 'subjectId': str(clip.teacher_id or clip.course_id or clip.project_id),
              'author': {'name': clip.owner.display_name or clip.owner.username, 'username': clip.owner.username},
              'duration': clip.duration, 'created': clip.created,
              'streamUrl': f'/api/hub/clips/{clip.pk}/stream' if clip.state in ('pending', 'published', 'rejected') else None,
              'posterUrl': f'/api/hub/clips/{clip.pk}/poster' if clip.state in ('pending', 'published', 'rejected') else None}
    if private:
        result.update(state=clip.state, note=clip.note)
    return result


def receive(request):
    require(request.user, verified=True)
    if not encoder():
        raise Problem('视频处理服务尚未配置。', 503)
    throttle('clip-upload', str(request.user.pk), 5, 86400)
    if request.POST.get('rightsConfirmed') != 'true':
        raise Problem('请确认有权发布视频。')
    file = request.FILES.get('file')
    ext = Path(file.name).suffix.lower() if file else ''
    if not file or file.size <= 0 or file.size > MAX_BYTES or ext not in ('.mp4', '.mov', '.webm'):
        raise Problem('请上传不超过 200 MB 的 MP4、MOV 或 WebM 视频。')
    kind = request.POST.get('subjectType')
    if kind not in ('teacher', 'course', 'project'):
        raise Problem('请选择视频关联的教师、课程或项目。')
    target = one({'teacher': Teacher, 'course': GuideCourse, 'project': Entry}[kind], request.POST.get('subjectId'))
    if kind == 'teacher' and not target.active:
        raise Problem('教师资料不可用。', 404)
    if kind == 'project' and (target.kind != 'project' or not target.public_revision or target.state == 'withdrawn'):
        raise Problem('只能关联公开项目。', 404)
    clip = CampusClip(owner=request.user, title=text(request.POST.get('title', ''), 120, True),
        transcript=text(request.POST.get('transcript', ''), 10000, True), extension=ext, **{kind: target})
    root = directory(clip)
    root.mkdir(parents=True, exist_ok=False)
    source = root / ('source' + ext)
    try:
        size = 0
        with source.open('xb') as output:
            for chunk in file.chunks():
                size += len(chunk)
                if size > MAX_BYTES:
                    raise Problem('视频超过 200 MB。')
                output.write(chunk)
        clip.save()
    except Exception:
        source.unlink(missing_ok=True)
        root.rmdir()
        raise
    return serialize(clip, True)


def transcode(clip):
    root = directory(clip)
    output = root / 'playback.mp4'
    binary = encoder()
    if not binary:
        raise Problem('视频处理服务尚未配置。')
    args = [binary, '-nostdin', '-hide_banner', '-v', 'error', '-y', '-max_alloc', '134217728',
        '-threads', '2', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm',
        '-i', str(root / ('source' + clip.extension)), '-map', '0:v:0', '-map', '0:a:0?',
        '-t', '181', '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-r', '30', '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '25',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-b:a', '96k', '-map_metadata', '-1',
        '-map_chapters', '-1', '-movflags', '+faststart', '-progress', 'pipe:1', str(output)]
    options = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    result = subprocess.run(args, capture_output=True, timeout=300, **options)
    times = re.findall(rb'^out_time_us=(\d+)', result.stdout, re.M)
    duration = max((int(t) / 1000000 for t in times), default=0)
    if result.returncode or not output.exists() or not duration:
        raise Problem('视频无法解码，请重新导出为常见 MP4 或 WebM 后上传。')
    if duration > 180.1:
        output.unlink(missing_ok=True)
        raise Problem('视频超过三分钟，请剪短后重新上传。')
    if output.stat().st_size > 100 * 1024 * 1024:
        output.unlink(missing_ok=True)
        raise Problem('处理后的视频过大，请降低画面复杂度后重试。')
    result = subprocess.run([binary, '-nostdin', '-hide_banner', '-v', 'error', '-y',
        '-protocol_whitelist', 'file,pipe', '-i', str(output), '-frames:v', '1', '-q:v', '3',
        '-map_metadata', '-1', str(root / 'poster.jpg')], capture_output=True, timeout=30, **options)
    if result.returncode:
        raise Problem('无法生成视频封面，请重新导出后上传。')
    return duration


def run_one():
    close_old_connections()
    with transaction.atomic():
        CampusClip.objects.filter(state='processing', updated__lt=timezone.now() - timedelta(minutes=10)).update(
            state='failed', note='视频处理已中断，请重新投稿。', updated=timezone.now())
        clip = CampusClip.objects.select_for_update().filter(state='queued').order_by('created').first()
        if clip is None:
            return False
        clip.state = 'processing'
        clip.save(update_fields=['state', 'updated'])
    try:
        duration = transcode(clip)
        CampusClip.objects.filter(pk=clip.pk, state='processing').update(
            duration=duration, state='pending', note='', updated=timezone.now())
    except Exception as exc:
        note = exc.message if isinstance(exc, Problem) else '视频处理未完成，请重新投稿。'
        CampusClip.objects.filter(pk=clip.pk, state='processing').update(state='failed', note=note, updated=timezone.now())
    finally:
        close_old_connections()
    return True


def loop(stop=None):
    stop = stop or threading.Event()
    while not stop.is_set():
        try:
            if not run_one():
                stop.wait(2)
        except Exception:
            import logging
            logging.getLogger('hub.clips').exception('Video queue failed')
            stop.wait(5)


def stream(request, clip, poster=False):
    privileged = request.user.is_authenticated and (request.user.pk == clip.owner_id or request.user.is_staff)
    if not public().filter(pk=clip.pk).exists() and not (privileged and clip.state in ('pending', 'rejected')):
        raise Problem('视频不存在或尚未通过审核。', 404)
    path = directory(clip) / ('poster.jpg' if poster else 'playback.mp4')
    if not path.is_file():
        raise Problem('视频处理文件暂不可用。', 404)
    if poster:
        response = FileResponse(path.open('rb'), content_type='image/jpeg')
    else:
        size = path.stat().st_size
        value = request.headers.get('Range')
        start, end = 0, size - 1
        if value:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', value)
            if not match or not any(match.groups()):
                return HttpResponse(status=416, headers={'Content-Range': f'bytes */{size}'})
            left, right = match.groups()
            if left:
                start, end = int(left), min(size - 1, int(right)) if right else size - 1
            else:
                start = max(0, size - int(right))
            if start > end or start >= size:
                return HttpResponse(status=416, headers={'Content-Range': f'bytes */{size}'})
        def chunks():
            with path.open('rb') as file:
                file.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = file.read(min(65536, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk
        response = StreamingHttpResponse(chunks(), status=206 if value else 200, content_type='video/mp4')
        response['Content-Length'] = str(end - start + 1)
        response['Accept-Ranges'] = 'bytes'
        if value:
            response['Content-Range'] = f'bytes {start}-{end}/{size}'
    response['Cache-Control'] = 'private, no-store'
    response['X-Content-Type-Options'] = 'nosniff'
    return response


def get(request, route):
    parts = route.split('/')
    if route == 'clips/capabilities':
        return capabilities()
    if route in ('clips/mine', 'clips/moderation'):
        require(request.user, staff=route.endswith('moderation'))
        query = CampusClip.objects.filter(owner=request.user) if route.endswith('mine') else CampusClip.objects.filter(state='pending')
        return {'items': [serialize(c, True) for c in query.select_related('owner').order_by('-created')[:100]]}
    if route == 'clips':
        query = public()
        kind, key = request.GET.get('subjectType'), request.GET.get('subjectId')
        if kind in ('teacher', 'course', 'project') and key:
            query = query.filter(**{kind + '_id': key})
        if request.GET.get('q'):
            q = text(request.GET['q'], 100)
            query = query.filter(Q(title__icontains=q) | Q(transcript__icontains=q))
        offset = max(0, int(request.GET.get('offset', 0)))
        total = query.count()
        return {'items': [serialize(c) for c in query.select_related('owner').order_by('-created')[offset:offset + 24]],
                'total': total, 'nextOffset': offset + 24 if offset + 24 < total else None}
    if len(parts) == 3 and parts[2] in ('stream', 'poster'):
        return stream(request, one(CampusClip, parts[1]), parts[2] == 'poster')
    raise Problem('页面不存在。', 404)


@transaction.atomic
def post(request, route, body):
    require(request.user, verified=True)
    parts = route.split('/')
    if len(parts) != 3:
        raise Problem('操作不存在。', 404)
    clip = one(CampusClip, parts[1])
    if parts[2] == 'withdraw':
        if clip.owner_id != request.user.pk and not request.user.is_staff:
            raise Problem('只能撤回自己的视频。', 403)
        clip.state = 'withdrawn'
    elif parts[2] == 'moderate':
        require(request.user, staff=True)
        if clip.owner_id == request.user.pk:
            raise Problem('自己的视频需由其他维护者审核。', 403)
        if clip.state != 'pending' or body.get('decision') not in ('approve', 'reject'):
            raise Problem('待审视频状态已变化。', 409)
        clip.state = 'published' if body['decision'] == 'approve' else 'rejected'
    else:
        raise Problem('操作不存在。', 404)
    clip.note = text(body.get('note', ''), 1000, True)
    clip.save(update_fields=['state', 'note', 'updated'])
    Audit.objects.create(actor=request.user, action='clip-' + clip.state, target=str(clip.pk), detail={'note': clip.note})
    notify(clip.owner, None, 'clip-result', f'clip:{clip.pk}:{clip.state}', '视频投稿处理结果：' + clip.note)
    return serialize(clip, True)
