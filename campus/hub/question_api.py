"""Owner-only endpoints for the local question workshop."""
from django.http import HttpResponse
from .core import Problem,require

def get(request,route):
    from . import question_robot as robot
    from question_sources import local_library_enabled
    parts=route.split('/')
    if route=='question-papers/capabilities':
        return {**robot.capabilities(),'localLibrary':local_library_enabled()}
    require(request.user)
    if route == 'question-papers/collected':
        from .question_university_sources import collected_catalogue
        return collected_catalogue(request.user)
    if len(parts) == 4 and parts[1] == 'collected' and parts[3] in ('text', 'json'):
        from .question_university_sources import collected_export
        content = collected_export(request.user, parts[2], parts[3])
        mime = 'text/markdown; charset=utf-8' if parts[3] == 'text' else 'application/json; charset=utf-8'
        response = HttpResponse(content, content_type=mime)
        extension = 'md' if parts[3] == 'text' else 'json'
        response['Content-Disposition'] = f'attachment; filename="collected-{parts[2]}.{extension}"'
        response['Cache-Control'] = 'private, no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        return response
    if len(parts)==1:return robot.list_papers(request.user)
    if len(parts)==2:return robot.get_paper(request.user,parts[1])
    if len(parts)==3 and parts[2] in ('text', 'json'):
        paper = robot.get_paper(request.user, parts[1])
        if parts[2] == 'text':
            content, mime, extension = robot.export_text(request.user, parts[1]), 'text/markdown; charset=utf-8', 'md'
        else:
            import json
            content, mime, extension = json.dumps(paper, ensure_ascii=False, indent=2), 'application/json; charset=utf-8', 'json'
        response = HttpResponse(content, content_type=mime)
        response['Content-Disposition'] = f'attachment; filename="questions-{parts[1]}.{extension}"'
        response['Cache-Control'] = 'private, no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        return response
    if len(parts)==3 and parts[2]=='source':
        image=robot.source_preview(request.user,parts[1],int(request.GET.get('page','1')))
        response=HttpResponse(image,content_type='image/png')
        response['Cache-Control']='private, no-store'
        response['X-Content-Type-Options']='nosniff'
        return response
    raise Problem('这个识题地址不存在。',404)

def post(request,route,body):
    from . import question_robot as robot
    require(request.user,verified=True)
    parts=route.split('/')
    if route=='question-papers/import-university':
        from .question_university_sources import import_bank
        return import_bank(request.user,body.get('bankId',''))
    if route=='question-papers/compose':
        from .question_university_sources import compose
        return compose(request.user,body)
    if route=='question-papers/import-source':
        from .question_public_sources import import_bank
        return import_bank(request.user,body.get('bankId',''))
    if len(parts)==1:
        local_source=None
        if body.get('sourceKind')=='local':
            require(request.user,staff=True)
            from question_sources import resolve_document_source
            local_source=resolve_document_source(body.get('documentId',''))
        return robot.create_paper(request.user,body,local_source=local_source)
    if len(parts)==2 or (len(parts)==3 and parts[2]=='save'):
        return robot.update_paper(request.user,parts[1],body)
    raise Problem('这个识题操作不存在。',404)
