"""Private, atomic site snapshots and isolated restore checks; never restore in place.

The archive contains private account data and the Django signing key. It must
never be placed under a web/static root or published with the source repository.
Model-provider configuration, API keys and email previews are not included.
"""
from __future__ import annotations

from contextlib import closing, contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import tempfile
import uuid
import zipfile

from django.conf import settings

FORMAT_VERSION = 1
TOOL = 'luokixi-private-backup'
NAME = re.compile(r'luokixi-backup-\d{8}T\d{6}Z-[a-f0-9]{12}\.zip\Z')
MAX_MEMBERS = 100_000
MAX_MANIFEST_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024
CHUNK = 1024 * 1024
EXCLUDED_NAMES = {'studio-config.json', 'modelconfig.json', 'model-config.json', '.env',
                  'api-key', 'api-key.txt', 'credentials.json', 'secrets.json', '.secrets',
                  'secret.key', 'developer-account.json', '.store.lock'}
LIBRARY_FILE_TYPES = {'.pdf', '.mp3', '.wav', '.txt', '.md', '.csv', '.png', '.jpg', '.jpeg',
                      '.webp', '.zip', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.epub'}
_VERIFIED_CACHE = {}


class BackupError(ValueError):
    """A safe explanation, without configuration contents or credential values."""


def _now():
    return datetime.now(timezone.utc).isoformat()


def _project_root():
    return Path(getattr(settings, 'BASE', Path(__file__).resolve().parents[1])).parent.absolute()


def _limit():
    try:
        value = int(os.environ.get('HUB_BACKUP_MAX_BYTES', DEFAULT_MAX_BYTES))
    except ValueError:
        raise BackupError('备份容量设置无效。') from None
    if value < 1024 or value > 64 * DEFAULT_MAX_BYTES:
        raise BackupError('备份容量设置超出范围。')
    return value


def _is_link(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def _no_links(path):
    """Reject Windows junctions as well as Unix/Windows symbolic links."""
    path = Path(path).absolute()
    for part in [*reversed(path.parents), path]:
        if part.exists() or part.is_symlink():
            if _is_link(part):
                raise BackupError('备份与恢复路径不能使用符号链接或目录联接。')
    return path


def _private_path(path):
    path = _no_links(path).resolve()
    project = _project_root().resolve()
    roots = [project, Path(settings.MEDIA_ROOT).resolve(), Path(settings.DATA).resolve()]
    static = os.environ.get('CAMPUS_STATIC_DIR')
    if static:
        roots.append(Path(static).resolve())
    for candidate in getattr(settings, 'STATICFILES_DIRS', []):
        roots.append(Path(candidate).resolve())
    if getattr(settings, 'STATIC_ROOT', None):
        roots.append(Path(settings.STATIC_ROOT).resolve())
    if any(path == root or path.is_relative_to(root) for root in roots):
        raise BackupError('请使用源码、数据库和网页公开目录之外的私有备份目录。')
    return path


def backup_root():
    default = (Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData' / 'Local')) /
               'Luokixi' / 'backups') if os.name == 'nt' else Path.home() / '.local' / 'share' / 'Luokixi' / 'backups'
    root = _private_path(os.environ.get('HUB_BACKUP_DIR', default))
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return root


@contextmanager
def _lock(root):
    lock_path = _no_links(root / '.luokixi-backup.lock')
    with lock_path.open('a+b') as handle:
        handle.seek(0)
        handle.write(b'0')
        handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise BackupError('已有备份或恢复检查正在执行，请稍后再试。') from None
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _sha_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _sqlite_info(path):
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=30)) as db:
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise BackupError('数据库完整性检查失败。')
        schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").fetchall()
        tables = [row[1] for row in schema if row[0] == 'table' and not row[1].startswith('sqlite_')]
        counts = {name: db.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in tables}
        migrations = db.execute('SELECT app,name FROM django_migrations ORDER BY app,name').fetchall() if 'django_migrations' in tables else []
        return {'schemaSha256': hashlib.sha256(json.dumps(schema, ensure_ascii=False).encode()).hexdigest(),
                'userVersion': db.execute('PRAGMA user_version').fetchone()[0],
                'tableCounts': counts, 'migrations': [list(row) for row in migrations]}


