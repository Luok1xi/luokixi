# Opus / Codex 当前对接 · 2026-10-10

Owner 已要求继续协作。已收到本地 Opus 第 20 次回信，并读取 10 月 10 日看板；**双方已确认分工，Opus 已把 Codex PR #2 的 STAR-01 合入她的整合分支**。双方通过项目交接文件与 PR 留下可核对的记录。

## 当前基线和交接入口

- 网站 main：`612c59e`；7 号以后完整功能已经在此主线。
- Codex 已测试候选：`codex/workflow-social-20261010`，原执行与社交编辑提交 `d1ab6c8`。
- STAR-01 已推送 `1a314e0`；Opus 本地 `opus/motion-v3` 已合入该提交，合并版本 `79ad90a`。
- Opus 实际工作副本：`C:\Users\user\Documents\GitHub\luokixi\.claude\worktrees\motion-v3`。先合入本地主线 `12d153f` 和云端动效（`33209db`），随后完成整理台 `16422a7`、首页 `db532a7`、资料 `1e78e62`；目前正在写校圈 / 口碑，以实时看板认领为准。
- Opus 今日云端动效：`claude/adoring-lamport-0b6m46`，提交 `d4ae064`，父提交 `c91e375`（10 月 7 日旧基线）。
- Opus 当前交接：[MOTION_V3_HANDOFF.md](https://github.com/Luok1xi/luokixi/blob/claude/adoring-lamport-0b6m46/docs/MOTION_V3_HANDOFF.md)。其后端收藏问题已由 Codex 接下并修复。
- 双方审阅 / 回信：[GitHub 草稿 PR #2](https://github.com/Luok1xi/luokixi/pull/2)。本地仍通过根 `CODEX_TO_OPUS.md` / `OPUS_TO_CODEX.md` 与 `docs/BOARD.md` 交接；现有 vendor 工作室只有手工模板，没有外部 Opus 的实时消息通道。

## 已确认分工与文件边界

| 范围 | 当前负责 / 状态 |
| --- | --- |
| 提示条、sheet、按压、换页、液态按钮、收藏整理台和各页面接入 | Opus 云端已有底层，本地继续页面实现；Codex不并行改这批动效源文件 |
| 发布 / 审核与原版 AI 持久执行 | Codex 候选已测试，保持独立分支，Opus审阅界面接线 |
| 收藏分类服务与公共客户端 | Codex STAR-01 已修复；`campus/hub/api.py`、`campus/hub-client.js`、对应测试 |
| 收藏真实时间与查询性能 | Codex STAR-02 进行中；仅 `campus/hub/{api,core,star_collections,test_star_collections}.py`，前端无需更改调用契约 |
| `src/pages/circle.js`、`content-editor.js` 与依赖清单 | Codex已有Tiptap接线；Opus接sheet时逐块合并，保留原文入口、九图及发布服务 |
| 本地运行目录 | 不直接用云端整份覆盖；本轮未替换源码/构建，未重启服务，未写私人数据 |

后续任务认领只写当前实际编辑范围；历史“全部释放”不表示允许把旧版本整份替换新版本。

## STAR-01：收藏分类修复与接口契约

Opus 交接第 3.1 节提出的问题在两份本地源码仍然存在，现已在 Codex 候选修复：

- `hubApi.star(id, true)`：请求只发 `enabled`；已有收藏保留原分组，新收藏才用“默认收藏”。
- `hubApi.star(id, true, '嵌入式')`：显式改分组，服务返回实际 `collection`；使用返回值核对整理台状态。
- `hubApi.star(id, true, '默认收藏')`：仍可以主动移回默认，不把显式请求当作未填写。
- `hubApi.star(id, false)`：取消收藏；再次收藏为新记录。
- 空名、非文本或超过80字仍拒绝；不会破坏原分组。不同账号的收藏互不影响。

本轮实际验证：3 项 Django 隔离测试（新建/移动/重复/取消/账号隔离、非法名称、既有完整互动）、4 项客户端测试及生产构建通过。此前候选的92项Django、37项Node、7项LangGraph和10组浏览器验收记录见 [候选交接](WORKFLOW_SOCIAL_HANDOFF_20261010.md)。

## STAR-02：已完成的收藏时间与查询优化

`GET /api/hub/me` 的 stars 现携带 `starredAt=Star.created.isoformat()`，按 `-created, -pk` 排序，先过滤本人 / 已公开 / 非撤回内容，再取最多 200 条。资料本身更新不会改变收藏顺序。计数与本人关注在列表层批量读取，通过同一个 `entry_data` 输出原字段；其他调用的默认序列化不变。

隔离单项测试 9 项通过；内容管理、工作室恢复和本模块合计 49 项回归通过。查询计数实测：1 条和 12 条收藏均为 5 次查询，空列表 1 次。真实 GET/me 同时验证原 profile / entries / workspaces、匿名 401 和私有 / 撤回 / 他人收藏隔离；全站构建通过。未写真实数据、未调用付费模型、未重启服务。

已只读核对 Opus 固定提交 `b2d8e8f`：`me.js` 原样传 stars，整理台按响应顺序排列，不用内容 updated 重排，因此该后台修改与她的前端兼容。

### 合并后的复核结果（提交 b2d8e8f）

- PhotoSwipe 的 JS 排除及原清理 / 焦点恢复已保留；`motion.css:94–162` 的通用 dialog 动画尚未同步排除 `.photo-viewer-modal` 和 `[data-sheet="off"]`，需 Opus 在自身样式范围处理。
- `content-editor.js:38` 直接 close；`sheet.js:123` 在 submit 时清 dirty，富文本同步 input 又是非 trusted。建议将编辑弹窗整体 opt-out 或统一关闭 / 脏状态 / busy，仅保存成功才清状态；API 失败后的取消不能丢编辑。交由 Opus 逐块接入，Codex 不在她整合目录并行改。
- `gsap.js:17` 仍调用全局 `gsap.defaults`，旧资料动画有未显式设置曲线 / 时长的调用。应把新增动画默认值限制到局部 timeline；这是代码状态核对，未称为实际掉帧测量。

## 初次合并核对记录

云端动效与 Codex 候选初次三方核对有 16 个重叠文件，5 个文本冲突。**Opus 第 20 次回信说明已在整合提交 `33209db` 逐块解决**：

- `AGENTS.md`
- `src/js/fx.js`
- `src/js/shell.js`
- `src/pages/discover.js`
- `src/pages/map.js`

Codex 不重复合并云端分支。Opus 报告合并 PR #2 后，PhotoSwipe 6 组、正文编辑 4 组浏览器检查通过，并在 `sheet.js` 修正确认结果时机、排除 PhotoSwipe 弹窗；这些是她的验收记录。Codex 继续只读核对语义，双方已通过的检查不能替代最终统一版本验收。

## 已确认的动效集成风险（Codex只读审阅）

这些风险发生在把云端动效接入最新功能后，不是当前运行站点已应用的改动。请Opus在接入时逐项处理：

1. **特殊dialog避免双重接管**：资料 `mt-reader` / `bag-dialog`、PhotoSwipe各有关闭、清理和手势；新sheet的排除名单未覆盖它们。应显式标 `data-sheet="off"`，且全局 `motion.css` 同样排除该属性。只在JS里排除不能避免双动画；不能用直接 `dialog.close()` 绕过资料的清理。
2. **编辑器脏状态**：内容编辑器关闭按钮会直接close，Tiptap向textarea派发的同步事件不是isTrusted；新sheet因此可能漏掉编辑。sheet又在submit时清dirty，API失败后会丢失保护。统一关闭入口、接受真实编辑通知，只有保存成功才清状态；未打通前先对编辑器显式opt-out。
3. **GSAP全局默认**：新增 `gsap.js` 在按需导入时调用 `gsap.defaults()`，会改变已有资料GSAP流程的默认曲线和时长。改用局部timeline/defaults，不在懒加载入口改全站默认。
4. **shell接线**：保留主线的管理编辑、reader及下载加速入口；`initAccount` 不要被initNav/initPublish重复调用。
5. **fx合并**：同时保留主线的 `disposeTilts` / `SPRINGS` 与Opus新增按压、sheet、toast功能；合并refreshFx初始化，不能整份取任一边。

以上是初次审阅指出的接入风险，部分已由 Opus 在合并后修正；后续只读复核以实际提交为准，不把旧风险描述当成仍存在的确定故障。Codex 没有修改她的动效源码。


## 旧基线与 Owner 最新要求

云端交接中“Codex已全部停止”“以前一律禁止倾斜/逐帧弹簧”等描述来自旧基线，不能覆盖Owner后来明确要求保留新闻视觉、搜索物理效果、资料袋抛物线和多图空间效果。Opus页面待办里也有已被后续主线实现的功能，接入前核对现状。

本轮后端与companion不在Opus动效提交范围内，因此STAR-01和持久执行可独立审阅。16个重叠文件不全是冲突；`motion.js` / `motion.css` / `head.html` 等可保留双方新增块。真实冲突仍逐块处理，不能借旧指令删除新功能。


## Opus 已回复与下一步

首页 exam / open 重复图已核对：`scripts/art-assets.json:16` 明确将 hero-exam / hero-open-course 复用 study-still-life，manifest 同源。浙江大学课程攻略是静态最高星的 course 项目，因此出现重复。实际 `loadCommunity` 已为项目补充来源封面，但 `today.js` 的开源卡未使用；已给 Opus 建议优先真实项目 cover 并带出处，fallback 才用分类 art，真实 media 与 art 不叠加。Codex 未修改她认领的首页；仓库无另一张准确课程主题母图，不用错误学校标识替代。

Q1：第 20 次回信已给出 `opus/motion-v3` 的实际基线和文件认领；当前在校圈 / 口碑。
Q2：双方同意 Codex 负责后端 / 执行 / 测试，Opus 负责动效 / 页面，共享文件逐块合并。
Q3：整理台已采用 STAR-01 可选 `collection` 契约，以实际回传值确认移动、失败回退。

Opus 另提出真实 `starredAt`、320px 小封面、批量改名三个可选需求。STAR-02 收藏时间与批量查询已通过上述隔离验收；其余两项尚未实现。该版本推送同一候选分支并回信，由 Opus 合入。没有更换真实运行站点。

Opus 与 Codex 在正常本机权限下均核对运行目录 Git：工作树有效、`core.bare=false`。此前“必须在工作树中运行”来自 Codex 执行环境限制，不是元数据损坏；不重置仓库。私人数据库和实际运行加载仍独立核验。
