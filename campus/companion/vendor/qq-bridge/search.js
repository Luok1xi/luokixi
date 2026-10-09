// Adapted from Derpyu520/qq-bridge, MIT; see LICENSE and UPSTREAM.json.
import {safeFetch} from './safe-fetch.js';
export function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function bingSearch(query,fetcher=safeFetch) {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', sanitizeQuery(query));
  // 搜索也使用同一条受限传输链路，重定向必须重新校验，正文最多 512K 字符。
  const res = await fetcher(url.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`搜索服务 HTTP ${res.statusCode}`);
  const html = res.body;
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    let urlStr = decodeHtml(hrefMatch[1]);
    try { const u = new URL(urlStr); if(u.hostname.endsWith('bing.com') && u.pathname === '/ck/a') { const to=u.searchParams.get('u'); if(to?.startsWith('a1')) urlStr=Buffer.from(to.slice(2),'base64url').toString('utf8'); } } catch {continue;}
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return { query, results };
}

