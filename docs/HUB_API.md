# Hub v2：Opus 页面接入契约

校圈新增公开动态/长帖/外链、话题订阅、作者关注、点赞与可解释推荐，接口详见 [CAMPUS_CIRCLE.md](CAMPUS_CIRCLE.md)。目前 Hub 46 项测试通过；页面仍归 Opus，自动知乎采集和系统级推送未接入。

2026-10-06 最新扩展：[教师/课程口碑与短视频契约](REPUTATION_API.md)。所有布局归 Opus；Codex 负责功能。当前 Hub 37 项测试通过，口碑与短视频同源浏览器流程通过；下文早期测试数保留为历史记录。

校园探索新增 `kind=place`、`GET /map/places`、`POST /map/places/{id}/observe`、`GET /uploads/{id}/photo`；详细字段、审核要求和导航口径见 [CAMPUS_EXPLORER.md](CAMPUS_EXPLORER.md)。该扩展加入后 Hub 共 24 项测试通过。

2026-10-06。实现位于 `campus/hub/`，20 项服务端测试及隔离数据库上的手机端账号/同源 HTTP 流程已通过。页面、美术和交互仍由 Opus 负责；投稿与项目详情页面须另做整页验收。服务端使用 Django 5.2 LTS，独立社区数据库；不把现有私人 PDF 自动公开。

## 地址、身份和错误

- 同源前缀 `/api/hub`，不要追加末尾斜杠。开发服务器 17861，本机入口 17860 与 Vite 已代理此前缀；浏览器入口 http://127.0.0.1:17860/ 。
- GET `/health` → `{ok:true,version:"2.0",accounts:true,emailDelivery:"local-preview"|"smtp",githubLogin:false,ai:{configured:false,provider:"ollama",model:""}}`。
- 所有 JSON POST 使用 `Content-Type: application/json`，带 `X-CSRFToken`。GET `/auth/session` 获取 `{user:null|Member,csrfToken,capabilities}`。浏览器使用 `credentials:'same-origin'`，会话为 HttpOnly cookie；每次登录/退出后更新 csrfToken。
- 非本机、未配置 `VITE_CAMPUS_BACKEND=same-origin` 的静态部署不请求 API，显示静态目录与未连接状态。部署采用同域网站 + API；不增加跨域会话。
- 失败统一 `{error:"中文说明"}`；400 输入错误，401 未登录，403 权限/CSRF/邮箱未验证，404 不存在，409 版本冲突，429 限流，503 外部能力未配置。必须展示失败，不能乐观假装提交成功。
- 用户 `Member`：`{id,username,name,bio,major,externalLinks,campusVerified,githubVerified}`。本人的对象额外有 `email,emailVerified,moderator,digestEnabled`。只有 `/auth/session`、`/me` 返回本人私有字段。

## 账号

| 方法 | 路径 | 请求 / 返回 |
|---|---|---|
| POST | `/auth/register` | `{email,username,name,password}` → session + message；用户名 3–30 位英文数字点下划线短横线，密码至少 12 位 |
| POST | `/auth/login` | `{email,password}` → session |
| POST | `/auth/logout` | `{}` → session（user=null） |
| POST | `/auth/send-verification` | `{}` → capabilities |
| POST | `/auth/verify` | `{token}` → session + message |
| POST | `/auth/reset-request` | `{email}` → 通用说明，不泄露邮箱是否存在 |
| POST | `/auth/reset-confirm` | `{uid,token,password}` → message；旧会话失效 |
| GET | `/auth/github/start` | 浏览器跳转，OAuth 完成后回 `/hub/#me`；未配置返回 503 |
| POST | `/auth/profile` | `{display_name,bio,major,externalLinks:{luogu:"https://..."},digestEnabled:false}`，字段可省略 |
| GET | `/me` | `{profile,entries:[Entry含draft],stars:[Entry],workspaces:[Workspace]}` |
| GET | `/members/{username}` | `{profile,entries}`，只返回公开资料 |

未配置 SMTP 时验证邮件写入受保护的 `campus/.data/hub/mail-preview/`，只供站主本机联调；浏览器不会得到验证 token，也不会假称已发邮件。正式发布需要配置 SMTP。邮箱验证后才能投稿/收藏/回复。GitHub 绑定必须由已经登录的用户发起；不会仅凭同名邮箱合并账号。

邮件链接使用 `/hub/#verify/{token}`、`/hub/#reset/{uid}/{token}`、`/hub/#unsubscribe/{token}`。跳转桥保留 fragment 到 `/auth.html#...`，账号页读取后抹去令牌，不把令牌放入 query。`POST /digest/unsubscribe {token}` 支持无需登录退订。

### 学院、目标与兴趣

`POST /auth/profile` 可带 `preferences:{faculty:"机械与电气工程学院",year:"2026",campus:"沙河",goals:["竞赛"],interests:["机器人"],courses:["physics"]}`。该对象按整体替换；传 `{}` 清空，任一字段可省略。所有字段仅本人 session/me 返回，公众成员资料不包含这些字段，不会因此变成校园认证账号。标签最多各 12 个、每个 80 字。

