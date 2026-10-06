// 极简 Markdown → HTML，用来显示投稿正文和讨论回复。
// 安全做法：先把整段文字转义，再识别少量语法；不支持内嵌 HTML。
// 链接只放行 http(s)，并加 nofollow ugc；图片不直接加载（避免外链追踪和超大图），只显示成链接。
import { esc } from './data.js';

const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;
const CJK = /[　-〿㐀-鿿＀-￯]/;

function link(text, url) {
  const u = url.replace(/&amp;/g, '&');
  if (!SAFE_URL.test(u)) return text;
  return `<a href="${esc(u)}" target="_blank" rel="noopener nofollow ugc">${text}</a>`;
}

// 行内语法。输入已经转义过
function inline(s) {
  // 代码和链接先换成占位符，免得网址里的 _ 和 * 被当成强调
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  s = s
    .replace(/`([^`]+)`/g, (_, c) => hold(`<code>${c}</code>`))
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => hold(link(`图片：${alt || '未命名'}`, url)))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => hold(link(text, url)))
    .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, url) => hold(link(url, url)))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
    .replace(/ {2}$/gm, '<br>');
  // 占位符可能嵌套（链接文字里有代码），多还原几轮
  for (let k = 0; k < 3 && s.includes('\u0000'); k += 1) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
  return s;
}

// 段落里的换行：中文之间直接连上，其他情况换成空格（和 GitHub 一致）
const joinLines = (lines) =>
  lines.reduce((acc, line) => {
    if (!acc) return line;
    const glue = CJK.test(acc.slice(-1)) && CJK.test(line[0] ?? '') ? '' : ' ';
    return acc.endsWith('<br>') ? acc + line : acc + glue + line;
  }, '');

export function renderMarkdown(src = '') {
  const lines = esc(String(src).replace(/\r\n?/g, '\n')).split('\n');
  const out = [];
  let i = 0;
  const para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(joinLines(para.splice(0)))}</p>`);
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      flush();
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      out.push(`<pre class="md-code"><code>${body.join('\n')}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flush();
      // 页面里已经有 h1/h2，正文标题从 h3 开始
      const level = Math.min(h[1].length + 2, 6);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      i += 1;
      continue;
    }
    if (/^\s*&gt;/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^\s*&gt;/.test(lines[i])) quote.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
      out.push(`<blockquote>${renderInner(quote)}</blockquote>`);
      continue;
    }
    const list = line.match(/^\s*([-*+]|\d+[.)])\s+/);
    if (list) {
      flush();
      const ordered = /\d/.test(list[1]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (m && /\d/.test(m[1]) === ordered) items.push([m[2]]);
        else if (items.length && /^\s{2,}\S/.test(lines[i])) items[items.length - 1].push(lines[i].trim());
        else break;
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(joinLines(it))}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
    i += 1;
  }
  flush();
  return out.join('\n');
}

// 引用块里的内容已经转义过，不能再转义一次
function renderInner(lines) {
  return lines
    .join('\n')
    .split(/\n{2,}/)
    .map((p) => `<p>${inline(joinLines(p.split('\n')))}</p>`)
    .join('');
}
