"""Private, local AI studio records; never included in public contributions/search."""
import uuid
from django.conf import settings
from django.db import models


class StudioRoom(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    title = models.CharField(max_length=120)
    brief = models.TextField(blank=True)
    context_files = models.JSONField(default=list)
    created = models.DateTimeField(auto_now_add=True)


class StudioRun(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    room = models.ForeignKey(StudioRoom, on_delete=models.CASCADE, related_name='runs')
    request_key = models.CharField(max_length=80)
    prompt = models.TextField()
    mode = models.CharField(max_length=16, default='discuss')
    seats = models.JSONField(default=list)
    rounds = models.PositiveSmallIntegerField(default=3)
    state = models.CharField(max_length=24, default='queued')
    claim = models.UUIDField(null=True)
    stop_requested = models.BooleanField(default=False)
    error = models.CharField(max_length=300, blank=True)
    artifact = models.JSONField(default=dict)
    approved_hash = models.CharField(max_length=64, blank=True)
    created = models.DateTimeField(auto_now_add=True)
    updated = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['room', 'request_key'], name='hub_studio_request_unique')]


class StudioMessage(models.Model):
    run = models.ForeignKey(StudioRun, on_delete=models.CASCADE, related_name='messages')
    sequence = models.PositiveSmallIntegerField()
    seat = models.CharField(max_length=24)
    provider = models.CharField(max_length=24)
    model = models.CharField(max_length=100, blank=True)
    body = models.TextField()
    tasks = models.JSONField(default=list)
    usage = models.JSONField(default=dict)
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['run', 'sequence'], name='hub_studio_message_unique')]


class StudioDay(models.Model):
    # Global provider budget, across rooms, owners and worker processes.
    day = models.DateField(primary_key=True)
    reserved_cny = models.DecimalField(max_digits=12, decimal_places=6, default=0)
    codex_calls = models.PositiveIntegerField(default=0)


class StudioCall(models.Model):
    run = models.ForeignKey(StudioRun, on_delete=models.CASCADE)
    sequence = models.PositiveSmallIntegerField()
    provider = models.CharField(max_length=24)
    day = models.ForeignKey(StudioDay, on_delete=models.PROTECT)
    reserved_cny = models.DecimalField(max_digits=12, decimal_places=6, default=0)
    state = models.CharField(max_length=20, default='reserved')

    class Meta:
        constraints = [models.UniqueConstraint(fields=['run', 'sequence'], name='hub_studio_call_unique')]
