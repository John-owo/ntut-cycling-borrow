// Optional real-browser regression, using the same external Playwright setup as browser-qa.mjs.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const app=createApp({dbPath:join(mkdtempSync(join(tmpdir(),'bike-member-race-')),'test.sqlite'),publicDir:resolve('public')});
app.db.prepare('UPDATE settings SET total=6 WHERE id=1').run();
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${app.server.address().port}`,oldToken='a'.repeat(64),newToken='b'.repeat(64);
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
try{
 for(const [name,token]of [['old',oldToken],['new',newToken]]){
  const response=await fetch(base+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({studentId:name,name,contactType:'line',contact:'synthetic-only',purpose:'group_ride',token})});
  assert.equal(response.status,200);
 }
 await page.goto(base);await page.evaluate(token=>localStorage.setItem('bike-query-token',token),oldToken);await page.reload();
 await page.locator('#personal-result').filter({hasText:'old'}).waitFor();
 const requested=deferred(),release=deferred();let oldRequests=0;
 await page.route('**/api/me',async route=>{
  const {token}=route.request().postDataJSON();
  if(token===newToken){requested.resolve();await release.promise;}else oldRequests++;
  await route.continue();
 });
 await page.locator('#lookup-token').fill(newToken);await page.locator('#lookup-form button').click();await requested.promise;
 await page.locator('#refresh').click();await page.waitForTimeout(100);
 assert.equal(oldRequests,0,'a background refresh must not replace the pending manual lookup');
 release.resolve();await page.locator('#personal-result').filter({hasText:'new'}).waitFor();
 assert.equal(await page.evaluate(()=>localStorage.getItem('bike-query-token')),newToken);
 assert.equal(await page.locator('#lookup-token').inputValue(),newToken);
 await page.unrouteAll();

 await page.evaluate(()=>localStorage.clear());
 const summaryRequested=deferred(),summaryRelease=deferred();
 await page.route('**/api/summary',async route=>{
  summaryRequested.resolve();await summaryRelease.promise;
  await route.fulfill({json:{total:6,borrowed:0,available:6,waiting:0,contactUrl:''}});
 });
 await page.reload();await summaryRequested.promise;
 await page.locator('#lookup-token').fill(newToken);await page.locator('#lookup-form button').click();
 await page.locator('#personal-result').filter({hasText:'new'}).waitFor();
 assert.equal(await page.locator('#waiting').textContent(),'2');
 summaryRelease.resolve();await page.waitForTimeout(100);
 assert.equal(await page.locator('#waiting').textContent(),'2','an earlier summary response must be discarded');
 assert.deepEqual(errors,[]);
 console.log('PASS: Edge + isolated SQLite; manual lookup priority, delayed public summary, no page errors.');
}finally{await browser.close();app.server.closeAllConnections();await app.close();}
