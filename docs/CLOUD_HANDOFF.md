# 云端 Opus 接手：先确认版本，再启动资料页

## 2026-10-10 最新：整个项目接手

请先读 [完整项目交接](OPUS_FULL_HANDOFF_20261010.md)。GitHub main 已包含至 `f7911c5` 的整个项目功能源码和公开素材：原版双角色、工作室、资料/组题、统一管理、聊天执行、九图/来源配图及性能更新。从 7 号基线 `c91e375` 起 8 条提交、737 个文件变化，已核对无可公开源码遗漏。

先保存自己的改动并 `git fetch origin`，合并最新 `origin/main`；干净且未分叉的 main 可 `git pull --ff-only origin main`。不要用下方 `7c5f85c` 历史页面证据当当前更新终点。完整 AI 要 Node 24+，根项目与 `campus/companion/` 分别安装依赖，Python 新增 Unfold 0.108.0，迁移至 `0022_content_management`，更新源码后重建。

当前健康字段：网站 `libraryPipelineVersion=3` / `managementVersion=1` / `socialMediaVersion=1`；Hub `beikuangChatVersion=34` / 管理与媒体版本 1；两个原版桥接 `bridgeVersion=28`。云端的数据与配置独立，Owner localhost、记忆、资料原件和语音模型不会自动出现在云端。完整启动与实测限制见新交接。

## 以下为 2026-10-07 历史核验记录

核对日期：2026-10-07（北京时间）。目标仓库为 [Luok1xi/luokixi](https://github.com/Luok1xi/luokixi)，分支为 `main`。

## 已确认的版本

Owner 指定的页面是 `http://127.0.0.1:17860/materials.html`。这个地址属于 Owner 的电脑，不是公开部署地址；在云端打开同一地址，只会访问云端机器自身。

该页面对应的集成代码已在 [7c5f85c](https://github.com/Luok1xi/luokixi/commit/7c5f85ce780e2c253963944412f92631149e842f) 中。此次补交仅增加版本证据与接手说明，不改变页面设计和功能。

核对结果：

- 扫描本机 360 个可发布源文件，与该提交的发布副本比较，唯一差异是上次上传后的本地交接回执；没有遗漏的功能代码。
- 本机 HTTP 返回的 `materials.html` 与发布副本构建结果逐字节一致。
- 页面直接加载的 10 个 JS/CSS 文件也逐字节一致，包括 `materials-Au7SyIMy.js`、`materials-c2rpL_Wn.css` 和共享导航资源。
- `materials.html`、`src/pages/materials.js`、`src/styles/market.css`、资料袋、资料目录和共享导航源文件与 `origin/main` 一致，比较时允许 Git 对 CRLF/LF 的正常转换。
- 完整校验值见 [MATERIALS_VERSION_CHECK.json](MATERIALS_VERSION_CHECK.json)。其中源文件 SHA 是 Windows 本机原始字节值；跨系统比较源码时需标准化行尾。构建文件比较为原始字节相等。

这些证据确认版本一致，不等于已验证云端环境的安装、浏览器效果或后端运行。

## 已有云端工作区怎样更新

先查看工作区与远端状态：

```bash
git status --short
git fetch origin
git log -1 --oneline origin/main
git branch --show-current
git merge-base --is-ancestor 7c5f85ce780e2c253963944412f92631149e842f HEAD
```

最后一条退出码为 0，说明当前分支包含上述页面基线。若不包含，在保存自己未提交的工作后，将最新 `origin/main` 合并到当前开发分支；不要用强制覆盖或重置丢掉云端改动。如果当前是干净的 `main` 且没有分叉，可用 `git pull --ff-only origin main` 更新。

如果界面仍旧，检查启动进程使用的项目目录，以及是否仍在服务旧 `dist`。更新源码后需要重新构建，并让预览服务使用这次的构建目录；单纯刷新浏览器不会更新旧构建文件。

## 新环境预览前端

需要 Node.js 22.12+。新环境可先克隆仓库：

```bash
git clone --branch main https://github.com/Luok1xi/luokixi.git
cd luokixi
npm ci
npm run build
npm run dev -- --host 0.0.0.0
```

通过云端开发环境提供的端口预览打开 `/materials.html`。不是直接双击源码 HTML，也不要打开历史 `cet4.html` 来判断新版资料页。

新版资料页的结构是：大标题、搜索和上传入口、左侧分类、右侧单列资料列表、底部资料袋；包含预览、上传与打包下载交互。

## 需要后端时

仅启动 Vite 可以检查前端结构。账号、投稿、审核、用户资料等需要社区后端；本机目录检索还需要资料服务。

在自己的独立环境安装 Python 3.12+ 依赖：

```bash
python -m venv campus/.venv
# Linux/macOS；Windows 使用 campus/.venv/Scripts/Activate.ps1
source campus/.venv/bin/activate
python -m pip install -r campus/requirements.txt -r campus/hub-requirements.txt
python campus/manage_hub.py migrate
python campus/manage_hub.py hub_import_catalogue
python campus/manage_hub.py hub_import_reputation
python campus/manage_hub.py hub_import_boards
```

保持 Vite 预览进程运行，再在两个终端中分别激活虚拟环境并运行：

```bash
python campus/run_hub.py --no-worker
```

```bash
python campus/server.py --port 17860
```

资料服务读取本环境的 `dist`，Vite 将对应接口转发到本环境的 17860/17861。`--no-worker` 用于这次界面核对，避免同时启动自动采集与审核。要启用正式后台任务、创建管理员或配置邮件，请另外按 [社区运行说明](../campus/HUB_SETUP.md) 设置，不要复制 Owner 的账号、模型凭据或数据库。

## 为什么数据可能与 Owner 电脑不同

公共仓库有功能源码、公开目录与可公开的图片，不包含 Owner 的私人试卷原文件、上传文件、账号库、运行中的爬虫结果及模型密钥。资料数量、可下载原件、登录状态和待审消息可能不同；这是数据差异，不能据此判断源码缺失，也不能虚构这些数据来让预览看起来相同。

本次未部署公网，未重启 Owner 的业务进程，未改动真实账号或数据库。上一轮集成验证为后端 142 项、前端 12 项通过，图片工具 17 项通过/1 项跳过，150 模块构建通过；详见 [集成记录](INTEGRATION_20261007.md)。
