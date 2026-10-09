"""Bounded offline PDF/text/image extraction; no network or cloud OCR adapter.

The legacy RapidOCR wheel bundles PP-OCRv4 ONNX weights, unlike adapters that
download on first request. Native decoding/inference runs in a disposable child
process with a hard wall-clock deadline.
"""
import importlib.util
from contextlib import closing
import base64
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys

MAX_BYTES = 25 * 1024 * 1024
MAX_PAGES = 12
MAX_PIXELS = 24_000_000
MAX_TEXT = 200_000
EXTENSIONS = {'.pdf', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.md'}
_ENGINE = None


class ExtractionError(ValueError):
    pass


def bootstrap():
    # Only this fixed, administrator-installed private dependency directory.
    runtime = Path(__file__).resolve().parents[1] / '.data' / 'question-runtime'
    if runtime.is_dir() and str(runtime) not in sys.path:
        sys.path.insert(0, str(runtime))


bootstrap()


def capabilities():
    ocr = importlib.util.find_spec('rapidocr_onnxruntime')
    models = bool(ocr and ocr.origin and len(list((Path(ocr.origin).parent / 'models').glob('*.onnx'))) >= 3)
    pdf = importlib.util.find_spec('pypdfium2') is not None
    return {'engine': 'rapidocr-onnxruntime', 'offline': True, 'cloudUploads': False,
            'imageOcr': bool(models and importlib.util.find_spec('onnxruntime') and importlib.util.find_spec('PIL')),
            'pdfText': pdf, 'pdfOcr': bool(pdf and models), 'manualText': True,
            'maxPages': MAX_PAGES, 'maxBytes': MAX_BYTES, 'maxPixels': MAX_PIXELS,
            'recognitionThreshold': .90, 'answerCorrectnessVerified': False,
            'limitations': ['普通印刷体中英文；手写、公式、表格和多栏需要人工核对。',
                            '仅结构与识别质量自检，未提供的答案保持未知。']}


def page_selection(pages):
    if pages in (None, []):
        return []
    if not isinstance(pages, list) or not 1 <= len(pages) <= MAX_PAGES:
        raise ExtractionError('每批请选择 1–12 页。')
    if any(isinstance(p, bool) or not isinstance(p, int) or not 1 <= p <= 10000 for p in pages):
        raise ExtractionError('页码必须是 1–10000 的整数。')
    return sorted(set(pages))


def _ocr(image, page_number):
    global _ENGINE
    if not capabilities()['imageOcr']:
        raise ExtractionError('本机 OCR 依赖或模型未安装；可先粘贴文字整理。')
    from rapidocr_onnxruntime import RapidOCR
    import numpy as np
    if _ENGINE is None:
        _ENGINE = RapidOCR(det_use_cuda=False, cls_use_cuda=False, rec_use_cuda=False,
                           det_use_dml=False, cls_use_dml=False, rec_use_dml=False,
                           intra_op_num_threads=2, inter_op_num_threads=1, text_score=.35)
    image = image.convert('RGB')
    image.thumbnail((2400, 3200))
    # RapidOCR accepts a PIL image; its loader performs the expected channel conversion.
    results, _ = _ENGINE(image)
    blocks = []
    for box, value, confidence in results or []:
        if not value.strip():
            continue
        if len(blocks) >= 2000:
            raise ExtractionError('单页文字区块过多，请裁剪后分批整理。')
        points = np.asarray(box)
        blocks.append({'text': value, 'confidence': round(float(confidence), 4),
                       'bbox': [round(float(points[:, 0].min()), 1), round(float(points[:, 1].min()), 1),
                                round(float(points[:, 0].max()), 1), round(float(points[:, 1].max()), 1)]})
    text = '\n'.join(b['text'] for b in blocks)
    issues = []
    if not text.strip():
        issues.append({'code': 'empty_page', 'message': f'第 {page_number} 页未识别出文字。', 'blocking': True})
    return {'page': page_number, 'text': text, 'blocks': blocks, 'method': 'ocr',
            'width': image.width, 'height': image.height, 'coordinateSpace': 'ocr-image-pixels', 'issues': issues}


def extract_local(path, selected_pages=None):
    path = Path(path)
    ext = path.suffix.lower()
    if ext not in EXTENSIONS or not path.is_file() or not 0 < path.stat().st_size <= MAX_BYTES:
        raise ExtractionError('仅支持 25 MB 内的 PDF、PNG、JPG、WEBP、TXT、MD。')
    selected = page_selection(selected_pages)
    pages, total_pages, issues = [], 1, []
    if ext in {'.txt', '.md'}:
        if selected and selected != [1]:
            raise ExtractionError('文字文件只有第 1 页。')
        text = path.read_bytes().decode('utf-8-sig', errors='replace').replace('\x00', '')
        pages = [{'page': 1, 'text': text, 'method': 'text-file', 'blocks': []}]
    elif ext == '.pdf':
        if not capabilities()['pdfText']:
            raise ExtractionError('本机 PDF 解析组件未安装；可先粘贴文字整理。')
        import pypdfium2 as pdfium
        try:
            document = pdfium.PdfDocument(str(path))
        except Exception as exc:
            raise ExtractionError('PDF 无法打开，可能已加密或损坏；请提供可读取的原件。') from exc
        with document:
            total_pages = len(document)
            chosen = selected or list(range(1, min(total_pages, MAX_PAGES) + 1))
            if any(p > total_pages for p in chosen):
                raise ExtractionError('所选页码超出 PDF 页数。')
            if not selected and total_pages > MAX_PAGES:
                issues.append({'code': 'page_limit', 'message': f'原件有 {total_pages} 页，本批仅整理前 12 页；其余请另建批次。', 'blocking': False})
            for number in chosen:
                with closing(document[number - 1]) as page:
                    with closing(page.get_textpage()) as textpage:
                        if textpage.count_chars() > MAX_TEXT:
                            raise ExtractionError('单页文字超过 20 万字，请缩小页码范围。')
                        text = textpage.get_text_range().replace('\x00', '')
                    # Tiny text layers are often scanner headers, not actual question text.
                    if len(text.strip()) >= 40:
                        pages.append({'page': number, 'text': text, 'blocks': [], 'method': 'pdf-text'})
                    else:
                        width, height = page.get_size()
                        if not (math.isfinite(width) and math.isfinite(height) and width > 0 and height > 0):
                            raise ExtractionError('PDF 页面尺寸无效。')
                        scale = min(2.5, 2400 / width, 3200 / height)
                        if math.ceil(width * scale) * math.ceil(height * scale) > MAX_PIXELS:
                            raise ExtractionError('PDF 页面分辨率过高，请分批裁剪。')
                        with closing(page.render(scale=scale, may_draw_forms=False)) as bitmap:
                            pages.append(_ocr(bitmap.to_pil(), number))
    else:
        if selected and selected != [1]:
            raise ExtractionError('单张图片只有第 1 页。')
        from PIL import Image, ImageOps
        with Image.open(path) as image:
            if image.width * image.height > MAX_PIXELS:
                raise ExtractionError('图片超过 2400 万像素，请缩小后再整理。')
            if getattr(image, 'n_frames', 1) != 1:
                raise ExtractionError('请将多帧图片拆分为单张图片。')
            pages = [_ocr(ImageOps.exif_transpose(image), 1)]
    if sum(len(p['text']) for p in pages) > MAX_TEXT:
        raise ExtractionError('本批文字超过 20 万字，请缩小页码范围。')
    for page in pages:
        issues.extend(page.get('issues', []))
    return {'pages': pages, 'totalPages': total_pages, 'issues': issues,
            'engine': 'rapidocr-onnxruntime' if any(p['method'] == 'ocr' for p in pages) else 'local-text',
            'offline': True}


def preview_local(path, page_number=1):
    path = Path(path)
    if not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ExtractionError('原件不可用或超过 25 MB。')
    from PIL import Image, ImageOps
    output = io.BytesIO()
    if path.suffix.lower() == '.pdf':
        import pypdfium2 as pdfium
        with pdfium.PdfDocument(str(path)) as document:
            if not 1 <= page_number <= len(document):
                raise ExtractionError('原件没有此页。')
            with closing(document[page_number - 1]) as source:
                width, height = source.get_size()
                if not (math.isfinite(width) and math.isfinite(height) and width > 0 and height > 0):
                    raise ExtractionError('原件页面尺寸无效。')
                with closing(source.render(scale=min(1600 / width, 1600 / height, 2), may_draw_forms=False)) as bitmap:
                    bitmap.to_pil().save(output, 'PNG')
    elif path.suffix.lower() in {'.jpg', '.jpeg', '.png', '.webp'} and page_number == 1:
        with Image.open(path) as original:
            if original.width * original.height > MAX_PIXELS:
                raise ExtractionError('图片超过预览尺寸限制。')
            image = ImageOps.exif_transpose(original).convert('RGB')
            image.thumbnail((1600, 1600))
            image.save(output, 'PNG')
    else:
        raise ExtractionError('此原件没有图片预览。')
    return output.getvalue()


def preview_file(path, page_number=1):
    command = [sys.executable, str(Path(__file__).resolve()), str(path), str(page_number), '--preview']
    try:
        run = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace',
            timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            env=dict(os.environ, PYTHONIOENCODING='utf-8'))
        if len(run.stdout) > 12_000_000:
            raise ExtractionError('预览输出超过限制。')
        result = json.loads(run.stdout)
        if not result.get('ok'):
            raise ExtractionError(result.get('error') or '原件预览未完成。')
        return base64.b64decode(result['data'], validate=True)
    except (subprocess.TimeoutExpired, ValueError, KeyError) as exc:
        raise ExtractionError('原件预览未完成，请检查原件或减少尺寸。') from exc


