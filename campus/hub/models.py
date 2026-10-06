import uuid
from .booking_models import SeatPlan
from .studio_models import StudioRoom, StudioRun, StudioMessage, StudioDay, StudioCall
from django.contrib.auth.models import AbstractUser
from django.db import models
from django.db.models.functions import Lower


class Member(AbstractUser):
    email = models.EmailField(unique=True)
    email_verified = models.BooleanField(default=False)
    campus_verified = models.BooleanField(default=False)
    trusted = models.BooleanField(default=False)
    github_id = models.CharField(max_length=32, null=True, blank=True, unique=True)
    display_name = models.CharField(max_length=80, blank=True)
    bio = models.TextField(blank=True)
    major = models.CharField(max_length=80, blank=True)
    preferences = models.JSONField(default=dict, blank=True)
    external_links = models.JSONField(default=dict, blank=True)
    digest_enabled = models.BooleanField(default=False)
    digest_cursor = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(Lower('email'), name='hub_email_ci'),
                       models.UniqueConstraint(Lower('username'), name='hub_username_ci')]


class Asset(models.Model):
    sha256 = models.CharField(max_length=64, primary_key=True)
    size = models.PositiveIntegerField()
    extension = models.CharField(max_length=12)
    path = models.CharField(max_length=300)
    text = models.TextField(blank=True)
    pages = models.JSONField(default=list)
    extraction = models.CharField(max_length=40, default='pending')
    created = models.DateTimeField(auto_now_add=True)


class Upload(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(Member, on_delete=models.PROTECT)
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT)
    name = models.CharField(max_length=180)
    created = models.DateTimeField(auto_now_add=True)


class Entry(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    kind = models.CharField(max_length=24)
    owner = models.ForeignKey(Member, null=True, on_delete=models.PROTECT)
    slug = models.CharField(max_length=160, unique=True)
    state = models.CharField(max_length=20, default='draft')
    draft = models.JSONField(default=dict)
    published = models.JSONField(default=dict)
    revision = models.PositiveIntegerField(default=1)
    public_revision = models.PositiveIntegerField(default=0)
    search_text = models.TextField(blank=True)
    canonical_key = models.CharField(max_length=500, blank=True, db_index=True)
    canonical = models.ForeignKey('self', null=True, blank=True, on_delete=models.PROTECT)
    review_note = models.TextField(blank=True)
    created = models.DateTimeField(auto_now_add=True)
    updated = models.DateTimeField(auto_now=True)


class Revision(models.Model):
    entry = models.ForeignKey(Entry, on_delete=models.CASCADE, related_name='versions')
    number = models.PositiveIntegerField()
    data = models.JSONField(default=dict)
    state = models.CharField(max_length=20, default='draft')
    reviewer = models.ForeignKey(Member, null=True, on_delete=models.PROTECT)
    note = models.TextField(blank=True)
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['entry', 'number'], name='hub_revision_unique')]


class Star(models.Model):
    user = models.ForeignKey(Member, on_delete=models.CASCADE)
    entry = models.ForeignKey(Entry, on_delete=models.CASCADE)
    collection = models.CharField(max_length=80, default='默认收藏')
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'entry'], name='hub_star_unique')]


class Watch(models.Model):
    user = models.ForeignKey(Member, on_delete=models.CASCADE)
    entry = models.ForeignKey(Entry, on_delete=models.CASCADE)
    events = models.JSONField(default=list)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'entry'], name='hub_watch_unique')]


class Reply(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    entry = models.ForeignKey(Entry, on_delete=models.CASCADE)
    author = models.ForeignKey(Member, on_delete=models.PROTECT)
    body = models.TextField()
    state = models.CharField(max_length=20, default='pending')
    accepted = models.BooleanField(default=False)
    created = models.DateTimeField(auto_now_add=True)


class Contribution(models.Model):
    key = models.CharField(max_length=180, primary_key=True)
    user = models.ForeignKey(Member, on_delete=models.PROTECT)
    entry = models.ForeignKey(Entry, null=True, on_delete=models.PROTECT)
    category = models.CharField(max_length=30)
    summary = models.CharField(max_length=200)
    evidence = models.CharField(max_length=500)
    active = models.BooleanField(default=True)
    reason = models.TextField(blank=True)
    created = models.DateTimeField(auto_now_add=True)


class Notification(models.Model):
    user = models.ForeignKey(Member, on_delete=models.CASCADE)
    entry = models.ForeignKey(Entry, null=True, on_delete=models.CASCADE)
    event = models.CharField(max_length=30)
    key = models.CharField(max_length=200)
    text = models.CharField(max_length=300)
    read = models.BooleanField(default=False)
    subscription = models.BooleanField(default=False)
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'key'], name='hub_notification_unique')]


