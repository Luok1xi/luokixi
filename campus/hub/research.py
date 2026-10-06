"""Private research notes, source-linked plans and portable personal records."""
import json
import re
from django.db import transaction
from .core import Problem, entry_for, public_entries, require, string_list, text, url
from .models import Star, Workspace

WORKSPACE_KINDS = {'reading','comparison','plan','workflow','personal-import'}


def validate_workspace(user, kind, data):
    if kind not in WORKSPACE_KINDS or not isinstance(data,dict) or len(json.dumps(data))>200000:
        raise Problem('工作区类型或内容无效。')
    # User text is stored as data; clients render with textContent, never raw HTML.
    if kind in {'reading','comparison'}:
        references = data.get('references',[])
        if not isinstance(references,list) or len(references)>100:
            raise Problem('最多添加 100 条文献。')
        cleaned = []
        for item in references:
            if not isinstance(item,dict):
                raise Problem('文献格式无效。')
            entry_id = text(item.get('entry',''),36)
            if entry_id:
                entry_for(user,entry_id)
            cleaned.append({'entry':entry_id,'title':text(item.get('title',''),300,True),
                'authors':text(item.get('authors',''),500),'year':text(item.get('year',''),20),
                'doi':text(item.get('doi',''),200),'url':url(item.get('url','')),
                'method':text(item.get('method',''),5000),'limitations':text(item.get('limitations',''),5000),
                'note':text(item.get('note',''),12000),'page':text(str(item.get('page','')),30),
                'quotation':text(item.get('quotation',''),4000)})
        return {'references':cleaned,'notes':text(data.get('notes',''),30000)}
    if kind in {'plan','workflow'}:
        steps = data.get('steps',[])
        if not isinstance(steps,list) or len(steps)>100:
            raise Problem('计划步骤过多。')
        result = dict(data)
        for step in steps:
            if not isinstance(step,dict):
                raise Problem('步骤格式不正确。')
            text(step.get('title',''),200,True)
            if step.get('state','todo') not in ('todo','doing','done'):
                raise Problem('步骤状态无效。')
            if step.get('evidence'):
                url(step['evidence'])
        return result
    return data


@transaction.atomic
def save_workspace(user, body, identifier=None):
    require(user)
    w = None
    if identifier:
        w = Workspace.objects.select_for_update().filter(owner=user,pk=identifier).first()
        if not w:
            raise Problem('工作区不存在。',404)
        if body.get('version') != w.version:
            raise Problem('工作区已改变，请刷新后重试。',409)
    kind = body.get('kind',w.kind if w else '')
    title = text(body.get('title',''),160,True)
    data = validate_workspace(user,kind,body.get('data'))
    if w:
        w.kind,w.title,w.data,w.version = kind,title,data,w.version+1
        w.save()
    else:
        w = Workspace.objects.create(owner=user,kind=kind,title=title,data=data)
    return w


TRACKS = {
 'employment': [('建立岗位能力清单','resource'),('完成一组基础练习','resource'),('做一个可演示的项目','project'),('整理作品与面试复盘','project')],
 'research': [('补齐方向基础','resource'),('阅读并比较关键论文','paper'),('复现一个公开方法','reproduction'),('整理实验记录与下一步问题','paper')],
 'competition': [('核对参赛资格与赛程','contest'),('完成必备知识练习','resource'),('组队并做最小可用作品','project'),('对照规则测试并准备提交','contest')],
}


def create_plan(user, body):
    require(user)
    goal = body.get('goal')
    if goal not in TRACKS:
        raise Problem('请选择就业、读研或竞赛目标。')
    hours, weeks = int(body.get('weeklyHours',6)), int(body.get('weeks',8))
    if not 1<=hours<=60 or not 4<=weeks<=52:
        raise Problem('每周时间应为 1–60 小时，计划长度为 4–52 周。')
    topic = text(body.get('topic',''),160,True)
    baseline = text(body.get('baseline',''),1000)
    candidates = public_entries()
    terms = topic.split()[:6]
    resources = [e for e in candidates if any(t.lower() in e.search_text.lower() for t in terms)]
    steps = []
    for i,(title,kind) in enumerate(TRACKS[goal]):
        selected = [e for e in resources if e.kind==kind][:3]
        start, end = i*weeks//4+1, (i+1)*weeks//4
        steps.append({'title':title,'startWeek':start,'endWeek':end,'hours':hours*(end-start+1),
                      'state':'todo','resources':[{'entry':str(e.pk),'title':e.published['title']} for e in selected],
                      'reason':f'围绕“{topic}”，先完成本阶段成果，再进入下一阶段。',
                      'availability':'matched' if selected else '需要补充经核对的资料', 'evidence':''})
    return Workspace.objects.create(owner=user,kind='plan',title=topic+' · 成长计划',
        data={'goal':goal,'topic':topic,'baseline':baseline,'weeklyHours':hours,'weeks':weeks,'steps':steps,
              'notice':'这是可调整的行动草案；参赛资格、升学要求以官方通知为准。'})


def bibliography(user, workspace):
    if workspace.kind not in ('reading','comparison'):
        raise Problem('此工作区没有文献列表。')
    def escape(value):
        return re.sub(r'[\\{}\x00-\x1f]',' ',str(value))
    records = []
    for i,ref in enumerate(workspace.data.get('references',[])):
        fields = [('title',ref['title']),('author',ref.get('authors','')),('year',ref.get('year','')),
                  ('doi',ref.get('doi','')),('url',ref.get('url',''))]
        records.append('@misc{luokixi'+str(i+1)+',\n'+',\n'.join(f'  {key} = {{{escape(value)}}}' for key,value in fields if value)+'\n}')
    return '\n\n'.join(records)


@transaction.atomic
def restore(user, body):
    require(user)
    if body.get('schema')!='luokixi-personal-v1' or body.get('confirmed') is not True:
        raise Problem('请确认将个人备份导入当前账号。')
    workspaces, stars = body.get('workspaces',[]), body.get('stars',[])
    if not isinstance(workspaces,list) or len(workspaces)>100 or not isinstance(stars,list) or len(stars)>500:
        raise Problem('备份条数超过上限。')
    restored = 0
    for item in workspaces:
        data = validate_workspace(user,item.get('kind'),item.get('data'))
        title = text(item.get('title',''),160,True)
        # Never trust a backup's owner or primary key. Do not overwrite existing work.
        if not Workspace.objects.filter(owner=user,kind=item['kind'],title=title,data=data).exists():
            Workspace.objects.create(owner=user,kind=item['kind'],title=title,data=data)
            restored += 1
    for item in stars:
        entry = public_entries().filter(pk=item.get('entry_id')).first()
        if entry:
            Star.objects.get_or_create(user=user,entry=entry,defaults={'collection':text(item.get('collection','默认收藏'),80,True)})
    return {'restored':restored}
