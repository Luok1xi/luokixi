// Browser adapter. Vite development proxy and production Python server use /api.
export const campusAvailable = ['127.0.0.1','localhost'].includes(location.hostname) || import.meta.env.VITE_CAMPUS_BACKEND === 'same-origin';
async function request(path, data, options = {}) {
  if (!campusAvailable) throw new Error('当前为静态浏览版本，请在电脑上启动本机知识库服务。');
  const response = await fetch(`/api${path}`, {
    ...options,
    ...(data === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Campus-Request': '1' },
      body: JSON.stringify(data),
    }),
  });
  const raw = await response.text();
  let result;
  try { result = JSON.parse(raw); }
  catch { throw new Error('知识库服务未连接，请启动 campus 后端并配置 /api 代理。'); }
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
  return result;
}
const qs = values => new URLSearchParams(Object.entries(values).filter(([,v]) => v !== undefined && v !== '')).toString();
export const campusApi = {
  health: () => request('/health'),
  meta: () => request('/meta'),
  catalogue: (filters = {}, options = {}) => request(`/catalogue?${qs(filters)}`, undefined, options),
  document: id => request(`/document/${encodeURIComponent(id)}`),
  file: id => `/api/file/${encodeURIComponent(id)}`,
  searchWeb: (q, options = {}) => request(`/search-web?${qs({q})}`, undefined, options),
  crawl: data => request('/crawl', data),
  jobs: () => request('/jobs'),
  curate: data => request('/curate', data),
  addCourse: name => request('/courses', {name}),
  cards: () => request('/cards'),
  addCard: data => request('/cards', data),
  review: (id, correct) => request('/review', {id, correct}),
  backup: () => request('/backup'),
  restore: data => request('/restore', data),
};
