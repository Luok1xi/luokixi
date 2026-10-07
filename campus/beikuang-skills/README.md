# 北矿娘的技能

北矿娘本身（名字、人设、语气、运行她的 Codex 配置）在 `campus/hub/studio_config.py` 的 `PERSONAS['beikuang']` 和 `campus/hub/supervisor.py` 的 `PERSONA`。**技能不改这些**，只给她加新的活儿。

每个技能是一个文件夹，里面一份 `SKILL.md`：

- 开头的 `---` 之间写名字、标题、一句话说明、类型。类型分两种：`rule` 是按规则核对，不调用模型；`model` 会用她已经接好的 Codex 写字。
- `## 要做的事` 写清这个技能要她做什么、核对哪几条。这几条和 `campus/hub/beikuang.py` 里的代码一一对应：改规则要两边一起改。
- `## 句式` 下面每一行是一句她会说的话。代码从这里随机挑一句，`{n}`、`{title}` 这类占位会换成实际内容。只想改她怎么说话，改这里就行，不用动代码。

| 技能 | 类型 | 做什么 |
|---|---|---|
| [voice](voice/SKILL.md) | 说话方式 | 对站主可爱、简短；写文章用她自己的第一人称 |
| [news-review](news-review/SKILL.md) | rule | 学校新闻：核对来源、日期、配图署名、是否重复，过了直接发布 |
| [project-review](project-review/SKILL.md) | rule | GitHub 候选项目：许可证、说明、下载入口、近期维护、风险词，过了放进开源广场 |
| [guide-review](guide-review/SKILL.md) | rule | 中文导读：十章齐全、每章有依据、原文没变、没有越界说法，过了公开 |
| [photo-review](photo-review/SKILL.md) | rule | 教师官网照片：来自本人个人页、竖版证件照尺寸，过了显示 |
| [announcement](announcement/SKILL.md) | rule | 她自己写的公告：没有待确认的疑问、有事实依据、不冒充学校官方，过了发布 |
| [escalate](escalate/SKILL.md) | rule | 没过的东西怎么交给站主：只在她的窗口里说，一件一行写原因 |
| [daily-report](daily-report/SKILL.md) | model | 每天晚上 9 点后给站主写一份可爱的小报告 |
| [chat](chat/SKILL.md) | model | 站主随时问进度，她用自己的语气简短回答 |

机器人（新闻、GitHub 采集、导读、北矿娘总监督的请示、公告草稿）原来直接通知站主，现在先交给北矿娘：`maintenance.staff_notice` 收到后转进她的待办（`BeikuangTask`），由她每小时巡检一次，收到新东西时立即巡检。设置 `HUB_BEIKUANG=0` 可以恢复为直接通知站主。
