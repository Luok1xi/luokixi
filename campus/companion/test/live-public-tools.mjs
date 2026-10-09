import {BrowserReader} from '../src/browser-reader.mjs';
import {publicBytes} from '../src/downloads.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
const browser=new BrowserReader({dataDir:'test-output/browser-profile'}),report={};
try{try{const rows=await browser.discover({kind:'bilibili-search',query:'机器人'});report.search=rows.map(({title,url})=>({title,url}));if(rows[0]){const doc=await browser.document(rows[0].url);report.document={title:doc.title,characters:doc.text.length,readLevel:doc.readLevel,limitations:doc.limitations};}}catch(e){report.browserError=e.message;}
 try{const r=await publicBytes('https://raw.githubusercontent.com/microsoft/playwright/main/LICENSE');report.download={url:r.url,bytes:r.bytes.length,mime:r.mime,containsLicense:r.bytes.toString().includes('Apache')};}catch(e){report.download={error:e.message};}
 await mkdir('test-output',{recursive:true});await writeFile('test-output/live-public-tools.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
