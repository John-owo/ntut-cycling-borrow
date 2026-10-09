// Isolated browser acceptance: no cloud requests or production data.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.mjs';
import {packagePages} from '../scripts/package-pages.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output=resolve(process.env.QA_OUTPUT || 'work/browser-qa');mkdirSync(output,{recursive:true});
if(readdirSync(output).some(name=>name.endsWith('.png')))throw Error('Choose an unused QA_OUTPUT directory to preserve earlier previews');
const qaRoot=mkdtempSync(join(tmpdir(),'bike-acceptance-'));
const publicDir=packagePages(join(qaRoot,'public'));
const app=createApp({dbPath:join(qaRoot,'synthetic.sqlite'),publicDir});
app.addAdmin('qa-admin','qa-only-password-123');app.db.prepare("UPDATE settings SET total=6,contactUrl='https://example.test/contact' WHERE id=1").run();
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${app.server.address().port}`;
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'msedge',headless:true});
const page=await browser.newPage();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
const results=[];
async function openLegacy(){const legacy=page.locator('.lc-legacy');if(await legacy.count()&&await legacy.getAttribute('open')===null)await legacy.locator('summary').click();}
// New waiting registrations are closed on the member page; existing queue entries are created through the API.
async function register(id,name,purpose='group_ride'){const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');const at=i=>new Date(Date.now()+i*3600000).toISOString();const response=await page.request.post(base+'/api/register',{data:{studentId:id,name,contactType:'instagram',contact:'synthetic-only',purpose,token,inspectionAt:at(1),rentalAt:at(2),returnAt:at(3),rentalNote:'',returnNote:''}});assert.equal(response.status(),200,await response.text());return token;}
async function lookupCode(token){await openLegacy();await page.locator('#lookup-token').fill(token);await page.locator('#lookup-form button').click();await page.locator('#lookup-message').filter({hasText:'已取得最新狀態'}).waitFor();}
async function layout(label,width){await page.setViewportSize({width,height:900});await page.screenshot({path:join(output,label+'.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' horizontal overflow');results.push(label+' no horizontal overflow');}
try{
 await page.goto(base);await page.locator('#lc-calendar-message').filter({hasText:'更新於'}).waitFor();
 assert.equal(await page.locator('#register-form,#register-button,[name=contactType]').count(),0);assert.equal(await page.locator('.lc-legacy').getAttribute('open'),null);results.push('Member page has no new waiting-registration form; the legacy lookup is collapsed');
 assert.equal(await page.locator('#lookup-form button').evaluate(el=>getComputedStyle(el).borderColor),'rgb(183, 195, 221)');assert.equal(await page.locator('#lc-reserve-form button[type=submit]').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(36, 60, 138)');results.push('Portal accent matches canonical brand #243C8A');
 const code=await register('QA001','測試社員甲');
 await lookupCode(code);await page.locator('#personal-result').filter({hasText:'測試社員甲'}).waitFor();await page.locator('#waiting').filter({hasText:'1'}).waitFor();
 await page.reload();assert.notEqual(await page.locator('.lc-legacy').getAttribute('open'),null,'a saved queue code opens the lookup');await page.locator('#personal-result').filter({hasText:'測試社員甲'}).waitFor();results.push('Existing queue entry lookup and private token reload passed');
 // Old polling response arriving after a new registration must not overwrite the new member.
 let release;let started;const gate=new Promise(r=>release=r),seen=new Promise(r=>started=r);
 await page.route('**/api/me',async route=>{const response=await route.fetch();started();await gate;await route.fulfill({response});});
 await page.locator('#refresh').click();await seen;
 const second=await register('QA002','測試社員乙','personal_ride');await page.unrouteAll({behavior:'ignoreErrors'});await page.locator('#lookup-token').fill(second);await page.locator('#lookup-form button').click();release();
 await page.locator('#personal-result').filter({hasText:'測試社員乙'}).waitFor();await page.waitForTimeout(150);assert.match(await page.locator('#personal-result').textContent(),/測試社員乙/);results.push('Delayed old lookup cannot replace a newer manual lookup');
 await layout('member-zh-mobile',390);await layout('member-zh-desktop',1280);
 await page.locator('[data-language=en]').click();await layout('member-en-mobile',390);
 await layout('member-en-desktop',1280);
 await page.locator('[data-language=zh]').click();
 await page.goto(base+'/admin.html');await page.locator('[name=username]').fill('qa-admin');await page.locator('[name=password]').fill('qa-only-password-123');await page.locator('#login-form button').click();await page.locator('#workspace:not([hidden])').waitFor();
 assert.match(await page.locator('#records').textContent(),/借車目的：自己私底下騎/);
 await page.locator('.record').first().getByRole('button',{name:'確認聯絡與時間',exact:true}).click();await page.locator('#dialog-confirm').click();await page.locator('#action-dialog').waitFor({state:'hidden'});
 await page.locator('.record').first().getByRole('button',{name:'確認借出',exact:true}).click();await page.locator('#dialog-confirm').click();await page.locator('#action-dialog').waitFor({state:'hidden'});
 await page.locator('[data-filter=borrowed]').click();await page.locator('.record').getByRole('button',{name:'確認歸還',exact:true}).click();await page.locator('#dialog-confirm').click();await page.locator('#action-dialog').waitFor({state:'hidden'});
 await page.locator('[data-filter=history]').click();await page.locator('.record').filter({hasText:'已歸還'}).waitFor();results.push('Officer login, actual lend/return transitions, history passed in synthetic SQLite');
 await layout('officer-zh-mobile',390);await layout('officer-zh-desktop',1280);
 await page.locator('[data-language=en]').click();await layout('officer-en-mobile',390);
 await layout('officer-en-desktop',1280);
 let downloads=0;page.on('download',()=>downloads++);
 let releaseExport,exportStarted;const exportGate=new Promise(r=>releaseExport=r),exportSeen=new Promise(r=>exportStarted=r);
 await page.route('**/api/admin/export',async route=>{const response=await route.fetch();exportStarted();await exportGate;await route.fulfill({response});});
 await page.locator('#export').click();await exportSeen;
 // Delay remote logout: local personal data must disappear before its response.
 let releaseLogout;const logoutGate=new Promise(r=>releaseLogout=r);
 await page.route('**/api/admin/logout',async route=>{await logoutGate;await route.continue();});
 await page.locator('#logout').click();await page.locator('#workspace').waitFor({state:'hidden'});assert.equal(await page.locator('#records').textContent(),'');assert.equal(await page.evaluate(()=>sessionStorage.getItem('bike-admin-session')),null);
 releaseLogout();releaseExport();await page.unrouteAll({behavior:'wait'});await page.waitForTimeout(100);assert.equal(downloads,0);results.push('Logout immediately removes credentials and personal records before remote response; delayed export cannot download PII');
 assert.equal(await page.locator('a[href*="club.html"],.portal-nav').count(),0);
 for(const path of ['/club.css','/club-assets/image1.jpeg','/club-assets/image6.jpeg'])assert.equal((await page.request.get(base+path)).status(),404,path);
 await page.goto(base+'/club.html');await page.waitForURL(base+'/index.html');await openLegacy();await page.locator('#lookup-form').waitFor();
 assert.equal(await page.locator('a[href*="club.html"],.portal-nav').count(),0);
 for(const href of await page.locator('a[href^="#"]').evaluateAll(links=>links.map(a=>a.getAttribute('href'))))assert.equal(await page.locator(href).count(),1,href);
 await layout('member-small-mobile',320);
 results.push('Borrowing-only deployment package, legacy redirect and excluded marketing routes passed');
 assert.deepEqual(errors,[]);results.push('No browser page errors');
 writeFileSync(join(output,'results.json'),JSON.stringify({mode:'isolated synthetic SQLite with borrowing-only Pages package',results,errors},null,2));console.log(results.join('\n'));
}catch(e){await page.screenshot({path:join(output,'failure.png'),fullPage:true});console.error(await page.locator('body').innerText());throw e;}
finally{await browser.close();app.server.closeAllConnections();await app.close();}
