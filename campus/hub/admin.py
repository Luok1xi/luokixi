"""Unfold UI; mutations use the same publication service as the website and AI."""
import json
from django import forms
from django.contrib import admin, messages
from django.http import FileResponse, Http404
from django.contrib.staticfiles import finders
from django.shortcuts import redirect
from django.urls import path
from django.template.response import TemplateResponse
from django.utils.html import format_html
from unfold.admin import ModelAdmin
from unfold.sites import UnfoldAdminSite
from . import content_management as cm
from .models import Entry, Revision, EditorialOverride, EditorialRevision, ContentTask, Audit
from .core import Problem


class ContentAdminSite(UnfoldAdminSite):
    site_header = 'Luokixi 内容管理'
    site_title = '管理中心'
    index_title = '文章、项目、公告与审核'
    def has_permission(self, request): return cm.manager(request.user)
    index_template = 'hub/manage_index.html'
    def get_urls(self):
        return [path('content/', self.admin_view(self.content), name='content')]+super().get_urls()
    def content(self, request):
        data=cm.search(request.user,request.GET.get('q',''),request.GET.get('state',''))
        return TemplateResponse(request,'hub/manage_content.html',{**self.each_context(request),
            'title':'全部内容与审核','items':data['items'],'query':request.GET.get('q',''),'state':request.GET.get('state','')})


site = ContentAdminSite(name='management')


class EntryForm(forms.ModelForm):
    expected_revision = forms.IntegerField(widget=forms.HiddenInput)
    title = forms.CharField(label='标题', max_length=160)
    summary = forms.CharField(label='简介', widget=forms.Textarea, required=False)
    body = forms.CharField(label='正文', widget=forms.Textarea, required=False)
    reason = forms.CharField(label='修改说明', initial='管理中心编辑并发布')
    location_checked = forms.BooleanField(label='已核对地点位置与来源', required=False)
    questions_resolved = forms.BooleanField(label='公告中的待确认事项已处理', required=False)
    class Meta:
        model = Entry
        fields = ['title', 'summary', 'body', 'draft', 'reason', 'location_checked', 'questions_resolved']
        labels = {'draft': '完整内容（分类、来源、图片等）'}
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance.pk:
            for k in ('title', 'summary', 'body'): self.fields[k].initial = self.instance.draft.get(k, '')
            self.fields['expected_revision'].initial = self.instance.revision
    def clean(self):
        data = super().clean()
        if data.get('expected_revision') != self.instance.revision:
            raise forms.ValidationError('内容已被其他操作修改，请刷新后重新编辑。')
        from .core import validate_payload
        payload = dict(data.get('draft') or {}, **{k: data.get(k, '') for k in ('title', 'summary', 'body')})
        try: validate_payload(self.instance.kind, payload, self.user, submit=True)
        except Problem as exc: raise forms.ValidationError(exc.message)
        data['draft'] = payload
        return data


