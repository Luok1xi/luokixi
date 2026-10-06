import hashlib
import os
import uuid
from pathlib import Path
from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.http import FileResponse
from django.utils import timezone
from .core import Problem, public_entries, require, throttle
from .models import Asset, Entry, Job, Revision, Upload

EXTENSIONS = {'.pdf','.txt','.md','.csv','.png','.jpg','.jpeg','.webp','.zip','.stl','.step','.ipynb'}


def upload_data(upload):
    return {'id':str(upload.pk), 'name':upload.name, 'bytes':upload.asset.size,
            'sha256':upload.asset_id, 'extraction':upload.asset.extraction,
            'preview':upload.asset.text[:12000], 'pages':len(upload.asset.pages),
            'url':'/api/hub/uploads/'+str(upload.pk)+'/file'}


def receive(request):
    require(request.user, verified=True)
    throttle('upload', str(request.user.pk), 30)
    f = request.FILES.get('file')
    if not f or not f.size or f.size>settings.MAX_UPLOAD_BYTES:
        raise Problem('请选择不超过 25 MB 的文件。')
    name = Path(f.name.replace('\\','/')).name[:180]
    ext = Path(name).suffix.lower()
    if ext not in EXTENSIONS:
        raise Problem('此类型暂不支持，请将代码托管到源码平台并添加链接。')
    settings.MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    tmp = settings.MEDIA_ROOT / (uuid.uuid4().hex+'.part')
    digest, head = hashlib.sha256(), b''
    try:
        with tmp.open('wb') as out:
            size = 0
            for chunk in f.chunks():
                size += len(chunk)
                if size>settings.MAX_UPLOAD_BYTES:
                    raise Problem('文件超过 25 MB。')
                head = (head+chunk)[:16]
                digest.update(chunk)
                out.write(chunk)
        if ext=='.pdf' and not head.startswith(b'%PDF-'):
            raise Problem('文件内容不是有效的 PDF。')
        if ext=='.zip' and not head.startswith(b'PK'):
            raise Problem('文件内容不是有效的 ZIP。')
        if ext in {'.png','.jpg','.jpeg','.webp'}:
            from PIL import Image
            with Image.open(tmp) as image:
                if image.width*image.height>36_000_000:
                    raise Problem('照片超过 3600 万像素，请缩小后上传。')
                image.verify()
        sha = digest.hexdigest()
        destination = settings.MEDIA_ROOT / (sha+ext)
        with transaction.atomic():
            asset = Asset.objects.filter(pk=sha).first()
            duplicate = bool(asset)
            if not asset:
                os.replace(tmp, destination)
                asset = Asset.objects.create(sha256=sha,size=size,extension=ext,path=destination.name)
                Job.objects.create(kind='extract',key='extract:'+sha,payload={'sha':sha},due=timezone.now())
            upload = Upload.objects.create(owner=request.user,asset=asset,name=name)
        # Only expose a duplicate's public references, never another user's private upload.
        matches = []
        for e in public_entries():
            ids = e.published.get('uploads',[])
            if ids and Upload.objects.filter(id__in=ids,asset=asset).exists():
                matches.append({'id':str(e.pk),'title':e.published.get('title','')})
        return dict(upload_data(upload), duplicate=bool(matches), matchingEntries=matches,
                    message='已保留原件和你的上传署名，文字提取已排队。')
    finally:
        tmp.unlink(missing_ok=True)


def visible_upload(user, uid, for_photo=False):
    try:
        upload = Upload.objects.select_related('asset').get(pk=uid)
    except (Upload.DoesNotExist, ValueError, TypeError):
        raise Problem('附件不存在。',404)
    if user.is_authenticated and (user.pk==upload.owner_id or user.is_staff):
        return upload
    entries = public_entries()
    if not for_photo:
        entries = entries.exclude(kind='place').exclude(kind='topic', published__has_key='circle')
    if any(str(upload.pk) in e.published.get('uploads',[]) for e in entries):
        return upload
    versions = Revision.objects.filter(entry__in=entries,state='published')
    if any(str(upload.pk) in r.data.get('uploads',[]) for r in versions):
        return upload
    raise Problem('附件不存在。',404)


