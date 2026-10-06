# Luokixi 校园知识库后端

学校：中国矿业大学（北京）。课程可扩展；本校资料、通用考试资料与待核对网络来源分开管理。
本目录代码采用 MIT 许可。搜索使用 DDGS，抓取使用 Scrapling，PDF 正文使用 pypdf，数据保存在 SQLite/FTS5。
无需付费 API 或大模型密钥。

新增的多人社区为独立 **Hub v2**，启动说明与限制见 [HUB_SETUP.md](HUB_SETUP.md)，接口见 [HUB_API.md](../docs/HUB_API.md)。它支持账号、审核、本站收藏、关注和通知；AI 导读需要自行配置模型。旧知识库 `/api/catalogue` 等接口仍是仅供站主使用的本机工具，不作为公网社区接口。

## 安装与启动

本机已配置完成：双击项目根目录的 `启动学校知识库.cmd`，会构建网站、启动本机服务并打开知识库。当前入口为 <http://127.0.0.1:17860/knowledge.html>。

新电脑或重新安装时，按下列步骤配置环境。

Python 3.12 或更高版本。在本目录执行：

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m pip install -r hub-requirements.txt
.venv/Scripts/scrapling install
.venv/Scripts/python server.py --port 17860
```

Linux/macOS 使用 `.venv/bin/python` / `.venv/bin/scrapling`。
Windows 默认可使用已有 Edge 执行动态抓取；其他系统使用安装的 Chromium。
本机已有专用环境：`C:/Users/user/Documents/Codex/tools/scrapling/.venv/Scripts/python.exe`。

## 接入 Opus 的 Vite 网站

在原 `vite.config.js` 导入 `campus` from `./campus/vite-plugin.js`，将 `campus()` 加入原 plugins 数组。
开发后端在 17860，Vite 使用 5173；前端可从 `campus/client.js` 导入 `campusApi`。
不要覆盖现有 `partials()`、页面入口和页面样式。

构建后的网站放在项目 `dist/`，Python 服务会直接提供该目录，可用 `http://127.0.0.1:17860` 查看完整站点。
使用 `CAMPUS_STATIC_DIR` 可指定其他构建目录。17860 仅绑定本机，能代理 17861 的 Hub v2 账号服务；请用启动脚本同时开启两者。静态托管不能运行社区、实时搜索或爬虫接口。正式自部署只公开 Hub v2 与公开构建文件，见新说明，不能直接公开旧本机服务。

## 导入资料

```powershell
python import_local.py --school-source PATH_TO_OLD_PUBLIC --cet-source PATH_TO_CET_ARCHIVE_DIRECTORY
```

前者包含 `papers-data.js` 和 `papers/`，后者包含 `资料索引.json` 与 `资料/`。
资料只引用本机原文件；SHA-256 去重、逐页提取并建立全文索引。重复导入不覆盖既有复习记录。
扫描资料仅做文件目录检索，未执行 OCR。正文提取不能可靠保持数学公式与全部字体编码，原 PDF 是校对依据。
读取试卷/答案/听力均使用受控文件 ID，不接受任意文件路径。

## 网络资料流程

1. `/api/search-web` 查询公开搜索引擎并返回网址，结果不自动认定为本校试题。
2. `/api/crawl` 抓取指定页面，最多 10 页、同域链接、单并发、1 秒间隔；检查 robots.txt。
3. 网页提取干净正文，PDF 提取分页文字；哈希去重；新内容进入 pending。
4. 核对来源、课程、年份和使用许可后，`/api/curate` 入库。入库仅表示已整理，不等于答案被权威验证。
5. 原件页码可关联复习卡；自评后安排 1/3/7/14/30 天复习，答错回到 1 天。

403、超时、robots 限制会记录到每页任务详情；不绕过登录、付费或验证码，不把失败记为入库成功。
搜索引擎可能限流或返回不相关内容。当前没有定时抓取、OCR、整卷自动判分或答案生成。

## 数据与备份

`.data/`（SQLite、采集 PDF、导入报告）不属于开源代码包，不提交。
学习记录 `/api/backup` 只备份复习卡；恢复时保留已存在 ID、跳过当前库没有来源的卡片。
完整资料库备份需在服务停止后复制 `.data/`，另备份引用的原始资料。
原卷、听力、网页文本与第三方依赖保留各自许可；MIT 不向这些资料扩展。

## 接口与协作

新增共创数据能力见 `../docs/COMMUNITY_API.md`：项目/题解投稿、核对、贡献事件、讨论与回复、GitHub 公开仓库信息，以及独立的浏览器题目足迹模块。最终页面排布由 Opus 整合，状态在 `COMMUNITY_STATUS.json`。本机服务版本 1.1 提供这些接口，不代表公共社区已经上线。

根目录 `CODEX_TO_OPUS.md` 提供当前接口契约；`OPUS_TO_CODEX.md` 为 Opus 回信入口；`STATUS.json` 提供最新验收状态。
测试：`python -m unittest discover -s tests -v`。网络验收与浏览器验收记录放在 `.data/`，不随源码公开。

上游：<https://github.com/D4Vinci/Scrapling>（BSD-3-Clause）、<https://github.com/deedy5/ddgs>（MIT）、<https://github.com/py-pdf/pypdf>（BSD-3-Clause）。
