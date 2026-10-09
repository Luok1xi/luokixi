"""Public learning discovery, using approved snapshots and exact course identities.

No library database, Workspace, upload extraction or private draft is read here.
GuideCourse is the existing single-school catalogue (cumtb); supporting another
school's course catalogue requires a separate explicit identity, not name matching.
"""
import hashlib
import re
import unicodedata
from collections import Counter
from urllib.parse import quote, urlsplit

from django.core.exceptions import ValidationError
from django.db.models import Case, Count, IntegerField, Q, Value, When
from django.utils.dateparse import parse_date, parse_datetime
from django.utils import timezone

from .core import Problem, public_entries, text
from .models import CampusBoard, CourseOffering, GuideCourse, Reply
from . import reputation
from .search_matching import text_score


SCHOOL = 'cumtb'
GROUPS = {'courses': '课程与学习专题', 'resources': '课程资料', 'papers': '论文',
          'tools': '数据与工具', 'questions': '问答与讨论',
          'experiences': '同学经验', 'opportunities': '学术机会'}
KINDS = {'resource': 'resources', 'paper': 'papers', 'project': 'tools',
         'reproduction': 'tools', 'topic': 'questions', 'contest': 'opportunities'}
ACCESS = {'unknown', 'public', 'open', 'campus', 'carsi', 'paid', 'request', 'link-only', 'local-only'}
MATERIAL_TYPES = {'notes', 'textbook', 'course', 'exam', 'exercise', 'code', 'data',
                  'experience', 'question', 'other', 'paper', 'dataset', 'tool'}
PUBLICATION_STATES = {'unknown', 'preprint', 'published', 'corrected', 'retracted'}
ALIASES = (('linear algebra', '线性代数'), ('线代', '线性代数'),
           ('高数', '高等数学'), ('大学英语四级', '英语四级'),
           ('cet-4', '英语四级'), ('cet4', '英语四级'),
           ('大学英语六级', '英语六级'), ('cet-6', '英语六级'), ('cet6', '英语六级'))
MAX_CANDIDATES = 1500


def normalize(value):
    value = unicodedata.normalize('NFKC', str(value or '')).casefold().strip()
    for alias, canonical in ALIASES:
        value = value.replace(alias, canonical)
    return re.sub(r'\s+', ' ', value)


def identifier(value):
    value = unicodedata.normalize('NFKC', str(value or '')).casefold().strip()
    return re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', '', value).rstrip('/')


def string(value, limit=1000):
    return value.strip()[:limit] if isinstance(value, str) else ''


def safe_url(value):
    value = string(value)
    try:
        parsed = urlsplit(value)
        return value if (parsed.scheme in ('http', 'https') and parsed.hostname
                         and not parsed.username and not parsed.password) else ''
    except ValueError:
        return ''


def checked_date(value):
    value = string(value, 40)
    try:
        return value if value and (parse_date(value) or parse_datetime(value)) else None
    except ValueError:
        return None


