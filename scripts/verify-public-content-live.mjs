import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({headless:true,executablePath:'C:/Users/user/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),report={errors:[]};
page.on('pageerror',e=>report.errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:17860/');
 await page.waitForSelector('.home-frontier-item');
 await page.waitForFunction(()=>!document.querySelector('.intro,.op')&&!document.documentElement.classList.contains('intro-pending'));
 await page.locator('.home-updates').scrollIntoViewIfNeeded();
 await page.screenshot({path:'campus/.data/verification-20261008/home-updates.png'});
 report.home={news:await page.locator('.home-frontier-item').count(),logs:await page.locator('.home-logs details').count()};
 await page.locator('.home-logs summary').first().click();
 report.home.logReadable=(await page.locator('.home-log-body').first().innerText()).length>60;
 const post=await page.locator('.home-frontier-item').first().getAttribute('href');
 const journal=await page.locator('.home-logs a').first().getAttribute('href');
 await page.goto('http://127.0.0.1:17860/'+post);
 await page.waitForSelector('.cs-thread .ds-img',{timeout:15000});
 report.news={photos:await page.locator('.cs-thread .ds-img').count(),text:(await page.locator('.cs-thread').innerText()).length};
 await page.goto('http://127.0.0.1:17860/'+journal);
 await page.waitForSelector('#discussion');
 report.journal={photos:await page.locator('.pd-photos .ds-img').count(),discussion:await page.locator('#discussion').count()};
 await page.setViewportSize({width:390,height:844});
 report.mobile={overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)};
 await writeFile('campus/.data/verification-20261008/public-content.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}finally{await browser.close();}
