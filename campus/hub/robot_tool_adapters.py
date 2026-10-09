"""Editable tool recipes and experiments; installer policy stays in robot_tools.py."""
RECIPES = {
    'markdown-reader': {'name': 'Markdown 结构阅读器', 'input': 'text', 'purpose': '识别 README 标题、代码、链接和图片，检查中文导读是否遗漏功能',
        'packages': [('markdown-it-py', '4.0.0'), ('mdurl', '0.1.2')], 'license': 'MIT',
        'source': 'https://github.com/executablebooks/markdown-it-py', 'keywords': '文档 中文 介绍 README Markdown 阅读'},
    'pdf-reader': {'name': 'PDF 文本检查器', 'input': 'document', 'purpose': '检查 PDF 页数与文本层；空文本明确交给 OCR，不冒充已经识题',
        'packages': [('pypdf', '6.19.0')], 'license': 'BSD-3-Clause',
        'source': 'https://github.com/py-pdf/pypdf', 'keywords': '资料 PDF 文本 题目 OCR'},
}
PROBE = '''import sys,json,io
sys.path.insert(0,sys.argv[1])
kind=sys.argv[2]; data=json.load(sys.stdin)
if kind=='markdown-reader':
 from markdown_it import MarkdownIt
 tokens=MarkdownIt('commonmark',{'html':False}).parse(data.get('text','# 检查\\n\\n[来源](https://example.org)'))
 result={'tokens':[{'type':t.type,'tag':t.tag,'text':t.content[:2000], 'children':[{'type':c.type,'text':c.content[:500],'url':c.attrs.get('src') or c.attrs.get('href')} for c in (t.children or [])]} for t in tokens[:400]],'characters':len(data.get('text',''))}
 assert tokens
else:
 from pypdf import PdfReader,PdfWriter
 if data.get('path'): reader=PdfReader(data['path'])
 else:
  stream=io.BytesIO();writer=PdfWriter();writer.add_blank_page(width=100,height=100);writer.write(stream);stream.seek(0);reader=PdfReader(stream)
 import itertools
 pages=[(p.extract_text() or '')[:12000] for p in itertools.islice(reader.pages,8)]
 result={'pages':len(reader.pages),'sampledPages':len(pages),'text':pages,'needsOCR':not any(p.strip() for p in pages)}
print(json.dumps(result,ensure_ascii=False))
'''