def _sqlite_copy(source, destination):
    source = _no_links(source).resolve()
    if not source.is_file():
        raise BackupError('数据库文件不存在，未创建备份。')
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=30)) as src:
        with closing(sqlite3.connect(destination)) as dst:
            src.backup(dst, pages=256, sleep=0.05)
            # A backup of a WAL-mode source inherits WAL mode. Make the isolated
            # copy self-contained before hashing; no transient -wal/-shm needed.
            dst.execute('PRAGMA journal_mode=DELETE')
    return _sqlite_info(destination)


def _safe_name(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value or '\x00' in value:
        raise BackupError('备份中包含无效路径。')
    parts = value.split('/')
    if any(p in ('', '.', '..') for p in parts) or PurePosixPath(value).is_absolute():
        raise BackupError('备份中包含无效路径。')
    if any(part != part.rstrip(' .') or re.fullmatch(r'(con|prn|aux|nul|com[1-9]|lpt[1-9])', part.split('.')[0], re.I) for part in parts):
        raise BackupError('备份中包含系统保留路径。')
    if value == 'manifest.json' or value in {'hub/community.sqlite3', 'hub/secret.key', 'library/library.sqlite3'}:
        return value
    if not any(value.startswith(prefix) for prefix in ('hub/uploads/', 'library/files/', 'public/files/')):
        raise BackupError('备份中包含未声明的数据范围。')
    if any(_sensitive_name(part) for part in parts):
        raise BackupError('备份不能包含模型配置或外部服务凭据文件。')
    return value


def _sensitive_name(name):
    name = name.lower()
    return name in EXCLUDED_NAMES or name.startswith('.env.')


def _copy_file(source, destination, budget):
    source = _no_links(source)
    if not source.is_file():
        raise BackupError('资料库引用的原文件不存在。')
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with source.open('rb') as src, destination.open('xb') as dst:
        while chunk := src.read(CHUNK):
            budget['used'] += len(chunk)
            if budget['used'] > _limit():
                raise BackupError('备份超过配置的容量限制。')
            dst.write(chunk)


def _copy_tree(source, destination, budget):
    source = _no_links(source).resolve()
    if not source.exists():
        return
    for parent, directories, files in os.walk(source, followlinks=False):
        parent = _no_links(parent)
        for name in directories:
            _no_links(parent / name)
        directories[:] = [name for name in directories if not _sensitive_name(name)]
        for name in files:
            candidate = _no_links(parent / name)
            if _sensitive_name(name) or name.endswith(('.part', '.tmp', '.lock')):
                continue
            if not candidate.is_file():
                raise BackupError('备份范围内出现非普通文件。')
            target = destination / candidate.relative_to(source)
            _copy_file(candidate, target, budget)


def _collect_library_originals(source_root, destination, budget):
    """Import actual legacy references, even when originals live outside .data.

    Read-only source; only the snapshot's file_path column is normalized. This
    includes user-imported PDF/audio in public/files or an original local folder.
    """
    path = destination / 'library.sqlite3'
    with closing(sqlite3.connect(path)) as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'documents' not in tables:
            return
        rows = db.execute("SELECT id,file_path,sha256 FROM documents WHERE file_path != ''").fetchall()
        for ident, value, expected in rows:
            original = Path(value)
            if not original.is_absolute():
                original = source_root / original
            original = _no_links(original).resolve()
            if _sensitive_name(original.name) or original.suffix.lower() not in LIBRARY_FILE_TYPES:
                raise BackupError('旧资料库原件类型不允许备份，请检查是否误导入敏感配置。')
            if not original.is_file():
                raise BackupError('旧资料库引用的原文件不存在。')
            try:
                relative = original.relative_to((source_root / 'files').resolve())
            except ValueError:
                digest = _sha_file(original)
                if expected and digest != expected:
                    raise BackupError('旧资料库原件 SHA-256 与记录不一致。')
                relative = Path(digest + original.suffix.lower())
            name = _safe_name('library/files/' + relative.as_posix())
            target = destination / 'files' / relative
            if not target.exists():
                _copy_file(original, target, budget)
            db.execute('UPDATE documents SET file_path=? WHERE id=?', ('files/' + relative.as_posix(), ident))
        db.commit()


def _referenced_files(hub_db, files, library_db=None, library_root=None):
    """Check every Asset/MirrorAsset, including assets with no Upload row."""
    with closing(sqlite3.connect(hub_db.as_uri() + '?mode=ro', uri=True)) as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'hub_member' not in tables or 'hub_entry' not in tables:
            raise BackupError('账号或社区数据缺失，无法作为全站备份。')
        for table, prefix in [('hub_asset', 'hub/uploads/'), ('hub_mirrorasset', 'hub/uploads/mirror/')]:
            if table not in tables:
                continue
            for path, digest, size in db.execute(f'SELECT path,sha256,size FROM {table}'):
                name = _safe_name(prefix + path)
                item = files.get(name)
                if not item or item['sha256'] != digest or item['bytes'] != size:
                    raise BackupError('账号数据库引用的附件或镜像缺失或已损坏。')
    if library_db and library_root:
        with closing(sqlite3.connect(library_db.as_uri() + '?mode=ro', uri=True)) as db:
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'documents' in tables:
                for path, digest in db.execute("SELECT file_path,sha256 FROM documents WHERE file_path != ''"):
                    candidate = Path(path)
                    if not candidate.is_absolute():
                        candidate = library_root / candidate
                    try:
                        relative = candidate.resolve().relative_to((library_root / 'files').resolve())
                    except ValueError:
                        raise BackupError('旧资料库引用了私有资料目录以外的文件。') from None
                    item = files.get(_safe_name('library/files/' + relative.as_posix()))
                    if not item or (digest and item['sha256'] != digest):
                        raise BackupError('旧资料库引用的原文件缺失或已损坏。')


def _manifest(path):
    try:
        with zipfile.ZipFile(path) as archive:
            info = archive.getinfo('manifest.json')
            if info.file_size > MAX_MANIFEST_BYTES:
                raise BackupError('备份清单过大。')
            data = json.loads(archive.read(info))
    except (OSError, KeyError, ValueError, zipfile.BadZipFile, RuntimeError):
        raise BackupError('备份包或清单无法读取。') from None
    if not isinstance(data, dict) or data.get('tool') != TOOL or data.get('formatVersion') != FORMAT_VERSION:
        raise BackupError('备份格式或版本不支持。')
    return data


def _summary(path, manifest):
    return {'id': path.name, 'createdAt': manifest['createdAt'], 'bytes': path.stat().st_size,
            'files': len(manifest['files']), 'formatVersion': manifest['formatVersion'],
            'scope': manifest['scope'], 'private': True, 'containsLoginSecret': True}


def _verified_receipt(path):
    """Hash once per unchanged archive/receipt, not gigabytes on every UI poll."""
    receipt = path.parent / (path.name + '.check.json')
    if not receipt.is_file() or _is_link(receipt):
        return None
    archive_stat, receipt_stat = path.stat(), receipt.stat()
    if receipt_stat.st_size > CHUNK:
        return None
    key = (str(path), archive_stat.st_size, archive_stat.st_mtime_ns,
           receipt_stat.st_size, receipt_stat.st_mtime_ns)
    if key in _VERIFIED_CACHE:
        return _VERIFIED_CACHE[key]
    verified = None
    try:
        check = json.loads(receipt.read_text(encoding='utf-8'))
        if (isinstance(check, dict) and check.get('ok') is True and check.get('backupId') == path.name
                and re.fullmatch('[a-f0-9]{64}', str(check.get('archiveSha256', '')))
                and check.get('verifiedAt') and check.get('verificationId')
                and check['archiveSha256'] == _sha_file(path)):
            verified = check
    except (OSError, ValueError, TypeError):
        pass
    if len(_VERIFIED_CACHE) > 256:
        _VERIFIED_CACHE.clear()
    _VERIFIED_CACHE[key] = verified
    return verified


def list_backups():
    results = []
    root = backup_root()
    for path in root.iterdir():
        if NAME.fullmatch(path.name) and not _is_link(path) and path.is_file():
            try:
                item = _summary(path, _manifest(path))
                item.update(verifiedOkay=False, verifiedAt=None, verificationId=None)
                check = _verified_receipt(path)
                if check:
                    item.update(verifiedOkay=True, verifiedAt=check['verifiedAt'], verificationId=check['verificationId'])
                results.append(item)
            except (BackupError, KeyError, TypeError):
                continue
    return sorted(results, key=lambda item: item['createdAt'], reverse=True)


def status():
    items = list_backups()
    checks = []
    for item in items:
        if not item['verifiedOkay']:
            continue
        check = _verified_receipt(backup_root() / item['id'])
        if check:
            checks.append(check)
    return {'items': items, 'latest': items[0] if items else None,
            'lastCheck': max(checks, key=lambda result: result.get('verifiedAt', ''), default=None),
            'private': True, 'defaultRetention': 7,
            'autoEnabled': os.environ.get('HUB_BACKUP_AUTO') == '1'}


def _inspect(path, destination=None):
    manifest = _manifest(path)
    declared = manifest.get('files')
    if not isinstance(declared, list) or not declared or len(declared) > MAX_MEMBERS:
        raise BackupError('备份文件清单无效。')
    files, folded = {}, set()
    for item in declared:
        if not isinstance(item, dict):
            raise BackupError('备份文件清单无效。')
        name = _safe_name(item.get('path'))
        if name == 'manifest.json' or name.casefold() in folded or not isinstance(item.get('bytes'), int) or item['bytes'] < 0:
            raise BackupError('备份清单包含重复或无效文件。')
        if not re.fullmatch('[a-f0-9]{64}', str(item.get('sha256', ''))):
            raise BackupError('备份文件校验值无效。')
        folded.add(name.casefold())
        files[name] = item
    if 'hub/community.sqlite3' not in files or 'hub/secret.key' not in files:
        raise BackupError('备份缺少账号数据库或登录签名密钥。')
    if sum(item['bytes'] for item in files.values()) > _limit():
        raise BackupError('备份展开大小超过容量限制。')
    scope = manifest.get('scope')
    if not isinstance(scope, dict) or bool(scope.get('library')) != ('library/library.sqlite3' in files):
        raise BackupError('备份声明范围与内容不一致。')
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(infos) > MAX_MEMBERS + 1 or len(set(names)) != len(names) or set(names) != {*files, 'manifest.json'}:
            raise BackupError('备份包有重复、未声明或缺失的文件。')
        for info in infos:
            _safe_name(info.filename)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode) or info.is_dir() or info.flag_bits & 1:
                raise BackupError('备份包不支持符号链接、目录条目或加密条目。')
            if info.filename == 'manifest.json':
                continue
            item = files[info.filename]
            if info.file_size != item['bytes'] or info.file_size > _limit():
                raise BackupError('备份文件大小与清单不一致。')
            if info.file_size > max(info.compress_size, 1) * 1000 and info.file_size > CHUNK:
                raise BackupError('备份压缩比异常，已停止恢复。')
            digest, actual = hashlib.sha256(), 0
            target = destination / info.filename if destination else None
            if target:
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            stream = target.open('xb') if target else None
            try:
                with archive.open(info) as source:
                    while chunk := source.read(CHUNK):
                        actual += len(chunk)
                        if actual > item['bytes']:
                            raise BackupError('备份展开大小与清单不一致。')
                        digest.update(chunk)
                        if stream:
                            stream.write(chunk)
            finally:
                if stream:
                    stream.close()
            if actual != item['bytes'] or digest.hexdigest() != item['sha256']:
                raise BackupError('备份文件 SHA-256 校验失败。')
    return manifest, files