def validate_learning(value):
    """Validate the optional Entry.learning object without creating records."""
    if not isinstance(value, dict):
        raise Problem('课程资料信息格式不正确。')
    result = {key: text(value.get(key, ''), limit) for key, limit in
              (('school', 40), ('courseId', 100), ('offeringId', 36), ('term', 80),
               ('faculty', 120), ('materialType', 60), ('version', 200), ('courseCode', 100))}
    result['access'] = value.get('access', 'unknown')
    result['publicationStatus'] = value.get('publicationStatus', 'unknown')
    if result['access'] not in ACCESS or result['publicationStatus'] not in PUBLICATION_STATES:
        raise Problem('请选择有效的获取方式和论文版本状态。')
    if result['materialType'] and result['materialType'] not in MATERIAL_TYPES:
        raise Problem('请选择有效的资料类型。')
    if result['school'] and not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', result['school']):
        raise Problem('学校范围无效。')
    source = text(value.get('sourceUrl', ''), 1000)
    if source and not safe_url(source):
        raise Problem('请填写完整的 HTTP 或 HTTPS 来源链接。')
    result['sourceUrl'] = source
    checked = text(value.get('checkedAt', ''), 10)
    if checked and (not re.fullmatch(r'\d{4}-\d{2}-\d{2}', checked) or not checked_date(checked)
                    or checked > timezone.localdate().isoformat()):
        raise Problem('最近核对日期需要使用 YYYY-MM-DD，且不能晚于今天。')
    result['checkedAt'] = checked
    course = GuideCourse.objects.filter(pk=result['courseId']).first() if result['courseId'] else None
    if result['courseId'] and not course:
        raise Problem('课程编号不存在，请从课程目录重新选择。')
    if course:
        if result['school'] not in ('', SCHOOL):
            raise Problem('课程与学校范围不一致。')
        result['school'] = SCHOOL
        if course.faculty and result['faculty'] and result['faculty'] != course.faculty:
            raise Problem('学院与当前课程记录不一致。')
        result['faculty'] = course.faculty or result['faculty']
    if result['offeringId']:
        if not course:
            raise Problem('请先选择课程，再选择具体开课安排。')
        try:
            offering = CourseOffering.objects.filter(pk=result['offeringId'], course=course, active=True).first()
        except (ValidationError, ValueError, TypeError):
            offering = None
        if not offering:
            raise Problem('开课安排不存在、已停用或与课程不一致。')
        if result['term'] and result['term'] != offering.term:
            raise Problem('学期与所选开课安排不一致。')
        result['term'] = offering.term
    return result


def base_card(**values):
    card = {'id': '', 'kind': '', 'group': '', 'title': '', 'summary': '', 'href': '',
            'school': '', 'courseId': '', 'courseIds': [], 'courseName': '', 'offeringId': '',
            'term': '', 'faculty': '', 'materialType': '', 'version': '', 'access': 'unknown',
            'sourceUrl': '', 'sourceNote': '', 'checkedAt': None, 'publicationStatus': 'unknown',
            'identifiers': [], 'updated': None}
    card.update(values)
    card['missingMetadata'] = [key for key in ('school', 'term', 'version', 'sourceUrl', 'checkedAt')
                               if not card.get(key)]
    if card['access'] == 'unknown':
        card['missingMetadata'].append('access')
    if card['kind'] != 'course' and not card['courseIds']:
        card['missingMetadata'].append('courseId')
    if card['kind'] == 'paper' and card['publicationStatus'] == 'unknown':
        card['missingMetadata'].append('publicationStatus')
    return card


def course_card(course):
    school = SCHOOL if course.scope == 'campus-catalogue' else ''
    return base_card(id='course:' + course.pk, kind='course', group='courses',
                     title=course.name, name=course.name, summary=course.prerequisites,
                     href='course.html?id=' + quote(course.pk), school=school,
                     courseId=course.pk, courseIds=[course.pk], courseName=course.name,
                     faculty=course.faculty, sourceUrl=safe_url(course.source_url),
                     scope=course.scope, identifiers=[course.pk],
                     materialType='课程' if school else '学习专题')


def guide_resources(course):
    for resource in course.resources if isinstance(course.resources, list) else []:
        if not isinstance(resource, dict):
            continue
        source = safe_url(resource.get('url'))
        if not source or not string(resource.get('title')):
            continue
        # Access rights cannot be inferred from the price of a course platform.
        access = resource.get('access', 'unknown')
        if access not in ACCESS:
            access = 'unknown'
        fingerprint = hashlib.sha256((source + '\n' + string(resource.get('version'))
                                     + '\n' + string(resource.get('term'))).encode()).hexdigest()[:20]
        yield base_card(id=f'course-resource:{course.pk}:{fingerprint}', kind='resource',
            group='resources', title=string(resource.get('title')), summary=string(resource.get('audience')),
            href=source, sourceUrl=source, school=SCHOOL if course.scope == 'campus-catalogue' else '',
            courseId=course.pk, courseIds=[course.pk], courseName=course.name, faculty=course.faculty,
            materialType=string(resource.get('type')), access=access, cost=resource.get('cost', 'unknown'),
            checkedAt=checked_date(resource.get('checkedAt')), term=string(resource.get('term')),
            version=string(resource.get('version')), _canonical='resource:' + source.rstrip('/'))


