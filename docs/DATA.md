# 数据格式

## 2026-10-07：广场主题与模糊查询

`discover-filters.js` 在现有公开项目快照之上派生 CS/日常/嵌入式/AI 等浏览主题，保留原 category/shelf 与项目 identity；不改投稿分类枚举，不建立假项目。相同目录仅载入一次，页内词条、分类、隐藏名单共同过滤。`fuzzy-search.js` 和服务端 `search_matching.py` 统一别名/有限错拼原则，搜索排名不用于合并课程/版本身份。私人收藏/本机资料提示不上传；公开学习、校圈、口碑和仓库检索仍先遵守发布/权限边界。详见 [交接与验证](PLAZA_MOTION_SEARCH_2026_10_07.md)。


页面在运行时读取 `public/data/*.json`。改数据不需要改代码，也不需要重新构建页面结构，刷新即可。

## `cet4.json` / `cet6.json`

```jsonc
{
  "version": 1,
  "exam": "cet4",
  "name": "大学英语四级",
  "short": "四级",
  "sessions": [
    {
      "id": "cet4-2025-12",
      "year": 2025,
      "month": 12,
      "sets": [
        {
          "id": "cet4-2025-12-1",        // 稳定 ID，练习记录、错题本都靠它关联，不要改
          "label": "第1套",
          "listening": true,             // 这一套是否有独立听力
          "resources": {
            "paper": null,               // 试卷 PDF 的 URL
            "answer": null,              // 答案 PDF 的 URL
            "audio": null                // 听力音频的 URL（建议 mp3，≤ 20 MB）
          },
          "practice": null,              // 在线练习页 URL，例如 "practice.html?set=cet4-2025-12-1"
          "note": "暂无公开答案"           // 可选，显示在卡片右下角
        }
      ]
    }
  ]
}
```

- 资源字段为 `null` 时，卡片上的按钮显示为灰色的“即将上线”。填上 URL 之后，按钮会自动变成可点击状态。
- `practice` 有值时，卡片底部显示“在线练习”按钮。
- URL 可以是站内相对路径（如 `files/cet4/2025-12-1.pdf`），也可以是外部 https 链接。
- `scripts/build-catalog.mjs` 用来生成考次骨架。重新运行会**保留**已经填好的 `resources` 和 `practice`，只补齐缺失的考次。

## `school.json`

```jsonc
{
  "version": 1,
  "school": "中国矿业大学（北京）",
  "courses": [{ "id": "calc-a1", "name": "高等数学 A1", "subject": "calculus" }],
  "papers": [
    {
      "id": "exam-01",
      "course": "calc-a1",               // 对应 courses[].id
      "year": "2022-2023",               // 学年；无法确认时写“年份待核”
      "stage": "期末",                    // 期中 / 期末 / 课程考卷 / 扫描试卷 / 扫描合集
      "kind": "A卷 · 答案",
      "pages": 2,
      "hasAnswers": true,
      "scanned": false,                  // 扫描件（不可复制文字）
      "file": "files/school/exam-01.pdf"
    }
  ]
}
```

新增课程时，`courses` 里要加一项，同时在 `src/pages/school.js` 和 `src/pages/home.js` 的 `GLYPH` 表里给它配一个符号（可选，不配时默认显示 ∑）。

## `site.json`

首页倒计时用。`nextExam.date` 为 `YYYY-MM-DD`（按北京时间）。考试结束后改成下一次的日期；日期未公布时删掉 `date` 字段，倒计时会显示“下一次考试时间待公布”。

## 社区内容：`content/`

社区内容放在 `content/` 下，每个文件对应一个项目或一位成员，通过 Pull Request 提交。`npm run data` 会读取这些文件，再去各平台抓取数据，最后写入 `public/data/community.json`。前端只读这个汇总文件。校验规则都在 `src/js/schema.js`，前端表单、构建脚本和 PR 检查共用这一份。

### `content/projects/<slug>.json`

