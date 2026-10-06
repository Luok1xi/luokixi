// 社区服务的页面侧入口。
// HTTP、CSRF、会话都交给 Codex 的 campus/hub-client.js（它在纯静态部署时不发任何请求），
// 这里只额外提供“服务是否在线 + 当前用户”的一次性探测，以及登录页地址。
import { hubApi, HubError } from '../../campus/hub-client.js';

export { hubApi, HubError };

let state;
export function hubState() {
  state ??= (async () => {
    const offline = { online: false, user: null, capabilities: null, ai: null };
    if (!hubApi.available) return offline;
    try {
      const health = await hubApi.health();
      if (!health?.ok) return offline;
      const s = await hubApi.session();
      return { online: true, user: s.user, capabilities: s.capabilities, ai: health.ai };
    } catch {
      return offline;
    }
  })();
  return state;
}

// 登录、注册、找回密码都在 auth.html；登录后回到当前页面
export const loginURL = (mode = 'login') =>
  `auth.html?mode=${mode}&next=${encodeURIComponent(location.pathname.split('/').pop() + location.search)}`;
