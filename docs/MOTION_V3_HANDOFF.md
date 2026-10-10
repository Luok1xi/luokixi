# 动效第三版：云端进度与本地接手说明

日期：2026-10-10。分支：`claude/adoring-lamport-0b6m46`（基于 `main` 的 `c91e375`）。

Owner 的要求：
- 把底层交互逻辑做好，做成苹果那样，各种功能动画再酷一些；
- 学习 ThreeUI Sylva 的按钮特效（https://threeui.com/hero/sylva）；
- 把看看收藏（kankan-shoucang）的效果做成收藏夹；
- motion-web 作为基础动画设计参考；
- 先看 Codex 交接里的最新位置。

云端已完成的部分如下，Owner 要求剩下的在本地 Opus 中完成。

## 1. 接手前先知道的事

- **Codex 的最新位置**是 `CODEX_TO_OPUS.md` 第 43 次。Codex 已在第 41 次停止开发、释放全部文件认领，所以 carousel / opening / story / art / cover / app-icons 现在都可以由 Opus 改。
- **GSAP 3.15** 已在依赖里，全部插件免费（Flip、Draggable、InertiaPlugin、SplitText、DrawSVG、MorphSVG、Observer）。统一从 `src/js/gsap.js` 按需加载，不要在页面里直接 `import 'gsap'`，否则首屏会多 28 KB。
- **参考仓库的许可**：
  - ThreeUI 是 MIT，已移植，声明写在 `THIRD_PARTY_NOTICES.md`。
  - 看看收藏是 AGPL-3.0，motion-web 是 CC BY-NC，两者都只能借鉴思路，**不能复制代码**。
- **验收动效要用构建后的站点**：`npm run build && npx vite preview`。`vite dev` 里 CSS 由 JS 注入，跨页转场只会是浏览器默认的 250ms 淡入淡出，看不出真实效果。
- **研究报告**都在 `docs/motion-research-20261010/`，里面的行号对应 `c91e375`。报告里提到的 `/tmp/...` 路径是云端临时目录，本地没有，需要的话重新克隆参考仓库：

  | 文件 | 内容 |
  |---|---|
  | `sylva-liquid-metal.md` | Sylva 按钮逐层拆解，以及 CSS 移植方案和测量 |
  | `favorites-desk-spec.md` | 看看收藏整理台的机制，以及本站收藏夹的完整规格（数据、动画、拖拽、无障碍、手机） |
  | `motion-system-gap.md` | motion-web 的动效体系，以及本站差距与令牌方案 |
  | `gsap-picks.md` | 26 个 GSAP 参考，按页面对号入座 |
  | `audit-*.txt` | 五块页面的逐条问题和机会（编号 SH-xx / H-xx / O-xx / A-xx） |

## 2. 云端已完成（本分支）

### 新增的共享底层

页面只需 `import { … } from '../js/fx.js'`。

