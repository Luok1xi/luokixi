# 学习引导：教师 / 课程口碑与短视频接口

2026-10-06。所有页面布局、美术和交互呈现由 Opus 负责；Codex 负责数据、接口、权限、功能逻辑与测试。reputation.html、src/pages/reputation.js、src/styles/reputation.css 的功能基线已移交 Opus。

## 通用约定

前缀 /api/hub/，复用 cookie 会话和 X-CSRFToken。参与操作要求登录且邮箱验证；维护/审核另需 staff。账号的管理字段叫 moderator。静态部署没有后台时明确未连接，不假装保存评分。

错误：400 参数，401 登录，403 权限/邮箱，404 不存在或不公开，409 版本冲突，429 限流，503 能力未配置。所有 client 方法见 campus/hub-client.js。

## 教师、课程与开课

- GET teachers?q=&offset= / teachers/{id}；GET courses?q=&offset= / courses/{id}；GET offerings/{id}。
- 目录每页 24，返回 items/total/nextOffset。
- 教师返回 id/name/faculty/title/sourceUrl/checkedAt/photo/teaching/ratingLabel/stats/highlight，详情另有 offerings。
- photo=null 或 {url,sourceUrl,credit}。缺照片或加载失败显示占位；来源公开不自动等于照片可复用。
- teaching 是带 name/sourceUrl 的授课经历，不推断本学期是否开课。
- stats={average:null或一位小数,count,distribution:键1至5,smallSample,label}。teacher 的 count 为独立评价者数；course 跨开课汇总的 count 是评价份数，标“历次开课”。
- course 含 scope=campus-catalogue/general-topic、prerequisites、resources；详情提供具体 offerings。一般专题不能作为正式开课记录。
- resources={title,url,type,audience,cost:free或paid或mixed或unknown,checkedAt:YYYY-MM-DD}。按钮明确前往外部平台，不保证原站价格固定。
- offering={id,courseId,name,term,campus,sourceUrl,teachers,stats,highlight}。

## 评价、计分与高赞

- POST reviews：subjectType=teacher/offering，subjectId，data={rating,body,anonymous,courseId?,term?}。rating 整数 1–5，body 1–5000 字，anonymous 默认 true。
- 教师评价的课程/学期是作者经验背景，不生成官方授课关系。教师评分和具体开课评分独立提交、独立计算。
- 每账号/教师与每账号/开课各一条。重复新建 409；修改原记录不增加计数。
- POST reviews/{id}/save：revision、data。只有作者能修改，不能更换评价对象。旧公开版本继续可见，新版本先审核；改为匿名时旧公开署名立即隐藏。
- 新版发布清空旧版点赞，防止新文字继承旧认可；无评分为 null，少于 5 份标样本较少。
- GET reviews?teacher=&offering=&course=&term=&q=&sort=newest或likes&offset=：仅查询公开版本，q 查正文，每页 24，默认最近发布。
- GET reviews/{id}：公开原文与已审核回复；未公开/撤回 404。本人草稿从 GET reviews/mine 读取。
- POST reviews/{id}/like {enabled}，按人去重，不允许自赞，可取消。
- POST reviews/{id}/withdraw {reason}：本人或 staff，立即退出统计、搜索、高赞和公开直链；可修改后重新提交。
- 公开评价字段：id/subjectType/subjectId/revision/rating/body/courseId/courseName/term/anonymous/author/likes/liked/own/publishedAt/href。
- highlight 按赞数降序、发布版本时间降序、创建时间降序、id 排序；额外 label=高赞评论/最新评价，无评论为 null。
- 返回完整原文，前端可 CSS 截三行，不能 AI 改写后加引号。href 定位 reputation.html?teacher=... 或 offering=...#review-{id}；引用不在第一页时可独立取原文。

## 匿名、回复、审核与申诉

- 独立 CourseReview 模型，**不写普通 Entry、公开个人作品或贡献热力图**。匿名 author 只有 name/anonymous，没有用户编号、用户名或邮箱。
- 回复 POST reviews/{id}/replies {body,anonymous}，最多 3000 字，先审核。匿名原作者的回复也隐藏账号；其他匿名回复用讨论内代号。
- POST review-replies/{id}/withdraw：本人或 staff。
- GET reviews/mine：本人编辑版、审核说明、本人举报/申诉结果。GET reviews/moderation：staff 队列，含 reviews/replies/cases/canTrace，普通审核员看不到匿名账号。
- POST reviews/{id}/moderate {revision,decision:approve或reject,note}，note 必填，禁止自审及审核过期版本；退回保留旧已公开版本。
- POST review-replies/{id}/moderate {decision,note}，同样禁止自审。
- POST reviews/{id}/report {reason}：公开评价；POST reviews/{id}/appeal {reason}：作者对退回/撤回申诉。
- POST review-cases/{id}/resolve {resolution}：staff 记录处理结果并通知反馈者；删除评价另调用 withdraw。
- POST reviews/{id}/trace {reason}：staff + hub.trace_review_author 专门权限，返回账号关联前记录身份访问审计。前端不得默认调用。
- 通知不暴露匿名账号，不公开点赞者清单。真实负面教学体验按同一规则审核。

