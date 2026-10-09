# 校园页面离线缓存

只为“我的校园”与校园地图提供离线再访问。私人课程、日程、备注、收藏和路线偏好仍由 `campus-store.js` 保存到 IndexedDB；此缓存不读取、不复制，也不上传这些记录。

## 缓存边界

`public/campus-worker.js` 只处理同源 GET：

- 已访问的 `planner.html`、`map.html`，网络优先；断网或服务异常时使用已保存页面。缓存键去除日期、课程与地图参数，保存通用页面，不保存私人页面快照。
- 校园页面访问的 `assets/` 中带内容 hash 的脚本、样式、字体和图像，已有缓存时优先读取。
- `data/courses.json`、`data/campus-map/xueyuanlu.json`、`data/campus-map/shahe.json`，网络优先，断网回退到已保存版本。

不缓存 `/api`、身份与账号页面、其他 HTML、投稿、上传目录、`public/files`、PDF、授权头请求、跨源请求或个人计划。拒绝缓存 `private` / `no-store`、按 Cookie 或 Authorization 变化的响应，以及从校园入口跳转到其他页面的响应。即使 Service Worker 控制整个网站路径，其他页面和接口也照常走网络。

缓存分别最多保留 2 个校园页面、160 个 hash 资源和 3 个公开 JSON。缓存名含部署路径，更新时只清理该路径下旧版校园缓存，不影响其他站点缓存。没有离线副本的页面返回“请联网访问一次”的提示，不制造地图、学校服务或预约结果。

## 接入与首次访问

页面在 localhost 或 HTTPS 上调用：

```js
await navigator.serviceWorker.register('campus-worker.js');
await navigator.serviceWorker.ready;
```

校园主入口为 `map.html`，课表与日程是地图中的工具；从地图首次进入也能完成离线准备。首次激活会保存当时已打开的校园页面和 HTML 中声明的 hash 依赖；样式引用的字体与图像，以及这些校园脚本明确引用的 hash 模块依赖也会保存。同时预备两校区地图与公开课程这 3 个明确公开 JSON，避免初次地图请求早于缓存接管而漏存；不读取私人资料来判断校区。后续页面访问由请求缓存补齐。首次在线打开地图，等待 Service Worker ready 与真实楼宇轮廓加载后即可离线重访，无需先打开课表工具。

这是校园页面缓存，不是全站 PWA。Vite 开发模式的源码路径没有内容 hash，无法完整离线重启；离线验收应使用 `npm run build` 后的 preview 或正式静态构建。本次没有部署公网。

离线仍可查看和编辑本机计划、读取已缓存地图；登录、投稿、公共活动更新、学校原站及预约流程需要联网。不会缓存官方余位、登录会话或接口返回的私人内容。未访问的导入模块或公共目录可能尚未缓存，应联网使用一次。清理浏览器“站点数据”可能同时删除缓存与 IndexedDB，清理前先导出 JSON 备份。

## 2026-10-07 本机验证

使用 Microsoft Edge 无持久资料的隔离浏览器环境，生产构建预览地址 `http://127.0.0.1:18197`：

- 首次 Service Worker ready 后有校园 HTML 与其 hash 依赖；未预缓存其他站点页面。
- 直接从地图首次进入，首次 ready 后两个校区与公开课程 JSON 已准备；无需先打开课表工具。
- 离线重访校园中心与地图，页面脚本正常启动，并核对真实楼宇轮廓渲染。
- 缓存列表没有 `/api`、`auth.html`、上传或 PDF 路径。
- 未使用真实账号、私人浏览器资料或线上服务。

证据位于本轮工作目录 `work/campus-offline-browser-result.json`，复验脚本 `work/test-campus-offline-browser.mjs`。页面功能完整验收与数据层测试另见校园中心的交付记录。

最终地图首次入口复验使用最新构建的 `http://127.0.0.1:17860`，在全新隔离浏览器环境只打开地图，首次 ready 后缓存为 1 个地图 HTML、3 个公开 JSON、24 个 hash 资源；随即断网重访并切换两校区，沙河显示 8 个、学院路显示 53 个真实建筑轮廓，再切回沙河仍显示 8 个，浏览器没有脚本错误。缓存范围核对通过，真实私人数据未读取或修改。证据为 `work/campus-map-first-offline-result.json`，复验脚本为 `work/test-campus-map-first-offline.mjs`。