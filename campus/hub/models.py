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


class EntryView(models.Model):
    """浏览量：同一个人（登录账号或浏览器会话）同一天看同一条内容只算一次。只存加盐摘要，不存账号或会话号。"""
    entry = models.ForeignKey(Entry, on_delete=models.CASCADE)
    viewer = models.CharField(max_length=64)
    day = models.DateField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=['entry', 'viewer', 'day'], name='hub_entry_view_unique')]


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
    # 教师资料机器人（faculty.py）从学院官网读到的公开资料：学院、系、研究方向、来源页、核对时间
    profile = models.JSONField(default=dict, blank=True)
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


class MirrorAsset(models.Model):
    """开源广场的本站下载：从 GitHub 正式发布镜像过来的文件（mirror.py）。只镜像允许再分发的许可证。"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    repository = models.CharField(max_length=140, db_index=True)
    tag = models.CharField(max_length=120)
    name = models.CharField(max_length=200)
    size = models.PositiveBigIntegerField()
    sha256 = models.CharField(max_length=64)
    license = models.CharField(max_length=60)
    source_url = models.URLField(max_length=600)
    release_url = models.URLField(max_length=600, blank=True)
    published = models.DateTimeField(null=True)
    path = models.CharField(max_length=200)
    downloads = models.PositiveIntegerField(default=0)
    metadata = models.JSONField(default=dict)
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['repository', 'tag', 'name'], name='hub_mirror_asset_unique')]


class DeviceSync(models.Model):
    """手机 App 同步上来的本人数据（sync.py、docs/MOBILE_SYNC.md）。只存数据，不存学校账号、密码或令牌。"""
    user = models.ForeignKey(Member, on_delete=models.CASCADE)
    kind = models.CharField(max_length=20)
    data = models.JSONField(default=dict)
    source = models.CharField(max_length=80, blank=True)
    fetched_at = models.DateTimeField(null=True)
    synced_at = models.DateTimeField(auto_now=True)
    bytes = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'kind'], name='hub_device_sync_unique')]


class ExternalMention(models.Model):
    """站外讨论：同学提交的贴吧 / 虎扑 / 知乎等帖子链接，加上自己写的一句话概括。
    本站不抓取、不转载原帖内容，也不计入评分；审核通过后在教师或课程页单独列出，并标明来源站点。"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    teacher = models.ForeignKey(Teacher, null=True, blank=True, on_delete=models.CASCADE, related_name='mentions')
    course = models.ForeignKey(GuideCourse, null=True, blank=True, on_delete=models.CASCADE, related_name='mentions')
    site = models.CharField(max_length=20)
    url = models.URLField(max_length=1000)
    title = models.CharField(max_length=160)
    summary = models.CharField(max_length=300)
    author = models.ForeignKey(Member, on_delete=models.PROTECT)
    state = models.CharField(max_length=20, default='pending')
    note = models.CharField(max_length=300, blank=True)
    created = models.DateTimeField(auto_now_add=True)
    decided_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['teacher', 'url'], name='hub_mention_teacher_url'),
            models.UniqueConstraint(fields=['course', 'url'], name='hub_mention_course_url'),
            models.CheckConstraint(condition=(models.Q(teacher__isnull=False, course__isnull=True) |
                models.Q(teacher__isnull=True, course__isnull=False)), name='hub_mention_single_subject'),
        ]


class ReplyLike(models.Model):
    """校圈回复的“亮了”：帖子详情顶部先放获赞最多的回复（虎扑亮回复）。"""
    reply = models.ForeignKey(Reply, on_delete=models.CASCADE, related_name='likes')
    user = models.ForeignKey(Member, on_delete=models.CASCADE)
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['reply', 'user'], name='hub_reply_like_unique')]


class BeikuangTask(models.Model):
    """交给北矿娘的活（beikuang.py）：机器人送来的新闻、候选项目、中文导读、教师照片、请示、她的公告草稿。
    她按技能（campus/beikuang-skills/）核对：过了就自己发布，没过的在她的窗口里交给站主。"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    kind = models.CharField(max_length=20)
    key = models.CharField(max_length=240, unique=True)
    target = models.CharField(max_length=240)
    title = models.CharField(max_length=240)
    link = models.CharField(max_length=600, blank=True)
    state = models.CharField(max_length=20, default='queued')
    checks = models.JSONField(default=list)
    note = models.TextField(blank=True)
    data = models.JSONField(default=dict)
    decided_by = models.CharField(max_length=60, blank=True)
    created = models.DateTimeField(auto_now_add=True)
    decided = models.DateTimeField(null=True, blank=True)


class BeikuangMessage(models.Model):
    """北矿娘和站主的对话：站主发的话、她的回复、她主动的汇报（审核没过的事、每日小报告）。"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(Member, on_delete=models.CASCADE, related_name='beikuang_messages')
    role = models.CharField(max_length=12)
    kind = models.CharField(max_length=16, default='chat')
    body = models.TextField()
    data = models.JSONField(default=dict)
    state = models.CharField(max_length=12, default='sent')
    read = models.BooleanField(default=False)
    created = models.DateTimeField(auto_now_add=True)
