// 汇总社区数据 → public/data/community.json
//
//   node scripts/build-community.mjs            联网抓取（GitHub / Gitee / 洛谷 / 力扣 / Codeforces）
//   node scripts/build-community.mjs --offline  不联网，只重排内容并复用上次抓到的数据
//
// 设计原则
//  · 只抓本人在 content/people/ 里自愿登记的账号；不爬名单、不猜账号。
//  · 某个平台抓取失败时，沿用上一次的数据并标记 stale，不让整站构建失败。
//  · 对每个平台串行、限速请求（Codeforces 官方要求每 2 秒 1 次）。
//  · GITHUB_TOKEN 存在时才查询 GitHub 个人贡献日历（GraphQL 需要令牌）。
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CATEGORIES, validateProject, validatePerson } from '../src/js/schema.js';

const OFFLINE = process.argv.includes('--offline');
const OUT = 'public/data/community.json';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 luokixi-bot';
const DAYS = 371; // 53 周

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[community]', ...a);
const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const prev = existsSync(OUT) ? readJSON(OUT) : { people: [], projects: [] };
const prevPerson = (login) => prev.people?.find((p) => p.login === login);
const prevProject = (slug) => prev.projects?.find((p) => p.slug === slug);

// 北京时间的日期字符串
const dayOf = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const since = Date.now() - DAYS * 86400e3;
const addDay = (cal, day, n = 1) => {
  if (n > 0 && day >= dayOf(since)) cal[day] = (cal[day] ?? 0) + n;
};

async function http(url, opts = {}, ms = 15000) {
  const r = await fetch(url, { ...opts, headers: { 'user-agent': UA, ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(ms) });
  return r;
}

// ---------------- 内容 ----------------

function readDir(dir, validate) {
  const items = [];
  const errors = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const id = f.slice(0, -5);
    let data;
    try { data = readJSON(`${dir}/${f}`); } catch (e) { errors.push(`${dir}/${f}: JSON 格式错误 ${e.message}`); continue; }
    const errs = validate(id, data);
    if (errs.length) errors.push(...errs.map((e) => `${dir}/${f}: ${e}`));
    else items.push({ id, data });
  }
  return { items, errors };
}

// ---------------- 仓库统计 ----------------

