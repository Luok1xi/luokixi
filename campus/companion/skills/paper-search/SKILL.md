---
name: paper-search
description: 学术文献检索：找某主题的论文、代表作或综述，查一篇论文的方法/结论/引用情况，按 DOI 或 arXiv 编号查论文，或问“学术界怎么看/有没有研究”。
tools: scholar_search, paper_details, citations, read_paper, wiki_search
keywords: 论文, 文献, 学术, 出处, doi, arxiv, 期刊, 引用, 有没有研究, 研究表明, paper, citation
---
# 学术文献检索

## 1. 建立检索式
- 把问题拆成 2—3 个概念块（对象 / 方法 / 结果），每块用英文学术术语，必要时补同义词。
  例：「大模型幻觉检测」→ hallucination detection + large language model
- 中文问题先用 wiki_search(lang=en) 确认术语的标准英文说法，再检索。
- 检索词保持 2—6 个核心词；太长会漏检，太短会泛滥。

## 2. 选数据库（可以同一轮并行查两个）
- openalex：默认首选，覆盖最广，支持 sort=cited（经典）、recent（最新）、reviews_only（综述）、年份范围。
- arxiv：计算机、物理、数学的最新预印本（sort=recent 看前沿）。预印本未经同行评审。
- europepmc：生物医学、医学、生命科学；reviews_only 找综述，open_access_only 找全文。
- crossref：已知标题找 DOI、核对出版信息。
- semanticscholar：可能限流（429），作为补充。

## 3. 推荐的检索顺序
1. 先找综述：openalex reviews_only=true，sort=cited —— 快速建立全貌。
2. 再找代表作：sort=cited；再找最新进展：sort=recent 加 from_year（近 2—3 年）。
3. 滚雪球：对最相关的 1—2 篇用 citations。
   - direction=references 找奠基工作
   - direction=cited_by sort=recent 找后续进展
4. 结果偏题时：换术语、加限定词或换数据库，不重复同一查询。

## 4. 筛选与精读
- 先看题目和摘要筛选（P 编号），保留真正回答问题的 2—5 篇。
- 需要方法细节、数据或具体数字时用 read_paper，focus 写清楚（如「实验设置和主要结果」「局限性」）。
- 只读到摘要时，结论要注明「仅依据摘要」。

## 5. 常见陷阱
- 学术接口出错时也可能返回 HTTP 200：空结果不等于「没有研究」，可能只是这个库没收录或检索式有问题，应换库或换词再确认。
- 引用数和时间有关：新论文引用少不代表质量差。
- 区分研究类型：综述/荟萃分析 > 随机对照/大规模实验 > 小样本/个案 > 预印本/观点文章。
- 同一结论只有一篇论文支持时，要说明证据有限。

## 6. 提交
- answer：直接回答，并说明证据强度（多篇一致 / 单篇 / 存在争议）。
- findings：每条写「谁（年份）发现了什么」+ P 编号 + 摘要或全文中的逐字片段。
- followups：值得继续读的论文或可以继续追问的问题。