## 维护资料

staff POST teachers/courses/offerings，均需 sourceChecked=true。

- teachers：id（更新选填）、name/faculty/title/sourceUrl/active、teaching[{name,sourceUrl}]。photo 非空时需 HTTPS url/sourceUrl/credit/rightsConfirmed=true。
- courses：稳定 id、name/faculty/scope/sourceUrl/prerequisites/resources。id 为小写字母、数字、短横线；外部资源需类型、适用基础、收费情况和有效核对日期。
- offerings：id（更新选填）、courseId、teachers 数组、term、campus=shahe/xueyuanlu、sourceUrl、active。只在核对具体开课安排后创建。
- manage_hub.py hub_import_reputation 只创建缺失记录，不覆盖编辑，不造账号、分数或开课关系。首批 13 条课程/专题沿用原编号。
- 三条教师来源：张孟霞 https://lxy.cumtb.edu.cn/info/1067/1196.htm ；刘兰冬 https://lxy.cumtb.edu.cn/info/1067/1195.htm ；刘菊 https://lxy.cumtb.edu.cn/info/1067/1214.htm 。
- 仅整理来源所列姓名、职称、学院和少量授课名称；原页面可能保留旧信息，不声明已核对本学期任职或开课。照片使用方式未确认，均为空。
- 外部学习入口核对于 2026-10-06：中国大学 MOOC https://www.icourse163.org/ （费用以原站为准）；IELTS https://ielts.org/take-a-test/preparation-resources/sample-test-questions （官方公开样题）。

## 短视频功能接口（页面交给 Opus）

- GET clips/capabilities：available/maxBytes/maxSeconds/formats，依据编码器实际可用性。
- POST multipart clips：file、subjectType=teacher/course/project、subjectId、title（120 字）、transcript（必填文字稿，10000 字）、rightsConfirmed=true。
- MP4/MOV/WebM，200 MiB、180 秒；扩展名之外还做真实解码。禁止远程协议/播放列表作为输入，限制单次运行时间、分配大小和线程数。
- queued→processing→pending→published/rejected；失败 failed，撤回 withdrawn。视频有独立队列，不阻塞来源采集。
- 转成兼容 MP4（最高 1280×720、保留比例、不放大小视频），去元数据、生成封面。超时长拒绝，不截断后发布。
- GET clips?subjectType=&subjectId=&q=&offset=：公开视频，q 搜标题/文字稿，每页 24。
- GET clips/mine、clips/moderation：本人状态、staff 队列。
- POST clips/{id}/moderate {decision,note}，禁止自审；POST clips/{id}/withdraw {note}，本人或 staff。
- clips/{id}/stream、poster：公开前仅本人/staff，原件没有公开路由，撤回关闭播放；支持单段 Range、后缀范围和 206/416。
- 视频明确署名投稿，不与匿名课评共用署名，不承诺隐藏人脸/声音。文字稿和发布权由投稿者确认。
- client：clipCapabilities、uploadClip(file,fields)、clips、myClips、moderateClips、moderateClip、withdrawClip。
- Opus 需接入上传、处理状态、失败说明、文字稿、审核和播放器。默认静音、离屏暂停属于页面交互，后端完成不代表页面已接好。
- run_hub.py 默认启用视频队列；独立 WSGI 部署另跑 manage_hub.py hub_clip_worker。HUB_FFMPEG 可配置可执行文件；imageio-ffmpeg 提供本机二进制，不上传外部处理。
- 反代仅 POST /api/hub/clips 需 201 MiB 上限，普通资料仍 25 MiB；私有 .data 不进发布目录。

## 验收

- test hub.test_reputation：分离计分、去重、高赞版本、匿名审计、权限/CSRF、申诉、资料来源与外链。
- test hub.test_clips：实际转码、元数据清除、范围播放、权限、撤回、伪视频、无编码器和超时长。
- campus/tests/reputation_browser_smoke.py：隔离库真实同源流程、390/1440、匿名原文定位、审核、回复、修改/撤回、独立课程评分。
- campus/tests/clips_browser_smoke.py：真实 multipart 经同源代理上传、独立队列、审核前私有、审核后 206 范围播放、Edge HTML5 解码播放/拖动进度、撤回后 404。仅浏览器临时测试播放器，不创建产品布局。
- 2026-10-06 验证：Hub 全部 37 项、原知识库 16 项、两项浏览器流程、全站构建及内容校验通过；短视频产品页面仍由 Opus 接入。
- campus/.data/reputation-qa/result.json 和截图只代表现有功能基线，不代表 Opus 后续布局修改已被测试。
