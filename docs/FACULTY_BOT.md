# 教师资料机器人与虎扑式评分（Opus · 2026-10-07）

面向同学的规则写在 [社区制度](../rules.html)，这里是实现说明。

## 教师资料机器人

- **读什么**：[campus/faculty-sources.json](../campus/faculty-sources.json) 列出 11 个学院官网的师资栏目。机器人在 `prefix` 目录里翻名单页，读取以下字段：
  - 个人页链接 `/info/<栏目>/<编号>.htm`；
  - 姓名、职称；
  - 系所、研究方向、主讲课程；
  - 官网照片地址。
- **兼容的名单写法**：
  - 段落标题（“副教授”）后跟一串姓名；
  - “姓名-职称”写在同一个链接里；
  - 照片卡片里带姓名和职称；
  - 链接里只有照片，姓名在下一行。
- **礼貌抓取**：
  - 每个站点先读 robots.txt，404 视为允许；
  - 请求间隔至少 1.5 秒；
  - 单次运行最多翻 24 个名单页、读 80 个个人页，优先读没读过的，其次读 30 天没核对过的；
  - 统一走 `discovery.fetch_public`：固定 DNS、只连公网、限制大小和重定向。
- **调度**：
  - 每个学院是一条 `Source(kind='faculty')`，迁移 `0013_reputation_bot` 按配置文件建好并启用；
  - worker 按 `interval_hours`（168 小时）自动运行；`discovery.refresh_source` 遇到 `kind='faculty'` 时转到 `faculty.crawl_source`；
  - 不改 maintenance / worker；`HUB_FACULTY_CRAWL=0` 时跳过。
- **写入规则**：
  - 文字资料自动更新，记在 `Teacher.profile`：`college / department / research / courses / profileUrl / crawledAt`，并带来源；
  - 维护者手工核对过的姓名、职称、授课信息、照片不被覆盖；
  - 照片只记成 `profile.photoCandidate`，维护者确认是本人后才写入 `Teacher.photo` 公开；拒绝过的地址记在 `photoRejected`，不再提；
  - 名单里消失的老师只记 `missingSince`，不自动下线，避免一次解析失败就把评价藏起来。
- **维护入口**：`reputation.html?view=moderation` →“教师资料机器人”，可以：
  - 查看各学院状态；
  - 立即运行；
  - 确认或拒绝照片，或整院确认；
  - 处理“更正 / 撤下照片”申请。
- **不做的事**：不读贴吧、虎扑。两站的 robots.txt 对非搜索引擎一律 `Disallow: /`，贴吧用户协议也禁止第三方抓取。机器人也不登录任何账号。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `reputation/rankings?kind=teachers\|courses` | 评分榜（≥5 人，按均分；不设最差榜）+ 热议榜（近 90 天新评价数） |
| GET | `reputation/wall` | 弹幕墙：按点赞数取已公开评价的原话（最多 40 条） |
| GET | `reputation/tags` | 印象标签（每条评价最多 3 个，不计入星级） |
| GET | `reputation/mentions?teacher=\|course=` | 已公开的站外讨论（链接 + 同学一句话 + 来源站点） |
| GET | `reputation/mentions/mine`、`reputation/mentions/pending`（维护者） | 我提交的 / 待核对的站外讨论 |
| POST | `reputation/mentions` | 提交站外讨论：`subjectType, subjectId, url(https), title, summary` |
| POST | `reputation/mentions/<id>/moderate`（维护者）、`/withdraw` | 核对或撤回 |
| GET | `reputation/faculty`（维护者） | 机器人状态、待确认照片、更正申请 |
| POST | `reputation/faculty/run`、`/setup`、`/photos`（维护者） | 立即运行、启用或停用、确认或拒绝照片（`approve-all` 按学院） |
| POST | `teachers/<id>/request` | 更正资料 / 撤下照片 / 其他，记审计并通知维护者 |
| GET | `reviews?...&sort=hot` | “最热”= 按点赞数（`likes` 的别名） |
| GET | `circle/hot?campus=` | 校圈热榜：近 7 天发布；热度 = 回复×3 + 点赞×2 + 有帮助×2（精选 +3），72 小时减半；和前一天名次比；5 分钟缓存，个人屏蔽读取时生效 |
| GET | `circle/posts/<id>/thread` | 帖子楼层（2 楼起）+ `lit`（亮回复，获赞最多的 3 条） |
| POST | `circle/replies/<id>/like` | 点亮回复；不能点亮自己的回复 |

评价数据新增 `tags`；统计新增 `stats.tags`；教师新增公开字段 `profile`。

## 验证

- 测试：`hub.test_faculty`（4 种名单写法、个人页解析、照片确认与拒绝、手工资料不被覆盖、缺失不下线、定时派发、开关、维护权限）和 `hub.test_reputation_hupu`（标签、最热、评分榜门槛、热议窗口、弹幕墙匿名、站外讨论审核与不计分、热榜屏蔽、亮回复）。
- 隔离库实测：worker 自动跑完 9 个学院，抓到 795 位老师、229 份研究方向，以及 304 张待确认照片。每轮只核对一部分个人页，其余留给后续轮次。官网照片确认后在教师页显示，带出处。
