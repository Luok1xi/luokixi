"""Self-hostable settings. Private library files are never exposed by this service."""
import os
import secrets
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get('HUB_DATA_DIR', BASE / '.data' / 'hub'))
DATA.mkdir(parents=True, exist_ok=True)
PUBLIC_ORIGIN = os.environ.get('HUB_PUBLIC_ORIGIN', 'http://127.0.0.1:17860').rstrip('/')
PRODUCTION = os.environ.get('HUB_PRODUCTION') == '1'
SECRET_KEY = os.environ.get('HUB_SECRET_KEY', '')
if not SECRET_KEY:
    if PRODUCTION:
        raise RuntimeError('HUB_SECRET_KEY is required in production')
    secret_file = DATA / 'secret.key'
    try:
        with secret_file.open('x', encoding='utf-8') as f:
            f.write(secrets.token_urlsafe(64))
    except FileExistsError:
        pass
    SECRET_KEY = secret_file.read_text(encoding='utf-8')
DEBUG = False
if PRODUCTION and not os.environ.get('HUB_ALLOWED_HOSTS'):
    raise RuntimeError('HUB_ALLOWED_HOSTS is required in production')
ALLOWED_HOSTS = os.environ.get('HUB_ALLOWED_HOSTS', '127.0.0.1,localhost,testserver').split(',')
if PRODUCTION and not PUBLIC_ORIGIN.startswith('https://'):
    raise RuntimeError('HUB_PUBLIC_ORIGIN must use HTTPS in production')
# Enable only when a controlled reverse proxy overwrites this header.
if os.environ.get('HUB_TRUST_PROXY') == '1':
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
ROOT_URLCONF = 'hub.urls'
INSTALLED_APPS = ['unfold', 'django.contrib.admin', 'django.contrib.auth', 'django.contrib.contenttypes',
                  'django.contrib.sessions', 'django.contrib.messages', 'django.contrib.staticfiles', 'hub']
MIDDLEWARE = ['django.middleware.security.SecurityMiddleware', 'django.contrib.sessions.middleware.SessionMiddleware',
              'django.middleware.common.CommonMiddleware', 'django.middleware.csrf.CsrfViewMiddleware',
              'django.contrib.auth.middleware.AuthenticationMiddleware', 'django.contrib.messages.middleware.MessageMiddleware',
              'django.middleware.clickjacking.XFrameOptionsMiddleware']
DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': DATA / 'community.sqlite3',
                         'OPTIONS': {'timeout': 30, 'transaction_mode': 'IMMEDIATE'}}}
AUTH_USER_MODEL = 'hub.Member'
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator', 'OPTIONS': {'min_length': 12}},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]
PASSWORD_HASHERS = ['django.contrib.auth.hashers.ScryptPasswordHasher', 'django.contrib.auth.hashers.PBKDF2PasswordHasher']
TIME_ZONE = 'Asia/Shanghai'
USE_TZ = True
LANGUAGE_CODE = 'zh-hans'
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
TEMPLATES = [{'BACKEND': 'django.template.backends.django.DjangoTemplates', 'APP_DIRS': True,
              'OPTIONS': {'context_processors': ['django.template.context_processors.request',
                  'django.contrib.auth.context_processors.auth', 'django.contrib.messages.context_processors.messages']}}]
STATIC_URL = '/manage-assets/'
STATIC_ROOT = DATA / 'manage-assets'
UNFOLD = {'SITE_TITLE': 'Luokixi 管理中心', 'SITE_HEADER': '内容管理', 'SITE_URL': '/',
          'SHOW_HISTORY': True, 'SHOW_VIEW_ON_SITE': True}
SESSION_COOKIE_NAME = 'luokixi_session'
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Lax'
SESSION_COOKIE_SECURE = PRODUCTION
SESSION_COOKIE_AGE = 7 * 86400
CSRF_COOKIE_NAME = 'luokixi_csrf'
CSRF_COOKIE_SAMESITE = 'Lax'
CSRF_COOKIE_SECURE = PRODUCTION
CSRF_TRUSTED_ORIGINS = [PUBLIC_ORIGIN]
if not PRODUCTION:
    CSRF_TRUSTED_ORIGINS += ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://localhost:17860']
CSRF_FAILURE_VIEW = 'hub.api.csrf_failure'
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = 'no-referrer'
SECURE_SSL_REDIRECT = PRODUCTION
SECURE_HSTS_SECONDS = 31536000 if PRODUCTION else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = PRODUCTION
SECURE_HSTS_PRELOAD = PRODUCTION
X_FRAME_OPTIONS = 'DENY'
DATA_UPLOAD_MAX_MEMORY_SIZE = 26 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 1024 * 1024
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MEDIA_ROOT = DATA / 'uploads'
EMAIL_HOST = os.environ.get('HUB_SMTP_HOST', '')
EMAIL_PORT = int(os.environ.get('HUB_SMTP_PORT', '587'))
EMAIL_HOST_USER = os.environ.get('HUB_SMTP_USER', '')
EMAIL_HOST_PASSWORD = os.environ.get('HUB_SMTP_PASSWORD', '')
EMAIL_USE_TLS = True
EMAIL_TIMEOUT = 15
DEFAULT_FROM_EMAIL = os.environ.get('HUB_FROM_EMAIL', 'Luokixi <noreply@localhost>')
EMAIL_BACKEND = ('django.core.mail.backends.smtp.EmailBackend' if EMAIL_HOST else 'django.core.mail.backends.filebased.EmailBackend')
EMAIL_FILE_PATH = DATA / 'mail-preview'
GITHUB_CLIENT_ID = os.environ.get('HUB_GITHUB_CLIENT_ID', '')
GITHUB_CLIENT_SECRET = os.environ.get('HUB_GITHUB_CLIENT_SECRET', '')
PASSWORD_RESET_TIMEOUT = 3600
APPEND_SLASH = False
