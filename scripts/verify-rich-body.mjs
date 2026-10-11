// Real editor in an isolated browser fixture; no accounts, APIs or model calls.
import {chromium} from 'playwright';
import {createServer} from 'vite';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const server=await createServer({root,configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0},
  plugins:[{name:'isolated-editor-fixture',configureServer(server){server.middlewares.use((req,res,next)=>{
    if(req.url!=='/rich-body-qa')return next();
    res.setHeader('Content-Type','text/html;charset=utf-8');
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>正文编辑隔离验收</title><style>body{font:16px system-ui;max-width:700px;margin:20px auto}textarea{width:100%;min-height:160px}</style>
      <form><textarea name="body" aria-label="正文"></textarea><button type="reset">清空表单</button></form>
      <script type="module">import {mountRichBody} from '/src/js/rich-body.js';
      const textarea=document.querySelector('textarea');
      textarea.value='<b>原文不是 HTML</b>\\n单行换行\\n\\n中文 😀';
      window.editorTest={textarea,adapter:mountRichBody(textarea),mount:mountRichBody};</script></html>`);
  });}}]});
let browser;const checks=[],errors=[];
try {
  await server.listen();
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const page=await browser.newPage({viewport:{width:1100,height:820}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/rich-body-qa`);
  await page.waitForFunction(()=>window.editorTest);
  assert.equal(await page.locator('textarea').inputValue(),'<b>原文不是 HTML</b>\n单行换行\n\n中文 😀');
  assert.equal(await page.locator('.tiptap b').count(),0);
  assert.equal(await page.evaluate(()=>window.editorTest.adapter.getFormat()),'plain');
  checks.push('Opening legacy text preserves its exact source and does not interpret HTML.');
  await page.getByRole('button',{name:'原文',exact:true}).click();
  await page.locator('textarea').fill('原文直接编辑\n第二行');
  assert.equal(await page.evaluate(()=>window.editorTest.adapter.getFormat()),'plain');
  await page.getByRole('button',{name:'排版',exact:true}).click();
  assert.match(await page.locator('.tiptap').innerText(),/原文直接编辑/);
  await page.locator('.tiptap').fill('修改后的重点');
  await page.locator('.tiptap').press('ControlOrMeta+A');
  await page.getByRole('button',{name:'加粗',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.editorTest.adapter.getFormat()),'markdown');
  assert.equal(await page.locator('textarea').inputValue(),'**修改后的重点**');
  assert.equal(await page.evaluate(()=>new FormData(document.querySelector('form')).get('body')),'**修改后的重点**');
  checks.push('Plain-source edits and rich formatting both submit through the original canonical body field.');
  await page.evaluate(()=>window.editorTest.adapter.setContent('## 标题\n\n**重点**','markdown'));
  assert.equal(await page.locator('.tiptap h2').innerText(),'标题');
  assert.equal(await page.locator('textarea').inputValue(),'## 标题\n\n**重点**');
  await page.getByRole('button',{name:'清空表单'}).click();
  await page.waitForFunction(()=>window.editorTest.textarea.value===''&&document.querySelector('.tiptap').innerText.trim()==='');
  assert.equal((await page.locator('.tiptap').innerText()).trim(),'');
  checks.push('Explicit Markdown renders without rewriting pristine text; reset clears the editor and canonical field together.');
  await page.evaluate(()=>{window.editorTest.adapter.destroy();});
  assert.equal(await page.locator('.rich-body').count(),0);
  assert.equal(await page.locator('textarea').isVisible(),true);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{window.editorTest.adapter=window.editorTest.mount(window.editorTest.textarea);});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
  checks.push('Close restores the original field; reopening fits a 390-pixel viewport without horizontal overflow.');
  const output=resolve(root,'campus/.data/rich-body-20261010');await mkdir(output,{recursive:true});
  await page.screenshot({path:resolve(output,'editor-mobile.png')});
  await writeFile(resolve(output,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));
  console.log(JSON.stringify({passed:true,checks,errors}));
}finally{await browser?.close();await server.close();}
