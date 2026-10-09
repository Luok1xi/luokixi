from django.test import Client, SimpleTestCase, TestCase
from django.utils import timezone

from .models import Member, Entry, CampusBoard, CirclePreference, BoardFollow
from .search_matching import normalize_search, text_score


class SearchMatchingTests(SimpleTestCase):
    def test_aliases_and_width_case_normalization(self):
        for query, title in [('线代', '线性代数复习'), ('高数', '高等数学'), ('ＣＥＴ－６', '英语六级答案'),
                             ('CS', '计算机科学'), ('embedded', '嵌入式开发'), ('日常', 'Daily notes')]:
            self.assertGreater(text_score(query, title), 0, (query, title))
        self.assertEqual(normalize_search(' Ｃ＋＋　入门 '), 'c++ 入门')

    def test_latin_one_edit_and_transposition(self):
        self.assertGreater(text_score('pyhton', 'Python 入门'), 0)
        self.assertGreater(text_score('embeddde', 'embedded workshop'), 0)
        self.assertEqual(text_score('pqythxn', 'Python 入门'), 0)

    def test_all_query_tokens_are_required(self):
        self.assertGreater(text_score('线代 矩阵', '线性代数', '矩阵运算讲义'), 0)
        self.assertEqual(text_score('线代 期末', '线性代数', '矩阵运算讲义'), 0)

    def test_exact_title_ranks_above_alias_and_body(self):
        self.assertGreater(text_score('线代', '线代'), text_score('线代', '线性代数'))
        self.assertGreater(text_score('线代', '线性代数'), text_score('线代', '笔记', '线性代数'))

    def test_never_correct_names_short_words_or_ids(self):
        for query, title in [('陈小明', '陈晓明'), ('CS', 'CSS'), ('ai', 'daily'), ('v1.2', 'v1.3'),
                             ('cet5', 'CET6'), ('calc-12', 'calc-13'), ('js', 'json')]:
            self.assertEqual(text_score(query, title), 0, (query, title))

    def test_empty_query_is_not_a_match(self):
        self.assertEqual(text_score(' ', 'anything'), 0)


class CircleSearchTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.author = Member.objects.create(username='search-author', email='search-author@example.test')
        cls.reader = Member.objects.create(username='search-reader', email='search-reader@example.test')
        CampusBoard.objects.create(id='makers', name='创作与开源')
        CampusBoard.objects.create(id='daily', name='校园日常')
        CampusBoard.objects.create(id='closed', name='已关闭', active=False)

    def post(self, title, *, board='makers', campus='all', state='published', public_revision=1,
             body='公开的实际经历', draft=None, search_text=''):
        payload = {'title': title, 'body': body, 'summary': body, 'tags': [], 'uploads': [],
                   'circle': {'board': board, 'campus': campus, 'format': 'moment',
                              'visibility': 'public', 'publishedAt': timezone.now().isoformat()}}
        return Entry.objects.create(owner=self.author, kind='topic', slug='search-' + str(Entry.objects.count()),
            state=state, public_revision=public_revision, published=payload if public_revision else {},
            draft=draft or payload, search_text=search_text)

    def feed(self, client=None, **params):
        response = (client or self.client).get('/api/hub/circle/feed', {'lane': 'latest', **params})
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_alias_and_typo_find_actual_published_posts(self):
        algebra = self.post('线性代数复习笔记')
        python = self.post('Python 工具制作')
        self.assertEqual([i['id'] for i in self.feed(q='线代')['items']], [str(algebra.pk)])
        self.assertEqual([i['id'] for i in self.feed(q='pyhton')['items']], [str(python.pk)])

    def test_unpublished_revisions_search_text_and_closed_boards_never_match(self):
        public = self.post('公开资料', draft={'title': '线性代数私有修订'}, search_text='线性代数私有修订')
        self.post('线性代数草稿', state='draft', public_revision=0)
        self.post('线性代数待审', state='pending', public_revision=0)
        self.post('线性代数撤回', state='withdrawn')
        self.post('线性代数关闭吧', board='closed')
        self.assertEqual(self.feed(q='线代')['items'], [])
        self.assertEqual([i['id'] for i in self.feed(q='公开资料')['items']], [str(public.pk)])

    def test_campus_board_following_and_mutes_remain_authoritative(self):
        north = self.post('Python 沙河经历', campus='shahe')
        south = self.post('Python 学院路经历', board='daily', campus='xueyuanlu')
        self.assertEqual([i['id'] for i in self.feed(q='pyhton', campus='shahe')['items']], [str(north.pk)])
        self.assertEqual([i['id'] for i in self.feed(q='pyhton', board='daily')['items']], [str(south.pk)])
        logged = Client()
        logged.force_login(self.reader)
        self.assertEqual(self.feed(logged, q='pyhton', lane='following')['items'], [])
        BoardFollow.objects.create(user=self.reader, board_id='daily')
        self.assertEqual([i['id'] for i in self.feed(logged, q='pyhton', lane='following')['items']], [str(south.pk)])
        CirclePreference.objects.create(user=self.reader, muted_creators=[self.author.username])
        self.assertEqual(self.feed(logged, q='pyhton')['items'], [])

    def test_recommended_search_orders_exact_title_first(self):
        exact = self.post('Python')
        self.post('如何安装 Python')
        self.assertEqual(self.feed(q='Python', lane='recommended')['items'][0]['id'], str(exact.pk))

    def test_cursor_rechecks_withdrawal_and_rejects_changed_query(self):
        entries = [self.post(f'Python 记录 {i}') for i in range(14)]
        first = self.feed(q='pyhton')
        self.assertEqual(len(first['items']), 12)
        displayed = {item['id'] for item in first['items']}
        remaining = [entry for entry in entries if str(entry.pk) not in displayed]
        Entry.objects.filter(pk=remaining[0].pk).update(state='withdrawn')
        second = self.feed(q='pyhton', cursor=first['nextCursor'])
        self.assertNotIn(str(remaining[0].pk), {item['id'] for item in second['items']})
        changed = self.client.get('/api/hub/circle/feed', {'lane': 'latest', 'q': 'Rust', 'cursor': first['nextCursor']})
        self.assertEqual(changed.status_code, 409)
