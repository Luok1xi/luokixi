# Hub v2：本机运行与自部署

## v0.2 更新

本版首页为 `/`，资料 `/materials.html`，校圈 `/circle.html`，站主工作室 `/studio.html`。Hub 68 项回归通过，完整浏览器投稿与审核验收见 [v0.2 记录](../docs/RELEASE_0_2.md)。以下早期测试数量保留作历史记录，以本段为准。

这是账号社区服务，与 `server.py` 的私人学习库分开存储。默认只监听本机。数据文件、邮件预览、上传原件和密钥位于被 Git 忽略的 `campus/.data/hub/`。

校园共建地图后端已加入：照片与坐标投稿、审核、临时发现时效、现场反馈、GeoJSON 和外部导航入口，详见 [CAMPUS_EXPLORER.md](../docs/CAMPUS_EXPLORER.md)。Opus 已报告地图页面接入及隔离测试，实地验证仍待完成。教师/课程口碑及短视频接口见 [REPUTATION_API.md](../docs/REPUTATION_API.md)；Hub 共 37 项测试通过。

## 本机

项目根目录运行 `campus/start.ps1`：构建 Opus 页面、启动 17860 的本机网站与 17861 的社区服务。已在此电脑验证同源接口 http://127.0.0.1:17860/api/hub/health 。账号入口 `/auth.html`，个人页面 `/me.html`，发现流 `/discover.html`。

新环境使用 Python 3.12 创建虚拟环境，安装 `campus/requirements.txt` 与 `campus/hub-requirements.txt`。本机当前 Django/Waitress/imageio-ffmpeg 安装于 `campus/.data/hub-runtime/`，`manage_hub.py` 会自动读取；不需要修改其他项目的 Python 环境。

```powershell
python campus/manage_hub.py migrate
python campus/manage_hub.py hub_import_catalogue
python campus/manage_hub.py hub_import_reputation
python campus/manage_hub.py hub_import_boards
python campus/manage_hub.py createsuperuser
python campus/run_hub.py
```

请在已装依赖的环境中执行。`createsuperuser` 由站主本人输入邮箱和密码，不存在默认管理员、共享密码或“第一个注册者自动成为管理员”。公开目录导入是幂等的，保留旧 slug，不认领他人账号，不导入私人 PDF。

发信未配置时，邮件只写 `mail-preview/`，浏览器不会拿到验证令牌。真实用户验证需要配置 SMTP。测试用例使用隔离数据库和保留域邮箱，不发送真实邮件。

## 可替换接入

| 能力 | 配置 | 未配置行为 |
| --- | --- | --- |
| SMTP | `HUB_SMTP_HOST/PORT/USER/PASSWORD`、`HUB_FROM_EMAIL` | 本机预览，页面明确说明不会收到邮件 |
| GitHub 登录 | `HUB_GITHUB_CLIENT_ID/SECRET`；回调为域名 + `/api/hub/auth/github/callback` | 邮箱登录仍可用，GitHub 登录关闭 |
| 本地模型 | `HUB_AI_PROVIDER=ollama`、`HUB_AI_MODEL`，可选 `HUB_AI_BASE_URL` | 原始项目资料可查，AI 导读返回未配置 |
| 兼容模型接口 | `HUB_AI_PROVIDER=openai-compatible`、`HUB_AI_MODEL`、`HUB_AI_BASE_URL`，需要时设置 `HUB_AI_API_KEY` | 不借用其他项目的凭据，不自动购买服务或下载模型 |
| GitHub 公共读取 | 可选 `HUB_GITHUB_READ_TOKEN` | 使用匿名公开 API；失败保留上次成功时间 |
| 视频编码 | 可选 `HUB_FFMPEG`，或 requirements 中的 imageio-ffmpeg | 无编码器时能力接口返回不可用，禁止假装接收成功 |
| 天地图底图 | 前端构建参数 `VITE_TIANDITU_TK`，由站主申请并限制浏览器域名 | 延续 Opus 当前底图选择；正式发布前单独核对影像条款和署名，本轮没有设置密钥或更换底图 |

模型调用没有执行工具；README 被视为资料。导读引用须能对应输入证据，生成结果进入待核对。只有维护者明确核对、选择理由和来源后进入精选；有测试证据才显示已实测。当前运行库尚无维护者审核的精选，因此在线发现流可能为空，不能用演示项目填充虚假审核。

