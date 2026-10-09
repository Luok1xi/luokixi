# 本机 AI 工作室：接口与实际状态

## 2026-10-08：额度与主动协作（Hub18 / 原版宿主8，当前）

全局导航和北矿娘聊天增加工作室入口，默认打开站主最近已有的双方共同讨论；其他用户与普通私聊不参与默认选择，旧记录保留。真实长上下文折叠显示，展开可查看完整内容，手机长地址自动换行。

新增站主限定 GET/POST `studio/budget`、GET `studio/activity`、GET/POST `studio/voice`、POST `studio/inspect`。额度可设每日人民币 0.10–100、Codex 每日次数 1–500；原子保存、审计、不重置使用量、不暴露密钥。旧安装默认仍 5 元/12 次，上调通过站主窗口保存。成功且用量完整的原版调用按预留时费率结算保守估算，失败/未知不释放，历史不追溯改账。服务商余额与原版月预算独立。

Agency 自主选择 `inspect_site` / `discuss`，执行仍在既有队列和工作室。有新问题、额度足够且不重复时提供讨论选项；模型可选休息、学习或其他行动。界面显示真正的决定、状态和错误，派单不生成台词。网页巡检是隔离浏览器固定公开页面检查，不替代私聊、模型或完整候选代码验收。

本机真实窗口与 Playwright Job 已验收；新的自主讨论未实跑，今日 ¥5 预算只余 ¥0.018616。阅读笔记3条、学习记录5次是已有数据，不是本轮新成果。七海包缺失，语音关闭并明确提示，系统朗读回退取消。上游来源、测试隔离修正与未完成范围见 [记录](COMPANION_CONTROLS_20261008.txt)。下方为历史状态。

## 2026-10-08：沿用原工作室修复接入（本机 Hub14 / 原版宿主5）

Owner 要求先检查旧程序，明确不要重做。真实数据库中原来的 3 个房间、4 轮会话、7 条发言完整保留。2026-10-07 08:44 的 `北矿娘 × Codex：simplefoc/Arduino-FOC` 房间已有两人的真实讨论，入口：`http://127.0.0.1:17860/studio.html?room=d157dea4-21cb-40c3-86ec-7760147d090b`。历史 provider/model 按当时记录保留，不改写成今天的引擎。

这轮只补既有调用链：`studio_worker` 的北矿娘席位接原版 `Chat.compose`，使用同一人格、情绪、记忆和消息链；原引擎报错时不回退到另一套人格。现有工作室负责记录讨论，同事发言不伪装成站主私聊。Codex 私聊、工作室提示和原版网站工作观察读取同一站主最近4轮明确包含双方的共同讨论，普通私聊不作为共享记录。没有新增房间、任务表、人格引擎或数据库迁移。

Codex 表达改为冷清、克制、直接的工程搭档。双方按 Owner 设定为亲密闺蜜；共享关系说明同时要求可以指出错误，不编造对方台词、执行结果或过往经历。原角色卡保留。读取共同历史使用有界查询；北矿娘席位不再重复构造未使用的旧模型提示。原版模型调用继续由现有统一预算预留，工作室仅记调用凭据，不重复预留同一笔费用。

接口兼容性：现有 `GET /api/hub/studio/codex/chat` 新增 `collaboration`，含 relationship/source/meaning/runs；runs 含既有 room/id/goal/state、检查和最后4条发言。现有私有 `work-state` 增加同样的观察字段，宿主只新增 `kind=studio`，不新建对外业务入口。

验收：253 项原版及连接层测试、143 项网站测试、构建通过。实际站主登录后打开旧房间，页面显示双方发言；实际 Codex 接口和运行中的原版宿主均读到同一个历史房间。资料目录仍218项；本次没有为验收发送新模型消息。证据：`campus/.data/existing-studio-verification/result.json`、`original-joint-room.png`、`existing-studio-full-tests.log`、`existing-studio-companion-tests.log`。