def photo_preview(user, uid):
    """Public display derivative; originals may contain EXIF and remain protected."""
    upload = visible_upload(user,uid,for_photo=True)
    if upload.asset.extension not in {'.png','.jpg','.jpeg','.webp'}:
        raise Problem('此附件不是照片。',400)
    original = (settings.MEDIA_ROOT/upload.asset.path).resolve()
    if not original.is_relative_to(settings.MEDIA_ROOT.resolve()) or not original.is_file():
        raise Problem('照片暂不可用。',404)
    folder = settings.MEDIA_ROOT/'previews'
    folder.mkdir(parents=True,exist_ok=True)
    target = folder/(upload.asset_id+'-1280.jpg')
    if not target.exists():
        from PIL import Image, ImageOps
        with Image.open(original) as source:
            if source.width*source.height>36_000_000:
                raise Problem('照片分辨率过高。',400)
            rotated = ImageOps.exif_transpose(source)
            rotated.thumbnail((1280,1280))
            # Recreate pixels in a fresh image; no EXIF/GPS/comment/ICC is copied.
            clean = Image.new('RGB',rotated.size,'white')
            rgba = rotated.convert('RGBA')
            clean.paste(rgba,mask=rgba.getchannel('A'))
            temporary = folder/(uuid.uuid4().hex+'.jpg')
            try:
                clean.save(temporary,'JPEG',quality=85,optimize=True)
                os.replace(temporary,target)
            finally:
                temporary.unlink(missing_ok=True)
    response = FileResponse(target.open('rb'),content_type='image/jpeg')
    response['Cache-Control'] = 'private, no-store'
    response['X-Content-Type-Options'] = 'nosniff'
    return response


def download(user, uid):
    upload = visible_upload(user,uid)
    path = (settings.MEDIA_ROOT/upload.asset.path).resolve()
    if not path.is_relative_to(settings.MEDIA_ROOT.resolve()) or not path.is_file():
        raise Problem('原文件暂不可用。',404)
    response = FileResponse(path.open('rb'), as_attachment=True, filename=upload.name, content_type='application/octet-stream')
    response['Cache-Control'] = 'private, no-store'
    response['Content-Security-Policy'] = "default-src 'none'; sandbox"
    return response


def extract(sha):
    asset = Asset.objects.get(pk=sha)
    path = settings.MEDIA_ROOT/asset.path
    pages, state = [], 'attachment-only'
    if asset.extension=='.pdf':
        from pypdf import PdfReader
        reader = PdfReader(path)
        if reader.is_encrypted:
            state = 'encrypted'
        else:
            remaining = 2_000_000
            for i,p in enumerate(reader.pages[:200]):
                value = (p.extract_text() or '').replace('\x00','')[:min(remaining,20000)]
                pages.append({'page':i+1,'text':value})
                remaining -= len(value)
                if remaining<=0:
                    break
            state = 'text' if any(p['text'].strip() for p in pages) else 'needs-ocr'
    elif asset.extension in {'.txt','.md','.csv','.ipynb','.step'}:
        pages = [{'page':1,'text':path.read_bytes()[:2_000_000].decode('utf-8',errors='replace').replace('\x00','')}]
        state = 'text'
    elif asset.extension in {'.png','.jpg','.jpeg','.webp'}:
        state = 'needs-ocr'
    asset.pages, asset.text, asset.extraction = pages, '\n'.join(p['text'] for p in pages), state
    asset.save(update_fields=['pages','text','extraction'])
    # Update only approved content's index; unreviewed draft text cannot enter public search.
    for entry in public_entries():
        ids = entry.published.get('uploads',[])
        if ids and Upload.objects.filter(pk__in=ids,asset=asset).exists():
            import json
            texts = [u.asset.text for u in Upload.objects.filter(pk__in=ids).select_related('asset')]
            entry.search_text = json.dumps(entry.published,ensure_ascii=False)+'\n'+'\n'.join(texts)
            entry.save(update_fields=['search_text'])
    return {'sha':sha,'extraction':state,'pages':len(pages)}
