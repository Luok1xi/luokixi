# 维护执行与社交编辑候选交接 · 2026-10-10

后续补充：已收到 Opus 第 20 次本地回信并确认分工。STAR-01 `1a314e0` 的3项Django、4项客户端与构建检查通过，Opus 已将 PR #2 合入整合分支（`79ad90a`），完成收藏台、首页、资料；Codex 正在补 STAR-02 收藏时间与批量查询。当前实际进度见 [对接记录](OPUS_CODEX_SYNC_20261010.md) / [草稿PR #2](https://github.com/Luok1xi/luokixi/pull/2)。仍未更新运行站点，下文为首次候选交接的历史条件。

Owner 已说明 Opus 的今日交接误放在云端，要求 Codex 先继续编写，稍后提供位置。此版本基于 `612c59e`，保存在独立目录与分支，不直接覆盖运行项目或合并 main。本文是 Codex 的范围记录，不代表 Opus 已同意共享文件的分工。

## 已实现

1. 内容任务和工作室执行接入 **LangGraph 1.4.21**；执行者与回复者仍为原版 campus-companion，同一角色沿用原数据库、人设、情绪、记忆和预算。普通聊天不经过维护执行图。
2. 原数据库记录请求、执行阶段、稳定操作编号和回执；新 checkpoint 表复用 Node 24 的 SQLite，不另装 SQLite 原生扩展。并发重复请求共享一次执行；重启从原编号核验。已发送但结果不明的写入不重放；回复生成中断不重复付费调用。
3. 管理服务在取得写锁后再次核对版本与状态。发布／审核回执包含已保存的公开版本、可见状态和 `publication.verified`；模型口头承诺、其他工具成功、单项成功不能替代任务完成证据。
4. 工作室执行失败记录区分预算、权限、版本、参数、连接与执行错误。部分失败、缺失的机器人任务和未解决项保留；成功读取状态不能消除失败写入。同目标同操作取得成功回执后才清除对应失败。
5. **Tiptap 3.31.4** 按需加载到原页面编辑和校圈投稿，支持基础正文排版与原文入口。后台继续保存唯一文本正文及 `bodyFormat: plain|markdown`，不建立第二份 HTML 内容。打开原文不改变内容，旧数据不按 HTML 解析；恢复旧版正文可恢复原纯文本格式。复杂 Markdown 仍可用原文编辑；不承诺支持其全部语法，Markdown 扩展官方仍标记 beta。
6. **PhotoSwipe 5.4.4** 按需加载大图查看，支持 URL 数组与尺寸元数据、原图链接、中文控制、键盘、关闭后返回焦点、坏图和加载中取消、手机双指缩放。原九图 Uppy 上传和 Agrumea 风格多图纵深滑轨沿用现有组件。
7. 新版健康标识为 `managementVersion=2`、`bridgeVersion=29`；两个原启动器同步检查版本，以免重启时误认为旧后台已加载新功能。未在本轮执行这些启动器。

## 文件范围与合并边界

| 范围 | 文件 | 注意事项 |
| --- | --- | --- |
| 原版执行传输 | `campus/companion/website-{host,jobs,maintenance,workflow,langgraph,checkpointer}.mjs`、`src/agent.mjs`、对应测试 | 不复制或替换人设、记忆；工作流只负责任务传输与证据 |
| 发布与审核 | `campus/hub/content_management.py`、`core.py`、`studio_workflow.py`、对应测试 | 与 Opus 维护范围可能重叠；共用唯一发布服务 |
| 启动版本 | `campus/hub/api.py`、`campus/server.py`、`campus/start.ps1`、`campus/start-codex-companion.ps1` | 只更新版本检查，保留 Windows 编码和进程归属检查 |
| 正文编辑 | `src/js/{content-editor,rich-body}.js`、`src/pages/circle.js`、`src/styles/{rich-body,circle-news}.css` | 共享页面文件逐块合并，不整份覆盖 |
| 大图查看 | `src/js/photo-viewer.js`、`src/styles/photo-viewer.css` | 不改九图上传与纵深滑轨源码 |
| 依赖 | 根及 `campus/companion/` 的 `package.json`、`package-lock.json` | 合并双方依赖，保留精确版本与锁文件 |
| 验证 | `scripts/verify-{photo-viewer,rich-body,content-management}.mjs` | 新脚本不接真实账号、数据库或模型；原管理脚本已适配原文按钮 |

## 本轮实际验收

- Django：内容管理、工作室恢复、工作室、机器人操作、companion bridge 共 **92 项通过**；临时配置和测试库隔离。
- Node：原版网站 host、工作感知、持久任务和恢复共 **37 项通过**，含原执行器通过工具目录审核并回到私聊；模型和 RPC 用测试替身。
- LangGraph：在实际安装包与文件 SQLite 上 **7 项恢复测试通过**，含并发去重、发送写入后崩溃、回复生成中断、数据库重开与聊天事务。
- Edge headless：图片查看 **6 组场景通过**，正文编辑 **4 组场景通过**；含 390px 视口与真实双指触摸事件，无页面脚本错误。
- 全站 `npm run build` 通过，403 模块构建；编辑器与大图核心为独立延迟加载文件。构建仍提示原有 Three.js 大包，未做无关拆包。
- 启动器 PowerShell 语法解析及 `git diff --check` 通过。

这些结果不等于真实模型已完成用户任务，也不是用户本人 Edge 的帧率测量。本轮未付费调用模型、未修改真实资料／社区库或私聊，未重启运行站点。

## 接手与上线

1. 拿到 Opus 的云端交接后，确认她的基线、认领和变更。先保存双方改动，再逐文件合并以上共享范围。历史回信不是当前认领。
2. 合并源码与锁文件后，在根目录、`campus/companion/`、`campus/companion/tools/crawler/` 安装各自锁定依赖。本机候选使用 `npm ci --ignore-scripts` 或等价固定版本安装；Node 至少 24。
3. 沿用原私有数据目录、凭据与角色配置；不要复制候选测试库覆盖真实库。新 checkpoint 表由原运行时创建，无新增 Django migration。
4. 隔离验证可运行 `node --test campus/companion/test/website-{host,work,jobs,workflow}.test.mjs`；再以 `WORKFLOW_TEST_ENGINE=langgraph` 单独跑 workflow 测试。两个新浏览器脚本独立启动临时页面，无需真实站点。
5. 安装依赖、合并和验收通过后，才用原启动器一次性加载网站与两位 AI。核对健康版本、原窗口任务状态和公开内容版本，再做现有额度内真实指令实测。
6. 默认工作流为 LangGraph；若需要诊断依赖问题，可显式设置 `COMPANION_WORKFLOW_ENGINE=journal` 使用同数据库的已测试基础传输。此选择会返回真实 engine 名称，不伪称已使用 LangGraph。

## 已知边界

框架依赖安装曾因审批服务额度故障及本机缓存／原生扩展问题失败；后续正常审批已恢复，改为复用 Node SQLite，固定版本依赖已成功安装和验证。没有绕过拒绝安装陌生脚本。

本轮没有引入第二个社交站点、第二个人格系统或新的自动化权限。Discourse、OpenHands 和 Temporal 等研究候选未被宣称已经接入。真实模型最终结果与 Opus 的重叠范围，留待统一整合验收。