def entry_card(entry, courses, offerings):
    data = entry.published
    if not isinstance(data, dict):
        return None
    learning = data.get('learning') if isinstance(data.get('learning'), dict) else {}
    circle = data.get('circle') if isinstance(data.get('circle'), dict) else {}
    if data.get('visibility', 'public') != 'public' or circle.get('visibility', 'public') != 'public':
        return None
    if learning.get('visibility', 'public') != 'public':
        return None
    raw_ids = data.get('courses') if isinstance(data.get('courses'), list) else []
    primary = string(learning.get('courseId'), 100)
    ids = list(dict.fromkeys(i for i in [primary, *raw_ids] if isinstance(i, str) and i in courses))
    offering = offerings.get(string(learning.get('offeringId'), 36))
    # A stale/mismatched relation must not attach the item to a different course.
    if offering and (not primary or offering.course_id == primary):
        ids = list(dict.fromkeys([offering.course_id, *ids]))
    else:
        offering = None
    course = courses.get(primary) or (courses.get(ids[0]) if len(ids) == 1 else None)
    explicit_school = string(learning.get('school'), 40)
    school = explicit_school or (SCHOOL if course and course.scope == 'campus-catalogue' else '')
    if explicit_school and explicit_school != SCHOOL:
        ids, course, offering = [], None, None
    links = data.get('links') if isinstance(data.get('links'), dict) else {}
    source = next((u for u in [safe_url(learning.get('sourceUrl')), safe_url(links.get('source')),
                  safe_url(links.get('paper')), safe_url(links.get('repo'))] if u), '')
    access = learning.get('access', 'unknown')
    if access not in ACCESS:
        access = 'unknown'
    group = KINDS[entry.kind]
    if entry.kind == 'resource' and learning.get('materialType') in ('dataset', 'data', 'code', 'tool', '数据集', '代码', '工具'):
        group = 'tools'
    if entry.kind == 'topic' and circle:
        href = 'circle.html?post=' + str(entry.pk)
    elif entry.kind == 'topic':
        href = ('course.html?id=' + quote(course.pk) + '&' if course else 'course.html?') + 'question=' + str(entry.pk)
    else:
        href = 'project.html?id=' + str(entry.pk)
    return base_card(id=str(entry.pk), kind=entry.kind, group=group,
        title=string(data.get('title'), 160), summary=string(data.get('summary')),
        href=href,
        school=school, courseId=course.pk if course else '', courseIds=ids,
        courseName=course.name if course else '', offeringId=str(offering.pk) if offering else '',
        term=offering.term if offering else string(learning.get('term'), 80),
        faculty=string(learning.get('faculty'), 120) or (course.faculty if course else ''),
        materialType=string(learning.get('materialType'), 60), version=string(learning.get('version'), 200),
        access=access, sourceUrl=source, sourceNote=string(data.get('sourceNote'), 600),
        checkedAt=checked_date(learning.get('checkedAt')),
        publicationStatus=string(learning.get('publicationStatus'), 40) or 'unknown',
        identifiers=[str(entry.pk), entry.slug, string(data.get('doi'), 200), string(learning.get('courseCode'), 100)],
        updated=entry.updated.isoformat(), revision=entry.public_revision,
        _body=string(data.get('body'), 80000), _tags=data.get('tags', []),
        _canonical=entry.canonical_key, _parent=str(entry.canonical_id) if entry.canonical_id else '',
        _year=string(data.get('year'), 30), _deadline=string(data.get('deadline'), 40),
        _codeVersion=string(data.get('codeVersion'), 200), _dataVersion=string(data.get('dataVersion'), 200))


def review_card(review, courses, user):
    # The existing serializer preserves forced anonymity and approved revisions.
    data = reputation.review_data(review, user)
    course_id = review.offering.course_id if review.offering_id else data.get('courseId')
    course = courses.get(course_id)
    if not course:
        return None
    offering = review.offering if review.offering_id else None
    return base_card(id='review:' + str(review.pk), kind='review', group='experiences',
        title=course.name + ' · 同学经验', summary=data['body'][:240], href=data['href'],
        school=SCHOOL if course.scope == 'campus-catalogue' else '', courseId=course.pk,
        courseIds=[course.pk], courseName=course.name, offeringId=str(offering.pk) if offering else '',
        term=offering.term if offering else data['term'], faculty=course.faculty,
        materialType='课程体验' if offering else '教学体验', access='open',
        sourceUrl=safe_url(offering.source_url) if offering else safe_url(course.source_url),
        rating=data['rating'], author=data['author'], review=data,
        updated=review.published_at.isoformat() if review.published_at else None,
        _body=data['body'], _tags=data['tags'])


