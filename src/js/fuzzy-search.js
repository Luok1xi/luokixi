// Shared local matching only: no requests, persistence, or identity merging.
const ALIASES = [
  ['线性代数', '线代', 'linear algebra', 'linalg'],
  ['高等数学', '高数', 'calculus'],
  ['大学物理', '大物', 'college physics'],
  ['概率论与数理统计', '概率论', '概率统计'],
  ['英语四级', '四级', 'cet4', 'cet 4', 'cet-4'],
  ['英语六级', '六级', 'cet6', 'cet 6', 'cet-6'],
  ['计算机科学', 'cs', 'computer science'],
  ['嵌入式', 'embedded', '单片机', 'mcu'],
  ['日常', 'daily', '生活'],
  ['数据结构', 'data structures', 'data structure'],
  ['机器学习', 'machine learning', 'ml'],
  ['人工智能', 'artificial intelligence', 'ai'],
  ['javascript', 'js'], ['typescript', 'ts'],
  ['图书馆', 'library'], ['开源', 'open source'],
];

// Pure string → string steps are cached: the same titles are re-scored on every keystroke,
// and the Unicode regex passes dominated typing latency. Behaviour is unchanged.
function memo(fn, limit = 8000) {
  const cache = new Map();
  return (value) => {
    const key = String(value ?? '');
    let out = cache.get(key);
    if (out === undefined) {
      if (cache.size >= limit) cache.clear();
      out = fn(key);
      cache.set(key, out);
    }
    return out;
  };
}

export const normalizeSearchText = memo((value) => value.normalize('NFKC').toLocaleLowerCase('en-US')
  .replace(/[\p{P}\p{S}]/gu, (character) => '+#'.includes(character) ? character : ' ')
  .replace(/\s+/g, ' ').trim());

const aliases = new Map(ALIASES.flatMap(([canonical, ...variants]) =>
  [canonical, ...variants].map((alias) => [normalizeSearchText(alias), canonical])));
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const aliasPattern = new RegExp([...aliases.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'gu');

const canonicalize = memo((value) => {
  const normalized = normalizeSearchText(value);
  return normalized.replace(aliasPattern, (match, offset, whole) => {
    // Short English aliases must be complete words: CS must not match CSS.
    if (/^[a-z0-9 +#]+$/.test(match) && (/[a-z0-9]/.test(whole[offset - 1] || '') || /[a-z0-9]/.test(whole[offset + match.length] || ''))) return match;
    if ((match === '大物' && whole[offset + match.length] === '理') || (match === '线代' && whole[offset + match.length] === '数')) return match;
    return aliases.get(match);
  });
});

export function searchTokens(query) {
  return [...new Set(canonicalize(String(query ?? '').slice(0, 256)).split(/\s+/).filter(Boolean))].slice(0, 12);
}

function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length === b.length && a[i] === b[j + 1] && a[i + 1] === b[j]) { i += 2; j += 2; }
    else if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return edits + Number(i < a.length || j < b.length) <= 1;
}

function nearWord(token, words) {
  // Do not autocorrect course IDs, dates, version numbers, C/C++, or Chinese names.
  if (!/^[a-z]{4,32}$/.test(token)) return false;
  return words.some((word) => /^[a-z]{4,32}$/.test(word) && oneEdit(token, word));
}

function closeSubsequence(token, value) {
  if (token.length < 2 || token.length > 24 || /\d/.test(token)) return false;
  // Two-letter Latin abbreviations belong in the explicit dictionary, not fuzzy matching.
  if (/^[a-z]+$/.test(token) && token.length < 3) return false;
  for (const word of value.split(/\s+/)) {
    if (word.length > token.length + 3) continue;
    let cursor = 0;
    for (const letter of word) if (letter === token[cursor]) cursor++;
    if (cursor === token.length) return true;
  }
  return false;
}

const defaultTitle = (item) => typeof item === 'string' ? item : item.title || item.name || item.label || '';
const defaultText = (item) => typeof item === 'string' ? item : [item.summary, item.sub, item.description, item.course, item.courseName, item.kind, item.year].filter(Boolean).join(' ');
const defaultKeywords = (item) => typeof item === 'string' ? '' : [item.kw, item.keywords, item.tags?.join?.(' '), item.id, item.code].filter(Boolean).join(' ');

function compileQuery(query) {
  const raw = normalizeSearchText(String(query ?? '').slice(0, 256));
  return { raw, canonical: canonicalize(raw), tokens: searchTokens(raw) };
}

function prepare(item, options) {
  const rawTitle = normalizeSearchText((options.getTitle || defaultTitle)(item));
  const title = canonicalize(rawTitle);
  const rawKeywords = normalizeSearchText((options.getKeywords || defaultKeywords)(item));
  const keywords = canonicalize(rawKeywords);
  const body = canonicalize((options.getText || defaultText)(item));
  const titleWords = `${title} ${rawTitle}`.split(/\s+/), keywordWords = `${keywords} ${rawKeywords}`.split(/\s+/);
  return {rawTitle, title, keywords, body, titleWords, keywordWords};
}

function scorePrepared(prepared, query) {
  if (!query.tokens.length) return 0;
  const {rawTitle, title, keywords, body, titleWords, keywordWords} = prepared;
  let score = rawTitle === query.raw ? 1000 : title === query.canonical ? 800 : 0;
  for (const token of query.tokens) {
    if (title === token) score += 140;
    else if (title.startsWith(token)) score += 110;
    else if (title.includes(token)) score += 85;
    else if (keywords.includes(token)) score += 60;
    else if (body.includes(token)) score += 35;
    else if (nearWord(token, titleWords)) score += 28;
    else if (nearWord(token, keywordWords)) score += 20;
    else if (closeSubsequence(token, title)) score += 18;
    else return -1;
  }
  return score - Math.min(rawTitle.length, 200) / 1000;
}

export function scoreSearchItem(item, query, options = {}) {
  return scorePrepared(prepare(item, options), compileQuery(query));
}

function rank(items, query, options, prepared) {
  const compiled = compileQuery(query);
  const limit = options.limit === Infinity ? Infinity : Math.max(0, Number(options.limit ?? 50) || 0);
  const ranked = [];
  for (let position = 0; position < items.length; position++) {
    const item = items[position], score = scorePrepared(prepared ? prepared[position] : prepare(item, options), compiled);
    if (score >= 0) ranked.push({ item, score, position });
  }
  ranked.sort((a, b) => b.score - a.score || a.position - b.position);
  return ranked.slice(0, limit).map(({ item }) => item);
}

export function fuzzySearch(items, query, options = {}) { return rank(items, query, options); }

// Immutable catalogue snapshot: normalization and tokenization happen once, not on
// every letter. Mutable forms continue using fuzzySearch, so edits never go stale.
export function createFuzzyIndex(items, options = {}) {
  const snapshot = [...items], prepared = snapshot.map(item => prepare(item, options));
  return (query, limit = options.limit ?? 50) => rank(snapshot, query, {...options, limit}, prepared);
}
