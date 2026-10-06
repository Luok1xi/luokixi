# 协作说明（Codex / Claude）

## 2026-10-06 最新授权与交付：v0.2

用户后来明确要求 Codex 接手全站重排，重点为 Collins Carousel、地图、资料袋、校圈、开源竖滑流与 AI 工作室；完成后只公开 Luokixi GitHub 仓库链接，不部署在线网站。**该最新授权优先于下方历史“仅规划”“前端仅 Opus”“不上传”的本轮限制。**

本版功能、验收和未接入项统一见 [v0.2 验收记录](docs/RELEASE_0_2.md)。跨页面变更先更新共享交接，避免覆盖并行修改。保留六板块与学习引导定位；不伪造用户、评价、题库、校园地理、预约成功或模型回复。

Luokixi 是面向中国矿业大学（北京）的学习引导与创作社区，使用 Vite 多页前端与 Django 社区后端。辅导通过外部网站提供；原有练习记录保留。纯静态部署提供只读内容。

**Owner 2026-10-06 最新分工（下午再次确认，直接告诉 Opus）：页面设计、排版、导航、样式、交互与动画由 Opus 负责；美术与一切图片素材（插画、配图、图标位图、分享图）由 Codex 负责，Opus 按 `docs/ART_DIRECTION.md` 审稿；数据、功能代码、接口、权限、测试与文档由 Codex 负责。设计方向：排版参照虎扑，界面风格参照 App Store（见 `docs/DESIGN.md` 第三版）。** reputation.html、src/pages/reputation.js、src/styles/reputation.css 的功能基线已交给 Opus。

**本轮要求：先理清各模块效果，再开始制作。** 当前范围统一到 [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md)，状态为统一整理草案；本轮不新增业务代码。它替代第 21–24 次交接的平行总计划和历史调研路线图。美术归属已由 Owner 直接确认：图片归 Codex，设计与动画归 Opus（见上）。后续变更写回统一规格，再在看板安排任务。

阅读顺序：

- `docs/PRODUCT_SPEC.md`：模块效果、现状、边界、分期与验收；新开发先看
- `docs/BOARD.md`：引用模块编号的工作安排；旧表不是自动执行指令
- `docs/DESIGN.md`：设计变量、组件、动效原则
- `docs/DATA.md`：真题目录与资料的 JSON 格式
- `docs/RESEARCH.md`：历史调研与来源；其中旧路线图不再控制当前开发

## 历史分工（仅存档，以上方最新分工为准）

| 领域 | 负责 | 主要文件 |
|---|---|---|
| 页面结构、设计系统、动效 | Claude | `src/styles/*`、`src/js/{intro,gallery,localnav,shell,heatmap,cover,search}.js`、`src/pages/home.js` 的动效部分 |
| 社区功能（开源广场、社区、成员主页、投稿） | Claude | `projects.html` `community.html` `profile.html` `contribute.html`、`src/pages/{projects,community,profile,contribute}.js`、`src/js/{schema,community}.js`、`scripts/{build-community,validate-content}.mjs`、`content/` |
| 美术素材（插画、配图、图标、分享图） | **Codex** | `public/art/`、`public/og.png` |
| 学习功能（资源接入、在线练习、错题本） | **Codex** | `public/data/{cet4,cet6,school}.json`、新增的 `practice.html` 与 `src/pages/practice.js` |
| 全校知识库后端 | **Codex** | `campus/`、`knowledge.html`、`src/pages/knowledge.js`、`src/styles/knowledge.css` |

需要改到对方负责的文件时，请保持改动最小，并在提交说明里写清楚原因。

## 约定

- 颜色、字号、圆角一律用 `tokens.css` 里的变量；新页面复用 `components.css` 里的组件。
- 新动画遵守 `docs/DESIGN.md` 的“动效原则”：只动 transform 和 opacity，循环动画加 `data-live`，尊重“减少动态效果”。
- 不要把文案写死在 JS 里冒充数据；统计数字一律从 JSON 计算。
- 不要提交 `public/files/`（校内试卷 PDF 是否公开还没定）、API key、`.secrets` 之类的文件。
- 原创题目和真题要分开标注，不要把原创题说成真题。
- 提交前运行 `npm run build`，确保构建通过。