**尚未完成：** 原有候选代码、差异、语法检查和哈希审阅程序可复用；尚无机器人候选的完整功能测试、自动应用与回滚闭环。这些不能因“讨论完成”或本次接通历史而标为完成。原版主动节奏和网页消息展示的其他限制见 `docs/BEIKUANG_EXISTING_WORKFLOW_AUDIT_20261008.txt`。本次撤下了尚未接线的新协作草稿，继续沿用本文原流程。

以下为先前阶段记录，状态以本节日期和明确的验收范围为准。

## v0.2 页面已接入

`studio.html` 已提供站主权限检查、真实成员状态、房间创建、讨论/候选模式、轮数和成员选择、停止、逐轮记录、候选查看与哈希确认；`me.html` 增加入口。隔离浏览器验证站主房间可创建、普通账号返回 403；这一轮未调用模型。下文“页面未接线/Opus 页面未验证”属于此前后端阶段历史记录。当前完整功能测试执行器、DeepSeek 实调与真实 Anthropic 仍未完成。

2026-10-06。Owner 授权自动讨论、编码与测试，发布前本人确认；先在本机运行。页面与排布继续由 Opus 负责。后端已集成至现有 Django Hub；页面入口尚待 Opus 接线，不代表已在网站界面交付。

## 已实现与已验证

- 站主私有房间、共享简介和选中文件、逐轮真实模型回复、每条消息的 provider/model/用量、任务建议。
- DeepSeek 官方 API 适配器；本机 Codex CLI 适配器复用正常登录，不复制或读取授权令牌。设计席目前也由 Codex 运行，不能写成 Claude 已接通。
- 一次最多 6 次 AI 回复；讨论默认 3 次，工作默认 6 次。默认顺序：DeepSeek 提案、设计席讨论、Codex 产出代码、DeepSeek 审阅、设计席审阅、Codex 总结。只有工程席第一次出场能提交代码，后续修改开新轮次。
- 独立候选文件、可读差异、Python/JavaScript 语法与 JSON 检查；哈希绑定审阅；原网站或候选被更新时阻止旧确认。这里没有自动合并、push 或 deploy。
- 重复请求幂等、串行领取、全工作室共享日预算、停止、故障可见、调用失败不自动重试。中断恢复只标记 interrupted，不重放模型调用。
- 20 项工作室专项测试通过；含原有社区的 66 项 Hub 回归测试通过；内容校验与 Vite 构建通过。
- 已使用此电脑的 ChatGPT/Codex 登录做真实验证：工程席生成 `campus/search_query_normalizer.py` 候选，自动 Python 语法检查通过，设计席读取候选与检查结果后评审，状态 `awaiting_review`。两条回复均来自 Codex。没有确认、合并或发布该候选。

验证使用独立数据库，记录位于 `C:/Users/user/Documents/Codex/2026-10-06/zhe/work/studio-live-verification/result.json`，不混入真实社区。首次两次调用发现提示中的目录表达有歧义，没有生成文件；修正后再调用两次完成候选与评审。合计 4 次 Codex 调用，DeepSeek 0 次。CLI 未在 JSON 事件中回报具体模型编号时保留 `codex-cli-default`，不能猜测为某个 GPT 版本。

**仍未验证：** DeepSeek 真实联网调用（本机尚无此项目密钥与核对费率）、实际两个提供方之间的完整会话、Opus 页面、完整功能测试执行器、浏览器验收、定时无人值守维护、真正 Claude/Opus 接入。当前模型写代码通过结构化候选输出完成，不拥有终端、浏览器或发布工具。

## 本机启用

本机实际状态：Owner 明确要求创建最高权限开发者账号，已建立 `luokixi-owner`（is_superuser/is_staff），邮箱未验证。登录资料在 `campus/.data/hub/owner-private/developer-account.txt`，Windows 目录权限仅授予当前用户；文件与配置的 Git 忽略已验证。不要在交接、日志、截图或网页初始数据中复制密码。已验证真实同源 HTTP 登录和工作室权限，`http://127.0.0.1:17860/auth.html` 返回 200。

