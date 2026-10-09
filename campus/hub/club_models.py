import uuid
from django.conf import settings
from django.db import models


class Club(models.Model):
    """An explicitly created student group, not a university-verified affiliation."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='owned_clubs')
    name = models.CharField(max_length=80)
    revision = models.PositiveIntegerField(default=1)
    invite_hash = models.CharField(max_length=64, blank=True, db_index=True)
    invite_expires = models.DateTimeField(null=True, blank=True)
    created = models.DateTimeField(auto_now_add=True)
    updated = models.DateTimeField(auto_now=True)


class ClubMembership(models.Model):
    club = models.ForeignKey(Club, on_delete=models.CASCADE, related_name='memberships')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='club_memberships')
    joined = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['club', 'user'], name='hub_club_membership_unique')]


class ClubEvent(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    club = models.ForeignKey(Club, on_delete=models.CASCADE, related_name='events')
    title = models.CharField(max_length=120)
    location = models.CharField(max_length=160, blank=True)
    status = models.CharField(max_length=16, default='pending')
    date = models.DateField(null=True, blank=True)
    start = models.CharField(max_length=5, blank=True)
    end = models.CharField(max_length=5, blank=True)
    duration = models.PositiveIntegerField(default=60)
    created = models.DateTimeField(auto_now_add=True)
    updated = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [models.Index(fields=['club', 'status', 'date'], name='hub_club_event_schedule')]


class ClubMutationReceipt(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    request_key = models.UUIDField()
    digest = models.CharField(max_length=64)
    response = models.JSONField(default=dict)
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'request_key'], name='hub_club_request_unique')]