| 文件 | 作用 |
|---|---|
| `src/js/toast.js` + `ui.css` | 全站唯一的提示条，是顶栏下方的深色胶囊（灵动岛式）。<br>- 一次只显示一条，停留时间按字数算，悬停、聚焦或切到后台时暂停。<br>- 往上拨可以收起；作为 popover 放在顶层，弹窗打开时也能盖住。<br>- 调用：`toast(msg)`、`toast(msg, {href,label})`、`toast(msg,{tone:'ok'\|'err', action, duration})`，会返回 `{update, dismiss}`。 |
| `src/js/sheet.js` | 页面上所有 `<dialog>` 自动获得：<br>- Esc 和点背景带动画关闭；填过的表单先问“放弃这次编辑？”；<br>- 手机上有顶部小横条，下拉可关闭（跟手、按速度判断、没拖够就弹回）。<br>导出 `openFrom` / `closeTo`（已修好：等比缩放，不再半透明叠影，关闭后清掉 flip 标记）、`dismiss`，以及代替 `confirm()` / `prompt()` 的 `confirmSheet({...})`。 |
| `src/js/fx.js` | **按压引擎**：手指一碰就收，松手按弹簧弹回。用的是独立的 `scale` 属性，不覆盖元素自己的 transform；收多少按面积自动选。各页原来散落的 `:active { transform: scale() }` 已全部删除。<br>另外新增：<br>- `toggle(btn,{request,apply,count,reconcile,guard})`：乐观切换，先变再发请求，同一按钮的请求按顺序发，失败退回、摇一下并提示；<br>- `act(btn, task, {success})`：超过 150ms 才转 iOS 菊花，至少转 400ms，可显示“✓ 已保存”；<br>- `reflow(list, update)`：GSAP Flip 列表重排，元素需要带 `data-flip-id`；<br>- 以及 `shake`、`stagger`、`swap`。 |
| `src/js/liquid.js` + `liquid.css` | Sylva 液态金属按钮 `.lm`，纯 CSS 图层，静止时零重绘。<br>- 悬停：底部亮起熔化的金属，边缘彩色高光跟光标转；<br>- 按下：从按下的位置荡开波纹；<br>- `aria-busy`：高光绕圈；`data-live`：在屏幕内时缓慢转动；<br>- 放在图片上用 `.is-glass`。<br>**还没有放到任何页面上**，见第 3 节。 |
| `src/js/gsap.js` | GSAP 按需入口：注册 `ios` / `out` / `ios-in` 曲线和 `spring-*` 弹簧（与 CSS 共用一条曲线）；提供 `loadFlip()` / `loadDraggable()` / `loadSplitText()`。 |
| `src/js/motion.js` | 新导出 `DUR`、`EASE`、`springEase(name)` 和 `reducedMotion`。 |
| `tokens.css` | 动效令牌：`--dur-instant…--dur-slow`、`--dur-exit*`、`--ease-in`、`--stagger*`、`--press-*`，以及 `--settle` / `--confirm` / `--surface`（弹簧必须配自己的 `-dur` 一起用）。 |

### 修掉的问题（云端已验证）

- 手机上点 ＋ 打开的“发布”面板原来跑到屏幕外（y = −360…−17）。原因是它被顶栏的 backdrop-filter 困住了，现在挂到 body 上，从底部升起，带半透明底，＋ 会转成 ×。菜单支持方向键，Tab 或 Esc 关闭，关闭也有动画。
- 原来有三套换页规则互相打架，`components.css` 和 `v3.css` 里的旧规则已删掉，只留 `motion.css` 一套：
  - 同板块换页时，旧页留在下面不动、新页盖上来，不再透出白底“闪一下”；
  - 顶栏和标签栏原地不动；
  - 切换深浅色时整页淡过去，月亮图标转半圈。
- 浏览器后退时，动画方向和来时相反（用 Navigation API 记下每条历史记录到达时的方向）。
- 后退回到异步渲染的页面时恢复滚动位置：内容高度够了再滚过去，用户已经动过页面就不动。需要更早恢复时，页面可以在首次渲染后调用 `pageReady()`（从 `shell.js` 导出）。
- 地图、开源、项目、知识库四个页面各自的 toast 已换成共享版本。原来开源页的进场动画从没播放过，连续提示还会被旧计时器提前关掉，这两个问题随之消失。
- `.dlg` 在手机上也贴底升起。卡片悬停只在真有鼠标的设备上触发，不再过渡阴影。`data-reveal` 改为 0.64 秒、24px。骨架屏的流光转 6 次后停止。

验证情况：
- `npm run build` 通过。
- 构建版 10 个页面在 1280 和 390 两个宽度下无脚本错误、无横向溢出。
- 手机上的发布面板位置和 Esc 关闭正常。
- **未做的**：真机测试、减少动态效果模式下的逐页检查、各页面里新底层的接入。

## 3. 本地待完成（建议顺序）

每页的具体做法、行号和数值都在 `audit-*.txt` 里。下面写的是要点。