def candidate_rows(queryset, limit=MAX_CANDIDATES):
    rows = list(queryset[:limit + 1])
    return rows[:limit], len(rows) > limit


def pool(query='', course_id=''):
    """Bounded search of public snapshots. Truncation is exposed, never hidden."""
    course_query = GuideCourse.objects.order_by('id')
    if course_id:
        course_query = course_query.filter(pk=course_id)
    elif query:
        course_query = course_query.annotate(exact_match=Case(When(pk__iexact=query, then=Value(1)),
            default=Value(0), output_field=IntegerField())).order_by('-exact_match', 'id')
    course_rows, course_truncated = candidate_rows(course_query)
    courses = {c.pk: c for c in course_rows}
    offerings = {str(o.pk): o for o in CourseOffering.objects.filter(active=True).select_related('course')
                 .filter(course_id__in=courses).order_by('id')[:MAX_CANDIDATES]}
    entries = public_entries().filter(kind__in=KINDS).order_by('-updated', 'id')
    reviews = reputation.public_reviews().select_related('author', 'offering__course').annotate(
        like_count=Count('likes')).order_by('-published_at', 'id')
    # Prioritize literal/identifier matches, then include recent public candidates
    # for fuzzy matching. SQL substring filtering alone would discard typo matches.
    # The bound and truncation remain explicit; never read Entry.search_text/draft.
    if query:
        words = normalize(query).split()[:12]
        variants = set(words + [string(query)])
        for alias, canonical in ALIASES:
            if any(canonical in word for word in words):
                variants.add(alias)
        exact_course_ids = [c.pk for c in course_rows if normalize(query) in normalize(c.name)
                            or identifier(query) == identifier(c.pk)]
        exact_entry = Q(slug__iexact=query) | Q(published__doi__iexact=identifier(query)) | Q(
            published__doi__iexact='https://doi.org/' + identifier(query)) | Q(
            published__learning__courseCode__iexact=query)
        entry_query = exact_entry
        review_query = Q(offering__course_id__in=exact_course_ids) | Q(published__courseId__in=exact_course_ids)
        for word in variants:
            # SQLite stores JSON with escaped Unicode. Searching the raw JSON
            # blob misses Chinese; scalar JSON_EXTRACT lookups preserve text.
            for field in ('title', 'summary', 'body', 'course', 'sourceNote', 'doi',
                          'learning__term', 'learning__faculty', 'learning__materialType',
                          'learning__version', 'learning__courseCode'):
                entry_query |= Q(**{'published__' + field + '__icontains': word})
            entry_query |= Q(kind='topic', pk__in=Reply.objects.filter(
                state='published', accepted=True, body__icontains=word).values('entry_id'))
            review_query |= Q(published__body__icontains=word) | Q(published__term__icontains=word)
        for key in exact_course_ids:
            entry_query |= Q(published__learning__courseId=key) | Q(published__courses__icontains=key)
        # UUID lookups remain exact and do not let malformed input reach the ORM.
        if re.fullmatch(r'[0-9a-fA-F-]{36}', query):
            try:
                import uuid
                exact_entry |= Q(pk=uuid.UUID(query))
                entry_query |= Q(pk=uuid.UUID(query))
            except ValueError:
                pass
        entries = entries.annotate(exact_match=Case(When(exact_entry, then=Value(1)),
            default=Value(0), output_field=IntegerField()), keyword_match=Case(
            When(entry_query, then=Value(1)), default=Value(0), output_field=IntegerField()
            )).order_by('-exact_match', '-keyword_match', '-updated', 'id')
        reviews = reviews.annotate(keyword_match=Case(When(review_query, then=Value(1)),
            default=Value(0), output_field=IntegerField())).order_by('-keyword_match', '-published_at', 'id')
    if course_id:
        entries = entries.filter(Q(published__learning__courseId=course_id) |
                                 Q(published__courses__icontains=course_id) |
                                 Q(published__learning__offeringId__in=[key for key, o in offerings.items()
                                                                    if o.course_id == course_id]))
        reviews = reviews.filter(Q(offering__course_id=course_id) | Q(published__courseId=course_id))
    entry_rows, entry_truncated = candidate_rows(entries)
    review_rows, review_truncated = candidate_rows(reviews)
    active_boards = set(CampusBoard.objects.filter(active=True).values_list('pk', flat=True))
    accepted_answers = {}
    for answer in Reply.objects.filter(entry_id__in=[e.pk for e in entry_rows if e.kind == 'topic'],
                                       state='published', accepted=True).order_by('entry_id', '-created'):
        # Only accepted, published answers are searchable. The parent entry's
        # visibility is still checked below; private/pending replies are ignored.
        accepted_answers.setdefault(answer.entry_id, answer)
    cards = []
    for course in course_rows:
        cards.append(course_card(course))
        cards.extend(guide_resources(course))
    for entry in entry_rows:
        circle = entry.published.get('circle', {}) if isinstance(entry.published, dict) else {}
        if isinstance(circle, dict) and circle and circle.get('board') not in active_boards:
            continue
        item = entry_card(entry, courses, offerings)
        if item:
            answer = accepted_answers.get(entry.pk)
            if answer:
                item['_answerBody'] = answer.body
                item['acceptedAnswerId'] = str(answer.pk)
            cards.append(item)
    return cards, review_rows, courses, bool(course_truncated or entry_truncated or review_truncated)