class EntryAdmin(ModelAdmin):
    form = EntryForm
    list_display = ['title_text', 'kind', 'state', 'revision', 'public_revision', 'updated']
    list_filter = ['kind', 'state']
    search_fields = ['search_text', 'draft__title', 'slug']
    readonly_fields = ['owner', 'kind', 'slug', 'state', 'revision', 'public_revision', 'review_note', 'source_preview', 'media_preview', 'canonical', 'created', 'updated']
    actions = ['approve', 'reject']
    def title_text(self, obj): return obj.draft.get('title', obj.slug)
    title_text.short_description = '标题'
    def source_preview(self,obj): return json.dumps(obj.draft.get('links',{}),ensure_ascii=False,indent=2)
    source_preview.short_description = '原始来源'
    def media_preview(self,obj):
        m=obj.draft.get('media',{})
        return format_html('<img src="{}" alt="{}" style="max-width:400px;max-height:240px;object-fit:contain"><p>{}</p>',m.get('src',''),m.get('alt',''),m.get('credit','')) if m.get('src') else '无独立配图'
    media_preview.short_description = '配图预览'
    def has_add_permission(self, request): return False
    def has_delete_permission(self, request, obj=None): return False
    def has_view_permission(self, request, obj=None): return cm.manager(request.user)
    def has_change_permission(self, request, obj=None): return cm.manager(request.user)
    def get_form(self, request, obj=None, **kwargs):
        form = super().get_form(request, obj, **kwargs)
        form.user = request.user
        return form
    def save_model(self, request, obj, form, change):
        cm.publish(request.user, {'key': 'entry/'+str(obj.pk), 'revision': form.cleaned_data['expected_revision'],
            'patch': form.cleaned_data['draft'], 'reason': form.cleaned_data['reason'],
            'locationChecked': form.cleaned_data['location_checked'],
            'supervisorQuestionsResolved': form.cleaned_data['questions_resolved']})
        obj.refresh_from_db()
    @admin.action(description='通过并发布所选投稿')
    def approve(self, request, queryset): self.decide(request, queryset, 'approve')
    @admin.action(description='退回所选投稿')
    def reject(self, request, queryset): self.decide(request, queryset, 'reject')
    def decide(self, request, queryset, decision):
        for e in queryset:
            try: cm.review(request.user, {'key': 'entry/'+str(e.pk), 'revision': e.revision,
                'decision': decision, 'reason': '管理中心批量审核'})
            except Problem as exc: self.message_user(request, e.draft.get('title', '')+'：'+exc.message, messages.ERROR)


class OverlayForm(forms.ModelForm):
    expected_revision = forms.IntegerField(widget=forms.HiddenInput)
    reason = forms.CharField(label='修改说明', initial='管理中心编辑并发布')
    class Meta:
        model = EditorialOverride
        fields = ['data', 'reason']
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields['expected_revision'].initial = self.instance.revision
    def clean(self):
        data = super().clean()
        if data.get('expected_revision') != self.instance.revision: raise forms.ValidationError('版本已变化，请刷新。')
        if 'media' in (data.get('data') or {}):
            try: data['data']['media'] = cm.validate_media(data['data']['media'], self.user)
            except Problem as exc: raise forms.ValidationError(exc.message)
        return data


class OverlayAdmin(ModelAdmin):
    form = OverlayForm
    list_display = ['key', 'revision', 'editor', 'updated']
    search_fields = ['key']
    readonly_fields = ['key', 'revision', 'editor', 'updated']
    def has_add_permission(self, request): return False
    def has_delete_permission(self, request, obj=None): return False
    def has_change_permission(self, request, obj=None): return cm.manager(request.user)
    def has_view_permission(self, request, obj=None): return cm.manager(request.user)
    def get_form(self, request, obj=None, **kwargs):
        form = super().get_form(request, obj, **kwargs); form.user = request.user; return form
    def save_model(self, request, obj, form, change):
        cm.publish(request.user, {'key': obj.key, 'revision': form.cleaned_data['expected_revision'],
            'patch': form.cleaned_data['data'], 'reason': form.cleaned_data['reason']})
        obj.refresh_from_db()


class RecordAdmin(ModelAdmin):
    list_per_page = 50
    def has_add_permission(self, request): return False
    def has_change_permission(self, request, obj=None): return False
    def has_delete_permission(self, request, obj=None): return False
    def has_view_permission(self, request, obj=None): return cm.manager(request.user)


class TaskAdmin(RecordAdmin):
    list_display = ['id', 'seat', 'state', 'progress', 'updated']
    list_filter = ['seat', 'state']
    search_fields = ['goal', 'origin', 'error']


class RevisionAdmin(RecordAdmin):
    list_display = ['entry', 'number', 'state', 'reviewer', 'created']


site.register(Entry, EntryAdmin)
site.register(EditorialOverride, OverlayAdmin)
site.register(Revision, RevisionAdmin)
site.register(EditorialRevision, RecordAdmin)
site.register(ContentTask, TaskAdmin)
site.register(Audit, RecordAdmin)


def manage_assets(request, path):
    if '..' in path or '\\' in path or path.startswith('/'): raise Http404
    filename = finders.find(path)
    if not filename: raise Http404
    import mimetypes
    return FileResponse(open(filename, 'rb'), content_type=mimetypes.guess_type(filename)[0] or 'application/octet-stream')
