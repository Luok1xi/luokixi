"""Bounded, read-only message extraction using the pinned pyweixin library.
No sending, hooks, key extraction, contacts export or clipboard logging.
"""
import contextlib
import ctypes
import hashlib
import io
import json
import sys


def scan():
    from pywinauto import Desktop
    windows = Desktop(backend='uia').windows(class_name='mmui::MainWindow', visible_only=False)
    if not windows:
        return {'status': 'blocked', 'detail': '微信没有暴露可读取的会话控件；当前账号或窗口的 UI 树不可见。', 'threads': []}
    window = windows[0]
    lists = window.descendants(control_type='List', depth=7)
    sessions = next((x for x in lists if x.window_text() in ('会话', 'Chats', '聊天')), None)
    if sessions is None:
        return {'status': 'blocked', 'detail': '微信窗口可见，但会话列表不可读。', 'threads': []}
    if '--probe' in sys.argv:
        return {'status': 'ready', 'detail': '会话控件可读，尚未读取正文。', 'threads': []}
    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [('cbSize', ctypes.c_uint), ('dwTime', ctypes.c_uint)]
    info = LASTINPUTINFO(); info.cbSize = ctypes.sizeof(info)
    ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info))
    idle = (ctypes.windll.kernel32.GetTickCount() - info.dwTime) & 0xffffffff
    if idle < 30000:
        return {'status': 'waiting', 'detail': '你正在使用电脑，等空闲后读取，避免切换你正在操作的聊天。', 'threads': []}
    names = []
    for item in sessions.children(control_type='ListItem')[:30]:
        automation_id = item.automation_id()
        if automation_id.startswith('session_item_'):
            names.append(automation_id[len('session_item_'):])
    offset = int(sys.argv[sys.argv.index('--offset')+1]) if '--offset' in sys.argv else 0
    chosen = (names[offset % len(names):] + names[:offset % len(names)])[:2] if names else []
    from pyweixin import Messages
    threads = []
    for name in chosen:
        rows = Messages.pull_messages(friend=name, number=20, myName='我', search_pages=0, is_maximize=False, close_weixin=False)
        messages = []
        for index, row in enumerate(rows[-20:]):
            content = str(row.get('消息内容', ''))[:8000]
            if not content.strip():
                continue
            sender = str(row.get('消息发送人') or '未识别发送人')[:100]
            # This upstream reader has no trustworthy per-message clock/ID. Do not invent one.
            fingerprint = hashlib.sha256((sender+'\0'+content).encode()).hexdigest()
            messages.append({'id': fingerprint, 'sender': sender, 'text': content, 'at': None})
        threads.append({'remote': name, 'title': name, 'kind': 'personal', 'messages': messages})
    return {'status': 'partial', 'detail': '轮询当前会话列表中的两段近期文字；不等于完整历史，原始时间未知，相同文字可能合并。', 'threads': threads}


try:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        result = scan()
except Exception as exc:
    result = {'status': 'blocked', 'detail': '微信读取失败：'+type(exc).__name__+'；请检查登录和窗口可访问性。', 'threads': []}
print(json.dumps(result, ensure_ascii=False))