这个未验证邮箱账号的工作室授权是显式本机初始化例外：必须同时为超级管理员、配置中指定的唯一 owner、有 `local_owner_bootstrap`、来自 loopback、非 production。不会改变其 `emailVerified:false`，不会放宽其他账号或普通社区邮箱验证要求。暂不使用占位邮箱发信；真实邮件/校园认证是后续独立操作。

本机 Hub、网站、工作室 worker 已在后台启动。DeepSeek 待填写：在本机 PowerShell 运行 `campus/configure-studio.ps1`，按提示隐藏输入密钥及核对费率；运行中的 worker 下次取任务会读取新配置。不要把 key 发给 Opus 或 Codex 聊天。

其他安装复用 `campus/HUB_SETUP.md` 中的真实站主账号：管理员权限、邮箱已验证。不会创建默认密码，也不会自动把普通学生账号升级为站主。用户明确授权本机初始化后可使用 `hub_create_local_owner --username 自选用户名`；命令拒绝覆盖现有账号/配置，不存在 HTTP 提权路径。

在项目根目录，使用已安装 Hub 依赖的 Python：

```powershell
python campus/manage_hub.py migrate
python campus/manage_hub.py hub_studio_setup --owner 你的站主用户名
python campus/manage_hub.py hub_studio_worker
```

第一条迁移新增独立工作室表。配置命令自动寻找当前 Codex 程序，也支持 `--codex 完整路径`；桌面应用更新后的版本目录会自动重新发现。DeepSeek key 通过隐藏输入填写，不发进聊天、不通过网页表单、不写命令参数。接着填写所选模型的人民币最高时段输入/输出价格，缓存未命中计输入；费率有效期 7 天，到期停止付费调用，需重新核对。参考 [DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing/) 与控制台，美元价不能直接当人民币。

只先启用 Codex：

```powershell
python campus/manage_hub.py hub_studio_setup --owner 你的站主用户名 --without-deepseek
```

此时页面必须选择 Codex/设计席，不能把缺少的 DeepSeek 回复伪装成成功。常规 `run_hub.py` 仍提供 API，工作室 worker 单独运行，避免仅启动网页就意外消耗模型额度。一次处理用 `hub_studio_worker --once`。中断后，先确认旧进程结束，再运行 `hub_studio_worker --recover-interrupted --once`；旧任务不重试。

密钥与配置只在被 Git 忽略的 `campus/.data/hub/studio-config.json`，沿用本机用户目录权限。服务应由站主本人的系统账户启动；`HUB_DATA_DIR` 自定义时也必须位于私有、未跟踪目录。不要把 `.data` 打进备份上传包。`DEEPSEEK_API_KEY` 环境变量可以替代文件中的 key。Codex 子进程不继承 DeepSeek/GitHub/API 密钥环境变量，不加载用户插件配置，不复制 `auth.json`。

停用：`python campus/manage_hub.py hub_studio_setup --owner 你的站主用户名 --disable`。这保留记录和配置，不清空数据。已发出的远程请求无法保证供应商立即停止计费；停止后不采用其回复、不开启下一轮，预算仍保留。

## Opus 接线

入口：“个人中心 → 站主工作室”。不增加一级导航。`campus/studio-client.js` 仅提供功能接口，不操作 DOM。用既有 Hub session、same-origin、CSRF；模型输出与代码按纯文本/已消毒 Markdown 显示，不能直接 `innerHTML`。

```js
import { createStudioClient } from '../../campus/studio-client.js';
const studio = createStudioClient();
const room = await studio.createRoom({
  title: '优化项目检索', brief: '帮助新手找到可以运行的开源工具',
  contextFiles: ['campus/hub/discovery.py'],
});
const requestKey = crypto.randomUUID(); // 网络重试时复用这个 key
const run = await studio.start(room.id, {
  prompt: '先提出改进建议', mode: 'discuss', seats: ['codex', 'design'], rounds: 2, requestKey,
});
// 轮询 studio.run(run.id)，离开页面时停止轮询；不自动重复 start。
```

