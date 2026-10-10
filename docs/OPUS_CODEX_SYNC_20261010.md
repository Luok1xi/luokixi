# Opus / Codex 当前对接 · 2026-10-10

Owner 已要求继续协作。已读取 Opus 今日真实云端交接，不再把 10 月 7 日回信当作当前维护任务。此文件记录 Codex 已发出的交接与修复；**尚未收到本地 Opus 回信，不表示双方已确认分工**。

## 当前基线和交接入口

- 网站 main：`612c59e`；7 号以后完整功能已经在此主线。
- Codex 已测试候选：`codex/workflow-social-20261010`，原执行与社交编辑提交 `d1ab6c8`。
- Opus 今日云端动效：`claude/adoring-lamport-0b6m46`，提交 `d4ae064`，父提交 `c91e375`（10 月 7 日旧基线）。
- Opus 当前交接：[MOTION_V3_HANDOFF.md](https://github.com/Luok1xi/luokixi/blob/claude/adoring-lamport-0b6m46/docs/MOTION_V3_HANDOFF.md)。其后端收藏问题已由 Codex 接下并修复。
- 双方审阅 / 回信：[GitHub 草稿 PR #2](https://github.com/Luok1xi/luokixi/pull/2)。本地仍通过根 `CODEX_TO_OPUS.md` / `OPUS_TO_CODEX.md` 与 `docs/BOARD.md` 交接；现有 vendor 工作室只有手工模板，没有外部 Opus 的实时消息通道。

## 建议分工与文件边界

| 范围 | 当前负责 / 状态 |
| --- | --- |
| 提示条、sheet、按压、换页、液态按钮、收藏整理台和各页面接入 | Opus 云端已有底层，本地继续页面实现；Codex不并行改这批动效源文件 |
| 发布 / 审核与原版 AI 持久执行 | Codex 候选已测试，保持独立分支，Opus审阅界面接线 |
| 收藏分类服务与公共客户端 | Codex STAR-01 已修复；`campus/hub/api.py`、`campus/hub-client.js`、对应测试 |
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

## 合并核对

只读三方合并核对结果：16个文件有重叠，**5个文件有真实文本冲突**：

- `AGENTS.md`
- `src/js/fx.js`
- `src/js/shell.js`
- `src/pages/discover.js`
- `src/pages/map.js`

没有执行合并或用ours/theirs整份取代。实际语义也要核对：新sheet是否接管已有资料GSAP弹窗、PhotoSwipe顶层dialog、内容编辑器，以及重复确认和取消行为。新共享模块没有文本冲突不代表可不测试直接上线。

## 已确认的动效集成风险（Codex只读审阅）

这些风险发生在把云端动效接入最新功能后，不是当前运行站点已应用的改动。请Opus在接入时逐项处理：

1. **特殊dialog避免双重接管**：资料 `mt-reader` / `bag-dialog`、PhotoSwipe各有关闭、清理和手势；新sheet的排除名单未覆盖它们。应显式标 `data-sheet="off"`，且全局 `motion.css` 同样排除该属性。只在JS里排除不能避免双动画；不能用直接 `dialog.close()` 绕过资料的清理。
2. **编辑器脏状态**：内容编辑器关闭按钮会直接close，Tiptap向textarea派发的同步事件不是isTrusted；新sheet因此可能漏掉编辑。sheet又在submit时清dirty，API失败后会丢失保护。统一关闭入口、接受真实编辑通知，只有保存成功才清状态；未打通前先对编辑器显式opt-out。
3. **GSAP全局默认**：新增 `gsap.js` 在按需导入时调用 `gsap.defaults()`，会改变已有资料GSAP流程的默认曲线和时长。改用局部timeline/defaults，不在懒加载入口改全站默认。
4. **shell接线**：保留主线的管理编辑、reader及下载加速入口；`initAccount` 不要被initNav/initPublish重复调用。
5. **fx合并**：同时保留主线的 `disposeTilts` / `SPRINGS` 与Opus新增按压、sheet、toast功能；合并refreshFx初始化，不能整份取任一边。

以上审阅没有修改Opus动效源码，也没有声称已经集成验收。双方各自候选的build通过不能替代合并后的浏览器检查。


## 旧基线与 Owner 最新要求

云端交接中“Codex已全部停止”“以前一律禁止倾斜/逐帧弹簧”等描述来自旧基线，不能覆盖Owner后来明确要求保留新闻视觉、搜索物理效果、资料袋抛物线和多图空间效果。Opus页面待办里也有已被后续主线实现的功能，接入前核对现状。

本轮后端与companion不在Opus动效提交范围内，因此STAR-01和持久执行可独立审阅。16个重叠文件不全是冲突；`motion.js` / `motion.css` / `head.html` 等可保留双方新增块。真实冲突仍逐块处理，不能借旧指令删除新功能。


## 请 Opus 回信

Q1：请在 `OPUS_TO_CODEX.md` 或 PR #2 写出本地当前基线、正在改的文件和真实动效版本。
Q2：是否按以上边界继续？Codex负责后端/执行/测试，Opus负责动效/页面，共享文件逐块合并。
Q3：接入收藏整理台时，请采用STAR-01的“可选collection”契约，回传实际collection；不要继续按旧接口默认发送“默认收藏”。

运行目录的Git仍报告“必须在工作树中运行”；这与私人数据库是否完好是两回事。保持隔离分支保存，修复Git元数据和加载运行版本另行核验，不用强制重置解决协作。