---

## 历史 Codex 任务清单（仅存档，不作为本轮待办）

### A. 美术素材

所有图片放在 `public/art/`，格式用 webp（照片类）或 svg（图标类），单张尽量不超过 200 KB。风格参照 apple.com 的产品图：柔和布光，纯白或纯黑背景，主体居中，**画面里不要出现文字**（文字由页面排版负责）。点缀色只用招牌渐变色系：`#0894ff` `#c959dd` `#ff2e54` `#ff9004`。

1. **分享图** `public/og.png`（1200×630）：深色背景，配一组试卷纸的等轴爆炸图，和首页首屏呼应。完成后在 4 个 HTML 的 `<head>` 里补上 `og:image`、`og:title`、`og:description`。
2. **触屏图标** `public/apple-touch-icon.png`（180×180），沿用 `public/favicon.svg` 的折线标志。
3. **矿大课程插画** `public/art/course-{calc-a1,calc-a2,linalg}.webp`（800×600，深色背景）。首页深色段的三张课程卡片和 `school.html` 会用到；接入位置是 `.course-glyph`，可以改成 `<img>`。
4. **便当格插画（可选）**：“错题本”和“零门槛”两张卡片现在是纯 CSS 图形，可以换成更精致的插画（600×400，浅色和深色各一张）。

5. **开源分类主视觉**（新增）`public/art/projects/category-{mech,embedded,software,algo,course,research}.webp`（1600×1000，纯黑背景）。参照苹果产品图：单个主体居中，柔和轮廓光，可以带一点招牌渐变色的反光。
   - 机电：一台小型机械臂或一组精密齿轮
   - 嵌入式：一块斜放的电路板，带芯片和排针
   - 软件：几块悬浮的半透明玻璃窗口
   - 算法：发光节点组成的立体图结构
   - 课程资料：一本摊开的书，书页翻起
   - 科研：显微镜，或分子结构模型

   这些图做好后，给对应分类的外部项目和没有封面的本校项目当默认封面：在 `src/js/cover.js` 的 `coverHTML()` 里加一层判断即可，保留现在的生成式封面作为兜底。
6. **社区首屏氛围图（可选）** `public/art/community-hero.webp`（2400×1200，深色）：等轴视角的发光城市，柱子用招牌渐变色，和 `heatmap.js` 的 3D 城市风格一致。只用作页面背景氛围，**不能代替真实数据**。
7. **空状态插画**（可选）`public/art/empty-{board,projects,contributors}.svg`：线稿风格，单色，用 `currentColor`，以便适配深浅色。

### B. 学习功能

1. **真题资源接入**：按 `docs/DATA.md` 的格式，把试卷、答案、听力的 URL 填进 `public/data/cet4.json` 和 `cet6.json`，卡片会自动亮起来。
   - 音频转成 mp3（96–128 kbps），不要用 wav。
   - GitHub Pages 单个文件不能超过 100 MB，整个仓库建议控制在 1 GB 以内。大文件建议放到对象存储或 Release 附件里，JSON 里只写 URL。
   - 真题的版权归教育部教育考试院所有。接入前请先和仓库主人确认来源和公开方式。
2. **在线练习** `practice.html?set=<set id>`：可以参考旧项目 `C:\Users\user\Documents\Codex\2026-09-05\k-d\outputs\website\public` 里的考试引擎（计时、答题卡、交卷解析、localStorage 存档），按本仓库的设计系统重写界面。做好之后，在 JSON 里给对应的套卷填上 `practice` 字段。
3. **错题本与进度**：记录统一以套卷 `id` 关联，数据存在 localStorage，提供导出和导入。首页便当格里“整卷模拟”“错题本”两张卡片上的“开发中”标签，等功能上线后再去掉。