`run_hub.py` 默认启动后台任务，处理文件提取、已启用来源的定时采集、排队 GitHub 读取/导读，以及用户自愿订阅的每周摘要。视频使用独立处理队列，本地转为 MP4 并生成封面，原件始终私有；180 秒/200 MiB，须审核后才能公开播放。独立 WSGI 部署另跑 `python campus/manage_hub.py hub_clip_worker`（可用 `--once` 只处理一项）；不能仅起 Web 服务就声称会自动处理视频。新来源默认需维护者设置；学校重要通知经审核发布。扫描件目前只标记待 OCR，未接 OCR 引擎。外部 OJ 每日同步、浏览器 Web Push、校园身份/空位接口尚未实现。

## 正式自部署边界

社区应使用同域 HTTPS：公开静态文件 + 仅 `/api/hub/*` 和 `/hub/*` 代理到 Hub。设置 `HUB_PRODUCTION=1`、强随机 `HUB_SECRET_KEY`、准确 `HUB_ALLOWED_HOSTS`、`HUB_PUBLIC_ORIGIN=https://你的域名`。`VITE_CAMPUS_BACKEND=same-origin` 用于前端构建。

反向代理示例见 `deploy/hub-nginx.conf.example`，需要运营方补全域名、证书和目录。视频上传 `/api/hub/clips` 单独使用 201 MiB 请求上限，普通资料仍为 25 MiB，勿全站扩大限制；播放器需保留 Range/Content-Range。只有反向代理覆盖来源头、后端不直接向外开放时，才设置 `HUB_TRUST_PROXY=1`。**不要把 17860 或旧 `/api/*` 暴露到公网**；它们能访问私人学习资料。

构建发布包前排除 `public/files/`、`campus/.data/`、`.venv/` 和所有本机材料；`dist/` 可能含 Vite 复制的 `public/files/`，不能整目录无检查发布。示例代理额外拒绝 `/files/`。真实上传只经权限检查的 Hub 文件接口访问。

SQLite 适合当前单机规模；需要多实例服务时另做共享数据库、文件存储和任务队列接入。当前没有部署到互联网，没有进行公网负载、SMTP 实际投递或真实 OAuth 验收。

## 验证

```powershell
python campus/manage_hub.py test hub
python -m unittest discover -s campus/tests -p "test_*.py"
npm run build
python campus/tests/hub_browser_smoke.py
python campus/tests/reputation_browser_smoke.py
python campus/tests/clips_browser_smoke.py
python campus/tests/circle_browser_smoke.py
```

浏览器测试需要已有 Edge 与 Playwright。它在 17960/17961 启动临时服务，通过真实移动页面完成账号创建、验证和资料保存；通过同源 HTTP 完成双用户投稿、审核、收藏、回复、通知、权限隔离。测试服务与数据库随后销毁。结果在忽略目录 `.data/hub-qa/result.json`，不会混入公开社区。

口碑测试在 17970/17971 验证移动端投稿、审核、匿名回复、高赞原文、改版、撤回和独立课程评分；短视频在 17980/17981 通过真实上传、处理队列、审核、Edge 原生播放及拖动进度测试。二者均使用临时库，结果在 `.data/reputation-qa/`。

验收边界：所有布局和呈现均由 Opus 负责。本轮验证的是已移交的口碑功能基线及视频接口，不代表短视频产品页面已接入；正式外部服务、学校实时数据和 Opus 后续改版须另行验收。

2026-10-06 校圈扩展：当前 Hub 46 项测试通过，新增 circle_browser_smoke.py 在 17990/17991 验证真实浏览器 client 的投稿、审核、关注、通知和推荐控制；该测试不代表校圈产品页面已落地。说明见 docs/CAMPUS_CIRCLE.md。初始化命令仅创建 6 个空话题，不生成帖子或用户。

本机视频依赖原目录出现不可读问题，固定版本 imageio-ffmpeg 0.6.0 已重新安装于 campus/.data/hub-video-runtime，manage_hub.py 优先读取此目录。原目录未删除、全局 Python 环境未修改；修复后完整测试包含真实视频解码/转码检查并通过。全新自部署仍按 requirements 安装即可，不需要此兼容目录。

该次读取差异来自依赖继承的临时目录权限。仅对新建 hub-video-runtime 恢复项目目录权限继承后，本机服务账号也能读取；重载后实际 clips/capabilities.available=true，校圈 boards=6、feed=0。没有放宽整个项目或用户资料的权限。
