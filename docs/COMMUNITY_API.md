# 共创功能接入说明（给 Opus）

当前只实现内容数据、后端和无排版的前端适配器。**最终共创页尚未由 Opus 接入，不应把接口验收等同于整页验收。** 新内容不会自动更改原首页、导航、知识库或动画。

## 文件

- `campus/community.py`：本机项目/题解投稿、核对、讨论、贡献统计、公开仓库核对。
- `campus/community-client.js`：`communityApi`、`loadCommunity()`、投稿文件导入/导出辅助。
- `src/js/community-notebook.js`：浏览器本地题目足迹、收藏、平台主页链接与备份。
- `public/data/community.json`：已核对的外部参考项目，不计入校园贡献。
- `public/templates/PROJECT_README.md`：项目说明模板。
- `docs/proposals/community-structure.html`：只作栏目与表单内容草稿。没有 JS/CSS，不是可发布页面。

## 接入时建议

```js
import { loadCommunity, communityApi, makeSubmissionFile, readSubmissionFile } from '../../campus/community-client.js';
import { createNotebook } from '../js/community-notebook.js';

const state = await loadCommunity();
// references: 外部参考；published: 静态目录中的其他作品；catalogue: Opus 原始完整目录。
// entries: 本机投稿（含 pending/rejected）
// 公开项目列表必须只用 status === 'approved' 的 entries。
// topics: 本机讨论；activity: 真实事件统计；connected: 服务可用性。
const notebook = createNotebook();
```

`loadCommunity()` 在静态站点只读 `data/community.json`，**零 API 请求**，`activity=null`；不能把 null 展示为“全站 0 位贡献者”，应解释数据尚未连接。本机服务无法连接时仍返回外部目录与明确 notice。

浏览器笔记模块不依赖服务器，在静态站也能用。题目完成状态是自评，不是从洛谷或力扣同步。保存失败会抛错，页面需展示错误，不可显示成功。页面没有内建登录或账号认证。

已适配 Opus 当前 `build-community.mjs` 输出：保留全部原字段，并映射 slug→id、links.repo→url、credit→author、repo.license→license、origin→external。`people` / `site` / `range` 等仍在 catalogue 内，由 Opus 现有页面使用。不会重写生成器或覆盖其目录。

你现有 `src/js/community.js` 中的 `loadCommunity()` 继续读取公开目录。若同一页面需要本机工作台，可将本文件导出别名为 `loadCommunityWorkbench`，避免与原导入重名；无需替换现有辅助函数。

## 项目/题解提交

`communityApi.submit(data)`：

```json
{
  "kind": "project",
  "title": "课程项目名称",
  "summary": "至少 8 个字符，说明解决什么问题",
  "category": "机电与机器人",
  "author": "作者或团队署名",
  "url": "https://github.com/owner/repository",
  "tags": ["STM32", "控制"],
  "license": "未说明",
  "body": "详细说明或自己的解题思路",
  "setup": "复现条件、边界情况",
  "needs": "希望得到的帮助",
  "rightsConfirmed": true
}
```

- `kind`：project / solution。
- `category`：机电与机器人 / 软件与 AI / 课程与资料 / 算法与编程 / 其他。
- 项目 URL 支持四个托管平台的 owner/repository 首页；题解 URL 支持洛谷原题与力扣原题。
- 相同项目来源不能重复提交；同一原题可由不同署名贡献不同解法，同署名重复来源被拦截。
- 成功返回 `{id,status:'pending'}`。所有正文作为纯文本处理；用 textContent 或严格转义渲染，不直接 innerHTML。
- `makeSubmissionFile(entry)` 生成 JSON 投稿文件；`readSubmissionFile(raw)` 只恢复填写字段，丢弃 status/approval/role。重新导入要再次确认权限，不直接批准。

本机维护核对：`review(id,'approved','说明',true)`；退回：`review(id,'rejected','具体原因')`。目前没有公共角色权限，因此仅绑定本机，禁止直接公开管理按钮。

## 仓库信息核对

`inspectRepository('https://github.com/owner/repo')` 返回 name、description、url、license、language、stars、forks、openIssues、archived、updated、checked、cached。

请求固定为 GitHub 公开 REST 地址，15 分钟缓存，超时/限流/私有或不存在的仓库给明确错误。不得借此标记“作者身份已验证”；不要把缺失许可自动填 MIT。其他托管平台目前只接链接，由维护者人工核对。

## 讨论

- `addTopic({title,category,author,body})`，category 为提问 / 协作招募 / 资料纠错 / 想法。
- `topic(id)` 取详情与回复。
- `reply({topic,author,body})` 新增回复。
- `acceptReply(topicId,replyId)` 将同一讨论的回复设为采纳，讨论变为 solved，贡献只记一次。
- `closeTopic(id)` 关闭讨论，拒绝继续回复。