def rank(card, query):
    if not query:
        return 1, '公开内容', ''
    normalized = normalize(query)
    if identifier(query) in {identifier(i) for i in card['identifiers'] if i}:
        return 1000, '编号精确匹配', ''
    title = normalize(card['title'])
    if normalized == title:
        return 900, '名称精确匹配', ''
    haystack = normalize(' '.join(str(card.get(k) or '') for k in
        ('title', 'summary', 'courseName', 'courseId', 'term', 'faculty', 'materialType',
         'version', 'sourceNote', '_body', '_answerBody', '_tags')))
    if not all(word in haystack for word in normalized.split()[:12]):
        score = text_score(query, card['title'],
            body=' '.join(str(card.get(key) or '') for key in ('summary', '_body', '_answerBody')),
            keywords=' '.join(str(card.get(key) or '') for key in
                ('courseName', 'courseId', 'term', 'faculty', 'materialType', 'version', 'sourceNote', '_tags')))
        # Exact IDs and literal titles remain ahead of alias/near matches.
        return (min(700, 200 + score * .4), '近似关键词匹配', '') if score else (0, '', '')
    if normalized in title:
        return 750, '标题匹配', ''
    for field, reason in (('_body', '公开正文匹配'), ('_answerBody', '已采纳的公开回答匹配')):
        body = card.get(field, '')
        for word in [string(query), *normalized.split()]:
            at = body.casefold().find(word.casefold())
            if at >= 0:
                start = max(0, at - 55)
                return 450, reason, ('…' if start else '') + body[start:start + 190] + ('…' if start + 190 < len(body) else '')
    return 500, '课程或资料信息匹配', ''


def deduplicate(cards):
    seen, result = set(), []
    for card in cards:
        identity = card.get('_canonical') or card['id']
        # An upstream canonical relation is only a hint. Different versions,
        # offerings or school applicability always remain separate results.
        key = (identity, card['kind'], card['school'], tuple(sorted(card['courseIds'])),
               card['offeringId'], card['term'], card['version'], card['publicationStatus'],
               card.get('_year', ''), card.get('_codeVersion', ''), card.get('_dataVersion', ''),
               '' if card['kind'] == 'project' else card['sourceUrl'])
        if key in seen:
            continue
        seen.add(key)
        result.append(card)
    return result


def public_card(card):
    return {k: v for k, v in card.items() if not k.startswith('_')}


