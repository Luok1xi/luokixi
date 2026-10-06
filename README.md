# Luokixi · 矿大学习引导与创作社区

面向中国矿业大学（北京），帮助同学决定选什么课、参考谁的经验、去哪里学习、参与什么项目。讲课与辅导连接外部平台。

2026-10-06 整理上传，仓库保持私有。当前是开发中的源码快照，不是所有规划功能都已上线。

## 功能与状态

| 板块 | 内容 | 当前说明 |
|---|---|---|
| 首页 | 编辑精选、近期热点和关注更新 | 正在按六板块方案调整 |
| 校园 | 课程、地点、校园地图和活动 | 地点/口碑接口已有；学校空位与预约接口未打通 |
| 资料 | 四六级与课程资料目录、检索、投稿 | 全文库与社区服务需后端；校内试卷原件不在仓库 |
| 校圈 | 动态、讨论、课程/教师口碑 | 账号和审核接口已有，页面接入状态见规格 |
| 开源广场 | GitHub 项目导读、推荐、创作与协作 | AI 需自己配置；视频联动、弹幕等仍在完善 |
| 个人中心 | 作品、收藏、消息、成长与外部链接 | 外部账号同步、等级等缺口在统一规格中列明 |

详细状态与验收目标：[PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md)。前端和后端的存在不等于端到端验收完成。

## 本地运行

本次检查使用 Node.js 24。安装依赖后启动 Vite：

    npm ci
    npm run dev

构建与内容校验：

    npm run validate
    npm run build

知识库与账号社区还需要 Python 3.12+ 及 campus 下的依赖，安装、数据库初始化、可选模型与邮件配置见 [后端运行说明](campus/HUB_SETUP.md) 和 [知识库说明](campus/README.md)。不要把只读静态页面当成完整在线服务。

## 目录

| 路径 | 内容 |
|---|---|
| src/、根目录 HTML | 页面与交互 |
| campus/ | 知识库、账号、投稿、审核、通知等后端 |
| content/、public/data/ | 内容条目与公开目录数据 |
| docs/ | 统一规格、接口与协作记录 |
| docs/art-review/maps/ | 两校区待审地图候选，不进入正式站点资源 |
| scripts/ | 内容与地图数据工具 |

地图候选见 [审阅说明](docs/art-review/README.md)。它们尚未完成精确对位，正式地图 manifest 没有因此改成已批准。

## 上传与部署

本次仅上传私有仓库，不启动公开站点。GitHub Pages 工作流改为仅手动触发；没有开启定时抓取或推送即部署。部署前按实际配置检查后端、公开资源与外部服务。

本机数据、密钥、登录状态、卫星截图、校内 PDF、依赖与构建目录不提交。后端示例与公开数据保留，使用者自行配置。

## 协作与相关项目

[CONTRIBUTING.md](CONTRIBUTING.md) · [统一任务板](docs/BOARD.md) · [Codex 与 Opus 分工](AGENTS.md) · [项目总索引](PROJECTS.md) · [上传检查](UPLOAD_CHECKS.md)

## 致谢

- 动画：[GSAP](https://gsap.com/) 与 ScrollTrigger
- 字体：[Inter](https://rsms.me/inter/)（自托管，不依赖外部字体服务）
- 开场动画的交叉溶解和真实进度条思路参考了 [lxj5820/dsh-boot-animation](https://github.com/lxj5820/dsh-boot-animation)（MIT）
- 真题目录的组织方式参考了 [WeHUSTER](https://www.wehuster.com/cet4)
- 用 GitHub 共享课程资料的做法，借鉴了 [浙江大学课程攻略共享计划](https://github.com/QSCTech/zju-icicles)、[清华大学计算机系课程攻略](https://github.com/PKUanonym/REKCARC-TSC-UHT) 和 [HITSZ OpenAuto](https://github.com/HITSZ-OpenAuto/hoa-v2)
- 力扣数据接口参考了 [LeetCode-Query](https://github.com/JacobLinCool/LeetCode-Query)；Codeforces 使用[官方 API](https://codeforces.com/apiHelp)

## 声明

四六级真题版权归教育部教育考试院所有，校内试卷版权归命题教师与学校所有。本站是校友自发维护的非官方公益项目，与中国矿业大学（北京）及教育考试院均无隶属关系。资料仅供个人学习使用。考试时间与报名信息以[四六级官网](https://cet.neea.edu.cn/)和学校教务通知为准。