这些操作目前都是本机维护工作台操作，不是已上线的公共论坛权限模型。

## 贡献日历

`state.activity` 包含 days（182 项 date/count）、total、activeDays、contributors（自填署名/count）、events（最多 80 条）、timezone、definition。

按服务端核对/采纳时间归档，使用 Asia/Shanghai。前端不能修改贡献日期与数量。每个收录或被解决讨论只计一次。空记录真实为空，不生成随机格子。这个日历是本站贡献，不是 GitHub 贡献图。

布局自行设计：建议日期和数量可被键盘与读屏读取，选择日期显示具体事件；较旧明细尚无分页接口，当前返回最近 80 条。

## 个人足迹

```js
notebook.addProblem('https://www.luogu.com.cn/problem/P1001', 'A+B');
notebook.updateProblem(url, {status:'review', note:'边界情况还要再练'});
notebook.toggleProject('https://github.com/owner/repo');
notebook.setProfiles({github:'https://github.com/name',luogu:'https://www.luogu.com.cn/user/123',leetcode:'https://leetcode.cn/u/name'});
const backup = notebook.export();
notebook.import(backup);
```

status：todo / review / solved（自评）。数据键 `luokixi.community.notebook.v1`。导入严格验证，按原题 URL 去重并保留当前笔记，不覆盖已有记录。不伪造平台账号认证；不读取 cookies、成绩或私有数据。

## API 路径

| 方法 | 地址 | 作用 |
|---|---|---|
| GET | `/api/community` | 本机投稿、讨论与贡献总览 |
| GET | `/api/community/repo?url=...` | 公开 GitHub 仓库核对 |
| GET | `/api/community/topic?id=...` | 讨论详情与回复 |
| POST | `/api/community/submit` | 项目/题解进入待核对 |
| POST | `/api/community/review` | 收录或退回 |
| POST | `/api/community/topics` | 创建本机讨论 |
| POST | `/api/community/replies` | 创建回复 |
| POST | `/api/community/topic-action` | 采纳/关闭 |

所有 POST 沿用 JSON 与 `X-Campus-Request: 1`，服务只监听 127.0.0.1。完整数据库备份需停止服务后复制 `.data/`；现有“复习卡备份”不包含社区表，个人足迹单独导出。

## 验证与后续

后端测试从 `campus/` 执行 `python -m unittest discover -s tests -p 'test_*.py' -v`。
足迹测试从根目录执行 `node --test campus/tests/test_notebook.mjs`。
适配器浏览器验证：先执行 `node campus/tests/build_community_test.mjs`，再执行 `python campus/verify_community.py`。使用临时库，不污染真实投稿与贡献。

Opus 页面接入后仍须做整页验收：投稿字段错误/成功/重复、核对后计数、讨论采纳、收藏与笔记刷新、深浅色、390px、键盘、静态站零 API。当前验证不替代这些最终页面检查。


## 校园建筑名称（2026-10-07）

`GET /api/hub/map/names?campus=xueyuanlu`（或 shahe）返回 `{campus, buildings: {"way/...": {preferred, total, names: [{name, votes}], mine?}}}`。匿名可读，mine 仅登录本人可见，不返回投票者身份。

`POST /api/hub/map/names` 使用 hubApi.request，内容为 `{campus, osm, name}`。需要登录且验证邮箱、地图中真实的校内建筑；名称不超过 40 字符，每账号每栋楼唯一选择，空名称表示撤回，每小时 30 次限制。返回 `{ok: true}` 后重新 GET 聚合。名称是学生常用名，不覆盖官方/OSM 来源名称；统计来自真实存储记录。静态或服务不可用时保持原地图名称。


## 2026-10-07 资料整理与识题工作台（实现接口约定）

GET /api/library/collections 为本机只读资料套件与实际缺件报告。GET /api/hub/question-papers/capabilities 返回本机识题能力；GET/POST /api/hub/question-papers 列出本人资料/创建识别任务，sourceKind=text/upload/local，文本或本人 uploadId/受信本机 documentId，选页上限 12 页。GET /api/hub/question-papers/{id} 与 POST /api/hub/question-papers/{id}/save 只限本人，保存带 revision 防止覆盖。字段 questions 支持题干、选项、答案、解析、知识点、来源与疑点；保存后规则复核并归类本人架。GET /api/hub/question-papers/{id}/source?page=1 返回本人源页预览。新任务 Job kind=question-process，仅此类可在 review-mode 中运行，不触发全部后台任务。


补充：POST /api/hub/question-papers/import-source 只接受已登记 bankId；保留署名/许可/固定版本，精确幂等导入到本人题架。question-process 在 review-mode 中执行，5分钟超时任务按最多3次恢复，旧处理结果受时间戳隔离；正常明确失败不冒充成功。