`GET /recommendations` 需登录，返回 `{items:[Entry + reasons:["与你选择的…匹配"]],notice}`。只匹配已公开内容的相同标签/课程/分类，最多 30 条；不匹配时为空，不以学院猜测资格或泄露草稿。这是主动标签匹配，不是系统弹窗推送。

`GET /categories` 返回 `{categories:{mech:{name,short,hue,glyph},...}}`，直接读取 `content/categories.json`，与 Opus 页面一致。

学习目录位于 `public/data/courses.json`：`courses[]` 内 `scope=campus-catalogue|learning-topic`，开课学院未知为 null，`materialAccess=local-only|external-link|awaiting-contributions`。竞赛位于 `public/data/competitions.json`：`competitions[]`，本批 `catalogueYear=2024`；`currentEdition/deadline/registrationUrl=null`，不代表开放报名。

## 内容：项目、资料、讨论、科研共用

`kind`：`project/resource/paper/reproduction/topic/contest/news/announcement/collection`。题解可用 resource + category=algo；组队可用 topic + category/截止日期/相关竞赛字段。公告仅维护者发布。

`Entry` 返回：

```json
{"id":"uuid","slug":"稳定标识","kind":"project","data":{"title":"标题","summary":"简介","links":{"repo":"https://github.com/owner/repo"}},"revision":1,"owner":{"id":2,"username":"alice","name":"Alice"},"siteStars":0,"starred":false,"watch":[],"updated":"ISO时间","canonical":null}
```

`owner` 是站内投稿者，不是外部项目原作者。外部原作者显示 `data.credit`。导入目录 owner=null，不自动认领账号。

本人/维护者请求详情额外返回 `draft,editRevision,state,reviewNote`。`data` 始终为已审核公开版本；`draft` 为待编辑版本，不能混进公开页。首次未审核内容对他人返回 404。

`data` 可用字段：

- 必填标题 `title`（≤160）；`summary`（≤1000）、`body`（Markdown源文≤80000）。
- `category,course,courses:[],year,difficulty,tags:[]`。
- `license,credit,sourceNote,rightsConfirmed:true,aiDisclosure`。
- `links:{repo,demo,video,source,paper,dataset,hardware,registration,release,site}`，只收 http(s)。
- `uploads:[上传uuid]`、`related:[站内内容uuid]`。
- 项目：`setup,needs,hardware`；复现：`environment,codeVersion,dataVersion,steps,results,failures`。
- 竞赛：`audience,deadline,ruleVersion`；论文：`doi`。
- 提交前要求简介、许可、分享权确认及对应来源；复现要求环境/步骤/结果/原作。

| 方法 | 路径 | 用法 |
|---|---|---|
| GET | `/catalogue?q=&kind=&course=&year=&difficulty=&slug=&offset=0` | `{total,items}`；每页30条，只检索公开版本与其已提取附件正文 |
| GET | `/entries/{id}` | Entry + `replies:[],tasks:[],attachments:[]` |
| GET | `/entries/{id}/history` | `{items:[{revision,data,state,note}]}`，他人仅看已发布版本 |
| POST | `/entries` | `{kind,data}` → Entry 含 draft/editRevision/state |
| POST | `/entries/{id}/save` | `{revision:editRevision,data}` → 新草稿；版本冲突409 |
| POST | `/entries/{id}/submit` | `{revision:editRevision}` → pending |
| POST | `/entries/{id}/review` | 维护者：`{revision,decision:"approve"|"reject",note}` |
| POST | `/entries/{id}/withdraw` | 作者/维护者：`{reason}`，撤回并撤销关联贡献 |
| POST | `/entries/{id}/star` | `{enabled:true,collection:"机器人入门"}`；显式设置，重试不重复计数 |
| POST | `/entries/{id}/watch` | `{events:["release","discussion","revision"]}`；空列表退订 |
| POST | `/entries/{id}/release` | 作者/维护者：`{version,url,note}`，同一版本重复发布不重复通知 |

上传：POST `/uploads`，FormData 的 `file` 字段，带 CSRF，**不要自行设置 multipart Content-Type**。允许 PDF/TXT/MD/CSV/PNG/JPG/JPEG/WEBP/ZIP/STL/STEP/IPYNB，≤25MB。压缩包不解压、不执行；代码建议外部托管。返回 `{id,name,bytes,sha256,extraction,preview,pages,url,duplicate,matchingEntries}`。GET `/uploads/{id}` 查询提取结果，`/uploads/{id}/file` 原件下载。

状态 `pending/text/needs-ocr/encrypted/attachment-only`；扫描件 `needs-ocr` 必须如实显示。附件只有作者/维护者或审核公开内容的读者能访问。重复原件共用存储但保留各上传者记录；重复资料的审核记录保留、贡献不重复增加。原 PDF 库不参与自动公开。

## 讨论、任务、通知、贡献