def parameters(query):
    values = {key: text(query.get(key, ''), limit) for key, limit in
              (('q', 160), ('type', 30), ('school', 40), ('course', 100), ('term', 80),
               ('faculty', 120), ('access', 20), ('materialType', 60), ('after', 10), ('before', 10))}
    values['school'] = values['school'] or SCHOOL
    values['type'] = values['type'] or 'all'
    if values['type'] not in {'all', *GROUPS} or (values['access'] and values['access'] not in ACCESS):
        raise Problem('搜索筛选项无效。')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', values['school']):
        raise Problem('学校范围无效。')
    for key in ('after', 'before'):
        if values[key] and (not re.fullmatch(r'\d{4}-\d{2}-\d{2}', values[key]) or not checked_date(values[key])):
            raise Problem('日期需要使用 YYYY-MM-DD。')
    if values['after'] and values['before'] and values['after'] > values['before']:
        raise Problem('起始日期不能晚于结束日期。')
    try:
        values['limit'] = max(1, min(24, int(query.get('limit', 8))))
        values['offset'] = max(0, min(10000, int(query.get('offset', 0))))
    except (ValueError, TypeError):
        raise Problem('分页参数无效。')
    return values


def matches_filters(card, values):
    # General public materials may be displayed, explicitly unscoped, in the
    # local school's search. Other schools never inherit this site's catalogue.
    if card['school'] != values['school'] and not (values['school'] == SCHOOL and not card['school']):
        return False
    if values['course'] and values['course'] not in card['courseIds']:
        return False
    for field in ('term', 'faculty', 'access', 'materialType'):
        if values[field] and normalize(values[field]) != normalize(card[field]):
            return False
    if values['after'] or values['before']:
        stamp = card['checkedAt']
        if not stamp or values['after'] and stamp[:10] < values['after'] or values['before'] and stamp[:10] > values['before']:
            return False
    return True


def search(request):
    values = parameters(request.GET)
    cards, reviews, courses, truncated = pool(values['q'], values['course'])
    cards.extend(card for r in reviews if (card := review_card(r, courses, request.user)))
    matched = []
    for card in cards:
        score, reason, snippet = rank(card, values['q'])
        if score and matches_filters(card, values):
            card['match'] = {'reason': reason, 'score': score}
            card['snippet'] = snippet or card['summary'][:190]
            matched.append(card)
    matched.sort(key=lambda c: (-c['match']['score'], c['title'], c['id']))
    matched = deduplicate(matched)
    groups = []
    for key, label in GROUPS.items():
        rows = [c for c in matched if c['group'] == key]
        offset, limit = values['offset'], values['limit']
        if values['type'] not in ('all', key):
            continue
        groups.append({'key': key, 'label': label, 'total': len(rows),
                       'items': [public_card(c) for c in rows[offset:offset + limit]],
                       'nextOffset': offset + limit if offset + limit < len(rows) else None,
                       'hasMore': offset + limit < len(rows)})
    facets = {field: [{'value': value, 'label': value, 'count': count} for value, count in sorted(
              Counter(c[field] for c in matched if c.get(field)).items())]
              for field in ('faculty', 'term', 'access', 'materialType')}
    course_counts = Counter(key for c in matched for key in c['courseIds'])
    facets['courses'] = [{'value': key, 'label': courses[key].name, 'count': count}
                         for key, count in sorted(course_counts.items()) if key in courses]
    facets['terms'] = facets['term']
    return {'query': values['q'], 'normalizedQuery': normalize(values['q']), 'school': values['school'],
            'type': values['type'], 'groups': groups, 'total': sum(g['total'] for g in groups),
            'facets': facets, 'limit': values['limit'], 'offset': values['offset'],
            'nextOffset': values['offset'] + values['limit'] if any(g['hasMore'] for g in groups) else None,
            'truncated': truncated, 'totalIsLowerBound': truncated,
            'limitations': ['检索已公开的标题、说明与正文；不读取私人资料、未公开附件或草稿。',
                            '学校、学期、版本、访问条件和核对日期缺失时均标为未核实。']
                            + ([f'近似检索优先覆盖精确与关键词命中，再读取最近 {MAX_CANDIDATES} 条公开候选；当前结果可能不完整，可增加课程或学期筛选。'] if truncated else [])}


