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
async function readTerms(){await page.locator('#borrow-terms-text').evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.locator('#terms-agree:enabled').waitFor();await page.locator('#terms-agree').check();}
async function register(id,name){await page.locator('[name=studentId]').fill(id);await page.locator('[name=name]').fill(name);await page.locator('[name=contact]').fill('synthetic-only');await readTerms();await page.locator('#register-button').click();await page.locator('#register-message').filter({hasText:'登記已保存'}).waitFor();}
async function layout(label,width){await page.setViewportSize({width,height:900});await page.screenshot({path:join(output,label+'.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' horizontal overflow');results.push(label+' no horizontal overflow');}
try{
 await page.goto(base);await page.locator('#total').filter({hasText:'6'}).waitFor();
 assert.equal(await page.locator('[name=contactType] option').evaluateAll(options=>options.map(option=>option.value).join(',')),'line,instagram');
 assert.equal(await page.locator('#terms-agree').isEnabled(),false);
 assert.equal(await page.locator('#register-button').isEnabled(),false);results.push('Contact options and borrowing-rules gate passed');
 assert.equal(await page.locator('#register-button').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(36, 60, 138)');results.push('Portal accent matches canonical brand #243C8A');
 await register('QA001','測試社員甲');
 assert.match(await page.locator('#personal-result').textContent(),/測試社員甲/);
 const code=await page.locator('#recovery-code').textContent();assert.equal(code.length,64);
 await page.reload();await page.locator('#personal-result').filter({hasText:'測試社員甲'}).waitFor();results.push('Registration and private token reload passed');
 // Old polling response arriving after a new registration must not overwrite the new member.
 let release;let started;const gate=new Promise(r=>release=r),seen=new Promise(r=>started=r);
 await page.route('**/api/me',async route=>{const response=await route.fetch();started();await gate;await route.fulfill({response});});
 await page.locator('#refresh').click();await seen;
 await register('QA002','測試社員乙');release();await page.unrouteAll({behavior:'wait'});
 await page.waitForTimeout(150);assert.match(await page.locator('#personal-result').textContent(),/測試社員乙/);results.push('Delayed old lookup cannot replace new registration');
 await layout('member-zh-mobile',390);await layout('member-zh-desktop',1280);
 await page.locator('[data-language=en]').click();await layout('member-en-mobile',390);
 await layout('member-en-desktop',1280);
 await page.locator('[data-language=zh]').click();
 await page.goto(base+'/admin.html');await page.locator('[name=username]').fill('qa-admin');await page.locator('[name=password]').fill('qa-only-password-123');await page.locator('#login-form button').click();await page.locator('#workspace:not([hidden])').waitFor();
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
 await page.goto(base+'/club.html');await page.waitForURL(base+'/index.html');await page.locator('#register-form').waitFor();
 assert.equal(await page.locator('a[href*="club.html"],.portal-nav').count(),0);
 for(const href of await page.locator('a[href^="#"]').evaluateAll(links=>links.map(a=>a.getAttribute('href'))))assert.equal(await page.locator(href).count(),1,href);
 await layout('member-small-mobile',320);
 results.push('Borrowing-only deployment package, legacy redirect and excluded marketing routes passed');
 assert.deepEqual(errors,[]);results.push('No browser page errors');
 writeFileSync(join(output,'results.json'),JSON.stringify({mode:'isolated synthetic SQLite with borrowing-only Pages package',results,errors},null,2));console.log(results.join('\n'));
}catch(e){await page.screenshot({path:join(output,'failure.png'),fullPage:true});console.error(await page.locator('body').innerText());throw e;}
finally{await browser.close();app.server.closeAllConnections();await app.close();}