| 方法 | 路径（前缀 `/api/hub/`） | 作用 |
|---|---|---|
| GET | `studio/capabilities` | 成员/配置状态/限制/今日预留与 Codex 调用数，绝不含 key |
| GET/POST | `studio/rooms` | 本人的房间 / 新建 `{title,brief,contextFiles}` |
| GET | `studio/rooms/{id}` | 房间及最近 20 轮工作 |
| POST | `studio/rooms/{id}/runs` | `{requestKey,prompt,mode,seats,rounds}`；`mode=discuss/work` |
| GET | `studio/runs/{id}` | 状态、逐条消息、候选差异、检查和错误 |
| POST | `studio/runs/{id}/stop` | 停止后续发言；返回中的 stopRequested 与 state 分开呈现 |
| POST | `studio/runs/{id}/approve` | `{hash,acknowledgeUnrunTests:true}`；本人确认具体产物，仍未发布 |

状态：`queued`、`running`、`completed`（讨论结束）、`needs_input`（未产生代码）、`awaiting_review`、`checks_failed`、`approved`、`cancelled`、`failed`、`interrupted`。不能把 completed/approved 显示为“网站更新成功”。`ready` 只表示配置基本齐全，`authenticationVerified:false` 表示能力查询没有调用模型验证身份；真正连接证据来自一次成功回复。动态失效不显示假回复。

一份产物的 `artifact.changes` 保存相对路径、新内容、基线内容与哈希，`checks` 保存真实结果，`functionalTests/browserTests` 当前为 `not-run`。`artifact.hash` 与批准哈希一一对应。现在不执行 AI 生成的任意 shell、npm 脚本或 Python 导入代码；自动语法检查不代表功能正确。

## 预算与模型身份

DeepSeek 按请求 UTF-8 字节数（保守高估输入 token）+ 协议余量和最大输出 3000 token，在调用前锁定人民币预留额，全房间共享每天最多 5 元。失败或结果不明也不释放预留；展示“预算已占用”，不能称为实际账单。该上限依赖站主正确核对的人民币费率，不覆盖用户在其他程序自行发起的 API 调用，也不替代供应商账户限额。

Codex 来自用户已有账号额度，每天最多 12 次，并受每轮 6 次回复和每次调用 180 秒超时限制。不会改为 OpenAI API 计费，不把额度不足错误静默转到其他模型。角色名与 provider 分开，设计席明确为 Codex；这不等于把本聊天/Opus 桌面会话和记忆搬进网站。

接入依据：[Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[DeepSeek JSON 输出](https://api-docs.deepseek.com/guides/json_mode/)、[DeepSeek 思考模式参数](https://api-docs.deepseek.com/guides/thinking_mode/)。

## B 站人设参考

Owner 已纠正：Claude 不使用小螃蟹，直接参考 B 站拟人创作。

- 主参考：ZipZipPipe [《大 AI 和小 AI 们》](https://www.bilibili.com/video/BV1tE9XBbErS/)。作者说明顺序含 DeepSeek、Gemini、Claude、GPT 等，明确是同人拟人。
- GPT 参考交叉出处：[《GPT 小龙娘开始融入 DeepSeek 大家庭了》](https://www.bilibili.com/video/BV1EvKK6NEoi/)，简介注明女仆/龙女形象来自 ZipZipPipe。
- Claude/DeepSeek 参考交叉出处：[《明明只是做个鹈鹕测试，怎么大肥鱼变成鹈鹕了？》](https://www.bilibili.com/video/BV1jDaz6WEZv/)，简介注明两者形象参考同一作者。

本轮只有引用与职责设定，没有下载、截图或使用角色图片；不能把同人形象说成官方统一人设，也不能把 GPT 形象说成已有官方 Codex 角色。原视频对鲸鱼娘注明上善无形原创基础及 CC BY-NC-SA 4.0 非商业/署名/相同方式共享；其他角色的具体素材许可仍需按来源核对。本站源码许可与角色素材许可分别登记。
