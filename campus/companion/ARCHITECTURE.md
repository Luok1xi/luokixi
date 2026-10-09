# 系统接口与维护

`server → Chat / Service → Store → SQLite` 为统一业务通道。网页、微信与 Feishu 共享同一个 Service。模型只返回受约束的意图；固定安排、截止日期和删除记忆进入提议确认。多个操作通过嵌套 SQLite 事务原子执行。

| 模块 | 职责 |
| --- | --- |
| `src/server.mjs` | 本地 HTTP、同源检查、会话 cookie、CSRF、SSE 与后台调度启动 |
| `src/service.mjs` | 校验命令、状态版本、确认提议、撤销、进度、生成提醒 |
| `src/store.mjs` | SQLite WAL、事务、命令去重、消息队列和内容清理 |
| `src/planner.mjs` | 固定时间生成、EDF 分配、保留旧时段、未安排工时、冲突警告 |
| `src/chat.mjs` | 串行对话、上下文、操作提取、可选复核、流式回答 |
| `src/models.mjs` | 两家接口、请求预留、用量回执和失败保守结算 |
| `src/persona.mjs` | 稳定人设、关系阶段、情绪衰减、共同事件 |
| `src/reminders.mjs` | 每日整理、免打扰、合并、重试与送达记录 |
| `src/feishu.mjs` | 官方长连接、账号绑定、私聊过滤、持久收件、卡片交互 |
| `src/importer.mjs` | PDF/图片本地渲染、视觉识别、校验草稿 |
| `src/conversation.mjs` | 模型会话决策原则、思考模式和带证据的情绪/风格评价 |
| `src/motivation.mjs` | 持久角色动机、明确语言偏好、解释记录、主动意向选择 |
| `src/advisor.mjs` | 少量 OpenAI 建议/资料，失败时回退，不执行命令 |
| `src/autonomy.mjs` | 判断是否值得主动分享，允许不发，一天最多尝试一次 |
| `src/style-eval.mjs` | 用实际账本付费、隔离虚构试读数据的会话样例检查 |
| `src/dialogue.mjs` | 真实对话上下文与模型写作提示；离线口吻检查不改写在线回复 |
| `src/affect.mjs` | 有来源的情绪评价、混合状态、角色需求、沉默与恢复 |
| `src/curriculum.mjs` | 五个入门学习主题、十五道题、程序判分及选题约束 |
| `src/learning.mjs` | 有限公开资料读取、DeepSeek 笔记与考核、每日去重与失败记录 |
| `src/weixin.mjs` | 腾讯 iLink 协议适配，私聊绑定、收件去重、分段回复和失败判断 |
| `src/research.mjs` | 每日研究阶段、模型选题/提炼/复核、暂停代次、来源与队列 |
| `src/public-reader.mjs` | DNS 固定与公网检查、robots、Readability、Atom/RSS 和 arXiv |
| `src/research-state.mjs` | 明确目标、信息源、转发通知、反馈和检索上下文 |
| `src/character-card.mjs` | 读取 AIRI 改编卡和带证据的持续表达情绪 |
| `public/research-ui.js` | 目标、来源、通知、核对入计划与研究记录 |
| `public/learning-ui.js` | 相处页的需求、关系数值、虚拟糖果和学习手账 |

## API

首次 `GET /api/bootstrap` 设置本机会话 cookie，返回 CSRF token。后续写操作需要 `X-Miku-Token` 请求头。默认 Host 为 `127.0.0.1:17839`；拒绝跨源 Origin 和跨站请求。