function parseRepo(url) {
  const m = url?.match(/^https:\/\/(github\.com|gitee\.com)\/([^/]+)\/([^/#?]+)/);
  return m ? { host: m[1], owner: m[2], name: m[3].replace(/\.git$/, '') } : null;
}

async function repoStats(url) {
  const r = parseRepo(url);
  if (!r) return null;
  if (r.host === 'github.com') {
    const res = await http(`https://api.github.com/repos/${r.owner}/${r.name}`, {
      headers: { accept: 'application/vnd.github+json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const d = await res.json();
    return {
      platform: 'GitHub', fullName: d.full_name, stars: d.stargazers_count, forks: d.forks_count,
      language: d.language, license: d.license?.spdx_id && d.license.spdx_id !== 'NOASSERTION' ? d.license.spdx_id : null,
      pushedAt: d.pushed_at, topics: (d.topics ?? []).slice(0, 6), checkedAt: new Date().toISOString(),
    };
  }
  const res = await http(`https://gitee.com/api/v5/repos/${r.owner}/${r.name}`);
  if (!res.ok) throw new Error(`Gitee ${res.status}`);
  const d = await res.json();
  return {
    platform: 'Gitee', fullName: d.full_name, stars: d.stargazers_count, forks: d.forks_count,
    language: d.language && d.language !== '其他' ? d.language : null, license: d.license ?? null, pushedAt: d.pushed_at, topics: [],
    checkedAt: new Date().toISOString(),
  };
}

// ---------------- 刷题平台 ----------------

// 洛谷：先拿一次性 cookie，再从页面内嵌的 lentille-context JSON 里读数据
async function luogu(uid) {
  const url = `https://www.luogu.com.cn/user/${uid}`;
  let cookie = '';
  for (let i = 0; i < 4; i++) {
    const res = await http(url, { redirect: 'manual', headers: { cookie, accept: 'text/html' } });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = [cookie, ...set.map((c) => c.split(';')[0])].filter(Boolean).join('; ');
    if (res.status >= 300 && res.status < 400) { await sleep(300); continue; }
    if (!res.ok) throw new Error(`洛谷 ${res.status}`);
    const html = await res.text();
    const m = html.match(/<script id="lentille-context" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('洛谷页面结构变了');
    const d = JSON.parse(m[1]).data ?? {};
    const u = d.user;
    if (!u) throw new Error('洛谷用户不存在');
    const calendar = {};
    for (const item of d.dailyCounts ?? []) {
      // 兼容几种可能的格式：[时间戳, 次数] / {date, count} / {time, count}
      if (Array.isArray(item)) addDay(calendar, dayOf(item[0] * (item[0] < 1e12 ? 1000 : 1)), item[1]);
      else if (item?.date) addDay(calendar, String(item.date).slice(0, 10), item.count ?? 1);
      else if (item?.time) addDay(calendar, dayOf(item.time * 1000), item.count ?? 1);
    }
    return {
      uid: u.uid, name: u.name, color: u.color ?? null, ccfLevel: u.ccfLevel || null,
      passed: u.passedProblemCount ?? null, submitted: u.submittedProblemCount ?? null,
      elo: u.eloValue ?? null,
      prizes: (d.prizes ?? []).slice(0, 4).map((p) => ({ year: p.prize.year, contest: p.prize.contest, prize: p.prize.prize })),
      calendar,
    };
  }
  throw new Error('洛谷重定向次数过多');
}

async function leetcode(slug) {
  const gql = async (path, query, variables) => {
    const res = await http(`https://leetcode.cn${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', referer: 'https://leetcode.cn/' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`力扣 ${res.status}`);
    const j = await res.json();
    if (j.errors) throw new Error(`力扣 ${j.errors[0]?.message}`);
    return j.data;
  };
  const d = await gql(
    '/graphql/',
    `query($u:String!){userProfileUserQuestionProgress(userSlug:$u){numAcceptedQuestions{count difficulty}}
      userProfilePublicProfile(userSlug:$u){siteRanking profile{realName}}}`,
    { u: slug },
  );
  if (!d.userProfilePublicProfile) throw new Error('力扣用户不存在');
  const solved = { easy: 0, medium: 0, hard: 0 };
  for (const q of d.userProfileUserQuestionProgress?.numAcceptedQuestions ?? []) solved[q.difficulty.toLowerCase()] = q.count;
  const calendar = {};
  const year = new Date().getFullYear();
  for (const y of [year - 1, year]) {
    const c = await gql('/graphql/noj-go/', 'query($u:String!,$y:Int){userCalendar(userSlug:$u,year:$y){submissionCalendar}}', { u: slug, y });
    for (const [ts, n] of Object.entries(JSON.parse(c.userCalendar?.submissionCalendar || '{}'))) addDay(calendar, dayOf(ts * 1000), n);
    await sleep(400);
  }
  return {
    slug, name: d.userProfilePublicProfile.profile?.realName ?? slug,
    solved: { ...solved, total: solved.easy + solved.medium + solved.hard },
    ranking: d.userProfilePublicProfile.siteRanking ?? null,
    calendar,
  };
}

let cfLast = 0;
async function cf(method, params) {
  const wait = cfLast + 2100 - Date.now();
  if (wait > 0) await sleep(wait);
  cfLast = Date.now();
  const res = await http(`https://codeforces.com/api/${method}?${new URLSearchParams(params)}`);
  const j = await res.json();
  if (j.status !== 'OK') throw new Error(`Codeforces ${j.comment ?? res.status}`);
  return j.result;
}

async function codeforces(handle) {
  const [u] = await cf('user.info', { handles: handle });
  const subs = await cf('user.status', { handle, from: 1, count: 3000 });
  const calendar = {};
  const solved = new Set();
  for (const s of subs) {
    addDay(calendar, dayOf(s.creationTimeSeconds * 1000));
    if (s.verdict === 'OK') solved.add(`${s.problem.contestId}${s.problem.index}`);
  }
  return {
    handle: u.handle, rating: u.rating ?? null, maxRating: u.maxRating ?? null,
    rank: u.rank ?? null, maxRank: u.maxRank ?? null, solved: solved.size, calendar,
  };
}

async function githubCalendar(login) {
  if (!TOKEN) return null;
  const res = await http('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'query($l:String!){user(login:$l){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}',
      variables: { l: login },
    }),
  });
  const j = await res.json();
  const weeks = j.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!weeks) throw new Error(j.errors?.[0]?.message ?? 'GitHub 日历为空');
  const calendar = {};
  for (const w of weeks) for (const d of w.contributionDays) addDay(calendar, d.date, d.contributionCount);
  return { calendar };
}

// 某个来源抓取失败时沿用上次结果
async function attempt(label, fn, fallback) {
  if (OFFLINE) return fallback ? { ...fallback, stale: true } : null;
  try {
    return await fn();
  } catch (e) {
    log(`⚠ ${label}: ${e.message}`);
    return fallback ? { ...fallback, stale: true } : { error: e.message };
  }
}

// ---------------- 本站提交记录 ----------------

function repoActivity() {
  let out = '';
  try {
    out = execFileSync('git', ['log', `--since=${DAYS} days ago`, '--no-merges', '--format=%aI%x1f%an%x1f%ae'], { encoding: 'utf8' });
  } catch {
    log('⚠ 读不到 git 记录（不是 git 仓库，或还没有提交）');
  }
  const days = {};
  const authors = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [iso, name, email] = line.split('\x1f');
    const day = dayOf(Date.parse(iso));
    addDay(days, day);
    const login = email.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i)?.[1] ?? null;
    const key = login ?? name;
    const a = authors.get(key) ?? { login, name, commits: 0, last: day, days: {} };
    a.commits++;
    if (day > a.last) a.last = day;
    addDay(a.days, day);
    authors.set(key, a);
  }
  return { days, authors: [...authors.values()] };
}

// ---------------- 汇总 ----------------

const mergeCal = (...cals) => {
  const out = {};
  for (const c of cals) for (const [d, n] of Object.entries(c ?? {})) out[d] = (out[d] ?? 0) + n;
  return out;
};
const sum = (cal) => Object.values(cal ?? {}).reduce((a, b) => a + b, 0);
// 日历压缩成与 START 对齐的计数数组（371 个整数），比按日期做键小得多
const START = dayOf(since);
const toSeries = (cal) => {
  const out = new Array(DAYS).fill(0);
  const t0 = Date.parse(START);
  for (const [d, n] of Object.entries(cal ?? {})) {
    const i = Math.round((Date.parse(d) - t0) / 86400e3);
    if (i >= 0 && i < DAYS) out[i] += n;
  }
  return out;
};

async function main() {
  const projects = readDir('content/projects', validateProject);
  const people = readDir('content/people', validatePerson);
  const errors = [...projects.errors, ...people.errors];
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  }

  const activity = repoActivity();
  const byLogin = new Map(activity.authors.filter((a) => a.login).map((a) => [a.login.toLowerCase(), a]));

  // 成员
  const peopleOut = [];
  for (const { id: login, data: p } of people.items) {
    log(`成员 ${login}`);
    const old = prevPerson(login);
    const oj = p.oj ?? {};
    const lg = oj.luogu ? await attempt(`洛谷 ${oj.luogu}`, () => luogu(oj.luogu), old?.oj?.luogu) : null;
    const lc = oj.leetcode ? await attempt(`力扣 ${oj.leetcode}`, () => leetcode(oj.leetcode), old?.oj?.leetcode) : null;
    const cfo = oj.codeforces ? await attempt(`CF ${oj.codeforces}`, () => codeforces(oj.codeforces), old?.oj?.codeforces) : null;
    const gh = await attempt(`GitHub 日历 ${login}`, () => githubCalendar(login), old?.github);
    const site = byLogin.get(login.toLowerCase());
    // “写代码”：有 GitHub 日历就用它（已经包含对本站的提交），否则用本站提交记录，避免重复计数
    const code = gh?.calendar && Object.keys(gh.calendar).length ? gh.calendar : site?.days ?? {};
    const practice = mergeCal(lg?.calendar, lc?.calendar, cfo?.calendar);
    const totals = {
      code: sum(code), site: site?.commits ?? 0,
      luogu: sum(lg?.calendar), leetcode: sum(lc?.calendar), codeforces: sum(cfo?.calendar),
    };
    for (const o of [lg, lc, cfo, gh]) if (o?.calendar) delete o.calendar;
    peopleOut.push({
      login, name: p.name, major: p.major ?? null, grade: p.grade ?? null, bio: p.bio ?? null,
      links: p.links ?? {}, joined: p.joined ?? null,
      avatar: `https://avatars.githubusercontent.com/${login}?s=160`,
      oj: { luogu: lg, leetcode: lc, codeforces: cfo },
      githubCalendar: Boolean(gh && !gh.error && !gh.stale),
      series: { code: toSeries(code), oj: toSeries(practice) },
      totals,
    });
  }

  // 项目
  const projectsOut = [];
  for (const { id: slug, data: p } of projects.items) {
    const old = prevProject(slug);
    const repo = p.links.repo
      ? await attempt(`仓库 ${p.links.repo}`, () => repoStats(p.links.repo), old?.repo)
      : null;
    projectsOut.push({ slug, ...p, repo: repo?.error ? null : repo });
    if (!OFFLINE && p.links.repo) await sleep(TOKEN ? 100 : 700);
  }

  // 贡献者：本站提交 + 本校项目作者
  const contributors = activity.authors
    .map((a) => {
      const person = a.login && peopleOut.find((p) => p.login.toLowerCase() === a.login.toLowerCase());
      return {
        login: a.login, name: person?.name ?? a.name, commits: a.commits, last: a.last,
        avatar: a.login ? `https://avatars.githubusercontent.com/${a.login}?s=96` : null,
        member: Boolean(person),
      };
    })
    .sort((a, b) => b.commits - a.commits);

  const out = {
    version: 1,
    generated: new Date().toISOString(),
    categories: CATEGORIES,
    range: { start: START, days: DAYS },
    site: { series: toSeries(activity.days), total: sum(activity.days), contributors },
    people: peopleOut,
    projects: projectsOut,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  log(`写入 ${OUT}：${projectsOut.length} 个项目，${peopleOut.length} 位成员，本站 ${out.site.total} 次提交`);
}

export { luogu, leetcode, codeforces, repoStats };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