- POST `/entries/{id}/replies {body}` → `{id,body,author,state,accepted,created}`。新用户回复 pending，维护者/受信任用户可直接发布。
- POST `/replies/{id}/review {approve:true}`；拒绝需 `{approve:false,reason}`，维护者专用。
- POST `/replies/{id}/accept {}`：提问者/维护者采纳别人的公开回复；调整采纳会撤销旧贡献。
- POST `/entries/{id}/tasks {title,description,beginner:true}` → Task。
- POST `/tasks/{id}/claim {}`、`/submit {evidence:"https://..."}`、`/review {approve:true,note}`。核对后贡献到账；重复核对不重复计入。
- GET `/notifications` → `{unread,items:[{id,entry,event,text,read,created}]}`；POST `/notifications/read {ids:[1,2]}`。
- GET `/contributions?username=&date=YYYY-MM-DD` → `{total,categories,items:[{id,user,category,summary,evidence,entry,date}],definition}`。最多1000条明细，total是全量；日期按北京时间。不要与刷题/Star相加。
- GET `/moderation`（维护者）→ `{entries,replies,reports,sources,jobs,needsOCR,audit}`。
- POST `/entries/{id}/report {reason}`；维护者 POST `/reports/{id} {resolution}`。

## 发现、项目严选与一次一个项目的浏览

- GET `/search/external?q=&provider=github|crossref` → `{items,portals,stale,lastSuccess,error}`。洛谷/力扣等仅提供原站入口时明确标注。
- POST `/github/inspect {repository:"owner/repo"}` → Job；GET `/jobs/{id}` 查询 `queued/running/done/failed`，done.result 为项目资料。
- POST `/github/summarize {repository}` → Job；未配置模型返回503，不伪造AI结果。
- GET `/github/project?repository=owner/repo` → `{url,repository,credit,stars,license,readmeUrl,releaseUrl,downloads,evidence,guide,selection,entryId,lastSuccess,stale}`。
- `downloads[].kind` 为 `official-release` 或 `source-archive`；源码 ZIP 不能写成安装包。
- `guide.sections[]:{heading,text,evidenceIds}`。`evidence[]:{id,url,text,startLine?,endLine?}`；导读包含 model/generatedAt/sourceSha/reviewState。生成状态不等于经过测试。
- 维护者 POST `/github/curate {repository,shelf:"practical"|"creative"|"potential"|"unlisted",reason,checks:{sourceRead:true,licenseChecked:true,downloadsChecked:true},testEvidence:"",approveGuide:true}`。未实测不得显示实测标志。
- GET `/github/selected` → 精选完整列表。
- GET `/feed?shelf=all|practical|creative|potential&cursor=` → `{items,nextCursor,total,ranking}`；每批8张，一次展示一张；本轮快照不因新收录/收藏而乱序。
- 卡片字段：`repository,entryId,title,idea,ideaLanguage,sections,unknowns,whyRecommended,shelf,repositoryUrl,downloads,readmeUrl,license,credit,githubStars,siteStars,starred,media,evidence,verifiedAt,tested,testEvidence`。没有视频时 `media.type=project-card`，不能冒充实机视频。未核对中文导读时显示原文简介并提示。
- POST `/feed/feedback {repository,action:"interested"|"not-interested"|"clear"}`；不感兴趣从下一轮排除。
- POST `/feed/workflow {goal:"我的需求",repositories:["owner/repo"]}` → 私有 Workspace，包含项目版本/官方链接/可勾选搭建步骤/来源。最多5个已核对中文导读的项目，不自动执行下载和代码。

## 科研与计划

- POST `/workspaces {kind:"reading"|"comparison"|"plan"|"workflow"|"personal-import",title,data}`；GET `/workspaces/{id}`；POST `/workspaces/{id} {version,title,kind,data}`；全部为本人私有。
- reading/comparison 的 data：`{references:[{entry?,title,authors,year,doi,url,method,limitations,note,page,quotation}],notes}`；GET `/workspaces/{id}/bibliography` 导出 BibTeX，可导入 Zotero。
- POST `/planning {goal:"employment"|"research"|"competition",topic,baseline,weeklyHours:6,weeks:8}` → Workspace；资料推荐只匹配已审核内容，缺少资料会明确显示。`steps[]`有起止周、用时、推荐理由、resources、state、evidence。
- 公开复现报告使用 kind=reproduction 的普通投稿与审核流程，并关联 related 原作；他人复现作为另一份署名报告，不能自行打“已验证”标记。
- GET `/backup` 导出个人工作区和收藏；POST `/restore {...backup,confirmed:true}`。忽略备份里的账号身份，不覆盖别人，也不静默迁移浏览器历史。

## 采集和运维

- 维护者 POST `/sources {name,url,kind:"rss"|"html",entry_kind:"news"|"contest"|"resource"|"paper",enabled:true,interval_hours:24}`；传id为更新。
- POST `/sources/{id}/refresh {}` → Job。目录采集、变更均进入 pending；不会自动宣称最新报名日期或官方公告。
- worker 持久队列可重试3次；失败保留上次成功信息。扫描件无 OCR 引擎时保留原件并进入 needsOCR 清单。
- 正式账号管理员由站主通过 `manage_hub.py createsuperuser` 创建；绝不把首个注册者自动设为管理员。