| 路径 | 用法 |
| --- | --- |
| `GET /health` | 不含私有信息的进程状态 |
| `GET /api/state` | 任务、课程、计划、角色、记忆、通知与用量 |
| `POST /api/chat` | `{text, requestId, deep}`，SSE status/delta/done/error |
| `POST /api/command` | `{action,args,requestId}`；重复编号不能执行不同操作 |
| `GET /api/export` | 业务数据 JSON，不含密钥 |
| `POST /api/import` | 原始文件内容，Content-Type 指定图片或 PDF |
| `POST /api/config` | 保存本地连接配置，秘密字段不回显 |
| `POST /api/check-model` | 用户触发的一次小额真实调用 |
| `POST /api/check-style` | 两段连续场景共八轮真实 DeepSeek 试读，含旧客服回复上下文；不写入用户记忆 |
| `POST /api/check-style`，`suite: emotion` | 二十轮隔离的温暖交流、冲突、沉默与修复试读 |
| `POST /api/study` | 当日一节真实 DeepSeek 资料阅读和基础小测 |

普通角色聊天的最终提示入口是 `writerPrompt`，与操作提取、顾问提示分开。所有社交表述由模型生成；不让写作者给没有发生的分数变化编理由。学习与聊天共用模型账本，但学习不读用户私人聊天，不修改课程和用户任务。
| `POST /api/feishu/connect` | 连接/重连官方长连接 |
| `POST /api/feishu/pair` | 生成短期绑定码 |
| `POST /api/feishu/test` | 用户明确触发的测试消息 |

## 幂等和时间

业务时间为 UTC epoch 分钟，日历边界使用 Asia/Shanghai 固定偏移。一个 requestId 只允许一种请求内容；聊天操作编号派生自消息编号。接收队列先落盘再处理，模型处理不阻塞提醒计时。对话使用同一串行队列，执行前检查状态版本。

删除记忆会清除派生内容，旧命令和消息转为 SHA-256 内容指纹及不含事实的处理回执，保持去重能力。已发送提醒的编号保留，避免内容清理导致旧通知重复发出。该机制针对应用侧再次引用，不承诺磁盘取证级擦除。

未回复/时段已过不产生实际完成记录。计划回滚先检查当前进度、固定安排和可用时间，不能逆转真实进度。LLM 的措辞可能出错，任务与日程面板展示的是服务实际执行结果。

## 运行与环境

Node.js 24。`MIKU_PORT` 可改本机端口；`MIKU_DATA` 可改数据库目录；`MIKU_CONFIG` 可指定本地配置文件；`DEEPSEEK_API_KEY` 和 `OPENAI_API_KEY` 环境变量优先于配置文件。启动脚本加载可选 `.env`，没有该文件时继续运行。

启动器通过健康检查避免重复启动；停止器检查 PID 对应的 node.exe 和本项目绝对路径后才停止。默认不注册 Windows 服务，不修改代理或系统网络。

在 Codex 中启动长期服务时必须获得正常联网执行授权：后台进程会继承启动环境的网络限制。本地 `/health` 成功只证明 HTTP 服务存在，不能证明外部模型可用；部署到本机后的检查还应验证实际 `/api/check-model` 请求。收到网络权限错误时给出中文提示，不能只返回 `fetch failed`。

所有测试使用内存库或专用临时目录；不能在真实数据目录里运行破坏性测试。自动化测试不访问模型付费接口、不向飞书用户发送消息。

## 研究与清理

`POST /api/research` 手动触发有限研究；`research.*` 命令通过统一 Service 操作。完整流程与实际限制见 GITHUB-MODULES.md。研究和基础学习共用学习子预算，模型额度预留统一处理。

研究状态存入主业务状态，随数据导出。来源含 URL、时间、正文摘要指纹、阅读级别、逐字证据。删除/更正记忆还会清理研究笔记、转发通知、目标、运行衍生记录和角色表达状态，阻止引用旧结论；信息源配置与既有任务保留。

微信凭证独立保存于本机私有表，不进入业务状态、模型上下文或普通导出。停止研究只取消待发研究信息，不停止已有课表提醒。真实联网/付费检查为显式 test/live-research.mjs --paid-check；日常 node --test 不访问付费接口。
