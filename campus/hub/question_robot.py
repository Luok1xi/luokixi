"""Private question workshop orchestration; no public publishing side effects."""
import hashlib
from pathlib import Path
from datetime import timedelta
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone
from .core import Problem, require, text
from .question_models import QuestionPaper, QuestionRevision
from . import question_ocr, question_pipeline


def capabilities():
    return dict(question_ocr.capabilities(), maxQuestions=200, maxActiveJobs=3,
                privateOnly=True, localRequiresStaff=True, formats=['pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'md'])


def _owned(user, paper_id, lock=False):
    require(user)
    try:
        query = QuestionPaper.objects.select_for_update() if lock else QuestionPaper.objects
        return query.get(pk=paper_id, owner=user)
    except (QuestionPaper.DoesNotExist, ValueError, TypeError, ValidationError):
        raise Problem('题稿不存在。', 404)


def paper_data(paper, detail=True):
    data = {'id': str(paper.pk), 'title': paper.title, 'course': paper.course,
            'category': paper.category, 'state': paper.state, 'visibility': 'private',
            'sourceKind': paper.source_kind, 'sourceName': paper.source_meta.get('name', ''),
            'sourceMeta': paper.source_meta, 'sourceUploadId': str(paper.source_upload_id or ''),
            'sourceDocumentId': paper.source_document_id, 'selectedPages': paper.selected_pages,
            'questionCount': len(paper.questions), 'review': paper.review, 'revision': paper.revision,
            'error': paper.error, 'created': paper.created.isoformat(), 'updated': paper.updated.isoformat(),
            'shelved': paper.shelved.isoformat() if paper.shelved else None,
            'classification': material_profile(paper)}
    if detail:
        data.update(questions=paper.questions, rawText=paper.raw_text, extractedPages=paper.extracted_pages)
    return data


def list_papers(user):
    require(user)
    return {'papers': [paper_data(p, detail=False) for p in QuestionPaper.objects.filter(owner=user).order_by('-updated')[:100]],
            'capabilities': capabilities()}


def get_paper(user, paper_id):
    return paper_data(_owned(user, paper_id))


def material_profile(paper):
    """School identity comes from registered sources, priority is a visible suggestion."""
    sources = paper.source_meta.get('sources') or [paper.source_meta]
    schools = list(dict.fromkeys(str(s.get('schoolName') or s.get('schoolId') or '')
                                 for s in sources if s.get('schoolName') or s.get('schoolId')))
    course = paper.course or '待归类'
    disciplines = {
        '数学': ('数学', '代数', '概率', '统计', '图论', '组合'),
        '计算机': ('数据结构', '算法', '计算机', '操作系统', '数据库', '编译', '程序', '人工智能', '机器学习'),
        '电子与控制': ('电子', '电路', '信号', '控制', '数字逻辑'),
        '物理': ('物理',), '化学': ('化学',), '语言': ('英语', '四级', '六级', '雅思'),
        '通识': ('马克思', '思想', '近现代', '通识', '心理学'),
    }
    discipline = next((name for name, words in disciplines.items() if any(word in course for word in words)), '待归类')
    needs_review = paper.state != 'shelved' or not paper.review.get('passed')
    priority = '待核对' if needs_review else '优先练习' if paper.questions else '补充阅读'
    return {'schools': schools, 'discipline': discipline, 'priority': priority,
            'priorityReason': '识别或归类尚未复核' if needs_review else '可编辑题册，适合直接练习',
            'supervisor': '北矿娘', 'reviewState': paper.state,
            'coverKey': {'数学': 'calc', '计算机': 'code', '电子与控制': 'mech', '物理': 'physics',
                         '化学': 'chem', '语言': 'cet'}.get(discipline, 'all')}


def export_text(user, paper_id, include_answers=True):
    """Export current structured questions as UTF-8 Markdown, never stale OCR text."""
    return render_text(_owned(user, paper_id), include_answers)


def render_text(paper, include_answers=True):
    if not paper.questions:
        raise Problem('这份原稿还没有可导出的题目，请先完成识别。', 409)
    profile = material_profile(paper)
    lines = ['# ' + paper.title, '', '课程：' + paper.course,
             '大学：' + ('、'.join(profile['schools']) or '待确认'),
             '整理状态：' + paper.state, '版本：' + str(paper.revision), '']
    for index, question in enumerate(paper.questions, 1):
        lines += ['## ' + str(index) + '. ' + question.get('stem', ''), '']
        lines += [str(option.get('label', '')) + '. ' + str(option.get('text', ''))
                  for option in question.get('options', [])]
        if include_answers:
            lines += ['', '答案：' + (question.get('answer') or '待补充')]
            if question.get('explanation'):
                lines += ['解析：' + question['explanation']]
        points = question.get('knowledgePoints') or []
        if points:
            lines += ['知识点：' + '、'.join(str(point) for point in points)]
        source = question.get('source') or {}
        if source.get('sourceUrl'):
            lines += ['来源：' + source['sourceUrl']]
        if not question.get('confirmed'):
            lines += ['识别内容待对照原件核对。']
        lines += ['']
    sources = paper.source_meta.get('sources') or [paper.source_meta]
    lines += ['## 来源与署名', '']
    for source in sources:
        lines += [' · '.join(str(source.get(key) or '') for key in
                            ('schoolName', 'title', 'sourceUrl', 'license', 'attribution') if source.get(key))]
    return '\n'.join(lines) + '\n'


def _local_source(document_id):
    # This resolver checks catalogue membership and a fixed allowed file root.
    from question_sources import resolve_document_source
    return resolve_document_source(document_id)


def _source_path(paper):
    if paper.source_kind == 'upload':
        upload = paper.source_upload
        if not upload or upload.owner_id != paper.owner_id:
            raise Problem('只能整理本人上传的原件。', 404)
        path = (settings.MEDIA_ROOT / upload.asset.path).resolve()
        if not path.is_relative_to(settings.MEDIA_ROOT.resolve()) or not path.is_file():
            raise Problem('原件不可用。', 404)
        return path
    if paper.source_kind == 'local':
        resolved = _local_source(paper.source_document_id)
        return Path(resolved['path'])
    raise Problem('文字题稿没有图片原件。')


def _record(paper):
    QuestionRevision.objects.create(paper=paper, number=paper.revision,
        snapshot={'title': paper.title, 'course': paper.course, 'category': paper.category,
                  'questions': paper.questions, 'review': paper.review, 'state': paper.state})


def create_paper(user, data, local_source=None):
    require(user, verified=True)
    if not isinstance(data, dict):
        raise Problem('题稿请求格式不正确。')
    from .models import Job, Upload
    kind = data.get('sourceKind', 'text')
    if kind not in {'text', 'upload', 'local'}:
        raise Problem('请选择上传原件、本机已有资料或粘贴文字。')
    title = text(data.get('title', '未命名题稿'), 160, True)
    course = text(data.get('course', ''), 160)
    category = text(data.get('category', '未分类'), 80)
    try:
        pages = question_ocr.page_selection(data.get('pages', []))
    except ValueError as exc:
        raise Problem(str(exc))
    upload, document_id, raw, meta = None, '', '', {}
    if kind == 'text':
        raw = text(data.get('text', ''), question_pipeline.MAX_TEXT, True)
        meta = {'name': '手动粘贴文字', 'sha256': hashlib.sha256(raw.encode()).hexdigest()}
    elif kind == 'upload':
        try:
            upload = Upload.objects.select_related('asset').get(pk=data.get('uploadId'), owner=user)
        except (Upload.DoesNotExist, ValueError, TypeError, ValidationError):
            raise Problem('只能选择本人上传的附件。', 404)
        if upload.asset.extension.lower() not in question_ocr.EXTENSIONS:
            raise Problem('此附件类型不能整理为试题。')
        if upload.asset.size > question_ocr.MAX_BYTES:
            raise Problem('原件超过 25 MB，请分批整理。')
        meta = {'name': upload.name, 'sha256': upload.asset_id, 'bytes': upload.asset.size}
    else:
        require(user, staff=True)
        document_id = text(data.get('documentId', ''), 160, True)
        resolved = local_source or _local_source(document_id)
        if str(resolved.get('documentId', document_id)) != document_id:
            raise Problem('资料标识与原件不一致。')
        local_path = Path(resolved['path'])
        if local_path.suffix.lower() not in question_ocr.EXTENSIONS or not local_path.is_file():
            raise Problem('该本机资料没有可用的 PDF、图片或文字原件。')
        size = local_path.stat().st_size
        if size > question_ocr.MAX_BYTES:
            raise Problem('原件超过 25 MB，请分批整理。')
        meta = {'name': str(resolved.get('name') or local_path.name)[:180], 'bytes': size,
                'sha256': hashlib.sha256(local_path.read_bytes()).hexdigest(),
                'documentId': document_id}
        for field in ('rights', 'source', 'provenance'):
            if field in resolved and isinstance(resolved[field], (str, bool)):
                meta[field] = resolved[field]
    with transaction.atomic():
        if QuestionPaper.objects.filter(owner=user, state__in=['queued', 'extracting']).count() >= 3:
            raise Problem('已有 3 批正在排队或识别，请等一批完成。', 429)
        paper = QuestionPaper.objects.create(owner=user, title=title, course=course, category=category,
            source_kind=kind, source_upload=upload, source_document_id=document_id, source_meta=meta,
            selected_pages=pages, raw_text=raw)
        _record(paper)
        Job.objects.create(kind='question-process', key='question:' + str(paper.pk), owner=user,
                           payload={'paperId': str(paper.pk)}, due=timezone.now())
    return paper_data(paper)


def run_paper(paper_id):
    """Called only by the bounded private worker, not during request handling."""
    with transaction.atomic():
        paper = QuestionPaper.objects.select_for_update().get(pk=paper_id)
        if paper.state in {'needs_review', 'shelved'}:
            return {'paperId': str(paper.pk), 'state': paper.state}
        if paper.state == 'extracting':
            raise Problem('这批题目已在识别中。', 409)
        paper.state, paper.error = 'extracting', ''
        paper.save(update_fields=['state', 'error', 'updated'])
        claim_time = paper.updated
    try:
        if paper.source_kind == 'text':
            extracted = {'pages': [{'page': 1, 'text': paper.raw_text, 'method': 'manual', 'blocks': []}],
                         'totalPages': 1, 'issues': [], 'engine': 'manual-text', 'offline': True}
        else:
            path = _source_path(paper)
            # Refuse replacing the selected original silently between intake and execution.
            if not path.is_file() or path.stat().st_size > question_ocr.MAX_BYTES:
                raise Problem('所选原件不可用或超过大小限制。')
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != paper.source_meta.get('sha256'):
                raise Problem('原件在排队后发生变化，请重新选择创建题稿。')
            extracted = question_ocr.extract_file(path, paper.selected_pages)
        questions, parsing_issues = question_pipeline.parse_pages(extracted['pages'])
        extraction_issues = extracted.get('issues', []) + parsing_issues
        questions, review = question_pipeline.self_review(questions, extraction_issues, paper.course, paper.category)
        with transaction.atomic():
            paper = QuestionPaper.objects.select_for_update().get(pk=paper.pk)
            if paper.state != 'extracting' or paper.updated != claim_time:
                return {'paperId': str(paper.pk), 'state': paper.state, 'superseded': True}
            paper.extracted_pages = extracted['pages']
            paper.raw_text = '\n\n'.join(p['text'] for p in extracted['pages'])
            paper.questions, paper.review = questions, review
            paper.source_meta.update(engine=extracted['engine'], totalPages=extracted['totalPages'], offline=True,
                                     extractionIssues=extraction_issues)
            paper.state = 'shelved' if review['passed'] else 'needs_review'
            paper.shelved = timezone.now() if review['passed'] else None
            paper.revision += 1
            paper.save()
            _record(paper)
        return {'paperId': str(paper.pk), 'state': paper.state, 'questions': len(questions)}
    except Exception as exc:
        safe_error = str(exc) if isinstance(exc, (Problem, question_ocr.ExtractionError, ValueError)) else '本机识别未完成，请检查依赖或补充文字后重试。'
        QuestionPaper.objects.filter(pk=paper.pk, state='extracting', updated=claim_time).update(
            state='failed', error=safe_error[:300], updated=timezone.now())
        # Error is visible on this private paper; worker receives no raw file data.
        return {'paperId': str(paper.pk), 'state': 'failed', 'error': safe_error[:300]}


def update_paper(user, paper_id, data):
    require(user, verified=True)
    if not isinstance(data, dict):
        raise Problem('题稿格式不正确。')
    with transaction.atomic():
        paper = _owned(user, paper_id, lock=True)
        if paper.state in {'queued', 'extracting'}:
            raise Problem('识别中，请完成后再编辑。', 409)
        if data.get('revision') != paper.revision:
            raise Problem('题稿已更新，请重新打开后编辑。', 409)
        try:
            questions = question_pipeline.validate_questions(data.get('questions', paper.questions), paper.questions)
        except ValueError as exc:
            raise Problem(str(exc))
        for attr in ('title', 'course', 'category'):
            if attr in data:
                setattr(paper, attr, text(data[attr], 80 if attr == 'category' else 160, attr == 'title'))
        extraction_issues = paper.source_meta.get('extractionIssues', [])
        # Explicit confirmation applies to unassigned/empty source passages too;
        # keep provenance warnings, never silently remove structural question errors.
        if 'confirmSourceCoverage' in data:
            if not isinstance(data['confirmSourceCoverage'], bool):
                raise Problem('原件覆盖确认必须是勾选状态。')
            paper.source_meta['sourceCoverageConfirmed'] = data['confirmSourceCoverage']
        if paper.source_meta.get('sourceCoverageConfirmed') is True:
            extraction_issues = [dict(i, blocking=False) for i in extraction_issues]
        paper.questions, paper.review = question_pipeline.self_review(questions, extraction_issues, paper.course, paper.category)
        paper.state = 'shelved' if paper.review['passed'] else 'needs_review'
        paper.shelved = timezone.now() if paper.review['passed'] else None
        paper.error = ''
        paper.revision += 1
        paper.save()
        _record(paper)
        return paper_data(paper)


def recover_stale_jobs(now=None):
    """Recover only question work; never start or reschedule crawler/model jobs.

    Five minutes exceeds the 150-second OCR deadline. At most three interrupted
    attempts are retried. Paper timestamps fence late results from old workers.
    """
    from .models import Job
    now = now or timezone.now()
    cutoff = now - timedelta(minutes=5)
    recovered = 0
    with transaction.atomic():
        candidates = list(Job.objects.select_for_update().filter(
            kind='question-process', state='running', updated__lt=cutoff).order_by('updated')[:50])
        # A generic queue recovery may already have reset its Job; recover the
        # corresponding stale paper too, without touching a current claimant.
        for job in Job.objects.select_for_update().filter(kind='question-process', state='queued').order_by('due')[:50]:
            try:
                stale = QuestionPaper.objects.filter(pk=job.payload.get('paperId'), state='extracting', updated__lt=cutoff).exists()
            except (ValueError, ValidationError):
                stale = False
            if stale:
                candidates.append(job)
        for job in candidates:
            try:
                paper = QuestionPaper.objects.select_for_update().filter(pk=job.payload.get('paperId')).first()
            except (ValueError, ValidationError):
                paper = None
            if not paper:
                job.state, job.error = 'failed', '原题稿已不存在。'
            elif paper.state in {'shelved', 'needs_review'}:
                job.state, job.error = 'done', ''
                job.result = {'paperId': str(paper.pk), 'state': paper.state}
            elif paper.state == 'extracting' and paper.updated >= cutoff:
                continue
            elif job.attempts >= 3:
                paper.state, paper.error = 'failed', '识别多次被中断，已停止重试；可手动补充文字。'
                paper.save(update_fields=['state', 'error', 'updated'])
                job.state, job.error = 'failed', paper.error
            else:
                paper.state, paper.error = 'queued', '上次识别被中断，已重新排队。'
                paper.save(update_fields=['state', 'error', 'updated'])
                job.state, job.error, job.due = 'queued', paper.error, now
                recovered += 1
            job.save(update_fields=['state', 'error', 'due', 'result', 'updated'])
    return recovered


def source_preview(user, paper_id, page=1):
    paper = _owned(user, paper_id)
    try:
        page = int(page)
    except (TypeError, ValueError):
        raise Problem('页码无效。')
    if page < 1 or page > 10000 or (paper.selected_pages and page not in paper.selected_pages):
        raise Problem('此页不在所选原件范围内。')
    path = _source_path(paper)
    if path.stat().st_size > question_ocr.MAX_BYTES:
        raise Problem('原件超过预览限制。')
    try:
        if hashlib.sha256(path.read_bytes()).hexdigest() != paper.source_meta.get('sha256'):
            raise Problem('原件已变化，请重新选择资料。', 409)
        return question_ocr.preview_file(path, page)
    except question_ocr.ExtractionError as exc:
        raise Problem(str(exc), 503)
