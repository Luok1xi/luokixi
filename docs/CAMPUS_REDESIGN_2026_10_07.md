# 课程板、地图与资料库 · 2026-10-07 本地验收

## 入口和范围

- http://127.0.0.1:17860/planner.html：首页与地图共用同一个本机课程板。
- http://127.0.0.1:17860/map.html：保留现有 Leaflet/校园几何底图，不使用百度跳转导航。
- http://127.0.0.1:17860/materials.html：全部资料、搜索筛选、纵向大封面、预览/下载/资料袋/上传。
- 当前 Git 工作区为未提交初始状态；本轮没有 reset/stash/commit/push/部署。改前 293 个源码文件已保存在本聊天 work/redesign-baseline，未复制私人数据库。

## 功能与数据边界

### 学校导入与课程板

学校登录在本人浏览器原站完成。首次将“提取到 Luokixi”拖入书签栏，之后在学校课表页点击；只读取可见表格，包括可访问的同源 iframe。不读取 cookie、存储、密码、隐藏输入，不请求学校接口。提取后通过检查 origin/source 的 postMessage 回到核对预览；弹窗/窗口通信不通时下载 .school.json 由本人导入。

当前仅接受 cumtb.edu.cn 及其子域名，支持明确时间/周次的星期网格、带合并单元格的表格、标准列名列表与显式节次映射。未给出开学日期或节次钟点时由用户填写；未知格式保留原计划并报错。真实教务系统页面未取得，真实登录态提取仍待 Owner 核对，不能宣称已完成某个教务供应商的适配。

学校课程使用 origin=school，学校事件 fixed=true；编辑器锁住学校名称/时间/地点等核心字段。任务支持待安排、拖入空闲时间、跨日移动、15 分钟吸附、时长拖动、待安排排序、原位淡影与拖动副本。重复安排拖动只改这一次，冲突不会保存。再次学校导入默认仅更新学校来源的课程/事件，保留手动课程与私人任务，并沿用匹配课程的本地备注/建筑/提醒与编号。普通个人日历可选择“个人日程”，不会被锁成学校课程。

数据仍仅在 IndexedDB；课程板与地图使用同一存储与版本冲突保护。准点/提前提醒需要该课表页打开且浏览器允许执行；关闭网页后必须将 ICS 导入系统日历。系统日历不是实时双向同步，改动后需重新导出导入。

### 地图

五个入口为课表/地图/活动/导航/资料库。“探索校园”在活动内折叠。楼宇原始轮廓和校园数据未修改，只恢复并调整低饱和分类色。点击建筑直接打开地图内详情卡，优先图片/轮廓示意与导航；预约在官方服务折叠区，相关活动仅列真实已公开记录。无真实投稿照片时明确标注 OSM 轮廓示意，不冒充建筑照片。

导航调用原有校内步行路网算法；无连通路网时用虚线、文字明确标出直线估算。不是实时定位或经过实地核实的无障碍路线。

名称提名和支持接口为 GET/POST /api/hub/map/names。使用现有 Workspace 的 building_name_vote 记录，不新增迁移；每个已验证邮箱账号每栋楼一个可修改/撤回的选择。聚合按真实票数排序，公众响应不包含投票者身份；学生常用名与原地图名/明确的官方名分开。普通工作区写接口不能创建或改造投票记录。真实社区库没有写入验收用投票；测试仅使用隔离测试库。

### 资料库

封面是根据真实资料分类/年份生成的代码封面，不伪称文件原封面。已有投稿显示真实 owner.name 与 siteStars；本机资料没有上传者或下载量时不编造数字。仅封面做 36px 范围滚动视差，正文保持稳定，减少动态模式禁用视差。空资料袋缩为角落按钮，有资料后才显示打包条。

## 验收

- npm run test:planner：79/79，覆盖旧数据、导入、存储冲突、路线、新的学校锁定/任务移动/排序/准点提醒/学校更新/合并单元格。
- node --test scripts/test-material-bag.mjs：4/4，字节/中文文件名/来源清单、下载目标边界、缺失/错误文件、取消。
- python campus/manage_hub.py test hub.test_building_names --noinput：3/3，单账号不重复计数、改选/撤回、公开聚合、匿名/未验证账号与非专用接口拒绝。
- npm run validate：通过；npm run build：183 modules，通过。已有 Three 模块大于 500 KB 的构建提示仍在，没有把其他模块的 Three 源码归为本轮。
- browser_redesign.py：真实本机资料检索、加入资料袋、实际 ZIP 解压检查、学校固定锁、待安排拖入/刷新保留、五入口、地图内路线、活动探索、390px 无页面横向溢出。
- browser_boundaries.py：本地拦截的合成学校页面 → 书签提取 → 检查同源窗口 → 预览 → 锁定导入；不提取密码输入；任务编辑/拖动/时长/拒绝占用时段/Escape/键盘取消；学校更新不重复；ICS 准点提醒；深浅色、减少动态及 390px 布局。
- check_map_final.py：真实名称 GET 接口可读、匿名写被拒绝、地图点击直接详情、图片/预约/相关活动/命名表单、转地图内导航、至少五种建筑色、无百度链接、首页进入同一课程板。
- 三组浏览器验证均 0 pageerror。真实学校适配、手机实机/触摸性能、真实预约、关闭网页后通知执行不在已通过范围内。

## 本轮源文件

- `src/js/campus-plan.js`
- `src/js/materials-catalog.js`
- `src/pages/map.js`
- `src/pages/materials.js`
- `src/pages/planner.js`
- `docs/BOARD.md`
- `docs/PRODUCT_SPEC.md`
- `campus/hub/api.py`
- `map.html`
- `materials.html`
- `planner.html`
- `package.json`
- `package-lock.json`
- `CODEX_TO_OPUS.md`
- `src/js/campus-schedule.js`
- `src/js/course-board.js`
- `src/js/school-import.js`
- `src/styles/course-board.css`
- `src/styles/campus-essential.css`
- `src/styles/materials-gallery.css`
- `scripts/test-course-board.mjs`
- `campus/hub/building_names.py`
- `campus/hub/test_building_names.py`

浏览器脚本/JSON/截图保存在 `C:/Users/user/Documents/Codex/2026-10-07/cha/work/`。源文件已释放，可继续在此本机版本上验收。