def _backup_path(backup_id):
    if not isinstance(backup_id, str) or not NAME.fullmatch(backup_id):
        raise BackupError('备份编号无效。')
    root = backup_root()
    path = _no_links(root / backup_id)
    if path.parent.resolve() != root or not path.is_file():
        raise BackupError('备份不存在。')
    return path


def get_backup_path(backup_id):
    """Call only after owner authorization; prefer open_backup_file for downloads."""
    path = _backup_path(backup_id)
    _inspect(path)
    return path


@contextmanager
def open_backup(backup_id):
    """Verified open handle for download; avoids pathname reopen after verification."""
    root = backup_root()
    with _lock(root):
        path = _backup_path(backup_id)
        handle = path.open('rb')
        try:
            # Validate the same opened inode/handle that is sent to the owner.
            _inspect(handle)
            handle.seek(0)
            yield handle
        finally:
            handle.close()


def open_backup_file(backup_id):
    """Return a verified OPEN handle. FileResponse must own/close it after sending."""
    root = backup_root()
    with _lock(root):
        path = _backup_path(backup_id)
        handle = path.open('rb')
        try:
            _inspect(handle)
            handle.seek(0)
        except BaseException:
            handle.close()
            raise
    return handle


def create_backup(*, include_library=True, include_public_files=True, retain=7):
    if not isinstance(retain, int) or retain < 1 or retain > 365:
        raise BackupError('历史保留数量应为 1 至 365。')
    root = backup_root()
    with _lock(root), tempfile.TemporaryDirectory(prefix='.luokixi-snapshot-', dir=root) as staging:
        folder = Path(staging)
        engine = settings.DATABASES['default']['ENGINE']
        database = str(settings.DATABASES['default']['NAME'])
        if engine != 'django.db.backends.sqlite3' or database == ':memory:' or database.startswith('file:'):
            raise BackupError('此备份工具要求使用文件形式的 SQLite 数据库。')
        info = {'hub': _sqlite_copy(Path(database), folder / 'hub' / 'community.sqlite3')}
        # Preserve login/session signing without reading or copying model-provider keys.
        (folder / 'hub' / 'secret.key').write_text(settings.SECRET_KEY, encoding='utf-8')
        budget = {'used': sum(p.stat().st_size for p in (folder / 'hub').iterdir() if p.is_file())}
        _copy_tree(Path(settings.MEDIA_ROOT), folder / 'hub' / 'uploads', budget)
        library_root = Path(os.environ.get('CAMPUS_DATA_DIR', Path(settings.BASE) / '.data')).absolute()
        library_db = library_root / 'library.sqlite3'
        has_library = bool(include_library and library_db.is_file())
        if has_library:
            info['library'] = _sqlite_copy(library_db, folder / 'library' / 'library.sqlite3')
            budget['used'] += (folder / 'library' / 'library.sqlite3').stat().st_size
            _copy_tree(library_root / 'files', folder / 'library' / 'files', budget)
            _collect_library_originals(library_root, folder / 'library', budget)
            info['library'] = _sqlite_info(folder / 'library' / 'library.sqlite3')
        public = _project_root() / 'public' / 'files'
        if include_public_files:
            _copy_tree(public, folder / 'public' / 'files', budget)
        files = []
        total = 0
        for path in sorted(folder.rglob('*')):
            if not path.is_file():
                continue
            size = path.stat().st_size
            total += size
            if total > _limit() or len(files) >= MAX_MEMBERS:
                raise BackupError('备份超过配置的容量或文件数量限制。')
            files.append({'path': _safe_name(path.relative_to(folder).as_posix()), 'bytes': size,
                          'sha256': _sha_file(path)})
        mapping = {item['path']: item for item in files}
        _referenced_files(folder / 'hub' / 'community.sqlite3', mapping,
                          folder / 'library' / 'library.sqlite3' if has_library else None, library_root)
        manifest = {'tool': TOOL, 'formatVersion': FORMAT_VERSION, 'createdAt': _now(),
                    'scope': {'accounts': True, 'community': True, 'reviews': True, 'uploads': True,
                              'library': has_library, 'publicFiles': bool(include_public_files)},
                    'sensitive': ['account-database', 'private-uploads', 'django-signing-key'],
                    'excluded': ['API keys', 'model-provider configuration', 'email previews', 'source code'],
                    'librarySourceRoot': str(library_root) if has_library else None,
                    'databases': info, 'files': files, 'totalBytes': total}
        raw = json.dumps(manifest, ensure_ascii=False, sort_keys=True).encode('utf-8')
        if len(raw) > MAX_MANIFEST_BYTES:
            raise BackupError('备份清单过大。')
        name = 'luokixi-backup-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:12] + '.zip'
        pending = folder / 'snapshot.zip'
        with zipfile.ZipFile(pending, 'x', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
            archive.writestr('manifest.json', raw)
            for item in files:
                archive.write(folder / item['path'], item['path'])
        _inspect(pending)
        destination = root / name
        os.replace(pending, destination)
        try:
            os.chmod(destination, 0o600)
        except OSError:
            pass
        # Prune only validated archives generated by this tool; unrelated files stay.
        retention_warnings = []
        for old in list_backups()[retain:]:
            try:
                old_path = _no_links(root / old['id'])
                old_path.unlink()
                check = root / (old['id'] + '.check.json')
                if check.exists() and not _is_link(check):
                    check.unlink()
            except (OSError, BackupError):
                # A download may still hold the old file open on Windows. The
                # new, verified backup succeeded; retry pruning next time.
                retention_warnings.append('部分旧备份正在使用，将在下次备份时重试清理。')
        result = _summary(destination, manifest)
        result['sha256'] = _sha_file(destination)
        if retention_warnings:
            result['retentionWarnings'] = retention_warnings
        return result


def _rewrite_library(folder, manifest):
    if not manifest['scope'].get('library'):
        return 0
    db_path = folder / 'library' / 'library.sqlite3'
    source_root = Path(manifest.get('librarySourceRoot') or '')
    rewritten = 0
    with closing(sqlite3.connect(db_path)) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'documents' in tables:
            rows = db.execute("SELECT id,file_path FROM documents WHERE file_path != ''").fetchall()
            for ident, value in rows:
                path = Path(value)
                if not path.is_absolute():
                    path = source_root / path
                try:
                    relative = path.relative_to(source_root / 'files')
                except ValueError:
                    raise BackupError('资料库包含无法恢复的外部文件路径。') from None
                name = _safe_name('library/files/' + relative.as_posix())
                db.execute('UPDATE documents SET file_path=? WHERE id=?', (str(folder / name), ident))
                rewritten += 1
        db.commit()
    return rewritten


def restore_backup(backup_id, *, destination=None):
    """Restore to a NEW private directory; never accept an existing destination."""
    root = backup_root()
    verification_id = uuid.uuid4().hex
    target = _private_path(destination or root / 'restore-checks' / verification_id)
    if target.exists():
        raise BackupError('恢复只允许全新隔离目录，不能覆盖已有数据。')
    with _lock(root):
        path = get_backup_path(backup_id)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        pending = Path(tempfile.mkdtemp(prefix='.luokixi-restore-', dir=target.parent))
        try:
            manifest, files = _inspect(path, pending)
            hub_info = _sqlite_info(pending / 'hub' / 'community.sqlite3')
            if hub_info != manifest['databases']['hub']:
                raise BackupError('恢复数据库的结构、版本或记录数量不一致。')
            has_library = manifest['scope'].get('library')
            if has_library and _sqlite_info(pending / 'library' / 'library.sqlite3') != manifest['databases']['library']:
                raise BackupError('恢复资料库的结构、版本或记录数量不一致。')
            _referenced_files(pending / 'hub' / 'community.sqlite3', files,
                              pending / 'library' / 'library.sqlite3' if has_library else None,
                              Path(manifest['librarySourceRoot']) if has_library else None)
            os.rename(pending, target)
            try:
                rewritten = _rewrite_library(target, manifest)
            except BaseException:
                shutil.rmtree(target)
                raise
            result = {'backupId': backup_id, 'verificationId': verification_id, 'verifiedAt': _now(),
                      'ok': True, 'files': len(files), 'bytes': sum(item['bytes'] for item in files.values()),
                      'archiveSha256': _sha_file(path), 'databases': {'hub': hub_info},
                      'rewrittenLibraryPaths': rewritten, 'productionChanged': False}
            if has_library:
                result['databases']['library'] = _sqlite_info(target / 'library' / 'library.sqlite3')
            # API returns no private filesystem path; CLI can explicitly print it.
            receipt = root / (backup_id + '.check.json')
            temporary = root / ('.luokixi-check-' + uuid.uuid4().hex + '.tmp')
            temporary.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
            os.replace(temporary, receipt)
            return result, target
        finally:
            if pending.exists():
                shutil.rmtree(pending)


def check_backup(backup_id):
    result, _ = restore_backup(backup_id)
    return result
