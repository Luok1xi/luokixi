import json
from django.contrib.auth.models import Permission
from django.test import Client, TestCase
from .models import (Member, Teacher, GuideCourse, CourseOffering, CourseReview, CourseReviewLike,
                     CourseReviewReply, Audit, Notification)


class ReputationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = Member.objects.create_user('private_reviewer', 'a@example.com', 'Quartz-river-tests-983', email_verified=True)
        cls.bob = Member.objects.create_user('other_reviewer', 'b@example.com', 'Quartz-river-tests-984', email_verified=True)
        cls.mod = Member.objects.create_user('review_mod', 'm@example.com', 'Quartz-river-tests-985', email_verified=True, is_staff=True)
        cls.teacher = Teacher.objects.create(name='验收教师（测试）', faculty='测试学院', source_url='https://example.edu/teacher')
        cls.course = GuideCourse.objects.create(id='calculus-test', name='验收课程')
        cls.offering = CourseOffering.objects.create(course=cls.course, term='2026 秋', campus='shahe', source_url='https://example.edu/course')
        cls.offering.teachers.add(cls.teacher)

    def setUp(self):
        self.a, self.b, self.m, self.anon = [Client() for _ in range(4)]
        for client, user in ((self.a, self.alice), (self.b, self.bob), (self.m, self.mod)):
            client.force_login(user)

    def post(self, client, route, body=None, status=200):
        res = client.post('/api/hub/' + route, json.dumps(body or {}), content_type='application/json')
        self.assertEqual(res.status_code, status, res.content)
        return res.json()

    def get(self, client, route, status=200):
        res = client.get('/api/hub/' + route)
        self.assertEqual(res.status_code, status, res.content)
        return res.json()

    def submit(self, client=None, rating=4, anonymous=True, offering=False, body='讲解有帮助。\n作业反馈还可以更及时。'):
        return self.post(client or self.a, 'reviews', {'subjectType': 'offering' if offering else 'teacher',
            'subjectId': str(self.offering.pk if offering else self.teacher.pk),
            'data': {'rating': rating, 'body': body, 'anonymous': anonymous, 'courseId': self.course.pk, 'term': '2026 秋'}})

    def publish(self, review):
        return self.post(self.m, f'reviews/{review["id"]}/moderate',
            {'revision': review['revision'], 'decision': 'approve', 'note': '核对为课程体验，无需内容立场一致。'})

    def teacher(self):
        return self.get(self.anon, 'teachers/' + str(type(self).teacher.pk))

    def test_ratings_separate_unique_and_unrated_not_zero(self):
        teacher_id = str(type(self).teacher.pk)
        self.assertIsNone(self.get(self.anon, 'teachers/' + teacher_id)['stats']['average'])
        a = self.submit(rating=5)
        self.assertEqual(self.get(self.anon, 'teachers/' + teacher_id)['stats']['count'], 0)
        self.publish(a)
        self.publish(self.submit(self.b, rating=4))
        self.publish(self.submit(rating=1, offering=True))
        data = self.get(self.anon, 'teachers/' + teacher_id)
        self.assertEqual(data['stats']['average'], 4.5)
        self.assertEqual(data['stats']['count'], 2)
        self.assertTrue(data['stats']['smallSample'])
        self.assertEqual(self.get(self.anon, 'offerings/' + str(self.offering.pk))['stats']['average'], 1)
        self.post(self.a, 'reviews', {'subjectType': 'teacher', 'subjectId': teacher_id,
            'data': {'rating': 3, 'body': '重复评价'}}, 409)

    def test_quote_likes_revision_and_withdrawal(self):
        original = '原文：“难，但是讲得清楚。”\n<script>不要执行</script>'
        a = self.submit(body=original)
        self.publish(a)
        b = self.submit(self.b)
        self.publish(b)
        route = 'teachers/' + str(type(self).teacher.pk)
        self.assertEqual(self.get(self.anon, route)['highlight']['id'], b['id'])
        for _ in range(2):
            self.post(self.b, f'reviews/{a["id"]}/like', {'enabled': True})
        top = self.get(self.anon, route)['highlight']
        self.assertEqual((top['id'], top['body'], top['likes'], top['label']), (a['id'], original, 1, '高赞评论'))
        self.post(self.b, f'reviews/{a["id"]}/like', {'enabled': False})
        self.assertEqual(self.get(self.anon, route)['highlight']['id'], b['id'])
        self.post(self.b, f'reviews/{a["id"]}/like', {'enabled': True})
        changed = self.post(self.a, f'reviews/{a["id"]}/save',
            {'revision': 1, 'data': {'rating': 2, 'body': '新版本需重新获得点赞。', 'anonymous': True}})
        self.assertEqual(self.get(self.anon, route)['highlight']['body'], original)
        self.publish(changed)
        self.assertEqual(CourseReviewLike.objects.filter(review_id=a['id']).count(), 0)
        self.post(self.a, f'reviews/{a["id"]}/withdraw', {'reason': '作者撤回'})
        self.assertEqual(self.get(self.anon, route)['highlight']['id'], b['id'])
        self.get(self.anon, f'reviews/{a["id"]}', 404)

    def test_anonymity_across_public_surfaces_and_trace_audit(self):
        a = self.submit()
        self.publish(a)
        reply = self.post(self.a, f'reviews/{a["id"]}/replies', {'body': '补充说明', 'anonymous': False})
        self.post(self.m, f'review-replies/{reply["id"]}/moderate', {'decision': 'approve', 'note': '允许补充'})
        routes = ['teachers', 'reviews?q=讲解', f'reviews/{a["id"]}', 'members/private_reviewer',
                  'contributions', 'catalogue']
        for route in routes:
            data = self.get(self.anon, route)
            if route.startswith('members/'):
                self.assertEqual(data['entries'], [])
            else:
                self.assertNotIn('private_reviewer', json.dumps(data))
                self.assertNotIn('a@example.com', json.dumps(data))
        for data in self.get(self.m, 'reviews/moderation').values():
            self.assertNotIn('private_reviewer', json.dumps(data))
        self.post(self.m, f'reviews/{a["id"]}/trace', {'reason': '处理具体申诉'}, 403)
        self.mod.user_permissions.add(Permission.objects.get(codename='trace_review_author'))
        result = self.post(self.m, f'reviews/{a["id"]}/trace', {'reason': '处理具体申诉'})
        self.assertEqual(result['username'], self.alice.username)
        self.assertTrue(Audit.objects.filter(action='review-identity-access', target=a['id'], detail__reason='处理具体申诉').exists())
        self.assertFalse(Notification.objects.filter(text__contains='private_reviewer').exists())

    def test_named_to_anonymous_hides_old_signature_while_pending(self):
        a = self.submit(anonymous=False)
        self.publish(a)
        self.assertEqual(self.get(self.anon, f'reviews/{a["id"]}')['author']['username'], self.alice.username)
        self.post(self.a, f'reviews/{a["id"]}/save', {'revision': 1,
            'data': {'rating': 4, 'body': '改为匿名', 'anonymous': True}})
        self.assertNotIn('username', self.get(self.anon, f'reviews/{a["id"]}')['author'])

    def test_ownership_versions_verified_email_and_csrf(self):
        a = self.submit()
        self.get(self.b, f'reviews/{a["id"]}', 404)
        self.post(self.b, f'reviews/{a["id"]}/save', {'revision': 1, 'data': {'rating': 4, 'body': '越权'}}, 403)
        self.post(self.a, f'reviews/{a["id"]}/save', {'revision': 0, 'data': {'rating': 4, 'body': '旧版本'}}, 409)
        self.publish(a)
        self.post(self.a, f'reviews/{a["id"]}/like', {'enabled': True}, 400)
        self.post(self.anon, f'reviews/{a["id"]}/like', {'enabled': True}, 401)
        self.bob.email_verified = False
        self.bob.save()
        self.post(self.b, f'reviews/{a["id"]}/like', {'enabled': True}, 403)
        strict = Client(enforce_csrf_checks=True)
        strict.force_login(self.alice)
        self.post(strict, f'reviews/{a["id"]}/withdraw', {'reason': '无 CSRF'}, 403)

    def test_reject_appeal_report_and_resolution(self):
        a = self.submit()
        self.post(self.m, f'reviews/{a["id"]}/moderate', {'revision': 1, 'decision': 'reject', 'note': '请补充课程背景'})
        self.assertEqual(self.get(self.anon, 'reviews')['total'], 0)
        case = self.post(self.a, f'reviews/{a["id"]}/appeal', {'reason': '正文已有背景，申请复核'})
        self.post(self.b, f'reviews/{a["id"]}/appeal', {'reason': '他人申诉'}, 403)
        self.post(self.m, f'review-cases/{case["id"]}/resolve', {'resolution': '已说明补充方式'})
        self.assertEqual(self.get(self.a, 'reviews/mine')['cases'][0]['state'], 'resolved')
        self.assertEqual(self.get(self.b, 'reviews/mine')['cases'], [])
        revised = self.post(self.a, f'reviews/{a["id"]}/save', {'revision': 1,
            'data': {'rating': 2, 'body': '具体的负面体验也可以发表', 'anonymous': True}})
        self.publish(revised)
        self.post(self.b, f'reviews/{a["id"]}/report', {'reason': '请求核对背景'})
        self.assertEqual(self.get(self.m, 'reviews/moderation')['cases'][0]['kind'], 'report')

    def test_catalogue_permissions_photo_provenance_and_course_links(self):
        data = {'name': '资料测试', 'faculty': '测试学院', 'sourceUrl': 'https://example.edu/a', 'sourceChecked': True}
        self.post(self.a, 'teachers', data, 403)
        data['photo'] = {'url': 'https://example.edu/photo.jpg'}
        self.post(self.m, 'teachers', data, 400)
        data['photo'].update(rightsConfirmed=True, sourceUrl='https://example.edu/a', credit='照片由本人提供')
        teacher = self.post(self.m, 'teachers', data)
        self.assertEqual(self.get(self.anon, 'teachers/' + teacher['id'])['photo']['credit'], '照片由本人提供')
        resource = {'title': '外部课程', 'url': 'https://example.edu/learn', 'type': '辅导课程',
                    'audience': '具备高中数学基础', 'cost': 'unknown', 'checkedAt': '2026-10-06'}
        self.post(self.m, 'courses', {'id': 'external-test', 'name': '引导专题', 'scope': 'general-topic',
            'sourceChecked': True, 'resources': [resource]})
        self.assertEqual(self.get(self.anon, 'courses/external-test')['resources'][0]['cost'], 'unknown')
        self.post(self.m, 'offerings', {'courseId': 'external-test', 'teachers': [teacher['id']],
            'term': '2026 秋', 'campus': 'shahe', 'sourceUrl': 'https://example.edu/source', 'sourceChecked': True}, 400)

    def test_invalid_scores_cannot_modify_target_and_owner_cannot_moderate(self):
        for score in (0, 6, True, 4.5, '5'):
            self.post(self.a, 'reviews', {'subjectType': 'teacher', 'subjectId': str(type(self).teacher.pk),
                'data': {'rating': score, 'body': '参数测试'}}, 400)
        a = self.submit()
        self.post(self.a, f'reviews/{a["id"]}/save', {'revision': 1, 'subjectId': 'changed',
            'data': {'rating': 4, 'body': '变更对象'}}, 400)
        self.alice.is_staff = True
        self.alice.save()
        self.post(self.a, f'reviews/{a["id"]}/moderate', {'revision': 1, 'decision': 'approve', 'note': '自审'}, 403)
