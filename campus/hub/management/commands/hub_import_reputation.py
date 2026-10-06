"""Import sourced catalogue metadata only; never seed accounts, scores or comments."""
import json
import uuid
from pathlib import Path
from django.core.management.base import BaseCommand
from django.db import transaction
from hub.models import GuideCourse, Teacher


class Command(BaseCommand):
    help = 'Import known local course IDs and a small, sourced teacher catalogue; never overwrite edited records.'

    @transaction.atomic
    def handle(self, *args, **options):
        root = Path(__file__).resolve().parents[4]
        catalogue = json.loads((root / 'public/data/courses.json').read_text(encoding='utf-8'))
        added_courses = added_teachers = 0
        for course in catalogue['courses']:
            ielts = course['id'].startswith('ielts-')
            resource = {
                'title': 'IELTS 官方样题与备考入口' if ielts else '中国大学 MOOC · 查找外部课程',
                'url': 'https://ielts.org/take-a-test/preparation-resources/sample-test-questions' if ielts else 'https://www.icourse163.org/',
                'type': '官方样题' if ielts else '外部课程平台',
                'audience': '准备了解雅思题型的同学' if ielts else '根据课程简介与先修要求，自行选择适合的课程',
                'cost': 'free' if ielts else 'unknown', 'checkedAt': '2026-10-06',
            }
            _, created = GuideCourse.objects.get_or_create(pk=course['id'], defaults={
                'name': course['name'], 'faculty': course.get('faculty') or '',
                'scope': 'campus-catalogue' if course['scope'] == 'campus-catalogue' else 'general-topic',
                'source_url': course.get('sourceUrl') or '', 'resources': [resource],
            })
            added_courses += created
        profiles = [
            ('张孟霞', '副教授', 'https://lxy.cumtb.edu.cn/info/1067/1196.htm', ['高等数学', '线性代数']),
            ('刘兰冬', '副教授', 'https://lxy.cumtb.edu.cn/info/1067/1195.htm', ['数值分析', '数值分析课程设计', '矩阵计算（双语）']),
            ('刘菊', '讲师', 'https://lxy.cumtb.edu.cn/info/1067/1214.htm', []),
        ]
        for name, title, source, teaching in profiles:
            _, created = Teacher.objects.get_or_create(pk=uuid.uuid5(uuid.NAMESPACE_URL, source), defaults={
                'name': name, 'faculty': '理学院', 'title': title, 'source_url': source,
                'teaching': [{'name': course, 'sourceUrl': source} for course in teaching],
                # Public page photographs do not by themselves establish reuse permission.
                'photo': {},
            })
            added_teachers += created
        self.stdout.write(f'Imported {added_courses} course/topic records and {added_teachers} sourced teachers. No ratings, photos or term-specific teaching assignments were fabricated.')
