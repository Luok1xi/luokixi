"""Build reviewed metadata only; never copy private course PDFs into public output."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKED = '2026-10-06'
SOURCE = 'https://jwc.cumtb.edu.cn/info/1144/4813.htm'
school = json.loads((ROOT/'public/data/school.json').read_text(encoding='utf-8'))
courses = []
for item in school['courses']:
    courses.append(dict(item,faculty=None,scope='campus-catalogue',verifiedCourseCode=None,
        resourceIds=[x['id'] for x in school['papers'] if x['course']==item['id']],sourceUrl=None,
        sourceNote='依据已有资料目录；原卷仅限本机，开课学院和官方课程代码待核。',
        checkedAt=CHECKED,materialAccess='local-only'))
for cid,name,subject in [
    ('physics','大学物理','physics'),('chemistry','大学化学','chemistry'),
    ('probability','概率论与数理统计','mathematics'),('college-english','大学英语','english'),
    ('cet4','英语四级','english'),('cet6','英语六级','english'),
    ('ielts-academic','雅思 Academic','english'),('ielts-general','雅思 General Training','english'),
    ('programming','程序设计','computing'),('data-structures','数据结构与算法','computing')]:
    ielts = cid.startswith('ielts')
    courses.append(dict(id=cid,name=name,subject=subject,faculty=None,scope='learning-topic',
        verifiedCourseCode=None,resourceIds=[],
        sourceUrl='https://ielts.org/take-a-test/preparation-resources/sample-test-questions' if ielts else None,
        sourceNote='官方样题入口；本站未转载试题，也不提供官方成绩。' if ielts else '按需求建立的学习专题，不代表已核对本校培养方案或拥有对应真题。',
        checkedAt=CHECKED,materialAccess='external-link' if ielts else 'awaiting-contributions'))
entries = [
    ('innovation','中国国际大学生创新大赛','各学院','research'),
    ('challenge','“挑战杯”全国大学生课外学术科技作品竞赛','各学院','research'),
    ('robot-ai','中国机器人及人工智能大赛','机械与电气工程学院','mech'),
    ('mechanical','全国大学生机械设计创新大赛','机械与电气工程学院','mech'),
    ('smartcar','全国大学生智能汽车竞赛','机械与电气工程学院','embedded'),
    ('engineering','中国大学生工程实践与创新能力大赛','机械与电气工程学院','mech'),
    ('siemens','“西门子杯”中国智能制造挑战赛','机械与电气工程学院','mech'),
    ('raicom','睿抗机器人开发者大赛（RAICOM）','机械与电气工程学院','mech'),
    ('robocup','中国机器人大赛暨RoboCup机器人世界杯中国赛','机械与电气工程学院','mech'),
    ('creative-robot','中国高校智能机器人创意大赛','机械与电气工程学院','mech'),
    ('electronics','北京市大学生电子设计竞赛','机械与电气工程学院','embedded'),
    ('computer-design','中国大学生计算机设计大赛','人工智能学院','software'),
    ('team-programming','中国高校计算机大赛—团体程序设计天梯赛','人工智能学院','algo'),
    ('lanqiao','蓝桥杯全国软件和信息技术专业人才大赛','人工智能学院','algo'),
    ('icpc','ACM-ICPC国际大学生程序设计竞赛','人工智能学院','algo'),
]
competitions = [dict(id=i,name=n,faculty=f,category=c,officialUrl=SOURCE,sourceUrl=SOURCE,
    sourceTitle='学校本科生学科竞赛名录（2024年）',catalogueYear=2024,checkedAt=CHECKED,
    currentEdition=None,deadline=None,registrationUrl=None,
    eligibility='具体年级、专业、组队限制待当届官方通知确认',status='catalogued-not-open',
    note='历史名录证明校内关联，不代表2026年正在报名或当前认定级别。') for i,n,f,c in entries]
for key,rows in [('courses',courses),('competitions',competitions)]:
    target = ROOT/'public/data'/f'{key}.json'
    target.write_text(json.dumps(dict(version=1,school=school['school'],checkedAt=CHECKED,**{key:rows}),
        ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(f'{key}: {len(rows)}')