1. **收藏夹整理台**（Owner 点名，最重要）
   - 新建 `src/js/favorites-desk.js` 和 `src/styles/favorites.css`，替换 `me.js` 里的 `SECTIONS.stars()`。
   - 完整规格见 `favorites-desk-spec.md`：
     - 按 `Star.collection` 分堆，每堆最多画 4 张，倾斜角由条目 id 的哈希决定；
     - 点堆名用 Flip 展开成卡片墙，其余堆变暗；
     - 拖卡片到另一堆就移到那个收藏夹（`hubApi.star(id, true, 名称)`），手机上长按 400ms 才开始拖；
     - 每张卡片有 ⋯ 菜单，键盘也能完成拖放；
     - 本机收藏和资料袋作为“仅本机”的只读堆；
     - 减少动态效果时直接切换。
   - **先修一个后端坑**：`campus/hub/api.py` 约第 395 行的 star 用了 `update_or_create`，前端各处默认传“默认收藏”，会把已经分好类的收藏冲回默认。请求里没带 `collection` 时应保留原值，`hub-client.js` 第 88 行也别默认传值。改完补一条测试。
2. **首页**（`audit-home.txt`）
   - H1：骨架屏和轮播尺寸一致（现在挂载时页面跳 214px）；
   - H2：故事详情的标题别重排；
   - H3：推荐流逐块出现，不必等 18 个 PDF 探测；
   - H4：触控板横扫切换轮播；
   - H5：分页点改成 iOS 胶囊进度；
   - H8：模块用 `.as-reveal` 入场；
   - H10：标签下划线只用 transform；
   - H12：放入资料袋时原地更新，并让图标弹一下；
   - 轮播主按钮换成 `.lm.is-glass`，加 `data-live`。
3. **资料页**（O3、O6、O10、O13、O15）
   - 不再整页重渲染；筛选和搜索用 `reflow()`；
   - 加入资料袋走抛物线；
   - 资料袋设 `--bottom-accessory-h`，让 FAB 让位；
   - “去打包”用 `.lm`。
4. **校圈和口碑**（O1、O2、O7、O9、O11、O12、O16、O17）
   - 点赞、收藏、关注改用 `toggle()`；
   - 帖子详情点开立刻显示，楼层随后补上；
   - 顶部 `#circle-status` / `#rp-message` 的提示改用 toast；
   - 评分条从左边长出来；修 `store.css` 里评论卡星星变灰的选择器优先级问题；
   - 回复框做成 iMessage 式。
5. **开源、项目、项目广场**（A2、A3、A8、A10、A12、A17）
   - 项目页按插槽局部更新，不再整页重渲染 4 次；
   - 收藏改用 `toggle()`；
   - 发现流用滚动时间线跟手入场；
   - 筛选用 Flip；
   - “读中文导读”用 `.lm`。
6. **地图**（A4、A6、A7）
   - 手机面板用 Draggable + Inertia 做成三档停靠（Apple 地图那样）；
   - 面板内部做导航栈推入和推出；
   - 图钉落下、气泡从锚点长出；
   - 循环动画加 `data-live`。
7. **个人中心、北矿娘、登录、预约、工作室**（A5、A11、A13、A14、A15、A16）
   - 北矿娘聊天按消息 id 局部更新，不再每 2.5 秒清空输入；
   - 手机上的“我的”做成设置页式的推入；
   - 密码错误时卡片摇一下，提交走 `act()`；
   - 原生 `confirm()` / `prompt()` 换成 `confirmSheet()`，位置在 `me.js:541`、`map.js:1364`、`reservations.js:16`、`project.js:440`。
8. **收尾**
   - 全站搜索的选中高亮做成滑动的（SH-14）；
   - `docs/DESIGN.md` 的“动效原则”按第三版重写（现在写的 1 秒入场、ScrollTrigger 都已过时）；
   - 在 `OPUS_TO_CODEX.md` 记第 18 次交接；
   - 跑 `npm run build`、前端测试和真机检查。

## 4. 不要做的

- 恢复以前被否决的效果：倾斜、粒子、数字从 0 数起、逐帧弹簧、宽度动画、故事卡片的 View Transition、彩色图标底。
- 在长列表的每一行上加入场动画。
- 用 ScrollSmoother，或者劫持滚动。
- 加持续呼吸的循环动画。
- 在移动中的图层上用 backdrop-filter。
- 让页面直接 `import 'gsap'`（统一走 `src/js/gsap.js`）。
- 复制看看收藏或 motion-web 的代码。
- 伪造收藏数据或计数。乐观更新之后必须以服务器返回为准。