```jsonc
{
  "title": "Dummy 超迷你机械臂",          // ≤ 40 字
  "summary": "六轴桌面机械臂……",          // ≤ 120 字
  "category": "mech",                     // mech 机电 / embedded 嵌入式 / software 软件 / algo 算法 / course 课程资料 / research 科研
  "tags": ["机械臂", "STM32"],            // 可选，≤ 6 个
  "origin": "cumtb",                      // cumtb 矿大同学 / external 外部推荐
  "authors": ["github-login"],            // 本校项目必填：作者的 GitHub 用户名
  "credit": "稚晖君 peng-zhihui",          // 外部项目必填：原作者
  "links": {                              // 至少一个
    "repo": "https://github.com/…",       // GitHub / Gitee / GitLab / Codeberg，会自动抓取 Star、语言、许可证
    "hardware": "https://oshwhub.com/…",  // 立创开源、EasyEDA、GrabCAD、Printables……
    "video": "https://www.bilibili.com/…",
    "paper": "https://arxiv.org/…",
    "site": "https://…"
  },
  "year": 2026,                           // 可选
  "cover": "art/projects/xxx.webp"        // 可选；不填则按分类自动生成封面
}
```

### `content/people/<GitHub 用户名>.json`

```jsonc
{
  "github": "login",                      // 必须和文件名一致
  "name": "昵称或姓名",
  "major": "机械工程",                     // 可选
  "grade": 2024,                          // 可选：入学年份
  "bio": "一句话介绍",                     // 可选
  "oj": { "luogu": 123456, "leetcode": "slug", "codeforces": "handle" },  // 都可选
  "links": { "blog": "https://…", "bilibili": "https://…" },             // 可选
  "joined": "2026-10-06"
}
```

### `public/data/community.json`（自动生成，不要手改）

- `range`：`{ start, days }`，所有日历都按这个起点对齐，长度为 371 天（53 周）。
- `site`：本站的提交日历（`series`）、提交总数、贡献者列表。
- `people[]`：每位成员各平台的统计数据，以及两条日历：`series.code`（写代码）和 `series.oj`（刷题）。如果有 GitHub 贡献日历就用它（里面已经包含对本站的提交），没有就用本站的提交记录，避免同一次提交被算两遍。
- `projects[]`：项目原始信息，加上 `repo` 统计数据（Star、Fork、语言、许可证、最后推送时间）。
- 某个平台抓取失败时，沿用上一次的数据，并标记 `stale: true`，页面上会提示“显示的是上一次的数据”。

社区热力图的数值 = 本站提交 + 所有成员的刷题记录。成员的 GitHub 日历只显示在个人主页，不计入社区热力图。

## 校园地图数据

- `public/data/campuses.json`：两个校区的地图视野（中心点、外接矩形），来自 OpenStreetMap，只用来定位视野。
- `public/data/campus-map/<校区>.json`：`npm run map:data` 从 OpenStreetMap（Overpass）生成，**ODbL 1.0**，页面必须署名“© OpenStreetMap 贡献者”。`boundary` 是校园轮廓；`features[]` 的 `properties.kind` 为 `building / road / mainroad / path / green / water / pitch / track / sportsground / plaza / parking`，楼另有 `use`（用途）、`levels`（层数，可能没有）、`center`；校外道路带 `context: true`。`pois[]` 是校门和带名字的设施。
- `public/data/campus-map/overrides.json`（可选）：按 OSM id 更正楼的用途、名称、层数，每条必须有 `source`。
- `public/art/campus-map/manifest.json`：Codex 交付的重绘插画清单，格式见 `docs/CAMPUS_MAP_ART.md`。
- 个人数据（学院、专业、课表、到过的楼）只存在浏览器的 `localStorage`（键 `luokixi.campus.me`），不上传。


## 2026-10-07 资料套件与私有结构化题目

LibraryCollection 使用不可混淆的 group_key：cet4/cet6 + 年 + 月 + 明确套号；范围套卷自成一套，未归组原件独立。保存 files/roles/missingRoles/原件 ID 与元数据，不推测答案配对。QuestionPaper 为用户私有文档，保存 source_meta、selected_pages、raw_text、extracted_pages、questions、review、revision；QuestionRevision 记录编辑版本。OCR 结果与人工改动均保留可追溯页码，审核只表示规则通过；公开发布继续走既有公共审核。
