// Optional Edge regression with synthetic maximum-length member data.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=mkdtempSync(join(tmpdir(),'bike-officer-layout-'));
const app=createApp({dbPath:join(output,'synthetic.sqlite'),publicDir:resolve('public')});
const username='qa-'+'a'.repeat(57),name='W'.repeat(60),studentId='S'.repeat(30),contact='c'.repeat(100);
app.addAdmin(username,'synthetic-only-password-123');app.db.prepare('UPDATE settings SET total=6 WHERE id=1').run();
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 const response=await fetch(base+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({studentId,name,contactType:'line',contact,purpose:'group_ride',token:'f'.repeat(64)})});
 assert.equal(response.status,200);
 await page.goto(base+'/admin.html');await page.locator('[name=username]').fill(username);await page.locator('[name=password]').fill('synthetic-only-password-123');await page.locator('#login-form button').click();await page.locator('#workspace:not([hidden])').waitFor();
 for(const language of ['zh','en']){
  await page.locator(`[data-language=${language}]`).click();
  for(const width of [320,390,768,1280]){
   await page.setViewportSize({width,height:900});
   await page.screenshot({path:join(output,`officer-${language}-${width}.png`),fullPage:true});
   assert.equal(await page.locator('.record h3').textContent(),`${name} · ${studentId}`,'preserve complete member identifiers');
   assert.equal(await page.locator('.record .user-content').textContent(),contact,'preserve complete contact');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${language} at ${width}px must not scroll horizontally`);
   for(const selector of ['#identity','#export','#logout','.record h3','.record-side','.record-actions']){
    assert.ok(await page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),`${selector} stays reachable at ${language}/${width}`);
   }
  }
 }
 await page.locator('#logout').click();await page.locator('#login-panel:not([hidden])').waitFor();
 assert.deepEqual(errors,[]);
 console.log(`PASS: 8 officer layouts (zh/en, 320/390/768/1280), complete synthetic identifiers, logout; ${output}`);
}finally{await browser.close();app.server.closeAllConnections();await app.close();}
