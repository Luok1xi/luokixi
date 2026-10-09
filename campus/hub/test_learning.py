"""Visibility, identity and relevance checks; Django creates an isolated test DB."""
import json
from unittest.mock import patch

from django.contrib.auth.models import AnonymousUser
from django.test import Client, RequestFactory, TestCase
from django.utils import timezone

from . import learning, learning_follow
from .core import Problem
from .learning_models import CourseFollow
from .models import (CampusBoard, CourseOffering, CourseReview, Entry, ExternalCache, GuideCourse,
                     Member, Notification, Reply, Source, Teacher, Workspace)


class LearningTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = Member.objects.create(username='learner', email='learner@example.test', email_verified=True)
        cls.bob = Member.objects.create(username='anonymous-real-identity', email='private@example.test', email_verified=True)
        cls.course = GuideCourse.objects.create(id='linalg', name='线性代数', faculty='理学院',
            source_url='https://lxy.cumtb.edu.cn/catalogue', prerequisites='向量与方程组',
            resources=[{'title': '公开课程入口', 'url': 'https://example.edu/algebra', 'type': 'course',
                        'audience': '补充学习向量与矩阵', 'cost': 'free', 'checkedAt': '2026-09-01'}])
        cls.other = GuideCourse.objects.create(id='linalg-b', name='线性代数', faculty='其他学院')
        cls.topic = GuideCourse.objects.create(id='robotics', name='机器人', scope='general-topic')
        cls.offering = CourseOffering.objects.create(course=cls.course, term='2026 秋', campus='shahe',
                                                     source_url='https://example.edu/offering')
        cls.other_offering = CourseOffering.objects.create(course=cls.other, term='2025 秋', campus='xueyuanlu',
                                                           source_url='https://example.edu/other-offering')
        cls.teacher = Teacher.objects.create(name='测试教师', source_url='https://example.edu/teacher')
        cls.offering.teachers.add(cls.teacher)
        CampusBoard.objects.create(id='courses', name='课程')
        CampusBoard.objects.create(id='closed', name='已关闭', active=False)

    def request(self, params=None, user=None):
        request = RequestFactory().get('/api/hub/learning/search', params or {})
        request.user = user or AnonymousUser()
        return request

    def create_entry(self, title='线性代数笔记', *, kind='resource', learning_meta=None, **extra):
        payload = {'title': title, 'summary': '公开资料说明', 'body': '',
                   'links': {'source': 'https://example.edu/' + str(Entry.objects.count())}}
        if learning_meta is not None:
            payload['learning'] = learning_meta
        payload.update(extra.pop('payload', {}))
        return Entry.objects.create(owner=self.bob, kind=kind, slug='entry-' + str(Entry.objects.count()),
            state=extra.pop('state', 'published'), public_revision=extra.pop('public_revision', 1),
            published=payload, draft=extra.pop('draft', payload), **extra)

    def cards(self, **params):
        return [card for group in learning.search(self.request(params))['groups'] for card in group['items']]

    def course_detail(self, **params):
        return learning.course_detail(self.request(params), 'linalg')

    def review(self, *, published=True, offering=None, teacher=None, body='向量空间的学习方法'):
        data = {'rating': 4, 'body': body, 'term': '2026 秋', 'courseId': 'linalg',
                'courseName': '线性代数', 'anonymous': True, 'tags': ['讲解清楚']}
        return CourseReview.objects.create(author=self.bob, offering=None if teacher else offering or self.offering,
            teacher=teacher, state='published' if published else 'pending',
            public_revision=1 if published else 0, published=data if published else {},
            draft=dict(data, body='仅审核员可见的修改内容'), published_at=timezone.now() if published else None)

    def test_search_never_exposes_drafts_private_workspaces_or_unpublished_revisions(self):
        public = self.create_entry(draft={'title': 'PRIVATE-DRAFT-SECRET'}, state='pending',
                                   search_text='PRIVATE-INDEX-SECRET')
        self.create_entry(title='PRIVATE-PENDING-SECRET', public_revision=0)
        self.create_entry(title='PRIVATE-WITHDRAWN-SECRET', state='withdrawn')
        self.create_entry(title='PRIVATE-METADATA-SECRET', payload={'visibility': 'private'})
        Workspace.objects.create(owner=self.alice, kind='notes', title='PRIVATE-WORKSPACE-SECRET', data={'body': '线代'})
        for secret in ('PRIVATE-DRAFT', 'PRIVATE-INDEX', 'PRIVATE-PENDING', 'PRIVATE-WITHDRAWN', 'PRIVATE-METADATA', 'PRIVATE-WORKSPACE'):
            with self.subTest(secret=secret):
                self.assertEqual(learning.search(self.request({'q': secret}))['total'], 0)
        cards = self.cards(q='线代')
        self.assertIn(str(public.pk), [c['id'] for c in cards])
        self.assertNotIn('PRIVATE-', json.dumps(cards, ensure_ascii=False))

    def test_synonyms_and_exact_identifier_outrank_title_and_body(self):
        exact = self.create_entry(title='矩阵的教学资料')
        exact.slug = 'MATH-001'; exact.save()
        self.create_entry(title='MATH-001 课程随笔')
        rows = self.cards(q='math-001', type='resources')
        self.assertEqual(rows[0]['id'], str(exact.pk))
        self.assertEqual(rows[0]['match']['reason'], '编号精确匹配')
        for query in ('线代', 'linear algebra', '线性代数'):
            self.assertIn('course:linalg', [c['id'] for c in self.cards(q=query)])

    def test_exact_doi_normalization_and_bounded_candidate_priority(self):
        exact = self.create_entry(title='正式发表论文', kind='paper', payload={'doi': 'https://doi.org/10.1234/ABC'})
        for i in range(4):
            self.create_entry(title=f'提及 10.1234/ABC 的讨论 {i}', kind='paper')
        with patch.object(learning, 'MAX_CANDIDATES', 2):
            # candidate_rows's explicit default is stable; patch its bound too.
            original = learning.candidate_rows
            with patch.object(learning, 'candidate_rows', side_effect=lambda queryset: original(queryset, 2)):
                result = learning.search(self.request({'q': 'doi:10.1234/abc', 'type': 'papers'}))
        self.assertEqual(result['groups'][0]['items'][0]['id'], str(exact.pk))
        self.assertEqual(result['groups'][0]['items'][0]['match']['score'], 1000)

    def test_public_body_snippet_and_no_html_injection_by_server_interpolation(self):
        item = self.create_entry(title='一份笔记', payload={'body': '公开引言。' * 20 + '<script>向量空间</script>定义保留原文。'})
        rows = self.cards(q='向量空间', type='resources')
        card = next(c for c in rows if c['id'] == str(item.pk))
        self.assertEqual(card['match']['reason'], '公开正文匹配')
        self.assertIn('向量空间', card['snippet'])
        self.assertLessEqual(len(card['snippet']), 192)

    def test_school_filter_never_associates_foreign_same_named_course(self):
        foreign = self.create_entry(title='线性代数异校笔记', learning_meta={'school': 'cumt', 'courseId': 'linalg'})
        self.assertNotIn(str(foreign.pk), [c['id'] for c in self.cards(q='线代', school='cumtb')])
        rows = self.cards(q='线代', school='cumt')
        self.assertEqual([c['id'] for c in rows], [str(foreign.pk)])
        self.assertEqual(rows[0]['courseIds'], [])
        self.assertNotIn(str(foreign.pk), [c['id'] for c in self.course_detail()['resources']])
        with self.assertRaises(Problem) as error:
            self.course_detail(school='cumt')
        self.assertEqual(error.exception.status, 404)

    def test_course_relationships_require_exact_ids_not_names_or_substrings(self):
        exact = self.create_entry(title='准确课程资料', payload={'courses': ['linalg']})
        for name in ('线性代数', 'prefix-linalg-suffix', 'linalg-b'):
            self.create_entry(title='同名不应合并', payload={'courses': [name], 'course': '线性代数'})
        self.create_entry(title='名称本身不代表关联')
        result = self.course_detail()
        entries = [c['id'] for c in result['resources'] if not c['id'].startswith('course-resource:')]
        self.assertEqual(entries, [str(exact.pk)])
        self.assertEqual(result['offerings'][0]['id'], str(self.offering.pk))

    def test_fuzzy_candidates_do_not_require_literal_sql_match_and_keep_private_data_hidden(self):
        target = self.create_entry(title='Python 笔记', learning_meta={'courseId': 'linalg', 'access': 'public'})
        self.create_entry(title='Python 私人笔记', payload={'visibility': 'private'})
        self.create_entry(title='Python 审核笔记', public_revision=0)
        self.create_entry(title='公开其他资料', draft={'title': 'Python 草稿'})
        rows = self.cards(q='pyhton', type='resources')
        self.assertEqual([item['id'] for item in rows], [str(target.pk)])
        self.assertEqual(rows[0]['match']['reason'], '近似关键词匹配')
        self.assertEqual(self.cards(q='pyhton', course='linalg-b', type='resources'), [])

    def test_fuzzy_aliases_and_close_chinese_subsequences_preserve_versions(self):
        for version in ['1', '2']:
            self.create_entry(title='计算机科学', canonical_key='same-source',
                learning_meta={'courseId': 'linalg', 'version': version})
        rows = self.cards(q='cs', type='resources')
        self.assertEqual({row['version'] for row in rows}, {'1', '2'})
        self.create_entry(title='大学物理')
        self.assertEqual(len(self.cards(q='大物理', type='resources')), 1)

    def test_fuzzy_candidate_window_reports_truncation_and_keeps_exact_identifier_first(self):
        exact = self.create_entry(title='较早的资料')
        exact.slug = 'PYTHON101'; exact.save()
        for index in range(3):
            self.create_entry(title='Python newer ' + str(index))
        original = learning.candidate_rows
        with patch.object(learning, 'candidate_rows', side_effect=lambda queryset: original(queryset, 2)):
            result = learning.search(self.request({'q': 'PYTHON101', 'type': 'resources'}))
        self.assertEqual(result['groups'][0]['items'][0]['id'], str(exact.pk))
        self.assertTrue(result['truncated'])
        self.assertTrue(result['totalIsLowerBound'])
        self.assertEqual(self.cards(q='PYTHON102', type='resources'), [])

    def test_filters_and_missing_metadata_are_explicit(self):
        item = self.create_entry(learning_meta={'school': 'cumtb', 'courseId': 'linalg',
            'offeringId': str(self.offering.pk), 'term': 'ignored stale metadata', 'version': '教材第 2 版',
            'access': 'campus', 'checkedAt': '2026-09-10', 'materialType': 'notes'})
        rows = self.cards(type='resources', course='linalg', term='2026 秋', faculty='理学院',
                          access='campus', materialType='notes', after='2026-09-01', before='2026-09-30')
        self.assertEqual([c['id'] for c in rows], [str(item.pk)])
        self.assertEqual(rows[0]['term'], '2026 秋')
        self.assertEqual(rows[0]['version'], '教材第 2 版')
        self.assertEqual(rows[0]['missingMetadata'], [])
        self.assertEqual(self.cards(course='linalg', access='paid'), [])
        unknown = self.create_entry(title='未知适用范围')
        card = next(c for c in self.cards(q='未知适用范围') if c['id'] == str(unknown.pk))
        self.assertTrue({'school', 'courseId', 'term', 'version', 'checkedAt', 'access'} <= set(card['missingMetadata']))
        self.assertIsNone(card['checkedAt'])

    def test_canonical_dedup_preserves_distinct_versions_terms_and_states(self):
        common = {'school': 'cumtb', 'courseId': 'linalg', 'version': '第 1 版', 'term': '2026 秋'}
        source = {'links': {'source': 'https://example.edu/shared'}}
        original = self.create_entry(learning_meta=common, canonical_key='doi:10.1/shared', payload=source)
        self.create_entry(learning_meta=common, canonical_key='doi:10.1/shared', canonical=original, payload=source)
        self.create_entry(learning_meta=dict(common, version='第 2 版'), canonical_key='doi:10.1/shared', canonical=original, payload=source)
        self.create_entry(learning_meta=dict(common, term='2025 秋'), canonical_key='doi:10.1/shared', canonical=original, payload=source)
        self.create_entry(learning_meta=dict(common, publicationStatus='retracted'), canonical_key='doi:10.1/shared', canonical=original, payload=source)
        rows = [c for c in self.cards(q='线代', type='resources', limit=24) if not c['id'].startswith('course-resource:')]
        self.assertEqual(len(rows), 4)

    def test_legacy_canonical_collision_never_merges_distinct_resource_paths(self):
        paths = ['https://example.edu/notes', 'https://example.edu/notes/', 'https://example.edu/notes.git']
        for source in paths:
            self.create_entry(title='不同来源路径的资料', canonical_key='resource:https://example.edu/notes',
                learning_meta={'courseId': 'linalg', 'version': '第 1 版'}, payload={'links': {'source': source}})
        rows = self.cards(q='不同来源路径的资料', type='resources')
        self.assertEqual(len(rows), 3)
        self.assertEqual({row['sourceUrl'] for row in rows}, set(paths))

    def test_project_repository_aliases_can_still_share_canonical_identity(self):
        for source in ['https://github.com/test/repo', 'https://github.com/test/repo.git']:
            self.create_entry(title='同一个开源仓库', kind='project', canonical_key='project:https://github.com/test/repo',
                              payload={'links': {'repo': source}})
        self.assertEqual(len(self.cards(q='同一个开源仓库', type='tools')), 1)

    def test_scoped_canonical_duplicate_is_not_hidden_when_canonical_is_withdrawn(self):
        original = self.create_entry(state='withdrawn', canonical_key='shared')
        visible = self.create_entry(canonical_key='shared', canonical=original)
        self.assertEqual([c['id'] for c in self.cards(q='线代', type='resources')
                          if not c['id'].startswith('course-resource:')], [str(visible.pk)])

    def test_offering_review_preserves_anonymity_pending_snapshot_and_course_stats(self):
        review = self.review()
        review.state = 'pending'; review.save()
        self.review(teacher=self.teacher, body='教师评价不计课程评分')
        result = self.course_detail()
        self.assertEqual(result['stats']['count'], 1)
        self.assertEqual(result['stats']['average'], 4)
        self.assertEqual(result['counts']['experiences'], 2)
        serialized = json.dumps(result, default=str, ensure_ascii=False)
        self.assertNotIn('anonymous-real-identity', serialized)
        self.assertNotIn('private@example.test', serialized)
        self.assertNotIn('仅审核员可见', serialized)
        self.assertIn('向量空间的学习方法', serialized)
        self.assertEqual(self.course_detail(term='2025 秋')['stats']['count'], 0)

    def test_inactive_or_unpublished_reviews_are_not_public(self):
        review = self.review(published=False)
        self.assertEqual(self.course_detail()['experiences'], [])
        review.public_revision = 1; review.published = review.draft; review.save()
        self.offering.active = False; self.offering.save()
        self.assertEqual(self.course_detail()['experiences'], [])

    def test_questions_link_course_and_only_approved_answers(self):
        question = self.create_entry(title='矩阵如何求秩', kind='topic',
            learning_meta={'courseId': 'linalg', 'school': 'cumtb', 'materialType': 'question'})
        Reply.objects.create(entry=question, author=self.alice, body='秘密待审核答案', state='pending', accepted=True)
        public = Reply.objects.create(entry=question, author=self.alice, body='公开消元步骤', state='published', accepted=True)
        result = self.course_detail()['questions'][0]
        self.assertEqual(result['answerCount'], 1)
        self.assertEqual(result['acceptedAnswer'], {'id': str(public.pk), 'body': '公开消元步骤'})
        self.assertEqual(result['href'], f'course.html?id=linalg&question={question.pk}')
        self.assertNotIn('秘密', json.dumps(result, ensure_ascii=False))

    def test_search_finds_accepted_public_answers_without_leaking_other_replies(self):
        question = self.create_entry(title='如何判断这个集合', kind='topic', learning_meta={'courseId': 'linalg'})
        answer = Reply.objects.create(entry=question, author=self.alice, body='子空间判定需要检查加法和数乘封闭性。',
                                      state='published', accepted=True)
        rows = self.cards(q='子空间判定', type='questions')
        self.assertEqual([c['id'] for c in rows], [str(question.pk)])
        self.assertEqual(rows[0]['acceptedAnswerId'], str(answer.pk))
        self.assertEqual(rows[0]['match']['reason'], '已采纳的公开回答匹配')
        self.assertIn('子空间判定', rows[0]['snippet'])
        for status, accepted, secret in [('pending', True, '待审秘密'), ('rejected', True, '撤回秘密'),
                                         ('published', False, '未采纳回答')]:
            Reply.objects.create(entry=question, author=self.alice, body=secret, state=status, accepted=accepted)
            self.assertEqual(self.cards(q=secret, type='questions'), [])
        question.state = 'withdrawn'; question.save()
        self.assertEqual(self.cards(q='子空间判定', type='questions'), [])

    def test_accepted_answer_cannot_expose_private_or_draft_parent(self):
        for extra in ({'public_revision': 0}, {'payload': {'visibility': 'private'}},
                      {'payload': {'circle': {'board': 'closed', 'visibility': 'public'}}}):
            question = self.create_entry(kind='topic', **extra)
            Reply.objects.create(entry=question, author=self.alice, body='隔离答案关键词', state='published', accepted=True)
        self.assertEqual(self.cards(q='隔离答案关键词', type='questions'), [])

    def test_hidden_boards_are_not_searchable(self):
        for visibility, board in [('public', 'closed'), ('private', 'courses')]:
            self.create_entry(title='隐藏主题', kind='topic', payload={'circle': {'visibility': visibility, 'board': board}})
        self.assertEqual(self.cards(q='隐藏主题'), [])

    def test_circle_search_and_course_alert_keep_original_discussion_route(self):
        CourseFollow.objects.create(user=self.alice, course=self.course)
        entry = self.create_entry(title='线代学习交流', kind='topic', learning_meta={'courseId': 'linalg'},
            payload={'circle': {'visibility': 'public', 'board': 'courses'}})
        row = next(c for c in self.cards(q='线代') if c['id'] == str(entry.pk))
        self.assertEqual(row['href'], f'circle.html?post={entry.pk}')
        learning_follow.on_entry_publish(entry)
        notice = Notification.objects.get(user=self.alice)
        self.assertEqual(learning_follow.notification_action(notice, self.alice)['href'], row['href'])

    def test_group_pagination_facets_and_invalid_filters(self):
        for i in range(5):
            self.create_entry(title=f'线性代数第 {i} 份笔记', learning_meta={'courseId': 'linalg', 'access': 'public', 'term': '2026 秋'})
        first = learning.search(self.request({'q': '线代', 'type': 'resources', 'limit': 2}))
        second = learning.search(self.request({'q': '线代', 'type': 'resources', 'limit': 2, 'offset': 2}))
        self.assertEqual(len(first['groups'][0]['items']), 2)
        self.assertEqual(first['nextOffset'], 2)
        self.assertFalse({c['id'] for c in first['groups'][0]['items']} & {c['id'] for c in second['groups'][0]['items']})
        self.assertIn({'value': '2026 秋', 'label': '2026 秋', 'count': 5}, first['facets']['terms'])
        self.assertIn('courses', first['facets'])
        for bad in ({'type': 'private'}, {'access': 'any'}, {'limit': 'invalid'}, {'after': 'yesterday'}, {'after': '2026-1-1'},
                    {'school': '../secret'}, {'q': 'a' * 161}, {'after': '2026-10-01', 'before': '2026-09-01'}):
            with self.subTest(bad=bad), self.assertRaises(Problem):
                learning.search(self.request(bad))
        self.assertEqual(learning.search(self.request({'limit': 99999}))['limit'], 24)

    def test_catalogue_ids_remain_stable_and_do_not_mix_same_named_courses(self):
        result = learning.get(self.request({'q': '线代', 'limit': 24}), 'learning/courses')
        self.assertEqual({c['id'] for c in result['items']}, {'linalg', 'linalg-b'})
        self.assertEqual(result['total'], 2)
        self.assertEqual(learning.get(self.request({'school': 'cumt'}), 'learning/courses')['items'], [])
        with self.assertRaises(Problem):
            learning.course_detail(self.request(), '线性代数')

    def test_validate_metadata_enforces_real_course_offering_term_and_school(self):
        data = learning.validate_learning({'courseId': 'linalg', 'offeringId': str(self.offering.pk),
            'materialType': 'notes', 'access': 'public', 'checkedAt': '2026-09-01'})
        self.assertEqual((data['school'], data['term'], data['faculty']), ('cumtb', '2026 秋', '理学院'))
        for bad in ({'courseId': '线性代数'}, {'courseId': 'linalg', 'school': 'cumt'},
                    {'offeringId': str(self.offering.pk)}, {'courseId': 'linalg', 'offeringId': str(self.other_offering.pk)},
                    {'courseId': 'linalg', 'offeringId': 'bad-id'},
                    {'courseId': 'linalg', 'offeringId': str(self.offering.pk), 'term': '2020 秋'},
                    {'access': 'anything'}, {'sourceUrl': 'javascript:alert(1)'}, {'checkedAt': '2999-01-01'},
                    {'checkedAt': '2026-02-30'}, {'materialType': 'invented'}):
            with self.subTest(bad=bad), self.assertRaises(Problem):
                learning.validate_learning(bad)

    def test_follow_requires_login_verification_and_is_idempotent(self):
        anonymous = learning_follow.get(self.request(), 'linalg')
        self.assertEqual(anonymous, {'courseId': 'linalg', 'following': False, 'requiresLogin': True})
        with self.assertRaises(Problem) as error:
            learning_follow.set_follow(self.request(), 'linalg', {'enabled': True})
        self.assertEqual(error.exception.status, 401)
        for _ in range(2):
            result = learning_follow.set_follow(self.request(user=self.alice), 'linalg', {'enabled': True})
            self.assertTrue(result['following'])
        self.assertEqual(CourseFollow.objects.count(), 1)
        self.assertFalse(learning_follow.get(self.request(user=self.bob), 'linalg')['following'])
        learning_follow.set_follow(self.request(user=self.alice), 'linalg', {'enabled': False})
        self.assertEqual(CourseFollow.objects.count(), 0)
        with self.assertRaises(Problem):
            learning_follow.set_follow(self.request(user=self.alice), 'linalg', {'enabled': 'yes'})

    def test_only_exact_course_followers_receive_public_material_updates_once(self):
        CourseFollow.objects.create(user=self.alice, course=self.course)
        CourseFollow.objects.create(user=self.bob, course=self.course)
        private = self.create_entry(public_revision=0, learning_meta={'courseId': 'linalg'})
        foreign = self.create_entry(learning_meta={'courseId': 'linalg', 'school': 'cumt'})
        other = self.create_entry(payload={'courses': ['linalg-b', '线性代数']})
        for item in (private, foreign, other):
            learning_follow.on_entry_publish(item)
        self.assertEqual(Notification.objects.count(), 0)
        public = self.create_entry(learning_meta={'courseId': 'linalg', 'school': 'cumtb'})
        learning_follow.on_entry_publish(public)
        learning_follow.on_entry_publish(public)
        notification = Notification.objects.get()
        self.assertEqual((notification.user_id, notification.entry_id), (self.alice.pk, public.pk))
        self.assertTrue(notification.subscription)
        CourseFollow.objects.filter(user=self.alice).delete()
        another = self.create_entry(learning_meta={'courseId': 'linalg'})
        learning_follow.on_entry_publish(another)
        self.assertEqual(Notification.objects.count(), 1)

    def test_review_notification_never_exposes_anonymous_author_or_draft(self):
        CourseFollow.objects.create(user=self.alice, course=self.course)
        review = self.review()
        for _ in range(2):
            learning_follow.on_review_publish(review)
        note = Notification.objects.get()
        self.assertEqual(note.event, 'learning-review')
        self.assertIsNone(note.entry_id)
        self.assertNotIn('anonymous-real-identity', note.text)
        self.assertNotIn('仅审核员可见', note.text)
        self.assertEqual(note.key, f'learning:review:{review.pk}:1:linalg')
        self.review(teacher=self.teacher)
        learning_follow.on_review_publish(CourseReview.objects.get(teacher=self.teacher))
        self.assertEqual(Notification.objects.count(), 1)

    def test_help_and_readonly_catalogue_do_not_create_records(self):
        before = (Entry.objects.count(), Notification.objects.count(), CourseFollow.objects.count())
        learning.get(self.request({'q': '线代'}), 'learning/search')
        learning.get(self.request(), 'learning/courses')
        learning.get(self.request(), 'learning/courses/linalg')
        learning.get(self.request(), 'learning/courses/linalg/follow')
        self.assertEqual(before, (Entry.objects.count(), Notification.objects.count(), CourseFollow.objects.count()))

    def test_http_publication_validates_metadata_preserves_draft_boundary_and_notifies(self):
        author, reader, moderator = Client(), Client(), Client()
        author.force_login(self.bob); reader.force_login(self.alice)
        staff = Member.objects.create(username='learning-reviewer', email='moderator@example.test',
                                      email_verified=True, is_staff=True)
        moderator.force_login(staff)
        def post(client, route, body, status=200):
            response = client.post('/api/hub/' + route, json.dumps(body), content_type='application/json')
            self.assertEqual(response.status_code, status, response.content)
            return response.json()
        post(reader, 'learning/courses/linalg/follow', {'enabled': True})
        data = {'title': '已核对的矩阵笔记', 'summary': '公开说明', 'body': '向量方法',
                'license': 'CC BY 4.0', 'rightsConfirmed': True, 'links': {'source': 'https://example.edu/matrices'},
                'learning': {'school': 'cumtb', 'courseId': 'linalg', 'materialType': 'notes',
                             'access': 'public', 'version': '第 1 版', 'checkedAt': '2026-09-01'}}
        post(author, 'entries', {'kind': 'resource', 'data': dict(data, learning={'courseId': 'nonexistent'})}, 400)
        self.assertEqual(Entry.objects.count(), 0)
        saved = post(author, 'entries', {'kind': 'resource', 'data': data})
        self.assertEqual(saved['draft']['learning']['courseId'], 'linalg')
        self.assertEqual(Client().get('/api/hub/learning/search', {'q': data['title']}).json()['total'], 0)
        post(author, f'entries/{saved["id"]}/submit', {'revision': 1})
        post(moderator, f'entries/{saved["id"]}/review', {'revision': 1, 'decision': 'approve', 'note': '核对公开来源与版本'})
        response = Client().get('/api/hub/learning/search', {'q': data['title']})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()['total'], 1)
        self.assertEqual(Notification.objects.filter(user=self.alice, event='learning').count(), 1)
        post(author, f'entries/{saved["id"]}/save', {'revision': 1, 'data': dict(data, title='私有的新修订标题')})
        self.assertEqual(Client().get('/api/hub/learning/search', {'q': '私有的新修订标题'}).json()['total'], 0)
        self.assertEqual(Client().get('/api/hub/learning/search', {'q': data['title']}).json()['total'], 1)

    def test_notification_links_recheck_stored_relations_and_public_visibility(self):
        from .notifications import inbox
        CourseFollow.objects.create(user=self.alice, course=self.course)
        question = self.create_entry(title='学习问题', kind='topic', learning_meta={'courseId': 'linalg'})
        learning_follow.on_entry_publish(question)
        review = self.review()
        learning_follow.on_review_publish(review)
        items = inbox(self.alice)['items']
        by_event = {item['event']: item for item in items}
        self.assertEqual(by_event['learning']['action']['href'], f'course.html?id=linalg&question={question.pk}')
        self.assertEqual(by_event['learning-review']['action']['href'], f'reputation.html?offering={self.offering.pk}#review-{review.pk}')
        question.state = 'withdrawn'; question.save()
        review.state = 'withdrawn'; review.save()
        for item in inbox(self.alice)['items']:
            self.assertIsNone(item['action']['href'])
            self.assertEqual(item['action']['status'], 'unavailable')
            self.assertNotIn('学习问题', item['text'])
        fake = Notification.objects.create(user=self.alice, event='learning-review',
            key=f'learning:review:{review.pk}:1:linalg-b', text='https://evil.example 假更新')
        self.assertIsNone(learning_follow.notification_action(fake, self.alice)['href'])

    def test_digest_honors_course_follow_cancellation_and_withdrawal(self):
        from .worker import digest
        self.alice.digest_enabled = True; self.alice.save()
        following = CourseFollow.objects.create(user=self.alice, course=self.course)
        item = self.create_entry(learning_meta={'courseId': 'linalg'})
        learning_follow.on_entry_publish(item)
        with patch('hub.worker.send_mail') as send:
            self.assertEqual(digest(self.alice.pk)['count'], 1)
            send.assert_called_once()
        item.public_revision = 2; item.save()
        learning_follow.on_entry_publish(item)
        following.delete()
        with patch('hub.worker.send_mail') as send:
            self.assertEqual(digest(self.alice.pk)['reason'], 'empty')
            send.assert_not_called()
        CourseFollow.objects.create(user=self.alice, course=self.course)
        item.state = 'withdrawn'; item.save()
        with patch('hub.worker.send_mail') as send:
            self.assertEqual(digest(self.alice.pk)['reason'], 'empty')
            send.assert_not_called()

    def test_digest_includes_public_review_without_entry_watch(self):
        from .worker import digest
        self.alice.digest_enabled = True; self.alice.save()
        CourseFollow.objects.create(user=self.alice, course=self.course)
        learning_follow.on_review_publish(self.review())
        with patch('hub.worker.send_mail') as send:
            self.assertEqual(digest(self.alice.pk)['count'], 1)
            self.assertIn('公开课程体验', send.call_args.args[1])
            self.assertNotIn('anonymous-real-identity', send.call_args.args[1])

    def test_learning_question_reply_notification_opens_exact_answer(self):
        from .notifications import content_action
        question = self.create_entry(kind='topic', learning_meta={'courseId': 'linalg', 'materialType': 'question'})
        answer = Reply.objects.create(entry=question, author=self.alice, body='公开答案', state='published')
        notice = Notification.objects.create(user=self.bob, entry=question, event='reply', key=f'reply:{answer.pk}', text='收到回答')
        self.assertEqual(content_action(notice, self.bob)['href'], f'course.html?id=linalg&question={question.pk}#reply-{answer.pk}')

    def test_source_rss_namespaces_and_missing_structure(self):
        from .discovery import parse_source
        raw = b'''<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
        <item><title>Public resource</title><link>https://example.edu/resource</link></item></rdf:RDF>'''
        parsed = parse_source(raw, 'rss', 'https://example.edu/feed')
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]['url'], 'https://example.edu/resource')
        with self.assertRaises(Problem):
            parse_source(b'<rss/>', 'rss', 'https://example.edu/feed')

    def test_source_url_change_resets_old_conditional_headers_and_health(self):
        self.alice.is_staff = True; self.alice.save()
        self.client.force_login(self.alice)
        now = timezone.now()
        source = Source.objects.create(name='原始来源', url='https://example.edu/old', kind='rss',
            etag='old-etag', modified='old-modified', fingerprint='old-fingerprint',
            last_success=now, last_attempt=now, metadata={'school': 'cumtb'})
        ExternalCache.objects.create(key='source-health:' + str(source.pk), data={'status': 'updated'})
        response = self.client.post('/api/hub/sources', json.dumps({'id': str(source.pk), 'name': '变更来源',
            'url': 'https://example.edu/new', 'kind': 'rss', 'entryKind': 'news'}), content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        source.refresh_from_db()
        self.assertEqual((source.etag, source.modified, source.fingerprint), ('', '', ''))
        self.assertIsNone(source.last_success)
        self.assertIsNone(source.last_attempt)
        self.assertFalse(ExternalCache.objects.filter(key='source-health:' + str(source.pk)).exists())
        self.assertEqual(source.metadata, {'school': 'cumtb'})
