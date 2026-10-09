import base64
import hashlib
import json
import secrets
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import default_token_generator
from django.core import signing
from django.core.exceptions import ValidationError
from django.core.mail import send_mail
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.http import HttpResponseRedirect
from django.middleware.csrf import get_token
from django.utils.encoding import force_bytes, force_str
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from .models import Audit, Member
from .core import Problem, member_data, require, text, throttle, url, string_list


def capabilities():
    return {'emailDelivery': 'smtp' if settings.EMAIL_HOST else 'local-preview',
            'githubLogin': bool(settings.GITHUB_CLIENT_ID and settings.GITHUB_CLIENT_SECRET),
            'schoolVerification': 'manual', 'publicBrowsing': True, 'registration': True}


def session(request):
    if request.user.is_authenticated:
        from .interests import read_interests
        read_interests(request.user)
    return {'user':member_data(request.user, True) if request.user.is_authenticated else None,
            'csrfToken':get_token(request), 'capabilities':capabilities()}


def email_value(value):
    value = text(value, 254, True).lower()
    try:
        validate_email(value)
    except ValidationError:
        raise Problem('邮箱格式不正确。')
    return value


def check_password(password, member=None):
    password = text(password, 256, True)
    try:
        validate_password(password, member)
    except ValidationError as exc:
        raise Problem(' '.join(exc.messages))
    return password


def send_verification(member):
    token = signing.dumps({'id':member.pk,'email':member.email}, salt='hub.verify')
    link = settings.PUBLIC_ORIGIN + '/hub/#verify/' + token
    send_mail('验证你的 Luokixi 邮箱', '请在 24 小时内打开以下链接：\n'+link+'\n如果不是你申请的，请忽略。', settings.DEFAULT_FROM_EMAIL, [member.email])


def checked_display_name(value, user=None):
    import unicodedata
    name = text(value, 80)
    normalized = ''.join(unicodedata.normalize('NFKC', name).split())
    if normalized in ('北矿娘', '小煤渣', '煤渣'):
        import os
        configured = os.environ.get('HUB_COMPANION_MEMBER_ID', '')
        if not user or (user.username != '北矿娘' and str(user.pk) != configured and name != user.display_name):
            raise Problem('这个昵称属于本站角色，请换一个昵称。', 409)
    return name


def register(request, body):
    throttle('register', request.META.get('REMOTE_ADDR',''), 10)
    email = email_value(body.get('email',''))
    handle = text(body.get('username',''), 30, True)
    import re
    if not re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,29}', handle):
        raise Problem('用户名需为 3–30 位英文、数字、下划线、点或短横线。')
    member = Member(username=handle, email=email, display_name=checked_display_name(body.get('name','')) or handle)
    member.set_password(check_password(body.get('password',''), member))
    try:
        with transaction.atomic():
            member.full_clean(exclude=['password'])
            member.save()
    except (IntegrityError, ValidationError):
        raise Problem('无法使用此邮箱或用户名注册；已有账号可登录或找回密码。', 409)
    login(request, member, backend='django.contrib.auth.backends.ModelBackend')
    try:
        send_verification(member)
        mail = '邮件已发送。' if settings.EMAIL_HOST else '验证邮件已保存为本机预览，尚未向外发送。'
    except Exception:
        mail = '账号已创建，但邮件发送失败；可稍后重新发送。'
    Audit.objects.create(actor=member, action='register', target=str(member.pk))
    return dict(session(request), message=mail)


def sign_in(request, body):
    email = email_value(body.get('email',''))
    throttle('login-ip', request.META.get('REMOTE_ADDR',''), 80, 900)
    throttle('login-account', email, 10, 900)
    member = Member.objects.filter(email__iexact=email).first()
    user = authenticate(request, username=member.username if member else email, password=text(body.get('password',''),256,True))
    if not user:
        raise Problem('邮箱或密码不正确。', 401)
    login(request, user)
    return session(request)


def reset_request(request, body):
    email = email_value(body.get('email',''))
    throttle('reset-ip', request.META.get('REMOTE_ADDR',''), 12)
    throttle('reset-email', email, 3)
    member = Member.objects.filter(email__iexact=email, is_active=True).first()
    if member and member.has_usable_password():
        uid = urlsafe_base64_encode(force_bytes(member.pk))
        token = default_token_generator.make_token(member)
        link = settings.PUBLIC_ORIGIN + '/hub/#reset/' + uid + '/' + token
        try:
            send_mail('重置 Luokixi 密码', '请在一小时内打开：\n'+link+'\n忽略此邮件不会更改你的密码。', settings.DEFAULT_FROM_EMAIL, [member.email])
        except Exception:
            pass  # Same public response whether account exists or SMTP fails.
    return {'message':'如果账号存在且可重置，系统会生成重置邮件。', **capabilities()}


def reset_confirm(request, body):
    throttle('reset-confirm', request.META.get('REMOTE_ADDR',''), 20)
    try:
        member = Member.objects.get(pk=force_str(urlsafe_base64_decode(text(body.get('uid',''),30,True))))
    except (ValueError, Member.DoesNotExist, TypeError, UnicodeDecodeError):
        raise Problem('重置链接无效或已过期。')
    if not default_token_generator.check_token(member, text(body.get('token',''),150,True)):
        raise Problem('重置链接无效或已过期。')
    member.set_password(check_password(body.get('password',''), member))
    member.save(update_fields=['password'])
    logout(request)
    Audit.objects.create(actor=member, action='password-reset', target=str(member.pk))
    return {'message':'密码已重置，请重新登录。', 'csrfToken':get_token(request)}


