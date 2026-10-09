# 基础功能本地验收与 Astra 交接

2026-10-07。按 Owner 最新要求：本机测试 → Astra 修正 → 再上传 GitHub。本轮没有提交、推送、公开部署或修改 GitHub 设置。

实际网站源目录：`C:/Users/user/Documents/GitHub/luokixi`。以下是本轮新增行为，光盘动画、北矿娘人设和原有页面布局继续沿用现有版本。

## 现在可以测试

| 入口 | 操作与预期 |
|---|---|
| [校圈](http://127.0.0.1:17860/circle.html) | 关注一位作者、订阅一个吧；“关注”同时出现两类内容，同一帖子不重复，卡片注明推荐原因。 |
| [通知](http://127.0.0.1:17860/me.html#notices) | A 发帖，B 回复；A 点通知一次进入原帖并定位回复。项目回复也有直接定位链接。撤回内容、丢失回复有明确状态。 |
| [兴趣设置](http://127.0.0.1:17860/me.html#growth) | 修改兴趣后回校圈，推荐立即读取同一份设置，不再分别维护两套兴趣。旧数据在首次读取时兼容导入。 |
| 校圈帖子详情 | 帖子作者或维护者可以采纳回复；显示“已采纳”，已有采纳权限继续沿用。 |
| [维护面板](http://127.0.0.1:17860/me.html#maintenance) | 站主登录后看心跳、处理范围、队列、告警及备份。点击“立即备份”，等待完成，再点“验证恢复”，成功后可下载。普通账号没有这些权限。 |
| [故障告警演练](http://127.0.0.1:17849/) | 开免打扰，模拟两次故障，再模拟恢复；关闭免打扰并推进重试，故障、恢复按顺序各通知一次。模拟不会关闭真实网站。 |

浏览器已打开旧页面时刷新一次即可加载本轮构建。验收账号、样例帖子和附件均写入隔离数据库，没有混入真实社区。

## 六项基础改动

1. **通知回访**：后端给出受权限控制的原内容入口；前端将已读回执与审核操作分开。匿名评价的通知仅进入本人私有评价页，不泄露匿名身份。
2. **关注流**：关注作者、订阅吧采用并集；增加作者关注入口与原因说明。
3. **兴趣来源**：`Member.preferences.interests` 为权威来源。个人资料及校圈接口同步使用；兼容旧 `CirclePreference`，显式清空仍可生效。
4. **自动检查**：新增 `.github/workflows/ci.yml`，PR/main 更新执行内容校验、前端测试、构建、Django 检查、迁移一致性、Hub 测试与配图工具测试；测试数据在 runner 私有临时目录。工作流已准备，尚未在 GitHub 执行；分支保护设置未改。
5. **可靠告警**：网站维护检测采用持久 outbox，两次失败确认，同一故障不刷屏；发送失败保留重试，恢复不能超过故障通知。站内通知直达维护页，知悉不等于修好。模型可用性不影响这条路径。
6. **全站备份**：一致性快照覆盖账号、帖子、审核、附件、镜像文件、资料数据库及其真实原件；原个人 JSON 导出继续保留。支持每日备份、手动备份、私有下载、隔离恢复验证及校验回执。

## 本地运行方式

- 网站 `127.0.0.1:17860` 与 Hub `127.0.0.1:17861` 已启动，健康接口的 `build` 为 `foundation-local-20261007`。
- 当前 Hub 使用 `campus/run_hub.py --review-mode`：只消费 `site-backup`、`site-backup-check`，避免本次验收自动消费原采集/模型任务。维护面板如实显示这个范围；旧任务保留。
- 常规 `campus/run_hub.py` 仍启动网站原有完整后台任务，新增维护监测同时运行。`--no-worker` 不运行后台处理器。
- Python 环境为 `C:/Users/user/Documents/Codex/2026-10-06/zhe/work/studio-venv/Scripts/python.exe`；重启时应使用包含 `campus/hub-requirements.txt` 的环境。
- 本机故障演练器为独立候选助手的 `tools/site-alert-preview.mjs`。不启用外部消息发送、不调用模型，不接管旧私人助手。
- 本轮进程和日志记录在 `C:/Users/user/Documents/Codex/2026-10-06/zhe/work/foundation-live-processes.json` 与 `foundation-live-*.log`；重启前重新核对进程，不凭历史 PID 停服务。

## 数据保护与实际恢复结果

备份默认位置是 `C:/Users/user/AppData/Local/Luokixi/backups`，不在源码、静态服务或 Git 目录。备份含账号、私人附件和 Django 登录签名密钥；不包含模型/API 配置。下载需要维护者登录，返回私有禁止缓存响应。

本轮已生成并恢复实际快照：`luokixi-backup-20261007T043819Z-6328f263f951.zip`，720,537,445 字节、249 个文件。验证编号 `e506851c587e4c0a91250f3c81ec2baf`。

旧资料库引用了项目目录外的 **218 份原件（177 PDF、41 MP3）**，已按真实引用收入快照；全部重新读取、核验哈希。恢复副本中的路径被改写为隔离目录，源数据库及源文件未改。真实恢复包含 3 个账号、25 条内容、18 条审核记录、10 个镜像记录及 219 条资料记录。另有隔离 fixture 实际验证恢复后的登录、上传附件下载、回复和审核历史。

恢复接口只能新建隔离目录，不能覆盖生产库；没有将旧数据库还原到真实网站。详细 CLI 和格式见 [BACKUP_RESTORE.md](BACKUP_RESTORE.md)。

## 已执行验证

| 检查 | 实际结果 |
|---|---|
| Hub 全量回归（集成初版） | 176 项：175 通过，1 项 Windows 无符号链接权限而跳过。 |
| 最终维护专项 | 12 项通过，包含告警重试/顺序、权限、备份幂等、任务冲突和启动后无心跳。 |
| 最终备份专项 | 16 项：15 通过，1 项 Windows 符号链接权限跳过；包含篡改、路径穿越、重复条目、外部原件和真实隔离恢复。 |
| 社区相关回归 | 50 项通过。 |
| 前端现有测试 | 12 项通过；内容校验通过。 |
| 配图工具测试 | 17 项通过，1 项跳过。 |
| 最终前端构建 | Vite 152 模块成功；未改依赖版本。 |
| 校圈真实 Edge 浏览器 | 390px/1440px：两账号回复→通知→定位→采纳；作者与吧关注流、兴趣同步；没有脚本错误和横向溢出。 |
| 最终维护真实 Edge 浏览器 | 7 个场景通过：手机备份→后台完成→隔离恢复→下载、401/403 权限、503 采集故障不挡基础面板、桌面重载持久状态、项目回复定位；没有脚本错误或横向溢出。 |
| 助手候选全量测试 | 242 项通过；真实微信/飞书发送未启用、未验证。 |

浏览器和恢复证据在 `C:/Users/user/Documents/Codex/2026-10-06/zhe/work/` 的 `foundation-community-browser/`、`foundation-maintenance-browser/`、`foundation-backups-evidence.json`。

维护最终回执为 `foundation-maintenance-browser/20261007-125132/result.json`。浏览器发现并已修复项目详情刷新版本/镜像记录时丢失回复焦点；最终在 networkidle 后等待额外 500ms，手机和桌面均保持正确回复焦点且目标位于视口。临时验收服务 18186/18187 已关闭，真实服务继续运行。

## Astra 接手范围

网站主要改动：

- `campus/hub/{accounts,circle,notifications,interests,operations,backup,api,worker}.py`
- `campus/run_hub.py`、`campus/hub/management/commands/{hub_backup,hub_restore_check}.py`
- `campus/hub/test_{foundation_community,operations,backups}.py`
- `src/pages/{circle,me,project}.js`、`src/js/operations-panel.js`
- `src/styles/{circle-news,operations}.css`、`.github/workflows/ci.yml`
- 本交接及 [备份说明](BACKUP_RESTORE.md)。没有新增数据库迁移。

助手候选独立保存在 `C:/Users/user/Documents/Codex/2026-10-06/zhe/work/foundation-companion`，基于云端 `claude/nice-cerf-b24x36` 的 `a7e253b`。其 `ASTRA_FOUNDATION_HANDOFF.md` 列出告警 outbox 和投稿重试改动。**没有覆盖** `C:/Users/user/Documents/ChatGPT/New project/companion` 私人助手；正式合并前必须由 Astra 对照正确基线。

代码基线：`C:/Users/user/Documents/Codex/2026-10-06/zhe/work/foundation-20261007-122735/source`。本轮交付文件清单和仅代码差异包位于 `work/foundation-delivery/`，可以按哈希核对，不能用代码快照覆盖真实数据库。

后续 AI 校园问答、发帖写作辅助、运营指标并非本轮六项基础工作，没有冒充实现。正式 SMTP、助手外部通道、独立机器故障探测、生产部署和 GitHub CI 云端运行仍待配置验收。网站站内维护告警已接入；助手目前提供独立本地演练。

由站主先测试，再请 Astra 修正。本轮文件认领全部释放；上传时仅提交代码，不上传真实数据库、备份包、隔离恢复文件或私人配置。
