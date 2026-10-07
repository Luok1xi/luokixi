# 项目仓库与北矿娘

功能入口：`projects.html` 的项目资料仓库、`project.html` 的说明书与文件、站主 `me.html#notices` 的可操作通知、`me.html#maintenance` 的维护队列、`studio.html` 的讨论。

## 机器人分工

| 角色 | 已实现 | 决策边界 |
| --- | --- | --- |
| 采集 / 配图 | GitHub API 搜索、共享缓存与限流；Scrapling 页面解析；README 配图 | 新项目先进入候选池，不标成实测或严选 |
| 分类 | 机器人、嵌入式、软件、算法、课程、科研多标签与命中依据 | 规则建议，维护者可指定主分类；人工分类不被覆盖 |
| 中文说明书 | 用途、人群、功能、条件、安装、首次使用、工作流、版本文件、限制、许可共十章，逐章引用 README / Release 等证据 | 原文更新后旧导读退出；生成后待审；证据不足明确说明 |
| 下载整理 | 官方附件与固定提交源码，版本、大小、SHA-256、许可证文本、来源、系统和架构提示 | 无明确再分发依据不保存；源码不冒充安装包；缺失文件返回不可用 |
| 北矿娘 | 自动复核分类依据、列出具体请示、接收站主答复；以第一人称起草更新公告；与 Codex 两席讨论 | 非学校官方。只能自动确认有限技术事项，不代站主采纳项目或发布公告 |

北矿娘语气亲切、清楚、有主见，不堆表情。规则检查会显示自动复核依据；公告与讨论使用真实模型。北矿娘和 Codex 工程席均由配置的本机 Codex 运行，角色不继承桌面聊天记忆，不冒充独立 Claude/Opus。

## 工具复用与存储

网页提取继续使用 [Scrapling](https://github.com/D4Vinci/Scrapling)。GitHub 传输使用 [HTTPX](https://github.com/encode/httpx) 0.28.1 的连接池、HTTP/2、流式读取，不自制 HTTP 协议栈。外围约束只允许 GitHub 官方域名、公开 DNS 固定、逐跳验证重定向、跨域去认证头；缓存及 API 限流复用原系统。没有再引入重复的 PyGithub 额度与缓存状态。

本站镜像文件保存在被 Git 忽略的数据目录，默认单文件 150 MB、总计 2 GB、每次最多六个 Release 附件加源码。先确认固定提交对应的许可证全文，再保存源码；目前二进制附件限明确的宽松许可，其余许可先只保存源码等待额外核对。保留作者、源提交、上游摘要（若提供）和本地 SHA-256。HTTP 下载支持 Range、ETag、Content-Length 和缺失文件 410；失败的部分文件不作为可下载结果。

直接下载只说明这份文件走本站；不保证依赖全部离线，也不等于已提供面向全国的公网服务。本机尚未部署公网。

## API

以下路径均以 `/api/hub/` 开头：

| 方法与路径 | 功能 / 权限 |
| --- | --- |
| GET `repositories?q=&category=&download=local&offset=0` | 公开已收录目录，每页 30 条；`includePending=1` 仅维护者 |
| POST `github/classify` `{repository}` | 重新分类，维护者 |
| POST `github/summarize` `{repository}` | 生成十章说明书，配置中的站主；返回任务编号 |
| POST `github/guide/review` `{repository,sourceFingerprint,approve,note}` | 独立核对导读；校验对应原文版本 |
| GET `mirror?repository=owner/repo` | 官方文件的本站副本与真实可用状态 |
| GET `mirror/{id}/file` / `mirror/{id}/license` | 本站下载与许可证正文 |
| POST `mirror/refresh` `{repository}` | 维护者触发镜像任务 |
| GET `supervisor` | 待处理请示和公告草稿，维护者 |
| POST `supervisor/answer` `{id,answer}` | 回答请示并记审计；不会连带发布项目 |
| POST `supervisor/discuss` `{id,message}` | 本机站主发起北矿娘、Codex 两轮讨论 |
| POST `supervisor/announcement` `{}` | 本机配置站主生成公告草稿，返回任务编号 |
| POST `entries/{id}/review` | 沿用公告审核；北矿娘草稿存在疑问时需显式 `supervisorQuestionsResolved:true` |

通知 `action.kind` 新增 `review-guides`、`review-supervisor`；点击后在原通知页展开审核表单。已读、收到通知、对请示回复均不代表同意发布。普通注册用户不能使用模型预算或访问监督队列。

## 本机运行与预算

`campus/run_hub.py` 启动通用队列；讨论由 `python campus/manage_hub.py hub_studio_worker` 单独执行。两者需保持运行，电脑关闭不会继续执行。分类每日、北矿娘复核每六小时；`HUB_GUIDE_AUTO=1` 开启每日导读批次，`HUB_MIRROR_AUTO=1` 开启每周镜像检查。任务串行等待队列，前端显示实际排队/运行/失败状态。

使用现有 `studio-config.json` 的本机站主身份与模型配置。付费模型和工作室共享每日不超过 ¥5 的保守预留账本；Codex 使用已登录账号额度并共享每日最多 12 次调用，不宣称免费或折算人民币。一次讨论最多六轮，本次监督入口默认两轮。无重复计费重试；失败保留预留记录，新重试需主动发起。自动批次遇到同一来源已尝试过会跳过。

## 2026-10-07 验收

- 全 Hub 基线 119 项通过；随后新增两席讨论和电机项目分类回归，相关 14 项通过。两次并非相加的独立测试总数。
- 生产构建通过；真实 Edge 桌面及 390px 手机测试完成导读核对、回复北矿娘、两席讨论入队、公告确认发布、目录筛选、搜索空态、下载和详情。审批仅发生在隔离数据库。
- 真实 SimpleFOC v2.4.0 源码镜像：5,914,638 字节，固定提交 `4f072b365f6e0185adca544071e595834405babc`，SHA-256 `397bb1163ca5f0a74269ec2cbfc8bb390c6fe2d39d82c3a03842733a637a2fdf`。从正式本机网站下载后的文件一致，Range 验证 206。
- 真实模型生成十章、约 4,400 字中文导读与一篇北矿娘公告，均待站主核对；北矿娘和 Codex 实际各回复一轮，已完成。首次讨论暴露了分类与共享证据不足，已增加硬件领域规则、相关回归测试，并为后续讨论补入对应分类证据和镜像元数据。
- 最终视觉排布交 Opus；本次没有发布源码或部署公网。
