# 矿大地图工作台：本机验收与接手

日期：2026-10-07。源码：`C:/Users/user/Documents/GitHub/luokixi`。入口：<http://127.0.0.1:17860/map.html>。Owner 指定 [Explore](https://ai.explore.poker)，并选择「卡片层叠、点击展开与顺滑缩放」。在保留地理真实性的前提下原创实现这些交互，不复制参考站源码或素材。本轮不推送、不部署。

## 实际行为

- 一级「校园」仍直接进入学院路地图，可切沙河；课表与日程是地图内工具，原路线、课程、活动和预约入口保留。
- 左侧列表与右侧详情独立；地图图标先开地点小窗，详情再展开成卡片。手机详情使用底部浮卡，原列表在后方，关闭后回到地图，不触发搜索键盘或重新展开列表。
- 会话内保留最近4个实际地点，以最多2个历史入口切回；切换内容及时刷新，不把幻造资料放进卡片。三个卡片层面对应最近查看状态。
- 选中/聚焦的图标完整显示名称，图书馆与食堂常驻名称；其他名称悬停显示。图标保持地理锚点，悬停只抬升2px，不向旁边跳动。
- 统一原有蓝色、浅色/深色表面；服务入口默认收起，详情保留官方来源和预约助手。无需新的全局色彩或导航。
- 地点切换停止旧镜头，展开250ms、退出180ms，使用已有曲线；仅卡片transform/opacity。快速关闭再打开不会被旧退出回调隐藏。
- 键盘操作即时反馈；地图方向键移动、加减键缩放，建筑图标Enter/Space打开小窗，Escape关闭详情。减少动态模式禁用对应变换。焦点回到可见触发点或地图。
- 拖动/缩放时暂时省略楼影与标签阴影，结束后集中刷新。没有全画布模糊或常驻自动镜头；不声称所有硬件60fps。

## 地理与数据边界

原OpenStreetMap数据部分center数值不在自身建筑内（学院路26、沙河3）；对公开展示数据按平移后的footprint中心重新计算，凹形/庭院采用合法边缘点。保留53/8个建筑IDs和全部真实轮廓。图标、建筑小窗、日程数字标点及绘制路线使用这份展示数据；不自动重写个人课表中的旧center/备注，不修改原公共JSON。

仅去除标记context的校外背景路（学院路132、沙河87），保留45/12条校内道路。现有OSM缺少名称与轮廓的区域如实显示，未造楼名、入口、楼层或设施状态。沙河仍只有8栋记录，详尽程度受公共数据限制；学校余位、自动预约和教务授权仍未接入。导航明确保留原站与估算信息。

## 技能安装

[Emil官方仓库](https://github.com/emilkowalski/skills)，MIT，核验commit `e8a175de22ae1e49370fc144c1f3bb9aeedf988d`。已有animate/apple-design/emil-design-eng/mobile-native已备份并核验一致；新增animation-vocabulary/ask-sonner/break-ui/find-animation-opportunities/improve-animations/pick-ui-library/prototype/review-animations，共12项Web技能。新技能下回合自动可用；只安装Markdown，没有运行其仓库代码。

记录：工作目录 `work/emil-skill-install-20261007-135727/INSTALL_REPORT.md`、`installed.json`。

## 本次验证

生产构建170模块成功；`npm run validate`成功；`npm run test:planner`70项通过，包括新增7项几何测试。没有后端更改，未重复执行此前完整Hub测试。本次Three736KB构建提示来自同时存在的其他页面依赖，地图不引入Three；不要为该提示删他人源码。

三套浏览器验证均针对实际17860的最新dist，使用独立非持久Edge上下文，不读取真实用户浏览器课程、不代人审批、不写真实账号或资料。390px是浏览器视口，没有手机硬件验收。

| 实测 | 证据（相对工作目录） |
| --- | --- |
| 卡片展开/最近地点/原列表/官方设施/本机收藏/390px浅深色/公开活动存IDB去重/首次离线重载及两校区切换，共9场景通过 | `work/campus-explore-browser/full-result.json`；`work/test-campus-explore-full.cjs` |
| 建筑道路数量/切校区/拖拽/滚轮/缩放按钮/图标锚点/390px/路线与真实中心/保留个人旧中心，共10场景通过；路线与数字标点差约0.57px | `work/campus-geometry-browser/result.json`；`work/test-campus-geometry-browser.cjs` |
| 手机关闭、地图焦点Escape、快速重开、减少动态模式、键盘即时反馈和Enter/Space小窗通过 | `work/emil-map-readonly-review-after-fixes.json`；`work/emil-marker-keyboard-focus-evidence.json` |

以上运行均0页面脚本错误、0发向真实服务的写请求。公开活动用浏览器GET拦截样本，不往生产数据库发布测试活动。离线缓存29个公共资源，未包含账号、API、私人资料。最终截图 `work/campus-explore-browser/final-*.png` 已目视检查。

## 文件与接手

本轮：`map.html`、`src/pages/map.js`、`src/pages/planner.js`的地图数据归一化、`src/js/campus-map.js`、新`src/js/campus-geometry.js`、新`src/styles/campus-workbench.css`、新`scripts/test-campus-geometry.mjs`、`package.json`测试脚本与交接文档。地图独立样式最后导入，不修改全局tokens或其他页面样式。已释放认领。

17860现有服务直接读取dist，刷新即可；17861继续review-mode，前端更改不需要重启Hub。先本人测试→Astra修正→再走上传流程。Shared交接写入CODEX_TO_OPUS第47次，没有声称直接发到云端Opus。修正后重建并检查地图、课程路线、手机关闭、键盘和离线即可；不要将DB、学校文件、密钥或本人浏览器数据加入源码。
