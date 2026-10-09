import { fuzzySearch } from './fuzzy-search.js';

export const DISC_TOPICS = Object.freeze({ all:'全部', practical:'实用', creative:'新奇', potential:'潜力', cs:'CS', daily:'日常', embedded:'嵌入式', ai:'AI', mech:'机电', course:'课程', research:'科研' });
export function projectTopics(item) {
  const text = [item.title,item.idea,item.repository,item.category,...(item.tags || [])].join(' ').toLowerCase();
  const topics = new Set([item.category, item.shelf].filter(Boolean));
  if (['software','algo'].includes(item.category) || /计算机|编程|开发|computer science/.test(text)) topics.add('cs');
  if (/日常|生活|效率|笔记|待办|日历|记账|阅读|翻译|下载|播放器|阅读器|浏览器|剪贴板|截图|桌面|办公|工具箱|todo|productivity|daily|note taking/.test(text)) topics.add('daily');
  if (/嵌入式|单片机|\bmcu\b|\besp32\b|\bstm32\b|\bfirmware\b/.test(text)) topics.add('embedded');
  if (/人工智能|机器学习|大模型|\bai\b|\bllm\b|machine learning/.test(text)) topics.add('ai');
  return [...topics];
}
export const projectSearchOptions = {
  getTitle: item => item.title,
  getText: item => [item.idea,item.credit,item.whyRecommended].filter(Boolean).join(' '),
  getKeywords: item => [item.repository,item.slug,item.language,...(item.tags || []),...projectTopics(item).map(topic => DISC_TOPICS[topic] || topic)].filter(Boolean).join(' '),
  limit: Infinity,
};
export function filterDiscovery(items, { shelf = 'all', query = '', hidden = [] } = {}) {
  const omitted = new Set(hidden);
  const candidates = items.filter(item => !omitted.has(item.repository) && (shelf === 'all' || projectTopics(item).includes(shelf)))
    .sort((a, b) => (b.githubStars ?? -1) - (a.githubStars ?? -1) || String(a.repository).localeCompare(String(b.repository)));
  return query.trim() ? fuzzySearch(candidates, query, projectSearchOptions) : candidates;
}