def verify(request, body):
    throttle('verify', request.META.get('REMOTE_ADDR',''), 30)
    try:
        data = signing.loads(text(body.get('token',''),500,True), salt='hub.verify', max_age=86400)
        member = Member.objects.get(pk=data['id'], email=data['email'], is_active=True)
    except (signing.BadSignature, Member.DoesNotExist, KeyError):
        raise Problem('验证链接无效或已过期。')
    member.email_verified = True
    member.save(update_fields=['email_verified'])
    return {'message':'邮箱验证成功。', **session(request)}


@transaction.atomic
def profile(request, body):
    require(request.user)
    user = request.user
    for key, limit in [('display_name',80),('bio',2000),('major',80)]:
        if key in body:
            setattr(user, key, checked_display_name(body[key], user) if key == 'display_name' else text(body[key], limit))
    if 'externalLinks' in body:
        links = body['externalLinks']
        if not isinstance(links, dict) or len(links)>8:
            raise Problem('外部账号格式不正确。')
        user.external_links = {text(k,30,True):url(v) for k,v in links.items()}
    if 'digestEnabled' in body:
        if not isinstance(body['digestEnabled'],bool):
            raise Problem('订阅设置需为布尔值。')
        user.digest_enabled = body['digestEnabled']
    if 'preferences' in body:
        value = body['preferences']
        if not isinstance(value,dict):
            raise Problem('兴趣设置应为对象。')
        # Optional, self-declared and private. This never grants verified campus status.
        from .interests import read_interests
        read_interests(user)
        preferences = dict(user.preferences)
        preferences.update({key:text(value[key],80) for key in ('faculty','year','campus') if key in value})
        preferences.update({key:string_list(value[key],12,80) for key in ('goals','interests','courses') if key in value})
        if not value:
            # Preserve the documented explicit reset while treating non-empty payloads as partial updates.
            preferences = {'faculty': '', 'year': '', 'campus': '', 'goals': [], 'interests': [], 'courses': []}
        user.preferences = preferences
    user.save(update_fields=['display_name','bio','major','external_links','digest_enabled','preferences'])
    if 'preferences' in body and ('interests' in body['preferences'] or not body['preferences']):
        from .interests import save_interests
        save_interests(user, user.preferences['interests'])
        request.session.pop('circle_snapshot', None)
    return session(request)


def github_request(endpoint, token=None, form=None):
    headers = {'Accept':'application/json', 'User-Agent':'Luokixi-Community'}
    if token:
        headers['Authorization'] = 'Bearer '+token
    req = Request(endpoint, headers=headers, data=urlencode(form).encode() if form else None)
    with urlopen(req, timeout=15) as response:
        return json.loads(response.read(2*1024*1024))


def github_start(request):
    if not capabilities()['githubLogin']:
        raise Problem('站点尚未配置 GitHub 登录，可先使用邮箱注册。', 503)
    state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(64)
    request.session['github_oauth'] = {'state':state,'verifier':verifier,'created':time.time(),
                                      'link_user':request.user.pk if request.user.is_authenticated else None}
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    params = {'client_id':settings.GITHUB_CLIENT_ID,'redirect_uri':settings.PUBLIC_ORIGIN+'/api/hub/auth/github/callback',
              'scope':'read:user user:email','state':state,'code_challenge':challenge,'code_challenge_method':'S256'}
    return HttpResponseRedirect('https://github.com/login/oauth/authorize?'+urlencode(params))


def github_callback(request):
    stored = request.session.pop('github_oauth', None)
    if not stored or time.time()-stored['created']>600 or not secrets.compare_digest(stored['state'],request.GET.get('state','')):
        raise Problem('GitHub 登录会话无效或已过期，请重试。', 403)
    token = github_request('https://github.com/login/oauth/access_token', form={
        'client_id':settings.GITHUB_CLIENT_ID,'client_secret':settings.GITHUB_CLIENT_SECRET,
        'code':text(request.GET.get('code',''),300,True), 'code_verifier':stored['verifier'],
        'redirect_uri':settings.PUBLIC_ORIGIN+'/api/hub/auth/github/callback'})
    access = token.get('access_token')
    if not access:
        raise Problem('GitHub 授权未完成。', 400)
    info = github_request('https://api.github.com/user', access)
    emails = github_request('https://api.github.com/user/emails', access)
    verified = sorted([e for e in emails if e.get('verified')], key=lambda e:not e.get('primary'))
    if not verified:
        raise Problem('请先在 GitHub 验证邮箱。')
    gid, email = str(info['id']), email_value(verified[0]['email'])
    with transaction.atomic():
        user = Member.objects.filter(github_id=gid).first()
        if stored['link_user']:
            require(request.user, verified=True)
            if request.user.pk != stored['link_user'] or (user and user.pk != request.user.pk):
                raise Problem('GitHub 账号已绑定或登录会话已改变。', 409)
            user = request.user
            user.github_id = gid
            user.save(update_fields=['github_id'])
        elif not user:
            if Member.objects.filter(email__iexact=email).exists():
                raise Problem('此邮箱已有账号，请先用密码登录，再连接 GitHub。', 409)
            handle = 'gh_'+gid
            user = Member(username=handle,email=email,email_verified=True,github_id=gid,
                          display_name=str(info.get('name') or info['login'])[:80])
            user.set_unusable_password()
            user.save()
        if not user.is_active:
            raise Problem('账号已停用。',403)
        user.external_links = dict(user.external_links, github=info['html_url'])
        user.save(update_fields=['external_links'])
    login(request,user,backend='django.contrib.auth.backends.ModelBackend')
    return HttpResponseRedirect('/hub/#me')
