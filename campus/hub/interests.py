"""Account interests are canonical; the old circle field is a compatibility copy."""
from django.db import transaction
from .models import CirclePreference, Member


@transaction.atomic
def read_interests(user, legacy=None):
    if not user.is_authenticated:
        return []
    # An explicit empty list is meaningful: never restore removed legacy interests.
    if 'interests' not in user.preferences:
        current = Member.objects.select_for_update().get(pk=user.pk)
        preferences = dict(current.preferences)
        if 'interests' not in preferences:
            legacy = legacy or CirclePreference.objects.filter(user=user).first()
            values = list(dict.fromkeys(legacy.interests if legacy else []))[:12]
            preferences['interests'] = values
            current.preferences = preferences
            current.save(update_fields=['preferences'])
            if legacy and legacy.interests != values:
                legacy.interests = values
                legacy.save(update_fields=['interests'])
        user.preferences = preferences
    return list(user.preferences.get('interests', []))


@transaction.atomic
def save_interests(user, values):
    current = Member.objects.select_for_update().get(pk=user.pk)
    preferences = dict(current.preferences)
    preferences['interests'] = values
    current.preferences = preferences
    current.save(update_fields=['preferences'])
    user.preferences = preferences
    CirclePreference.objects.update_or_create(user=user, defaults={'interests': values})
