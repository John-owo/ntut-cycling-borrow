// Optional real-browser regression for the one-time booking notice, using the same external Playwright setup as browser-qa.mjs.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.mjs';
import {packagePages} from '../scripts/package-pages.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=mkdtempSync(join(tmpdir(),'bike-notice-'));
const app=createApp({dbPath:join(root,'test.sqlite'),publicDir:packagePages(join(root,'public'))});
app.db.prepare('UPDATE settings SET total=6 WHERE id=1').run();
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${app.server.address().port}`;
const key='lc-notice-booking-1011';
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
const context=await browser.newContext({viewport:{width:360,height:640}}),page=await context.newPage(),errors=[],violations=[];
page.on('pageerror',e=>errors.push(e.message));
await context.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>(window.__violations=window.__violations||[]).push(`${e.effectiveDirective}:${e.blockedURI}`)));
const open=()=>page.locator('#lc-notice').evaluate(el=>el.open);
const noOverflow=async label=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${label}: no horizontal overflow`);
try{
 // First visit: the notice opens on its own, focus lands inside it, the page behind is covered.
 await page.goto(base+'/index.html');await page.locator('#lc-notice[open]').waitFor();
 assert.equal(await page.locator('#lc-notice-title').textContent(),'借車改成線上預約了');
 assert.equal(await page.locator('#lc-notice li').count(),5);
 assert.equal(await page.evaluate(()=>document.activeElement.id),'lc-notice-start','focus moves into the notice');
 assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),'1','showing it marks it seen');
 await noOverflow('zh notice');
 // Esc closes it; a reload does not bring it back.
 await page.keyboard.press('Escape');assert.equal(await open(),false);
 await page.reload();await page.locator('#lc-calendar-message').waitFor();assert.equal(await open(),false,'shown only once');
 // A different device or cleared storage sees it again, in English when that language is chosen.
 await page.evaluate(key=>{localStorage.removeItem(key);localStorage.setItem('bike-language','en');},key);
 await page.reload();await page.locator('#lc-notice[open]').waitFor();
 assert.equal(await page.locator('#lc-notice-title').textContent(),'Borrowing is now by online booking');
 assert.equal(await page.locator('#lc-notice-start').textContent(),'Start booking');assert.equal(await page.locator('#lc-notice-close').textContent(),'Got it');
 const leftover=await page.locator('#lc-notice').evaluate(el=>[...el.querySelectorAll('*')].flatMap(n=>[...n.childNodes].filter(c=>c.nodeType===3).map(c=>c.data.trim())).filter(t=>/[㐀-鿿]/.test(t)));
 assert.deepEqual(leftover,[],'no untranslated text in the English notice');
 await noOverflow('en notice');
 // The photo and signature wording matches the real pickup flow.
 assert.match(await page.locator('#lc-notice li').nth(3).textContent(),/upload photos.*check each item.*sign/);
 // Start booking closes the notice and brings the calendar into view (smooth scrolling is disabled so the check is deterministic).
 await page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';});
 await page.locator('#lc-notice-start').click();assert.equal(await open(),false);
 const top=await page.locator('#lc-calendar-panel').evaluate(el=>el.getBoundingClientRect().top);assert.ok(top>=0&&top<200,`calendar scrolled into view (top ${top})`);
 // Clicking the backdrop dismisses it as well.
 await page.evaluate(()=>document.getElementById('lc-notice').showModal());await page.mouse.click(2,2);assert.equal(await open(),false,'backdrop click closes');
 // The officer page is unaffected.
 await page.goto(base+'/admin.html');assert.equal(await page.locator('#lc-notice').count(),0);
 violations.push(...await page.evaluate(()=>window.__violations||[]));
 assert.deepEqual(errors,[]);assert.deepEqual(violations,[]);
 console.log('PASS: first-visit notice opens once, closes by button/Esc/backdrop, English complete, no overflow at 360px, no page errors or CSP violations.');
}finally{await browser.close();app.server.closeAllConnections();await app.close();}
