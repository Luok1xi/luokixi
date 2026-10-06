# 校园地图重绘：仿上海迪士尼导览图（给 Codex 的规格）

2026-10-06 更新。Owner 的决定：

1. **网站上不要卫星地图**，只保留一张插画地图。
2. 卫星图只拿来截图，作为重绘底稿（Claude 已经截好，见第 1 节）。
3. **请 Codex 仿照上海迪士尼乐园导览图的风格重绘**，只画矿大，越精细越好。

页面和交互由 Claude 负责（`map.html`、`src/pages/map.js`、`src/js/{campus-map,quests,places}.js`、`src/styles/map.css`）。重绘交上来、审过以后，页面自动换成你的图，楼的点击区域、名字标签、图钉、任务序号都按同一投影叠在上面。

## 现在的状态

| 部分 | 来源 | 状态 |
|---|---|---|
| 插画地图（临时） | `npm run map:data` 从 OpenStreetMap 拉楼、路、操场、校门 → `public/data/campus-map/<校区>.json`，页面画成粉彩风格 | 可用。学院路 53 栋楼（21 栋有名字）；**沙河只有 8 栋、都没有名字** |
| 卫星截图 | `scripts/capture_campus_satellite.py` | **已截好**，只在本机 |
| Codex 重绘 | `public/art/campus-map/manifest.json` | **等你交付**；清单为空时继续用上面的临时插画 |

## 1. 底稿：已经截好的卫星图

位置：`campus/.data/map-capture/`（被 Git 忽略，不进仓库）。

| 文件 | 内容 |
|---|---|
| `luokixi-xueyuanlu-satellite-z19.png` | 学院路，3666 × 2602，每像素约 0.23 米，干净底图 |
| `luokixi-xueyuanlu-outline-z19.png` | 同一张图叠加：白线是校园边界，黄线是 OSM 楼轮廓，白字是楼名，红框是校门 |
| `luokixi-xueyuanlu-z19.json` | 对位信息：`leafletBounds`、`zoom`、`pixelOrigin`、`width`、`height`、投影 EPSG:3857 |
| `luokixi-shahe-*-z19.*` | 沙河，2691 × 2648，同上 |
| `*-z18.*` | 两个校区的一半分辨率版本，生成工具对输入尺寸有限制时用 |

重新截图：`python scripts/capture_campus_satellite.py`（需要 Pillow；瓦片缓存在同目录 `tiles/`，重跑不再请求）。范围是校园轮廓外扩约 60 米，和页面地图同一投影。

卫星影像版权归 Esri、Maxar 等提供方：**只做本机对位参考，不进仓库、不公开发布**。网站上的插画必须是重新画出来的作品，不能是卫星图加滤镜。

## 2. 风格：上海迪士尼导览图的画法

参考：[上海迪士尼度假区官方地图](https://www.shanghaidisneyresort.com/experience/?map=true)。**只学画法，不搬任何元素。**

- **视角**：俯视的“鸟瞰导览图”，楼画成精致的小模型，露出朝南的正面和屋顶，像一个玩具沙盘。全图同一个光源（左上），柔和投影。
- **色彩**：明亮、饱和但柔和。屋顶颜色按用途区分，可以沿用现在页面的配色思路（`map.css` 里的 `--b-*`：教学楼暖橙、图书馆淡紫、食堂奶黄、宿舍天蓝、体育珊瑚红、实验楼薄荷绿、礼堂粉色），整体不超过一套和谐的色板。
- **园林**：树画成一簇一簇圆润的树冠，草坪有细纹理，操场是砖红色跑道和带白线的绿色球场，水面亮蓝带白色波纹，园路是暖米色。
- **边界**：校园外一圈柔和的绿篱，校外是浅色纸面，最多留几条主路的淡线。
- **不要**：迪士尼城堡、米奇等任何角色、迪士尼标志和字体；画面里不出现任何文字、数字、校徽和人物（见 `ART_DIRECTION.md` 第一节）。名字由页面标签负责。

## 3. 位置不能编

- 每栋楼的**屋顶对齐对位图里的黄线**（卫星图上看到的就是屋顶），朝南的立面向画面下方画出，高度按层数成比例（例如学院路西一楼、西二楼 18 层，逸夫实验楼 12 层，综合楼 10 层），不要盖住南侧的路和入口。这和第 28 次同步的候选、页面的矢量插画是同一个约定，点击区域和名字标签都放在屋顶上。（2026-10-06 晚更正：早先写的“底面对齐、楼身向上”作废。）
- 道路、出入口、操场、楼的位置只能来自截图和 OSM。可以简化、圆角化，但不能挪动、增加或删除。
- 卫星图上看得到、OSM 里没有的楼（沙河很多）：可以画，但要在 `traced` 里逐条登记（大概位置 + 依据的截图文件名），并建议同学在 OSM 上补画（见第 6 节）。

## 4. 交付格式

文件放 `public/art/campus-map/<校区>.webp`（单张不超过 1.5 MB；可选夜景版 `<校区>-night.webp`），在 `manifest.json` 的 `campuses` 里加一条：

```json
"xueyuanlu": {
  "image": "art/campus-map/xueyuanlu.webp",
  "bounds": [[39.994452, 116.33731], [39.999798, 116.347141]],
  "zoom": 19,
  "width": 3666,
  "height": 2602,
  "created": "2026-10-07",
  "tool": "生成工具和版本",
  "prompt": "完整提示词",
  "basedOn": ["luokixi-xueyuanlu-z19.json", "OpenStreetMap（ODbL）"],
  "traced": [],
  "usage": "概念插画",
  "review": "pending"
}
```

`bounds` 直接复制截图 JSON 里的 `leafletBounds`；画布尺寸和 JSON 的 `width`、`height` 一致（或等比放大整数倍）。页面只使用 `review` 为 `approved` 的条目；审稿流程同 `ART_REVIEW.md`，Claude 审过后改成 `approved`。

**对位自检**：把重绘图和干净的卫星截图按 50% 透明度叠在一起，楼的底面偏差不超过 4 像素（z19 约 1 米）。叠图附在审稿记录里。

建议先交学院路（OSM 数据全），沙河等补图以后再做。

## 5. 用途分类的更正

楼的颜色和探索任务按 OSM 名称和标签分类（`build-campus-map.mjs` 的 `buildingUse()`）。猜错的楼（例如“学八楼”目前归成了教学楼，可能其实是宿舍）有两种改法：

1. 推荐：在 OSM 上补准确的 `building=*` 标签。
2. 写进 `public/data/campus-map/overrides.json`，**每条必须有来源**，没有来源的条目会被忽略：

```json
{
  "buildings": {
    "way/123456": { "use": "dorm", "name": "", "levels": 6, "source": "学校公开通知链接，或同学实地核对记录" }
  }
}
```

可选用途：`teaching` `library` `canteen` `dorm` `sports` `lab` `hall` `clinic` `shop` `other`。

## 6. 补全沙河

沙河在 OSM 上只有 8 栋楼。最省事、版权最干净的办法是由同学用自己的账号在 OpenStreetMap 上补画（OSM 网页编辑器自带获准用于描图的影像），给楼加 `name`、`building`、`building:levels`；然后运行 `npm run map:data`，网站的地图、楼宇列表、探索任务会一起变完整。请 Codex 先整理一份“截图上看得到、OSM 里没有”的楼清单，方便大家认领。
