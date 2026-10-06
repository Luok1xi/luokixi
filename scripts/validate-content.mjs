// 校验 content/ 下的投稿。在 Pull Request 里自动运行，也可以本地运行：node scripts/validate-content.mjs
//
// 额外规则（仅在 CI 里，设置了 PR_AUTHOR 时生效）：
//   content/people/<login>.json 只能由 <login> 本人新增、修改或删除；
//   仓库所有者和协作者（PR_ASSOCIATION 为 OWNER / MEMBER / COLLABORATOR）不受此限。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validateProject, validatePerson } from '../src/js/schema.js';

const problems = [];

for (const [dir, validate] of [['content/projects', validateProject], ['content/people', validatePerson]]) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) {
      problems.push(`${dir}/${f}：只接受 .json 文件`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
    } catch (e) {
      problems.push(`${dir}/${f}：JSON 格式错误（${e.message}）`);
      continue;
    }
    for (const err of validate(f.slice(0, -5), data)) problems.push(`${dir}/${f}：${err}`);
  }
}

const author = process.env.PR_AUTHOR;
const trusted = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(process.env.PR_ASSOCIATION ?? '');
if (author && !trusted) {
  const base = process.env.BASE_SHA ?? 'origin/main';
  const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const path of changed) {
    const m = path.match(/^content\/people\/([^/]+)\.json$/);
    if (m && m[1].toLowerCase() !== author.toLowerCase())
      problems.push(`${path}：名录只能由本人提交（这个 PR 来自 @${author}）`);
  }
}

if (problems.length) {
  console.error(`发现 ${problems.length} 个问题：\n${problems.map((p) => `  · ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('内容校验通过 ✓');
