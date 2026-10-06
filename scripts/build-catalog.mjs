// 生成 public/data/cet4.json 与 cet6.json 的考次骨架。
// 只描述"哪一年哪一次考试有哪几套卷子"，资源链接（paper/answer/audio）留空，由内容接入方填写。
// 已存在的 JSON 中填好的资源会被保留，重新运行不会覆盖。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

// 记法：'1L' = 第1套含听力；'3' = 第3套；'2-3' = 第2-3套合卷；后缀 '!' = 目前公开渠道无答案
const STD = ['1L', '2L', '3'];
const catalogs = {
  cet4: {
    name: '大学英语四级',
    short: '四级',
    sessions: {
      '2026-06': STD,
      '2025-12': STD, '2025-06': STD,
      '2024-12': STD, '2024-06': STD,
      '2023-12': STD, '2023-06': STD, '2023-03': ['1L', '2-3'],
      '2022-12': STD, '2022-09': ['1L', '2-3'], '2022-06': STD,
      '2021-12': STD, '2021-06': STD,
      '2020-12': ['1L', '2L', '3!'], '2020-09': ['1L', '2', '3!'], '2020-07': ['1L'],
      '2019-12': STD, '2019-06': STD,
    },
  },
  cet6: {
    name: '大学英语六级',
    short: '六级',
    sessions: {
      '2026-06': STD,
      '2025-12': STD, '2025-06': STD,
      '2024-12': STD, '2024-06': STD,
      '2023-12': STD, '2023-06': STD, '2023-03': ['1L', '2-3'],
      '2022-12': STD, '2022-09': ['1L', '2-3'], '2022-06': ['1L', '2-3'],
      '2021-12': STD, '2021-06': STD,
      '2020-12': ['1L', '2L', '3!'], '2020-09': ['1L', '2', '3!'], '2020-07': ['1L!'],
      '2019-12': STD, '2019-06': STD,
    },
  },
};

mkdirSync('public/data', { recursive: true });

for (const [exam, cat] of Object.entries(catalogs)) {
  const path = `public/data/${exam}.json`;
  const prev = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const prevSets = new Map();
  prev?.sessions?.forEach((s) => s.sets.forEach((t) => prevSets.set(t.id, t)));

  const sessions = Object.entries(cat.sessions).map(([key, codes]) => {
    const [year, month] = key.split('-').map(Number);
    const sets = codes.map((code) => {
      const noAnswer = code.endsWith('!');
      const c = code.replace('!', '');
      const listening = c.endsWith('L');
      const num = c.replace('L', '');
      const id = `${exam}-${key}-${num}`;
      const old = prevSets.get(id);
      return {
        id,
        label: `第${num}套`,
        listening,
        resources: old?.resources ?? { paper: null, answer: null, audio: null },
        practice: old?.practice ?? null,
        ...(noAnswer ? { note: '暂无公开答案' } : {}),
      };
    });
    return { id: `${exam}-${key}`, year, month, sets };
  });

  const out = { version: 1, exam, name: cat.name, short: cat.short, sessions };
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  const n = sessions.reduce((a, s) => a + s.sets.length, 0);
  console.log(`${path}: ${sessions.length} 个考次, ${n} 套`);
}
