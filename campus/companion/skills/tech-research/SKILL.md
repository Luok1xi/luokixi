---
name: tech-research
description: 技术问题：编程报错排查、库/框架/工具选型、开源项目调研、某技术怎么用、版本差异、硬件/机器人/软件配置问题。
tools: qa_search, code_search, repository, web_search, read_page, community_search, scholar_search
keywords: 报错, error, 错误, 安装, 配置, 框架, 选型, 开源, github, bug, 版本, 代码, 编译, 依赖
---
# 技术检索

## 报错排查
1. 从报错中提取关键部分：错误类型 + 核心信息 + 库名/版本。去掉本机路径、用户名、密钥、内网地址。
2. 并行检索：qa_search（stackoverflow，必要时 superuser / askubuntu / unix）+ web_search（加上库名和 "github issue"）。
3. 优先看：已采纳或高分回答、项目 GitHub issue 里维护者的回复、官方文档的迁移指南。
4. read_page 精读 1—2 个最匹配的回答或 issue，focus 写「原因和解决办法」。
5. 核对版本：解决办法适用于哪个版本？是否已被新版本修复？

## 选型 / 开源项目调研
1. code_search 找候选项目（sort=best，必要时 sort=stars）；同一轮用 web_search 找对比文章或官方文档。
2. 对 2—4 个候选用 repository 读取：许可证、最近提交时间、星标、README 中的功能和安装方式。
3. 比较维度：功能是否满足、维护活跃度、许可证是否允许你的用途、文档质量、依赖和平台要求、社区规模。
4. hackernews 或 zhihu 的讨论只作为用户体验参考，不作为事实依据。
5. 有学术背景的算法（如 SLAM、目标检测、强化学习），可用 scholar_search 找原始论文和基准对比。

## 提交
- 报错：原因 → 解决步骤（按可能性排序）→ 适用版本 → 来源编号。
- 选型：给出推荐 + 理由 + 对比表要点 + 风险（许可证、停止维护等），每项附来源编号。
- 只读了 README 不等于验证过能运行；需要实际安装测试的地方写进 gaps。
