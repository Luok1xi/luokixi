# 第三方内容与版本

## 2026-09-21 Crawlee 与 Miku 表情

- 实际依赖：`@crawlee/basic@3.18.1`，上游 https://github.com/apify/crawlee ，Apache-2.0；依赖锁文件位于 `tools/crawler/package-lock.json`。
- 图片来源：https://github.com/r48n34/sekai-sticker-v2 ，提交 `47afd1739d26970c28edb174e652e6fb26009dbc`，`public/img/Miku/Miku_01/02/03/04/06/07/08/09/11/12/13/14/16.png` 对应本地 `public/stickers/miku_*.png`。原项目为 https://github.com/TheOriginalAyaka/sekai-stickers ，图像裁切鸣谢 Modder4869，来源为 Project SEKAI 社区素材。未修改图片像素。
- Project SEKAI / Hatsune Miku 相关图像权益归各原权利人，仓库程序许可不改变角色与游戏素材权利。本地私人使用，不将这些图像描述为本项目原创或官方合作。

本文件区分复制/改编的资料、安装的依赖与只作设计参考的项目。包含下方列明的聊天表情图片；不包含声音或 Live2D 素材。

## 2026-09-21 消息链与通用表情

实际加入 Noto Emoji 的 8 张未修改 PNG（`2D/png/128/` → `public/stickers/`），固定提交 `06121655d0e82f9cae6e7ba6feed4fa6fdbfc2a4`，Copyright 2013 Google, Inc.。图片许可为 Apache 2.0，见 `vendor/noto-emoji/IMAGE-LICENSE` 与 `APACHE-2.0.txt`；根目录字体 OFL 许可也保存在 `vendor/noto-emoji/LICENSE`，不将字体许可误当作 PNG 许可。这些是通用 emoji，不是 Miku 人物素材。

AstrBot、其主动聊天插件及 MaiBot 仅为结构研究，没有复制其 AGPL/GPL 运行代码。腾讯公开图片协议由本项目独立实现。固定提交和具体使用范围见 `CONVERSATION-UNIFICATION.md`。

## AIRI — MIT

- 仓库：https://github.com/moeru-ai/airi
- 固定提交：`cfffa9b6f3c7575097c9fb71213e84782dafb0ea`
- 版权：Copyright (c) 2024-PRESENT Neko Ayaka。
- 完整许可：`vendor/airi/LICENSE`。
- 原版：`packages/i18n/src/locales/en/base.yaml` → `vendor/airi/original-base.yaml`；`packages/stage-ui/src/constants/emotions.ts` → `vendor/airi/original-emotions.ts`。
- 改编：`vendor/airi/miku-card.json` 的身份/人格/口吻/关心四段和 `src/character-card.mjs` 的九种情绪名称。Miku 采用自己的持续记录，不继承 AIRI 的虚构身世、年龄、模型控制指令或现有关系。没有宣称上游作者认可此改编。

## K-Dense Scientific Agent Skills — MIT

- 仓库：https://github.com/K-Dense-AI/scientific-agent-skills
- 固定提交：`330c8e764435a731eff571e3efdda70b363d0792`
- 版权：Copyright (c) 2025 K-Dense Inc.
- 完整许可：`vendor/scientific-skills/LICENSE.md`。
- `skills/paper-lookup/SKILL.md` → `vendor/scientific-skills/PAPER-LOOKUP.md`。
- `skills/paper-lookup/references/arxiv.md` → `vendor/scientific-skills/arxiv.md`。
- `skills/literature-review/references/core_workflow.md` → `vendor/scientific-skills/core_workflow.md`。
- 采用学术检索格式、来源核对与摘要/全文区分，`src/research.mjs` 加载已审核的 arXiv 参考摘选。平台不具备全部技能内提及的 CLI/数据库/付费服务，不自动执行其安装指令，也不宣称完整系统综述。

## 安装的解析与网络依赖

精确版本与完整性摘要在 `pnpm-lock.yaml`；许可证随依赖包安装。核心新增：Mozilla Readability 0.6.0（Apache-2.0）、LinkeDOM 0.18.13（ISC）、fast-xml-parser 5.11.1（MIT）、robots-parser 3.0.1（MIT）、ipaddr.js 2.5.0（MIT）、Undici 8.10.2（MIT）。微信二维码使用 qrcode 1.5.4（MIT）。原项目的其他依赖继续保留自身许可。

## 仅比较或参考

MaiBot、Open-LLM-VTuber、Crawl4AI、Crawlee、AstrBot、OpenClaw、LangGraph、SillyTavern 只用于可行性/设计比较，本轮没有复制其运行代码。OpenClaw 与 LangGraph 的持久流程、有限心跳等设计采用适合现有 SQLite 服务的独立实现，不应描述成已经安装或移植其完整引擎。微信适配器依据 Tencent/openclaw-weixin 公开协议独立实现，见 `WECHAT-GUIDE.md`。

## 表达方向第二次调整

2026-09-19：Miku 卡 version 2 改为温柔、单纯、开朗，旧轻傲娇偏好退役。额外阅读 Artemis 的 ATRI 卡、Clawra Anime 人格与 my-raze 源码，仅参考一般性格特点和比较设计，没有复制这些项目的运行代码、专有角色经历或安装脚本；原 AIRI MIT 归属继续保留。见 VOICE-UPDATE.md。

## OpenClaw 唤醒冷却模块 — MIT

- 仓库：https://github.com/openclaw/openclaw
- 固定提交：`e2bcb1614de060927121bd72de850cee3a08d308`。
- Copyright (c) 2026 OpenClaw Foundation。完整许可保存在 `vendor/openclaw/LICENSE`。
- `src/infra/heartbeat-cooldown.ts` 原样保存在 `vendor/openclaw/heartbeat-cooldown.ts`；Node.js `stripTypeScriptTypes` 仅移除类型生成 `heartbeat-cooldown.mjs`，由 `src/agency.mjs` 实际调用。
- AIRI spark-notify 与 D2A Value_ActComp 仅作自主行为结构参考，没有复制其运行代码；详情与固定版本见 `AGENCY.md`。

网上见闻新增协议适配器为独立实现，研究过的 GitHub 项目、更新时间和实际接入区别见 WEB-LIFE.md。网页提取实际复用已有 Mozilla Readability、linkedom 与 fast-xml-parser 依赖。

2026-09-20 再次核查 OpenClaw、Hermes Agent 与 AIRI 的调度、投递和主动事件源码。新增的每日阅读尝试登记、聊天工具接入与独立分享为本项目适配实现，没有复制 Hermes/AIRI 的整套运行引擎。固定版本与实际采用范围见 PROACTIVE-REPAIR.md。

## 2026-10-06 检索与科研升级

- `skills/paper-search`、`skills/literature-review` 的检索顺序与“学术接口出错时也返回 HTTP 200”等注意事项，参考上文 K-Dense Scientific Agent Skills（MIT）的 `PAPER-LOOKUP.md`；技能正文为本项目中文改写，没有复制其脚本。
- [Shinsekai](https://github.com/RachelForster/Shinsekai)（源码可见、**非开源**，禁止再分发）：只参考了“工具注册表按组与风险分级、用检索方式发现工具、MCP 工具并入同一列表”的设计思路，没有复制或改写其代码。
- 学术与参考数据来自 OpenAlex、Crossref、Europe PMC、arXiv、Semantic Scholar、维基百科、GitHub、Stack Exchange、Hacker News（Algolia）的公开接口，按各自使用条款低频调用；通用网页搜索使用用户自己填写的 Tavily / 博查 / Brave / SearXNG。
