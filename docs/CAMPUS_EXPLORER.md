# 校园探索：空间叙事、共建地图与前往导航

2026-10-06。Owner 新增要求；Codex 提供接口与内容规则，Opus 负责校园展示和地图页面。

## 产品体验

学校展示可以从“进入矿大的一天”展开：晨光下的校园、学习空间、运动场、学生创造的作品、同学发现的新角落。借鉴 Apple Park 页面的大幅建筑摄影、克制文字与场景切换，使用矿大自己的授权照片、学生作品和原创插画，不复制苹果素材。[Apple Park 官方页面](https://www.apple.com/retail/appleparkvisitorcenter/)

从展示页可直接进入“探索地图”，而不是必须看完长动画。参考上海迪士尼地图用主题分类组织地点的方式，把点位分成学习、饮食、运动、风景、设施、活动、同学发现。学院路和沙河独立切换。[上海迪士尼地图](https://www.shanghaidisneyresort.com/experience/?map=true)

推荐布局：桌面左侧搜索/分类/地点卡，右侧地图；手机全屏地图配可收起的底部卡片。地图和列表互相定位，收藏、关注、导航、纠错都在地点卡中完成。网络不佳时列表仍可读，不能把没加载成功的地点显示成“附近没有”。

“奶龙最新地点”示例流程（示例不是实际校园情报）：

1. 同学在现场拍照，选择校区，在地图上确认点位，填写“楼的哪一侧、哪个入口旁”等详细说明。
2. 选择临时发现，记录观察时间和有效期，例如今天晚上结束。图片署名、分享许可和公共地点确认随投稿提交。
3. 审核者核对地点、照片与时效后发布，地图出现图标；关注该条目的同学可收到后续修订通知。
4. 后来的同学可报告“仍在”或“已不在”。每人每个地点只保留一个当前反馈，不累计刷贡献。
5. 到期自动从当前地图过滤；历史页面保留记录并显示过期，不再给前往导航按钮。

长期设施和临时热点有不同生命周期。常驻图书馆不应七天就消失；临时布置不能永远悬挂。地图首批没有真实点位时保持空白，不填入虚构的“最新奶龙”“网红机位”或人气数字。

## 创意扩展的先后顺序

第一版：地点检索、校区与分类筛选、照片卡、投稿审核、Star/关注、临时有效期、现场反馈、外部导航。地点与普通项目共用账号、贡献记录、审核、讨论与举报。

后续可做“新生第一周”“雨天不淋雨路线”“傍晚摄影散步”“机器人社团作品展”等主题路线。路线需要同学实地确认入口、开放时间和通行条件后发布；无障碍标签需现场核对，不从图片猜测。收藏形成私人“想去清单”，完成记录由用户自愿记下，不要求持续定位。

可再增加某栋楼关联的课程、实验室开放项目、社团活动和校史故事。校园在地图上不仅是建筑位置，也可以成为学习与共建的入口。

## 已实现的数据接口

2026-10-06：下列服务端代码与测试已完成；地图页面、底图与真实校园点位尚未验收。不会据此宣称已具备逐向导航或实时校园热点。

### 创建与审核

复用 `POST /api/hub/entries`，`kind="place"`，`data` 包括通用的 title/summary/body/license/rightsConfirmed/tags/uploads，加：

```json
{
  "campus": "shahe",
  "placeType": "discovery",
  "duration": "temporary",
  "location": { "lat": 40.1, "lng": 116.2, "coordinateSystem": "wgs84", "accuracyMeters": 10 },
  "addressHint": "测试示例：公共广场入口旁（不是已确认地点）",
  "observedAt": "2026-10-06T15:00:00+08:00",
  "expiresAt": "2026-10-06T21:00:00+08:00",
  "accessNotes": "说明开放时间、入口和现场条件",
  "photoCredit": "照片作者署名",
  "publicLocationConfirmed": true
}
```

示例坐标不是已验证地标。临时记录最多自观察时间起七天；提交和审核时必须未过期。长期地点 `duration="permanent"`，`expiresAt=null`。校区为 `shahe/xueyuanlu`，类型为 `facility/study/food/sports/scenery/event/discovery`。地图坐标必须 WGS84，不能把高德/百度坐标直接标成 WGS84。

上传先调用现有 multipart `/uploads`，获得本人 upload ID，再填入 `data.uploads`。地点要求至少一张照片；支持 JPEG/PNG/WebP，单文件 25MB、最大 3600 万像素。校内资料 PDF 不作为地点照片。

草稿保存、提交、退回、修订沿用 Hub。审核批准除了 revision/decision/note 还必须 `locationChecked:true`；服务端写入 locationReviewedAt 和 locationReviewer，普通投稿者不能自行赋予。需要确认校区、坐标、公共区域和照片来源，**不表示审查者到现场证明热点仍在**。

`hubApi.review(id,revision,'approve',note,{locationChecked:true})`。

### 地图读取

`GET /api/hub/map/places?campus=shahe&type=discovery&q=奶龙&bbox=west,south,east,north&offset=0`

返回 GeoJSON FeatureCollection：

- `features[]`：Feature `{id, geometry:{type:"Point",coordinates:[lng,lat]}, properties}`。
- `properties`：沿用 Entry，另有 `campus/placeType/expired/sourceLabel/photos/observations/navigation`。详细文案和期限在 `properties.data`。
- `photos[]`：`{id,previewUrl:"/api/hub/uploads/{id}/photo"}`。
- `observations`：`{stillThere,gone,lastReportAt,notice}`，只统计最近 24 小时。
- `navigation`：`{url,label,notice}`。过期记录 url=null。
- 顶层另有 `total/offset/nextOffset/campuses/placeTypes/generatedAt/coordinateSystem/notice`，每页最多 200 项。

默认仅公开、已核对、未过期地点。`includeExpired=1` 可查看过期记录；必须用样式和文字清晰标出。轮询建议只在页面可见时进行，发布和修订审核后刷新即可；不要称为服务器主动推送或跨设备实时定位。

照片公开接口重新生成不带 EXIF/GPS/注释的预览，最大边 1280；地点原图下载只对本人或维护者开放。撤回地点后公开预览也失效。对照片作者与现场人物的展示按投稿审核处理，分享的是地点而非同学个人实时行踪。

### 反馈与现有社区动作

`POST /api/hub/map/places/{id}/observe {status:"still-there"|"gone"|"clear",note:"可选"}`。需验证邮箱；作者更新原记录，其他人提交现场反馈。重复提交更新同一条反馈，不刷贡献、不自动认证为官方状态、不自动延长有效期。

Star、关注、回复、举报继续使用 `/entries/{id}/*`。关注 events 选择 revision（地点修订通知）或 discussion；`generatedAt` 是接口生成时间，`observedAt` 才是作者观察时间，不可混为一谈。

## 导航与底图

第一版输出百度地图官方 marker 调起链接，显式指定 `coord_type=wgs84`；用户进入外部地图选择起点和路线。本站不采集用户起点或连续轨迹，也没有宣称完成实地导航验收。后续可增加高德适配，但须正确转换或使用其官方支持的坐标输入。[百度地图官方调起文档](https://lbs.baidu.com/docs/webapi?title=mapadjustment/uri/web)

前端可选开源 Leaflet 接 GeoJSON。它的底图来源是独立配置项，不能把开源地图框架误解成可无限使用第三方地图服务。[Leaflet 文档](https://leafletjs.com/reference.html)

如试用 OSM 公共瓦片，必须显示署名、按需请求并遵守缓存要求，不提供离线批量下载。全站目前倾向 no-referrer；若直接使用公共 OSM 瓦片，要给图层设置合规的 `referrerPolicy`，否则与其服务规则冲突。校园正式服务可配置自托管或其他许可合适的底图。[OSM 瓦片政策](https://operations.osmfoundation.org/policies/tiles/)

迪士尼式插画可以是独立导览层。没有地理配准时明确是示意图，导航按钮继续使用经核对坐标；AI 美术不能凭想象决定道路、出入口和建筑位置。

## 验收

新增 4 项地图测试已通过：审核与坐标标识、原图权限与 EXIF 去除、有效期与现场反馈去重、异常坐标与他人附件拒绝。合计 Hub 24 项测试通过。

Opus 页面待验收：手机选点上传 → 审核 → 地图出现 → 收藏和关注 → 修改后提醒 → 外部地图落点核对 → 到期隐藏。需用真实同学有权分享的照片和确认过的地点进行实地验证，不能用单元测试坐标宣布完成。
