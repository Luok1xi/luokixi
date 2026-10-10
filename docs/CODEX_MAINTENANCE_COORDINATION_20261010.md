# Codex 与 Opus 维护协作核对 · 2026-10-10

本文件以下是首次核对的历史快照。后续已收到 Opus 第 20 次本地回信，双方确认分工，STAR-01 `1a314e0` 已由她合入 `opus/motion-v3`（`79ad90a`）。当前交接、STAR-02 和实际整合进度以 [当前对接](OPUS_CODEX_SYNC_20261010.md) / [PR #2](https://github.com/Luok1xi/luokixi/pull/2) 为准；下文“尚未确认”仅描述首次核对时的情况。

Owner 要求检查 Opus 最新交接，避免两边维护工作互相覆盖。本轮 Codex 改动目前仅在隔离源码目录，尚未同步到运行站点、合并 main 或重启真实服务。已有成果保留。

Owner 随后说明今日交接误放在云端，要求先继续编写，稍后提供位置。候选实现、依赖安装与隔离验收已经完成，准备独立分支保存；此文件不代表 Opus 已确认分工。

## 已读取的真实交接

- 本机 `OPUS_TO_CODEX.md`：最新正文是 10 月 7 日第 19 次回信，搜索浮层和搜索接口分工；它不是今天维护任务的认领。
- GitHub `Luok1xi/luokixi`：main 为 `612c59ec25d92401569e812d4b66c52c06dc2ba9`；main 的回信和看板与本机一致，最新完整交接来自 Codex。
- GitHub `claude/friendly-archimedes-ghtyqn`：`0a759b1f0d2b5d0b1c46fc771be7d396cdedc4c8`，10 月 7 日光碟架及浏览量提交；该分支交接正文仍是历史记录，不能用作今天的分工。
- GitHub `campus-companion`：Claude 分支仍为 `d5ca8d3feab76271049868ed5f56ce85ac45cadb`，与当前网站记录的导入基线相同。
- GitHub `opus-codex-studio`：main 为 `707284eff2757470e2df26a87782cee8a658f770`，10 月 8 日的框架源码整理提交。
- 查询时网站没有打开中的 PR。未发现今日新交接不代表 Opus 没有在工作；Owner 已确认今日交接在云端，稍后提供。

## Codex 当前隔离改动与待核对范围

隔离目录：`C:\Users\user\Documents\Codex\2026-10-07\cha\git-save-20261009`。这里与实际运行项目不同。完整实现、测试和合并清单见同一候选分支的 [本轮交接](WORKFLOW_SOCIAL_HANDOFF_20261010.md)。

| 范围 | 已写入的候选内容 | 合作边界 |
| --- | --- | --- |
| `campus/hub/content_management.py`、`core.py`、`studio_workflow.py`及对应测试 | 锁定后核对版本、公开结果凭据、失败证据；plain/markdown 字段 | 与 Opus 维护工作可能重叠；定位新交接前保持隔离 |
| `campus/companion/website-{host,jobs,maintenance,workflow,langgraph,checkpointer}.mjs`、`src/agent.mjs` | 持久输入/阶段、稳定操作编号、LangGraph 编排及回执信息 | 与 Opus 执行维护可能重叠；取得交接后逐块整合 |
| `src/js/content-editor.js`、`rich-body.js`、`src/pages/circle.js`、`rich-body.css` | Tiptap 编辑，原文入口与统一正文格式 | 发布接口沿用现有管理服务；circle.js 也是共享文件，合并前核对 |
| `src/js/photo-viewer.js`、`src/styles/photo-viewer.css`及浏览器脚本 | PhotoSwipe 大图查看、嵌套弹窗、手势、焦点返回 | 多图纵深轨道、九图上传和角色演出沿用原组件 |
| 根 `package.json` / `package-lock.json` | PhotoSwipe 5.4.4，Tiptap 3.31.4 依赖已安装 | 公共依赖文件须合并双方版本，不覆盖整份清单 |
| `campus/companion/package.json` / `package-lock.json` | LangGraph 1.4.21，checkpoint 1.1.4 已安装 | 复用原角色 SQLite；不创建第二份人格或记忆 |
| `campus/hub/api.py`、`campus/server.py`、两个启动器 | 管理版本 2，角色桥接版本 29 | 同步健康检查标识，启动器仅解析检查，未执行 |

## 合并与运行规则

1. 拿到 Opus 最新工作目录或分支后，先读她的认领、基线与真实变更，再逐文件比较。旧交接不当作当前认领或释放证明。
2. 同一维护文件指定一位实际编辑者；另一方做审阅、测试或提供小补丁。共享接口与字段先记录，分别从同一个基线实现。
3. 保持一个内容发布服务、现有任务/回执和原版双角色。新的工作流只管理已选任务的执行状态，不建立第二份人格、长期记忆或发布数据库。
4. 测试用隔离库和端口；真实站点由一次整合后的加载操作更新。双方不各自重启同一服务，也不将自己的隔离空库替换真实库。
5. 合并前保存双方改动；先隔离测试、构建与浏览器核对，再更新运行站点并记录版本。成功以实际工具和公开读回结果为依据。

## 已完成验收与验证边界

此前安装失败已解决：审批服务恢复后固定版本依赖安装完成；SQLite checkpoint 使用原 Node SQLite 连接，不再安装第二份原生扩展。LangGraph 实际包与文件库完成 7 项恢复测试。

Django 92 项、Node 37 项检查通过；Edge 图片查看 6 组、正文编辑 4 组场景通过，全站构建和启动器语法检查通过。没有付费模型测试，没有写入真实私聊、人格卡、记忆或资料数据库，没有替换当前运行网站。详细限制与复测方法在候选交接中记录。

这份文件为 Codex 的当前范围与状态，尚不是 Opus 已确认的双方分工。
