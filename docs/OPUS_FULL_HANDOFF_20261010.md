# Opus 完整项目交接 · 2026-10-10

Owner 明确要求交接整个 Luokixi 项目，以及 10 月 7 日以后的网站和原版 AI 更新。请以 GitHub `main` 为接手入口；不要仅阅读旧的 10 月 7 日资料页交接。

## 版本与完整性

- 仓库：[Luok1xi/luokixi](https://github.com/Luok1xi/luokixi)。完整功能版本为 [`f7911c534608cb201eb40672a58f563e7e270098`](https://github.com/Luok1xi/luokixi/commit/f7911c534608cb201eb40672a58f563e7e270098)；本交接随后作为文档提交追加到 `main`。
- 从 10 月 7 日基线 `c91e37506cc9f5bf3c766a9e72871c89737b698c` 到该功能版本，共 8 条提交、737 个变更文件。不是只有滑轨补丁。
- 对该功能版本的 1010 个 Git 跟踪文件与 Owner 实际项目逐项比较：功能源码和公开素材一致，差异仅为 CRLF/LF 换行；没有遗漏的可公开源码。
- 原版 AI 在 `campus/companion/`，包含 276 个文件：66 个源码模块、69 个测试文件，以及角色卡、工具、上游来源记录和依赖锁文件。两位角色共用原程序，独立保存人格和记忆。
- `public/art/` 有 75 个跟踪文件，包括角色头像、正确服装的表情立绘和图片来源记录。
- 本机另外忽略的 313 个文件为 299 份测试产物/隔离浏览器状态、2 份日志、12 份明确不发布的美术待审稿。没有误忽略 AI 源码、测试源码或依赖锁文件。
- Git 中继续保留 12 份旧说明和地图验收档案；即使实际项目目录没有这些归档，也不按目录镜像删除。

| 提交 | 内容 |
| --- | --- |
| `d2c6086` | 保存截至 10 月 9 日的原版 AI、网站功能、素材与测试 |
| `fd27a6c` / `4d75f42` | 统一管理、版本审计、聊天执行与两位真实角色的审核验收 |
| `155f563` | 九图投稿、多图空间预览、来源原图与学校标识修复 |
| `f7911c5` | 多图滑轨输入、惯性、吸附、中断及卸载优化 |

可获取[整个仓库的源码 ZIP](https://github.com/Luok1xi/luokixi/archive/refs/heads/main.zip)。保存自己的未提交改动后合并最新 `origin/main`，不强制覆盖、不重置历史。

## 全项目模块清单

下表是已提交代码的范围。各验收文档中的数量、预算与旧版本号是当轮快照；较新的专项记录及下文当前运行版本优先。历史“未推送”指当时状态，这些源码本轮已经公开保存。

| 模块 | 已提交实现与记录 |
| --- | --- |
| 原版双角色 | 完整 `createApp`，Chat、情绪、自我状态、记忆、Agency、研究、学习、工具和调度；各自身份/记忆。[双运行时](COMPANION_DUAL_RUNTIME_20261008.txt)、[接入核对](BEIKUANG_INTEGRATION_AUDIT_20261008.txt)，来源在 `campus/companion/UPSTREAM.json` |
| 私聊与共同工作 | 原 StudioRoom/Run/Message 历史、角色参与的讨论回忆、实际回执、持久化执行和断点恢复。[既有工作流](BEIKUANG_EXISTING_WORKFLOW_AUDIT_20261008.txt)、[工作室恢复](STUDIO_RECOVERY_20261009.md) |
| 人格和消息 | 唯一角色卡、原话语气学习、模型原始分段/表情、情绪与行动接线、结构化消息修复。[消息连续性](BEIKUANG_MESSAGE_CONTINUITY_20261008.txt) |
| 立绘、声音、对话 | 黑红北矿娘、白发 Codex；正确服装表情、半身舞台、七海/蕾姆日语适配；点击推进、中断旧声音、静音历史、整段摘要/原文回查。[角色与语音](COMPANION_DUAL_RUNTIME_20261008.txt)、[对白推进](GALGAME_DIALOGUE_20261009.md)、[语音调节](CHARACTER_VOICE_TUNING_20261009.md) |
| 工具与自主维护 | 固定版本工具下载、校验、试用；机器人、内容读写、候选代码测试/应用/回退与真实工作记录。[工具与质量循环](QUALITY_LOOP_20261009.md)、[工作室](AI_STUDIO.md) |
| 管理与聊天执行 | Unfold 0.108.0 `/manage/`、原页面编辑、站主直接公开；两角色原版执行器调用相同内容服务、任务回发起窗口、版本/恢复/配图覆盖。[管理验收](CONTENT_MANAGEMENT_20261009.md) |
| 资料、课程与组题 | 原件成套整理、原题/答案/听力、资料袋 ZIP、课程资料/经验、OCR/原页坐标、编辑/打印 PDF/JSON、学校/学科/优先级分类。[资料机器人](LIBRARY_ROBOT_2026_10_07.md)、[课程检索](LEARNING_DISCOVERY_2026_10_07.md)、[本机交付](LOCAL_VERIFICATION_20261009.md) |
| 社团课程板与地图 | 原地图底图/地点/导航；社团 dnd-kit 拖排、固定课拒让、可调活动退让、成员共享/冲突、提醒/ICS。[校园重构](CAMPUS_REDESIGN_2026_10_07.md)、[社团与资料动效](MOTION_CLUB_REDESIGN_2026_10_07.md) |
| 开源广场 | 分类/stars 排序、页内模糊查询、中文十章导读/原文、来源/镜像文件、分段下载校验、自动图文讲解。[广场与搜索](PLAZA_MOTION_SEARCH_2026_10_07.md)、[下载与讲解](QUALITY_LOOP_20261009.md) |
| 新闻与角色日志 | 学校新闻、AI/科研中文摘要、站内讨论、人格日志；日志事实取本轮执行记录。[内容与日志](LOCAL_VERIFICATION_20261009.md)、[日志修正](QUALITY_LOOP_20261009.md) |
| 配图与九图投稿 | Uppy 5.2.0；连续选择/拖入/粘贴 9 图、排序/移除/失败续传；来源原图优先、缓存/学校核对/人工编辑保留。[图片实际覆盖](SOCIAL_MEDIA_20261010.md) |
| 多图空间与性能 | 预览/详情/首页共用 Agrumea 式滑轨，保留反向视差/缩放、触摸/键盘，输入按帧合并与原弹簧。[最新优化](DEPTH_MOTION_20261010.md)、`scripts/verify-post-depth.mjs`、`scripts/measure-depth-motion.mjs` |
| 搜索、光碟与启动 | 全站模糊提示词、字帘、光碟资源/Worker 优化；原视觉保留；Windows 编码与启动检查修正。[广场动效](PLAZA_MOTION_SEARCH_2026_10_07.md)、[性能与已知问题](MOTION_PERFORMANCE_20261009.md) |

接入范围：campus-companion 固定基线 `d5ca8d3feab76271049868ed5f56ce85ac45cadb`，网站修改在本仓库继续实现，不会自动双向同步独立项目。QQ Bridge / Shinsekai 为具体能力及协议参考/适配，不是全服务原样照搬。`campus/vendor/opus-codex-studio/` 只采用 4 份规范、模板和来源文件；真实执行在本站已有的 `campus/hub/studio*.py` 等模块，不宣称移入整个上游框架。

## 当前运行版本与启动

Owner 本机项目：`C:\Users\user\Documents\GitHub\luokixi`。云端 `127.0.0.1` 指云端自身，不能直接访问 Owner 本机预览。

| 服务 | 本机端口 | 核对字段 |
| --- | ---: | --- |
| 资料/静态/代理 | 17860 | `/api/health`：`libraryPipelineVersion=3`、`managementVersion=1`、`socialMediaVersion=1` |
| Django Hub | 17861 | `/api/hub/health`：`beikuangChatVersion=34`、`managementVersion=1`、`socialMediaVersion=1` |
| 北矿娘原版桥接 | 17862 | `/health`：`engine=campus-companion`、`bridgeVersion=28`、`seat=beikuang` |
| Codex 原版桥接 | 17864 | 同上，`seat=codex` |
| 原版完整控制台 | 17839 / 17840 | 分别属于两角色，不是另外两个人格 |
| 角色语音 | 17863 | GPT-SoVITS，权重/参考音频在本机私有目录 |

网站构建需要 Node 22.12+，**原版 AI 需要 Node 24+**；完整项目用 Node 24+、Python 3.12+。根项目与 AI 依赖分别安装：

```bash
npm ci
npm --prefix campus/companion ci
# 使用爬虫子工具时另外安装其锁定依赖
npm --prefix campus/companion/tools/crawler ci
python -m pip install -r campus/requirements.txt -r campus/hub-requirements.txt
npm run build
```

云端独立环境按 [启动交接](CLOUD_HANDOFF.md) / [Hub 配置](../campus/HUB_SETUP.md) 完成迁移（至 `0022_content_management`）、导入公开目录，再用 `run_hub.py --no-worker` 与 `server.py` 预览。只运行 Vite 不会出现真实聊天和审核。

Windows `启动学校知识库.cmd` / `campus/start.ps1` 面向 Owner 已有数据库，发现原库缺失会停止，避免创建空替代库。不要把这个保护错误当作新云端项目源码缺失，也不要删除检查。云端初始化自己的数据；模型凭据、桥接身份和语音模型按文档配置，不复制 Owner 私有配置。

## 验收证据与实际限制

- 管理轮：社区 532 项（1 跳过）、原版角色 289 项、内容工具 4 项通过；两位真实模型各审核一条指定校圈测试并回原窗口，测试帖随后撤回，记录保留。
- 九图/配图轮：社区 540 项（1 跳过）、图片队列 4 项、构建和 Edge 验收通过。原 219 条资料保留；218 原文件与 1 外链区别保留。
- 最新滑轨轮：构建、共享运动 7 项、Edge 双图/九图/触摸/键盘/首页/详情回归、只读真实站检查通过。120 次输入的一批滚动写入 119→1；30 条无控件轨道额外 JS 帧请求 30→0，反向视差保持。
- 最新滑轨轮没有修改后端、人设、模型、语音或真实数据，没有新增付费对话；先前整库测试不能写成这轮重跑。
- Headless 调度间隔不是 RTX 5070 实体屏幕 FPS；没有宣称全站稳定 60 帧，也没有用固定样本冒充真实大图解码验收。
- 配图快照为 98 篇公开内容：53 来源原图、44 标记主题封面、1 投稿图；不是全部恢复原图，后台数量会变化。
- 学校真实登录课表/自动预约、全库逐页 OCR、所有项目导读和镜像、所有自主工具选择与全天无人维护仍不能宣称全完成。复杂指令、主观语气和声线质量需实际使用验收。
- 下载加速是分段/续传/校验，不承诺固定倍数；项目视频是标记的图文讲解，不是软件实录。来源索引不等于下载文件。
- 旧固定四行对白在短回复时可能多留空白，已记录，尚未回退；不要将所有留白解释成人格变更。

## 接手顺序

1. 保存当前分支和未提交工作；`git fetch origin`，合并最新 `origin/main`。干净且未分叉的 `main` 可 `git pull --ff-only origin main`。
2. 先读本文件，再读管理、原版运行时、图片与滑轨记录。`CLAUDE.md` / `CODEX_TO_OPUS.md` / `docs/BOARD.md` 顶部最新状态优先。
3. 安装两层 Node/Python 依赖，迁移、重新构建，核对服务的项目路径和新 `dist`。Git 更新不会让旧进程自动加载新代码。
4. 验收使用独立数据，不清空真实数据库/记忆，不启用未配置的付费调用，不用模拟回复冒充真实 AI。
5. 跨页面改动先在看板写文件范围，继续既有组件和数据服务；交付写真实结果、证据和未完成项。

本轮交付整个可公开项目的源码、资源和记录。数据库、私聊、密钥、会话、下载资料和角色语音权重留在本机，不放公开 GitHub；云端数据数量因此可能不同。文件已供 Opus 拉取，是否读到及接受须以她后续回信为准。