class Task(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    entry = models.ForeignKey(Entry, on_delete=models.CASCADE)
    title = models.CharField(max_length=160)
    description = models.TextField()
    beginner = models.BooleanField(default=True)
    state = models.CharField(max_length=20, default='open')
    assignee = models.ForeignKey(Member, null=True, on_delete=models.PROTECT)
    evidence = models.URLField(max_length=500, blank=True)
    note = models.TextField(blank=True)


class Workspace(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(Member, on_delete=models.CASCADE)
    kind = models.CharField(max_length=30)
    title = models.CharField(max_length=160)
    data = models.JSONField(default=dict)
    version = models.PositiveIntegerField(default=1)
    updated = models.DateTimeField(auto_now=True)


class Audit(models.Model):
    actor = models.ForeignKey(Member, null=True, on_delete=models.PROTECT)
    action = models.CharField(max_length=50)
    target = models.CharField(max_length=180)
    detail = models.JSONField(default=dict)
    created = models.DateTimeField(auto_now_add=True)


class Report(models.Model):
    reporter = models.ForeignKey(Member, on_delete=models.PROTECT)
    entry = models.ForeignKey(Entry, on_delete=models.PROTECT)
    reason = models.TextField()
    state = models.CharField(max_length=20, default='open')
    resolution = models.TextField(blank=True)
    created = models.DateTimeField(auto_now_add=True)


class Source(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=160)
    url = models.URLField(max_length=500, unique=True)
    kind = models.CharField(max_length=20, default='rss')
    entry_kind = models.CharField(max_length=20, default='news')
    enabled = models.BooleanField(default=False)
    interval_hours = models.PositiveIntegerField(default=24)
    last_success = models.DateTimeField(null=True)
    last_attempt = models.DateTimeField(null=True)
    error = models.CharField(max_length=300, blank=True)
    fingerprint = models.CharField(max_length=64, blank=True)
    etag = models.CharField(max_length=300, blank=True)
    modified = models.CharField(max_length=100, blank=True)


class Job(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    kind = models.CharField(max_length=30)
    owner = models.ForeignKey(Member, null=True, on_delete=models.CASCADE)
    key = models.CharField(max_length=200, unique=True)
    payload = models.JSONField(default=dict)
    state = models.CharField(max_length=20, default='queued')
    attempts = models.PositiveIntegerField(default=0)
    result = models.JSONField(default=dict)
    error = models.CharField(max_length=300, blank=True)
    due = models.DateTimeField()
    updated = models.DateTimeField(auto_now=True)


class ExternalCache(models.Model):
    key = models.CharField(max_length=80, primary_key=True)
    data = models.JSONField(default=dict)
    success = models.DateTimeField(null=True)
    checked = models.DateTimeField(null=True)
    error = models.CharField(max_length=300, blank=True)


class RateBucket(models.Model):
    key = models.CharField(max_length=100, primary_key=True)
    count = models.PositiveIntegerField(default=0)
    reset = models.DateTimeField()


class FeedFeedback(models.Model):
    user = models.ForeignKey(Member, on_delete=models.CASCADE)
    repository = models.CharField(max_length=250)
    action = models.CharField(max_length=20)
    updated = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user','repository'], name='hub_feed_feedback_unique')]


class PlaceObservation(models.Model):
    user = models.ForeignKey(Member,on_delete=models.CASCADE)
    entry = models.ForeignKey(Entry,on_delete=models.CASCADE)
    status = models.CharField(max_length=20)
    note = models.CharField(max_length=300,blank=True)
    updated = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user','entry'],name='hub_place_observation_unique')]


# Separate from Entry: its public attribution/profile feeds cannot expose reviewers.
class Teacher(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=80)
    faculty = models.CharField(max_length=120, blank=True)
    title = models.CharField(max_length=80, blank=True)
    source_url = models.URLField(max_length=1000)
    photo = models.JSONField(default=dict, blank=True)
    teaching = models.JSONField(default=list, blank=True)
    active = models.BooleanField(default=True)
    checked_at = models.DateTimeField(auto_now=True)


class GuideCourse(models.Model):
    id = models.SlugField(max_length=100, primary_key=True)
    name = models.CharField(max_length=160)
    faculty = models.CharField(max_length=120, blank=True)
    scope = models.CharField(max_length=40, default='campus-catalogue')
    source_url = models.URLField(max_length=1000, blank=True)
    prerequisites = models.TextField(blank=True)
    resources = models.JSONField(default=list, blank=True)


class CourseOffering(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    course = models.ForeignKey(GuideCourse, on_delete=models.PROTECT, related_name='offerings')
    teachers = models.ManyToManyField(Teacher, related_name='offerings')
    term = models.CharField(max_length=80)
    campus = models.CharField(max_length=20)
    source_url = models.URLField(max_length=1000)
    active = models.BooleanField(default=True)


class CourseReview(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    author = models.ForeignKey(Member, on_delete=models.PROTECT)
    teacher = models.ForeignKey(Teacher, null=True, blank=True, on_delete=models.PROTECT)
    offering = models.ForeignKey(CourseOffering, null=True, blank=True, on_delete=models.PROTECT)
    revision = models.PositiveIntegerField(default=1)
    public_revision = models.PositiveIntegerField(default=0)
    state = models.CharField(max_length=20, default='pending')
    draft = models.JSONField(default=dict)
    published = models.JSONField(default=dict, blank=True)
    force_anonymous = models.BooleanField(default=True)
    note = models.TextField(blank=True)
    created = models.DateTimeField(auto_now_add=True)
    published_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        permissions = [('trace_review_author', 'Trace anonymous review authors with audit reason')]
        constraints = [
            models.UniqueConstraint(fields=['author', 'teacher'], name='hub_teacher_review_unique'),
            models.UniqueConstraint(fields=['author', 'offering'], name='hub_offering_review_unique'),
            models.CheckConstraint(condition=(models.Q(teacher__isnull=False, offering__isnull=True) |
                models.Q(teacher__isnull=True, offering__isnull=False)), name='hub_review_single_subject'),
        ]


class CourseReviewVersion(models.Model):
    review = models.ForeignKey(CourseReview, on_delete=models.CASCADE)
    number = models.PositiveIntegerField()
    data = models.JSONField(default=dict)
    state = models.CharField(max_length=20, default='pending')
    note = models.TextField(blank=True)
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['review', 'number'], name='hub_course_review_version')]


class CourseReviewLike(models.Model):
    review = models.ForeignKey(CourseReview, on_delete=models.CASCADE, related_name='likes')
    user = models.ForeignKey(Member, on_delete=models.CASCADE)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['review', 'user'], name='hub_course_review_like')]


class CourseReviewReply(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    review = models.ForeignKey(CourseReview, on_delete=models.CASCADE, related_name='discussion')
    author = models.ForeignKey(Member, on_delete=models.PROTECT)
    body = models.TextField()
    anonymous = models.BooleanField(default=True)
    state = models.CharField(max_length=20, default='pending')
    created = models.DateTimeField(auto_now_add=True)


class CourseReviewCase(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    review = models.ForeignKey(CourseReview, on_delete=models.PROTECT)
    author = models.ForeignKey(Member, on_delete=models.PROTECT)
    kind = models.CharField(max_length=20)
    body = models.TextField()
    state = models.CharField(max_length=20, default='open')
    resolution = models.TextField(blank=True)
    created = models.DateTimeField(auto_now_add=True)


class CampusClip(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(Member, on_delete=models.PROTECT)
    teacher = models.ForeignKey(Teacher, null=True, blank=True, on_delete=models.PROTECT)
    course = models.ForeignKey(GuideCourse, null=True, blank=True, on_delete=models.PROTECT)
    project = models.ForeignKey(Entry, null=True, blank=True, on_delete=models.PROTECT)
    title = models.CharField(max_length=120)
    transcript = models.TextField()
    extension = models.CharField(max_length=10)
    state = models.CharField(max_length=20, default='queued')
    duration = models.FloatField(default=0)
    note = models.TextField(blank=True)
    created = models.DateTimeField(auto_now_add=True)
    updated = models.DateTimeField(auto_now=True)


class CampusBoard(models.Model):
    id = models.SlugField(primary_key=True, max_length=60)
    name = models.CharField(max_length=80)
    description = models.CharField(max_length=500, blank=True)
    rules = models.TextField(blank=True)
    active = models.BooleanField(default=True)


class BoardFollow(models.Model):
    user = models.ForeignKey(Member, on_delete=models.CASCADE)
    board = models.ForeignKey(CampusBoard, on_delete=models.CASCADE)
    notify = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'board'], name='hub_board_follow_unique')]


class CreatorFollow(models.Model):
    user = models.ForeignKey(Member, on_delete=models.CASCADE, related_name='creator_follows')
    creator = models.ForeignKey(Member, on_delete=models.CASCADE, related_name='creator_followers')
    notify = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'creator'], name='hub_creator_follow_unique'),
                       models.CheckConstraint(condition=~models.Q(user=models.F('creator')), name='hub_no_self_follow')]


