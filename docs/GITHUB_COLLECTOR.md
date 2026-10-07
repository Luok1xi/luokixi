# GitHub 采集与配图机器人

入口：站主登录后进入 `me.html#maintenance`。普通用户不能运行采集或审核候选。

## 工作流程

1. 通过 GitHub 官方 REST API 检索机器人、嵌入式、开发工具、数据可视化四个方向。
2. 默认排除私有、已归档、被禁用、Fork、许可不明、简介为空的仓库；至少 100 Star、近 730 天有提交、README 至少 150 字符。Star 只是粗筛，不能证明好用、安全或适合初学者。
3. 每轮最多详细读取 8 个项目，保留来源、作者、Star 快照、README 证据、许可、正式 Release 与源码包入口。重复仓库不重复建立身份，也不刷贡献值。
4. 新项目进入“GitHub 候选项目”。维护者阅读原文、许可与下载入口，勾选核对项并填写推荐理由后，才加入开源广场。可选实用 / 新奇 / 潜力，也可不推荐。
5. 新候选自动排队检查 README 配图。已收录项目也会补图。图片 API 已接通首页/项目目录使用的 `loadCommunity()` 和开源推荐流。

**机器人不执行仓库代码，也不把 README 当指令。** 采集、分类、配图不调用模型。详细中文导读单独启用并计入共享额度；镜像单独启用且受许可证、文件大小和总容量限制。自动整理不等于严选或实际运行验证。最新功能和权限见 [项目仓库与北矿娘](PROJECT_REPOSITORY.md)。

## 配图

- 解析 Markdown 图片、引用式图片和 HTML img；支持嵌套 README 路径与相对链接。
- 优先截图、演示与硬件图片；排除徽章、logo、赞助段落、候补名单广告、贡献者头像拼图及二维码。
- 每仓库最多检查 3 张候选，每张最多读取 4 MB；验证真实图片格式、宽高、比例及像素上限。
- 只连接公开 HTTPS 地址，限制重定向并逐跳验证 DNS；读取公开网页/图片前检查 robots.txt。
- 记录原图地址、README、仓库出处、署名、核对时间和尺寸。只引用原图；仓库代码许可证不会被自动解释为图片的独立转载许可。
- 没有合适图片时继续显示带说明的分类概念图；网络失败保留上次可用图并标记 stale。不是每个仓库都会有封面。

## 运行

网站的 `campus/run_hub.py` 默认包含后台队列。GitHub 每 24 小时运行；项目配图每 72 小时运行，新采集完成会额外排队补图。成功的手动运行也满足本轮间隔；部分失败至少等待一小时重试。后台关闭期间不会运行，重新启动后会检查到期任务。

手动运行同一流程（在已配置 Python 的项目根目录）：

```powershell
python campus/manage_hub.py hub_collect_projects
python campus/manage_hub.py hub_collect_projects --task media
```

可在维护面板分别点击“GitHub 项目采集”或“项目配图（README）”的运行按钮。结果写入 Job 与 ExternalCache，部分成功明确显示“部分完成”。公开图片接口会保留已成功的项目，不因一个失败项目清空整批。

配置 `campus/github-sources.json` 可修改方向和筛选门槛。硬上限每轮 6 个搜索方向、12 个详细项目、24 个配图项目。默认量低于这些上限。

环境变量：

| 名称 | 默认 | 用途 |
| --- | --- | --- |
| HUB_MAINTENANCE | 1 | 0 关闭定时维护 |
| HUB_GITHUB_CRAWL | 1 | 0 单独关闭 GitHub 定时采集 |
| HUB_GITHUB_READ_TOKEN | 未设置 | 可选的只读 GitHub API 令牌；仅服务器环境中配置，不写前端或仓库 |
| HUB_MIRROR_AUTO | 未设置 | 设为 1 对已收录项目每周检查镜像；本机试运行已开启 |
| HUB_GUIDE_AUTO | 未设置 | 设为 1 每日批次生成最多 2 个详细导读，先预留额度，失败不自动重试同一个来源版本；本机试运行已开启 |

API 共用 12 小时缓存和 ETag 条件请求，搜索缓存 24 小时。403/429 后记录 Retry-After / rate-limit-reset，后续请求等待额度恢复；旧项目与配图不变成零。跨站重定向不携带认证头。采集结果和任务状态保存在被 Git 忽略的 `campus/.data/hub` 中，不随源码上传。

## 文件与接口

- `hub/github_api.py`：共享 GitHub 只读请求缓存与限流等待。
- `hub/github_crawler.py` / `campus/github-sources.json`：候选发现与筛选。
- `hub/project_media.py`：图片解析和验证。
- `maintenance/status`：新增 `tasks.github` 与维护者专用 `pendingProjects`。
- `maintenance/run {task:"github"|"media"}`：任务入队。
- `github/curate`：复用已有的维护者审核与 Star/关注/讨论身份。
- `projects/media`：公开原图、来源、核对时间与逐项目 stale 状态。

GitHub 接入依据：[仓库搜索 API](https://docs.github.com/en/rest/search/search#search-repositories)、[REST API 请求建议](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)。

## 2026-10-07 本机验收

首轮发现 8 个候选，仍待站主审核；检查现有目录与候选共 17 个项目，7 张原图通过验证，3 个项目图片检查暂时失败，7 个没有合适配图。无图时使用已有分类概念图，不生成虚构项目截图。

94 项 Hub 测试、3 项客户端测试和生产构建通过。真实网站在桌面 1440px / 手机 390px 验证了原图加载、可见性和无横向溢出；隔离数据库通过登录、核对候选、加入推荐流、显示对应原图的完整流程。真实站点没有为测试发布候选，也没有创建测试账号。
