"""Owner-private question drafts. These records never enter the public Entry index."""
import uuid
from django.conf import settings
from django.db import models


class QuestionPaper(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    title = models.CharField(max_length=160)
    course = models.CharField(max_length=160, blank=True)
    category = models.CharField(max_length=80, default='未分类')
    state = models.CharField(max_length=24, default='queued', db_index=True)
    source_kind = models.CharField(max_length=16)
    source_upload = models.ForeignKey('hub.Upload', null=True, blank=True, on_delete=models.PROTECT)
    source_document_id = models.CharField(max_length=160, blank=True)
    source_meta = models.JSONField(default=dict)
    selected_pages = models.JSONField(default=list)
    raw_text = models.TextField(blank=True)
    extracted_pages = models.JSONField(default=list)
    questions = models.JSONField(default=list)
    review = models.JSONField(default=dict)
    revision = models.PositiveIntegerField(default=1)
    error = models.CharField(max_length=300, blank=True)
    created = models.DateTimeField(auto_now_add=True)
    updated = models.DateTimeField(auto_now=True)
    shelved = models.DateTimeField(null=True, blank=True)


class QuestionRevision(models.Model):
    paper = models.ForeignKey(QuestionPaper, on_delete=models.CASCADE, related_name='versions')
    number = models.PositiveIntegerField()
    snapshot = models.JSONField(default=dict)
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['paper', 'number'], name='hub_question_revision_unique')]
