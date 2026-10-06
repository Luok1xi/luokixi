# Luokixi

面向中国矿业大学（北京）的校园、资料、校圈与开源创作社区。帮助同学选择课程、找到资料和工具、分享经验、参与项目。学习辅导通过外部平台提供。

**v0.3 · 纵向资料与校园报**：单列资料与打包下载、新闻 / 搜索 / 吧讨论首页、共用口碑导航、一次性开场与页面过渡，以及贡献可视化、图书馆座位提醒助手。保留 Collins 风格轮播、校园地图、竖向项目发现流和本机站主 AI 工作室。当前是可本机运行的开发版本；本次公开源码，未部署在线网站。

## 六个入口

| 板块 | 已有功能 | 入口 |
|---|---|---|
| 首页 | 学校新闻来源与时效、关注动态、Collins 风格透视拖动轮播 | `index.html` |
| 校园 | 学院路 / 沙河真实 OSM 地图、设施图标、活动投稿、地点详情、官方预约入口、个人座位提醒助手 | `map.html` |
| 资料 | 课程 / 年份 / 类型筛选、原文件预览、上传审核、资料袋和带来源清单的 ZIP | `materials.html` |
| 校圈 | 校园新闻、搜索与真实热议、校区论坛、图文投稿、审核、点赞、收藏、回复；独立教师 / 课程口碑 | `circle.html` / `reputation.html` |
| 开源广场 | 逐个浏览项目、原仓库入口、已核对项目导读、视频链接、公开评论弹幕 | `discover.html` |
| 个人中心 | 账号、投稿、收藏、通知、个人资料、真实贡献可视化；站主另有 AI 工作室 | `me.html` / `studio.html` |

旧版资料与检索地址继续保留。`knowledge.html` 提供本机全文检索及公开资料采集；`projects.html` 可按列表搜索项目。

## 本地运行

需要 Node.js **22.12+**、Python **3.12+**。先在项目根目录构建前端：

```bash
npm ci
npm run build
```

只看前端可运行 `npm run dev`。账号、上传、审核、论坛与 AI 工作室需要后端；静态页面不会伪造登录或互动成功。

Windows 本机完整运行：

```powershell
python -m venv campus/.venv
campus/.venv/Scripts/python -m pip install -r campus/requirements.txt -r campus/hub-requirements.txt
campus/.venv/Scripts/python campus/manage_hub.py migrate
campus/.venv/Scripts/python campus/manage_hub.py hub_import_catalogue
campus/.venv/Scripts/python campus/manage_hub.py hub_import_reputation
campus/.venv/Scripts/python campus/manage_hub.py hub_import_boards
campus/.venv/Scripts/python campus/manage_hub.py createsuperuser
powershell -NoProfile -ExecutionPolicy Bypass -File campus/start.ps1
```

打开 **http://127.0.0.1:17860/**。Linux/macOS 可在安装上述依赖与完成迁移后，用两个终端分别运行 `python campus/run_hub.py` 和 `python campus/server.py --port 17860`；本轮运行验收在 Windows 完成。

创建管理员时自行设置账号，没有仓库内置密码。邮箱验证需要配置 SMTP；未配置时只写本机邮件预览。详细配置、自部署边界见 [社区运行说明](campus/HUB_SETUP.md)。本机私人资料、数据库和模型密钥均不随仓库上传。

### AI 工作室

站主启用后从个人中心进入 `studio.html`，可建房间、讨论、请求候选代码、查看检查记录、停止任务、确认候选。按 [AI 工作室说明](docs/AI_STUDIO.md) 设置并单独启动 worker。仅打开网页不会调用模型。

现有适配器为 DeepSeek API 和本机 Codex CLI；设计席明确显示“由 Codex 运行”，**没有冒充实际 Claude / Opus 接入**。单次最多 6 条 AI 回复，DeepSeek 日预算默认 5 元；未配置密钥或核对费率则不可调用。候选确认只记录审核，不自动覆盖网站、合并、上传或发布。

## 当前边界

- 公共仓库不包含私人试卷或他人上传文件。资料页只将实际可取的原文件放入资料袋；新安装可自行导入有权使用的资料或通过投稿补充。
- 全校课程分类已开放；物理、化学、雅思等栏目缺资料时展示空状态，不用虚构题库填充。
- 图书馆和体育场馆入口通向官方服务。座位助手支持私人计划、站内提醒与日历下载；实时空位、校内单点登录及自动预约尚未接入，学校预约仍须本人确认。地图几何来自 OSM，待审插画不作为可导航地图。
- 无已核对精选时，开源流明确显示人工目录。不会把未验证的安装步骤、下载地址或视频说成实测成功；个性化与站外同步仍受接口、审核和数据条件限制。
- 新闻带来源、时间和精选展示期限；学校通知以原文为准。项目为学生自发维护的非官方网站。

## 验证与贡献

```bash
npm run validate
npm run test:materials
npm run test:client
python campus/manage_hub.py test hub
npm run build
```

本版完成 73 项 Hub 测试、4 项资料打包测试、3 项请求客户端测试，以及桌面 / 手机视口浏览器验收。过程、功能边界见 [v0.3 验收记录](docs/RELEASE_0_3.md)。这是本机验收，不代表公网部署、实体手机或校园实地测试。

欢迎补充原创笔记、真实项目、安装记录、校园地点与代码修正。见 [贡献指南](CONTRIBUTING.md) 和 [统一模块规格](docs/PRODUCT_SPEC.md)。投稿保留来源与许可；评价保留具体体验，禁止冒用他人身份。

## 许可与致谢

本站原创代码采用 [MIT](LICENSE)。第三方依赖、图片、地图数据、课程资料和用户投稿遵循各自许可；MIT 不授予学校标识、第三方作品或试卷的转载权。

- 轮播效果参考 [Dimi · Collins Carousel](https://www.dimi.me/lab/collins-carousel)，独立实现；未复制 Motion+ 源码或依赖付费组件。
- 设计工作流参考 [Emil Kowalski skills](https://github.com/emilkowalski/skills)。
- 地图使用 [Leaflet](https://leafletjs.com/) 与 [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)，保留来源与署名。
- 压缩下载使用 [fflate](https://github.com/101arrowz/fflate)；动画使用 [GSAP](https://gsap.com/)，字体为自托管 [Inter](https://rsms.me/inter/)。
- 课程资料组织参考 [WeHUSTER](https://www.wehuster.com/cet4) 与各高校课程共享项目。既有开场参考 [dsh-boot-animation](https://github.com/lxj5820/dsh-boot-animation)。