def course_detail(request, key):
    key = text(key, 100, True)
    if request.GET.get('school', SCHOOL) != SCHOOL:
        raise Problem('该学校范围内没有这门课程。', 404)
    course = GuideCourse.objects.filter(pk=key).first()
    if not course:
        raise Problem('课程不存在。', 404)
    values = parameters(request.GET)
    values['course'] = key
    cards, review_rows, courses, truncated = pool(course_id=key)
    linked = deduplicate([c for c in cards if c['kind'] != 'course' and matches_filters(c, values)])
    resources = [public_card(c) for c in linked if c['group'] in ('resources', 'papers', 'tools')]
    questions = [public_card(c) for c in linked if c['group'] == 'questions']
    # Count and accepted replies use only publicly released answers.
    for question in questions[:100]:
        replies = Reply.objects.filter(entry_id=question['id'], state='published').order_by('-accepted', 'created')
        question['answerCount'] = replies.count()
        answer = replies.filter(accepted=True).first()
        question['acceptedAnswer'] = {'id': str(answer.pk), 'body': answer.body[:1000]} if answer else None
    experience_cards = [card for r in review_rows if (card := review_card(r, courses, request.user))
                        and matches_filters(card, values)]
    offerings = course.offerings.filter(active=True).select_related('course').prefetch_related('teachers').order_by('-term', 'id')
    if values['term']:
        offerings = offerings.filter(term=values['term'])
    reviews = reputation.public_reviews().filter(offering__course=course)
    if values['term']:
        reviews = reviews.filter(offering__term=values['term'])
    result = public_card(course_card(course))
    result['id'] = course.pk
    result.update(prerequisites=course.prerequisites, stats=reputation.statistics(reviews),
                  offerings=[reputation.offering_data(o, request.user) for o in offerings[:100]],
                  resources=resources[:100], questions=questions[:100],
                  experiences=[public_card(c) for c in experience_cards[:100]],
                  counts={'resources': len(resources), 'questions': len(questions), 'experiences': len(experience_cards)},
                  truncated=truncated or any(len(rows) > 100 for rows in (resources, questions, experience_cards)),
                  gaps=[{'key': name, 'label': label} for name, label, missing in (
                      ('source', '官方课程编号与来源待核对', not course.source_url),
                      ('prerequisites', '先修建议待共建', not course.prerequisites),
                      ('offerings', '尚无已核对的具体开课安排', not offerings.exists()),
                      ('resources', '公开课程资料待补充', not resources),
                      ('questions', '常见问题待共建', not questions),
                      ('experiences', '还没有公开的同学经验', not experience_cards)) if missing],
                  notes=['本页只关联明确课程编号；同名课程、不同学校或课程版本不会按名称合并。',
                         '课程体验评分来自原开课评价；教师评价单独显示，不重复计入课程评分。'])
    return result


def get(request, route):
    if route == 'learning/search':
        return search(request)
    parts = route.split('/')
    if route == 'learning/courses':
        values = parameters(request.GET)
        rows = []
        for course in GuideCourse.objects.order_by('id')[:MAX_CANDIDATES]:
            card = course_card(course)
            score, reason, _ = rank(card, values['q'])
            if score and matches_filters(card, values):
                card['match'] = {'score': score, 'reason': reason}
                rows.append(card)
        rows.sort(key=lambda card: (-card['match']['score'], card['title'], card['id']))
        offset, limit = values['offset'], values['limit']
        # Course catalogue IDs are GuideCourse IDs, never search-card prefixes.
        return {'items': [dict(public_card(card), id=card['courseId']) for card in rows[offset:offset + limit]],
                'total': len(rows), 'nextOffset': offset + limit if offset + limit < len(rows) else None,
                'school': values['school']}
    if len(parts) == 4 and parts[:2] == ['learning', 'courses'] and parts[3] == 'follow':
        from . import learning_follow
        return learning_follow.get(request, parts[2])
    if len(parts) == 3 and parts[:2] == ['learning', 'courses']:
        return course_detail(request, parts[2])
    raise Problem('学习资源接口不存在。', 404)


def post(request, route, body):
    parts = route.split('/')
    if len(parts) == 4 and parts[:2] == ['learning', 'courses'] and parts[3] == 'follow':
        from . import learning_follow
        return learning_follow.set_follow(request, parts[2], body)
    raise Problem('学习资源接口不存在。', 404)