def extract_file(path, selected_pages=None, timeout=150):
    """Trusted callers resolve IDs to paths; raw client paths must never reach here."""
    selected = page_selection(selected_pages)
    command = [sys.executable, str(Path(__file__).resolve()), str(path), json.dumps(selected)]
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    try:
        run = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace',
                             timeout=timeout, creationflags=flags, env=dict(os.environ, PYTHONIOENCODING='utf-8'))
    except subprocess.TimeoutExpired as exc:
        raise ExtractionError('本批识别超过 150 秒，已停止；请减少页数或缩小图片。') from exc
    if len(run.stdout) > 4_000_000:
        raise ExtractionError('识别结果过大，请减少页数。')
    try:
        result = json.loads(run.stdout)
    except (ValueError, TypeError) as exc:
        raise ExtractionError('本机识别进程未返回有效结果，请检查依赖后重试。') from exc
    if not result.get('ok'):
        raise ExtractionError(result.get('error') or '本机识别未完成。')
    return result['data']


if __name__ == '__main__':
    import contextlib
    try:
        with contextlib.redirect_stdout(sys.stderr):
            if len(sys.argv) > 3 and sys.argv[3] == '--preview':
                data = base64.b64encode(preview_local(sys.argv[1], int(sys.argv[2]))).decode('ascii')
            else:
                data = extract_local(sys.argv[1], json.loads(sys.argv[2]))
        output = {'ok': True, 'data': data}
    except ExtractionError as exc:
        output = {'ok': False, 'error': str(exc)}
    except Exception:
        output = {'ok': False, 'error': '本机识别失败，请检查原件是否清晰、完整及依赖是否可用。'}
    print(json.dumps(output, ensure_ascii=False))