class CirclePreference(models.Model):
    user = models.OneToOneField(Member, on_delete=models.CASCADE, primary_key=True)
    personalized = models.BooleanField(default=True)
    interests = models.JSONField(default=list)
    muted_creators = models.JSONField(default=list)
    muted_boards = models.JSONField(default=list)


class CircleLike(models.Model):
    user = models.ForeignKey(Member, on_delete=models.CASCADE)
    entry = models.ForeignKey(Entry, on_delete=models.CASCADE, related_name='circle_likes')
    revision = models.PositiveIntegerField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'entry'], name='hub_circle_like_unique')]


class CircleFeedback(models.Model):
    user = models.ForeignKey(Member, on_delete=models.CASCADE)
    entry = models.ForeignKey(Entry, on_delete=models.CASCADE, related_name='circle_feedback')
    revision = models.PositiveIntegerField()
    action = models.CharField(max_length=20)
    updated = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'entry'], name='hub_circle_feedback_unique')]


class CircleSelection(models.Model):
    entry = models.OneToOneField(Entry, on_delete=models.CASCADE, primary_key=True, related_name='circle_selection')
    revision = models.PositiveIntegerField()
    reason = models.CharField(max_length=1000)
    reviewer = models.ForeignKey(Member, on_delete=models.PROTECT)
    checked_at = models.DateTimeField(auto_now=True)
