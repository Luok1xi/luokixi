// Interface for Opus's page. This module owns data access, not page layout.
import { campusAvailable } from './client.js';
export const communityAvailable = campusAvailable;

async function request(path = '', data) {
  if (!communityAvailable) throw new Error('此页面为静态浏览版。可导出投稿文件；本机工作台启动后才能提交和核对。');
  const response = await fetch(`/api/community${path}`, {
    signal: AbortSignal.timeout(20000),
    ...(data === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json','X-Campus-Request':'1'},body:JSON.stringify(data)}),
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error('共创服务尚未连接，请启动学校知识库服务。'); }
  if (!response.ok) throw new Error(result.error || '操作未完成，请稍后再试。');
  return result;
}

export const communityApi = {
  overview: () => request(),
  inspectRepository: url => request('/repo?' + new URLSearchParams({url})),
  submit: entry => request('/submit', entry),
  review: (id, status, reason = '', checked = false) => request('/review', {id,status,reason,checked}),
  topic: id => request('/topic?' + new URLSearchParams({id})),
  addTopic: data => request('/topics', data),
  reply: data => request('/replies', data),
  acceptReply: (id, reply) => request('/topic-action', {id,reply,action:'solve'}),
  closeTopic: id => request('/topic-action', {id,action:'close'}),
};

export async function loadCommunity() {
  const response = await fetch(new URL('./data/community.json', document.baseURI));
  if (!response.ok) throw new Error('项目参考目录读取失败。');
  const catalogue = await response.json();
  // Support Opus's build-community.mjs schema as well as the initial draft.
  const normalize = project => ({...project,
    id:project.id || project.slug,
    url:project.url || project.links?.repo || '',
    author:project.author || project.credit || '',
    license:project.license || project.repo?.license || '未说明',
    external:project.external === true || project.origin === 'external',
  });
  const projects=(catalogue.projects || []).map(normalize);
  const base = {catalogue, references:projects.filter(p=>p.external), published:projects.filter(p=>!p.external), verified:catalogue.verified || catalogue.generated, entries:[], topics:[], activity:null, connected:false};
  if (!communityAvailable) return {...base, notice:'静态浏览版：项目参考和个人足迹可用，投稿可导出；社区服务尚未上线。'};
  try { return {...base, ...await communityApi.overview(), connected:true, notice:'本机共创工作台 · 署名由投稿者填写'}; }
  catch (error) { return {...base, notice:error.message}; }
}

export function makeSubmissionFile(entry) {
  return {schema:'luokixi-community-submission-v1', created:new Date().toISOString(), entry};
}

export function readSubmissionFile(raw) {
  if (raw?.schema !== 'luokixi-community-submission-v1' || !raw.entry || typeof raw.entry !== 'object') throw new Error('投稿文件格式不匹配。');
  // Return form fields only. Approval, authorship and role claims are never imported.
  const fields = ['kind','title','summary','category','author','url','tags','license','body','setup','needs'];
  return Object.fromEntries(fields.filter(key => key in raw.entry).map(key => [key,raw.entry[key]]));
}
