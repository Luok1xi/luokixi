import uuid
from django.conf import settings
from django.db import models

class SeatPlan(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    request_key = models.UUIDField()
    campus = models.CharField(max_length=20)
    starts = models.DateTimeField()
    ends = models.DateTimeField()
    remind_at = models.DateTimeField()
    preference = models.CharField(max_length=200, blank=True)
    state = models.CharField(max_length=24, default='scheduled')
    reminded = models.BooleanField(default=False)
    version = models.PositiveIntegerField(default=1)
    updated = models.DateTimeField(auto_now=True)
    created = models.DateTimeField(auto_now_add=True)
    class Meta:
        constraints = [models.UniqueConstraint(fields=['owner','request_key'], name='seat_plan_request_unique')]
        indexes = [models.Index(fields=['state','remind_at'], name='seat_plan_due')]
