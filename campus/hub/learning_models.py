"""Explicit subscriptions to a stable course identity."""
from django.db import models


class CourseFollow(models.Model):
    user = models.ForeignKey('hub.Member', on_delete=models.CASCADE)
    course = models.ForeignKey('hub.GuideCourse', on_delete=models.CASCADE, related_name='followers')
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'course'], name='hub_course_follow_unique')]
