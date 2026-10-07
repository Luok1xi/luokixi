"""One-project-at-a-time discovery with explicit preferences and source-linked checklists."""
import secrets
from django.core import signing
from .core import Problem, require, string_list, text
from .models import Entry, ExternalCache, FeedFeedback, Star, Watch, Workspace


def cards(request):
    cursor = request.GET.get('cursor','')
    shelf = request.GET.get('shelf','all')
    if shelf not in ('all','practical','creative','potential'):
        raise Problem('精选分类无效。')
    if cursor:
        try:
            info = signing.loads(cursor,salt='hub.feed',max_age=3600)
            snapshot = request.session.get('feed_snapshot',{})
            if snapshot.get('id')!=info['snapshot']:
                raise ValueError()
            keys, offset = snapshot['keys'],info['offset']
        except (signing.BadSignature,KeyError,ValueError):
            raise Problem('这轮浏览已结束，请刷新发现页。',409)
    else:
        candidates = []
        ignored = set(FeedFeedback.objects.filter(user=request.user,action='not-interested').values_list('repository',flat=True)) if request.user.is_authenticated else set()
        for cache in ExternalCache.objects.filter(key__startswith='github:'):
            selection = cache.data.get('selection') or {}
            if selection.get('shelf') not in ('practical','creative','potential') or selection.get('needsRecheck'):
                continue
            if shelf!='all' and selection['shelf']!=shelf:
                continue
            if cache.data.get('repository') in ignored:
                continue
            candidates.append(cache)
        candidates.sort(key=lambda c:(c.data['selection']['reviewedAt'],c.key),reverse=True)
        keys, offset = [c.key for c in candidates[:200]],0
        snapshot = {'id':secrets.token_urlsafe(16),'keys':keys}
        request.session['feed_snapshot'] = snapshot
    result = []
    media_cache = ExternalCache.objects.filter(pk='maint:project-media').first()
    pictures = media_cache.data.get('items',{}) if media_cache else {}
    for key in keys[offset:offset+8]:
        cache = ExternalCache.objects.filter(pk=key).first()
        if not cache:
            continue
        data = cache.data
        selection = data.get('selection') or {}
        if selection.get('shelf')=='unlisted' or selection.get('needsRecheck'):
            continue
        guide = data.get('guide',{})
        reviewed = guide.get('reviewState')=='reviewed'
        entry = Entry.objects.filter(pk=data.get('entryId'),public_revision__gt=0).exclude(state='withdrawn').first() if data.get('entryId') else None
        result.append({'repository':data['repository'],'entryId':str(entry.pk) if entry else None,
            'cover':pictures.get(data['repository'],{}).get('image',''),
            'coverCredit':pictures.get(data['repository'],{}).get('credit',''),
            'category':(data.get('discovery') or {}).get('category','software'),
            'title':data['repository'].split('/')[-1],
            'idea':guide.get('oneLiner') if reviewed else data.get('description',''),
            'ideaLanguage':'zh' if reviewed else 'original',
            'guideState':guide.get('reviewState','unavailable'),
            'sections':guide.get('sections',[]) if reviewed else [],
            'unknowns':guide.get('unknowns',[]) if reviewed else ['中文 AI 导读尚未完成核对，请查看项目原文。'],
            'whyRecommended':selection.get('reason',''),'shelf':selection['shelf'],
            'repositoryUrl':data['url'],'downloads':data.get('downloads',[]),'readmeUrl':data.get('readmeUrl'),
            'releaseUrl':data.get('releaseUrl'),'license':data.get('license'),'credit':data.get('credit'),
            'githubStars':data.get('stars'),'siteStars':entry.star_set.count() if entry else 0,
            'views':entry.entryview_set.count() if entry else None,
            'replyCount':entry.reply_set.filter(state='published').count() if entry else None,
            'starred':bool(entry and request.user.is_authenticated and Star.objects.filter(entry=entry,user=request.user).exists()),
            'media':{'type':'project-card','notice':'项目图文导读；不是实机演示视频。'},
            'evidence':data.get('evidence',[]),'verifiedAt':data.get('verifiedAt'),
            'tested':selection.get('tested',False),'testEvidence':selection.get('testEvidence','')})
    next_cursor = signing.dumps({'snapshot':snapshot['id'],'offset':offset+8},salt='hub.feed') if offset+8<len(keys) else None
    return {'items':result,'nextCursor':next_cursor,'total':len(keys),
            'ranking':'维护者精选，按核对时间排列；不以停留时长和刷播放量排序。'}


def feedback(user, body):
    require(user)
    from .github_guides import repository,cache_key
    repo = repository(body.get('repository',''))
    if not ExternalCache.objects.filter(pk=cache_key(repo)).exists():
        raise Problem('项目不存在。',404)
    action = body.get('action')
    if action not in ('interested','not-interested','clear'):
        raise Problem('反馈类型无效。')
    if action=='clear':
        FeedFeedback.objects.filter(user=user,repository=repo).delete()
    else:
        FeedFeedback.objects.update_or_create(user=user,repository=repo,defaults={'action':action})
    return {'ok':True}


def workflow(user, body):
    require(user)
    from .github_guides import repository,cache_key
    goal = text(body.get('goal',''),500,True)
    repos = string_list(body.get('repositories',[]),5,250)
    if not repos:
        raise Problem('请先选择 1–5 个项目。')
    projects,steps = [],[]
    for repo in repos:
        repo = repository(repo)
        cache = ExternalCache.objects.filter(pk=cache_key(repo)).first()
        if not cache or not cache.data.get('selection') or cache.data['selection'].get('shelf')=='unlisted':
            raise Problem('请从已核对的精选项目中选择。')
        data,guide = cache.data,cache.data.get('guide',{})
        if guide.get('reviewState')!='reviewed' or data['selection'].get('needsRecheck'):
            raise Problem('该项目的中文导读尚未核对，暂不能生成搭建清单。')
        projects.append({'repository':repo,'url':data['url'],'readmeSha':data.get('readmeSha'),
                         'downloads':data['downloads'],'license':data.get('license')})
        steps.append({'title':'确认 '+repo+' 是否符合你的需求','state':'todo','evidence':'',
                      'source':data['readmeUrl'],'instructions':guide['oneLiner'],'reason':'与你填写的目标逐项比较，不自动保证适配。'})
        for section in guide.get('sections',[]):
            steps.append({'title':section['heading'],'instructions':section['text'],'state':'todo','evidence':'',
                          'sources':[e for e in data['evidence'] if e['id'] in section['evidenceIds']],
                          'reason':'来自已核对的项目中文导读。'})
        steps.append({'title':'验证最小示例并记录结果','state':'todo','evidence':'','source':data['readmeUrl'],
                      'instructions':'按原项目说明完成最小示例，记录版本、环境、结果与失败信息。'})
    return Workspace.objects.create(owner=user,kind='workflow',title=goal[:150],data={
        'goal':goal,'projects':projects,'steps':steps,'notice':'这是搭建清单；不会自动下载或执行代码。多个项目的兼容性需要验证。'})
