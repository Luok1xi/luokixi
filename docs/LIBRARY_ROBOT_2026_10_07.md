# 资料成套整理与北矿娘识题工作台 · 2026-10-07

本机入口：[资料库](http://127.0.0.1:17860/materials.html)、[识题工作台](http://127.0.0.1:17860/question-workshop.html)。已构建并在真实 17860 检查；17861 已备份、迁移 0019，保持 review-mode，仅允许备份/恢复检查与用户明确创建的 question-process 任务。未启用全部采集、模型或邮件队列；未 commit、push 或部署。

## 现有资料

218 份可用原件整理为 115 册：97 套四六级 + 18 份校内原件。四六级 40 套附件齐全、57 套不完整；35 套缺答案、56 套缺听力，两类可能重叠。1 份原先待核对记录没有混入书架。没有丢失磁盘文件，110 份文件的原目录提取状态标为扫描件。

按明确考试年月、套号和已有 group_key 归组；延考月份和合并套卷保持各自身份，不用相似标题猜配。校内 18 份原件没有充分成套凭据，保留为独立资料；支持后续用明确来源的 verified manifest 关联书籍/章节。原文件不改写，不把缺件伪装成完整。

展开一本资料后切换原题、答案、听力；听力使用真实文件，等待点击才加载。支持整册入袋、单文件移除、补齐已选套册；容量不足时整册操作不部分生效。真实 ZIP 下载已检查为 2 PDF + 1 MP3 + 来源清单，完整性通过。

资料、搜索、课程、收集页对照现有开源广场统一纸张底色、细线、实体书册和紧凑排版；保留空间取书/翻开/归位与入袋动效、键盘操作、连续点击和减少动态模式。

## 北矿娘识题

登录后选择原稿和页码即可创建任务。维护者可处理现有本机目录；普通成员处理本人上传的 PDF、图片或粘贴文字。默认只保存到本人题架。上传原件、本机 OCR、题目切分、结构与质量检查、分类存架的流程已接通。

题干、选项、答案、解析、知识点可以编辑；支持补题、删除、排序、原页对照、单栏/双栏预览、字号与答案开关、打印保存 PDF、JSON 导出。只有资料中明确出现的知识点才自动提取，缺失答案保持未知。编辑保留服务端来源页码/坐标和置信度，版本冲突不会覆盖新版本。保存期间冻结编辑与换册，避免异步响应丢失输入。

自动审核是独立的结构、完整性与识别质量检查，不是学科答案认证。公式、乱码、低置信度、分题疑点、缺失题干/答案停留待核对。勾选后再取消整页确认会恢复原检查项。未知答案只有本人明确确认保留后才可存架，仍显示未知。

实际本机 OCR 验证包含合成中文图片/扫描 PDF，以及真实六级、线代各一页：六级得到 6 组听力选项，缺印刷题干和答案；线代得到 11 道草稿，矩阵/公式与编码缺损待核对。没有将它们称为完整准确题库，也没有声称 218 份资料已全部完成逐页 OCR。真实账号没有创建测试题稿；截图中的识题内容是隔离测试原稿。

## 通识与公开来源

已收录 6 条学校官方通识选修通知，保留学期与日期。最新通知公布 35 门在线课程；完整 XLSX 目录和 DOCX 简介实际返回验证码页面，附件未取得。当前仅核实通知中明确写出的“大国兵器”，代码 UT610070，教师/简介未知留空。页面显示“已核实 1 门 / 公布 35 门”，保留学校原件入口；平台内课程资料需要学生本人登录，没有取得或伪造其题库。

OpenStax Psychology 2e 首章实际采集 15 道英文题、24 个术语，来源答案、固定提交、署名、修改说明和 CC BY-NC-SA 4.0 许可保留。可整理为私人题册，明确标为外部开放教材，未冒充校内课程。ICPC 保留官方入口，不复制版权未授权的整套赛题。没有接入未授权 Z-Library 批量下载。

来源：
- 学校当前开课通知：https://jwc.cumtb.edu.cn/info/1133/6585.htm
- 学校当前选课通知：https://jwc.cumtb.edu.cn/info/1133/6535.htm
- OpenStax 原仓库：https://github.com/openstax/osbooks-psychology
- OpenStax 许可：https://creativecommons.org/licenses/by-nc-sa/4.0/
- RapidOCR 文档：https://rapidai.github.io/RapidOCRDocs/v1.4.4/install_usage/api/RapidOCR/
- PDFium 文档：https://pypdfium2.readthedocs.io/en/stable/python_api.html

## 验证与后续维护

106 项相关 Django 回归、31 项 Node、8 项整理机器人、11 项来源采集测试通过。迁移无漂移，生产构建和内容校验通过。浏览器验证实际上传 OCR、私人隔离、原页预览、未知答案、编辑与增删排序、版本冲突、JSON/PDF、合法来源导入、保存竞态修复、390px 精确宽度、明确浅/深色覆盖系统偏好、失败状态；未出现脚本错误。手机为浏览器模拟，不代表手机实机验收。

代码：campus/library_organizer.py、learning_sources_robot.py、question_sources.py；campus/hub/question_*、0019_question_workshop；question-workshop.html、src/pages/question-workshop.js、src/styles/question-workshop.css；materials-bundles、materials-catalog、materials-motion 与页面统一样式。source 缓存、OCR 模型和私人数据库在忽略提交的 .data 内。

重新整理只读报告：`python campus/library_organizer.py --report <目标报告.json>`。公开来源显式刷新：`python campus/learning_sources_robot.py --refresh`，没有新增定时采集。可选本机识题依赖固定在 campus/question-requirements.txt，安装位置 campus/.data/question-runtime；识别时不下载模型，不将文件发送云端。

接口：GET /api/library/collections、/api/library/sources；GET /api/hub/question-papers/capabilities；本人 GET/POST /api/hub/question-papers；GET /{id}、POST /{id}/save（含 revision）；GET /{id}/source?page=；POST /import-source（仅已核验题库 bankId）。所有修改使用既有 CSRF 机制；私有题稿不进入公共检索，公开投稿继续使用原审核路径。

当前待补充的是学校需要本人完成验证码/登录后的合法资料，以及扫描公式的逐题核对。此处状态是已完成本机实现与列明的验收，不是已获得全校知识库。
