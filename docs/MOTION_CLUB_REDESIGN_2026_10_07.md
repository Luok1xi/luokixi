# 资料空间动效与社团排期 · 2026-10-07

本轮方向取代上一轮被 Owner 否定的通用个人待办课表和轻微视差。视觉是否达到 Owner 的要求仍由其实际体验判断，不以测试通过冒充审美认可。

## 本地入口

- http://127.0.0.1:17860/materials.html
- http://127.0.0.1:17860/planner.html

资料参考：https://gsap.com/showcase/ 实际渲染DOM收录的 https://www.agrumeafarm.it/en ，另实看现有 discover.html 光碟取出与环境退后。采用竖直分层书架、共享位置取书/翻封面/反向收回、先起飞后弧线落袋、购物袋从按钮源点展开。默认 dialog CSS 动画在这两个 GSAP 容器禁用。只为附近书架行保留 ScrollTrigger，全部218项加载样本中活动数量为7（含3本首屏书）；减少动态时释放。

## 真实排期行为

登录后创建社团或使用社长邀请码加入。社长选择社团，直接输入名称、回车生成待排活动；地点与时长可选。拖进空档弹簧吸附，撞同社团活动形成因果退让链；未受影响的旧冲突不自动改动。固定主课/预约拒让，成员不能改社长活动，其他社团不被挤走。退让全部在一个batch中以revision保存，服务器拒绝冲突或旧版本时不部分落库。移动端触屏以pointerdown原始抓取位置为锚点。

成员读取同一共享活动记录，每15秒轮询、回到页面立即同步。相同数据不重绘；旧GET不得覆盖新保存。个人课程不上传，成员在本机看到自己的课程冲突。共享活动/本人预约参与网页提醒与ICS日历导出。提醒仅页面打开时检查，关闭页面需使用系统日历。

## 实现范围

资料：materials.html、src/pages/materials.js、src/js/materials-motion.js、src/styles/materials-gallery.css。
排期：planner.html、src/pages/planner.js、src/js/course-board.js、campus-schedule.js、planner-shared.js、planner-spring.js、src/styles/course-board.css、scripts/test-schedule-yield.mjs。
后端：campus/hub/club_models.py、club_schedule.py、test_club_schedule.py、migrations/0016_club_schedule.py；models.py/api.py挂接。package.json加入新测试。

## 验证与证据

Node课表91项、资料打包4项、Django社团/原排期/预约/同步42项均通过。npm run build与npm run validate通过。原本Three广场chunk仍有体积提示；本轮资料使用GSAP，不额外引入Three。

聊天工作目录 work/motion-v2/review 包含最终17860检查、社员冲突、不上传主课、已有预约、刷新持久化、编辑不被轮询打断、390/1440深浅色、触屏拖入08:00和实际共享ICS下载的报告/截图。work/motion-v2-planner/browser-results.json记录拒让零写入、Escape零写入、一次batch连锁退让、33px缩放对应30分钟、scroll精确保留。motion-results.json是本机Headless采样，不是真机帧率保证。

work/motion-v2-materials保留参考页面截图、最终书本视频、真实PDF/ZIP验证文件。work/motion-v2-backend/API_CONTRACT.md记载接口，review_materials_motion.py证实同帧关闭、相对时间线、目标中断复位与减少动态释放。

学校真实登录课表尚未实测，学校预约接口未接通，社团身份没有学校认证。测试账号和活动仅在独立HUB_DATA_DIR；真实17861仅加新表且保持review-mode。地图、光碟广场保留。没有发布、push或向真实社员发消息。
