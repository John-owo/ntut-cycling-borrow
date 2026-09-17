import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.mjs';

test('HTTP / SQLite: permissions, queue, concurrency, retries, persistence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bike-backend-'));const dbPath=join(dir,'db.sqlite');let app;let base;let bearer;
 const start=async()=>{app=createApp({dbPath});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;};
 const call=async(path,body,admin=false)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(admin?{Authorization:`Bearer ${bearer}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,...await response.json()};};
 const registration=id=>({studentId:id.toUpperCase(),name:'Test member',contactType:'line',contact:'test-only',token:randomBytes(32).toString('hex')});
 try{
 await start();app.addAdmin('president','test-password-123');app.addAdmin('vice','test-password-456');
 assert.equal((await call('/api/summary')).total,null);
 assert.equal((await call('/api/register',registration('1'))).status,409);
 assert.equal((await call('/api/admin/records')).status,401);
 assert.equal((await call('/api/admin/settings',{total:1,contactUrl:''})).status,401);
 const deniedOrigin=await fetch(base+'/api/summary',{headers:{Origin:'https://untrusted.example'}});assert.equal(deniedOrigin.status,403);
 assert.equal((await call('/api/me',{token:'1'})).status,400);
 assert.equal((await call('/api/admin/login',{username:'president',password:'wrong'})).status,401);
 bearer=(await call('/api/admin/login',{username:'president',password:'test-password-123'})).token;
 assert.equal((await call('/api/admin/settings',{total:1,contactUrl:''},true)).status,200);
 const a=registration('a'),b=registration('b');const ra=await call('/api/register',a),rb=await call('/api/register',b);
 assert.equal(ra.record.position,1);assert.equal(rb.record.standby,1);
 assert.equal((await call('/api/register',a)).record.id,ra.record.id);
 assert.equal((await call('/api/register',registration('a'))).status,409);
 assert.equal((await call('/api/register',{...registration('a'),studentId:' a '})).status,409);
 assert.equal((await call('/api/register',{...registration('z'),contactType:'email'})).status,400);
 assert.equal((await call('/api/me',{token:randomBytes(32).toString('hex')})).status,404);
 const results=await Promise.all([call('/api/admin/action',{id:rb.record.id,action:'lend'},true),call('/api/admin/action',{id:ra.record.id,action:'lend'},true)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const winner=results.find(r=>r.status===200).record;
 assert.equal((await call('/api/admin/action',{id:winner.id,action:'lend'},true)).status,200);
 assert.equal((await call('/api/register',registration(winner.studentId))).status,409);
 assert.equal((await call('/api/admin/settings',{total:0,contactUrl:''},true)).status,409);
 assert.equal((await call('/api/summary')).borrowed,1);
 assert.equal((await call('/api/admin/action',{id:winner.id,action:'return'},true)).status,200);
 assert.equal((await call('/api/admin/action',{id:winner.id,action:'return'},true)).status,200);
 assert.equal((await call('/api/summary')).available,1);
 // A later registration can receive a bike without corrupting the earlier queue.
 const c=registration('c');const rc=await call('/api/register',c);
 assert.equal((await call('/api/admin/action',{id:rc.record.id,action:'lend'},true)).status,200);
 assert.equal((await call('/api/me',{token:remainingToken(a,b,winner)})).record.position,1);
 assert.equal((await call('/api/admin/action',{id:rc.record.id,action:'return'},true)).status,200);
 const waiting=winner.id===ra.record.id?rb:ra;const waitingToken=winner.id===ra.record.id?b.token:a.token;
 assert.equal((await call('/api/me',{token:waitingToken})).record.position,1);
 assert.equal((await call('/api/admin/action',{id:waiting.record.id,action:'cancel'},true)).status,200);
 assert.equal((await call('/api/summary')).waiting,0);
 const summary=await call('/api/summary');assert.equal(JSON.stringify(summary).includes('studentId'),false);
 const all=await call('/api/admin/records',undefined,true);assert.equal(all.audit.filter(x=>x.action==='return'&&x.recordId===winner.id).length,1);assert.equal(JSON.stringify(all).includes('tokenHash'),false);
 await app.close();await start();assert.equal((await call('/api/me',{token:waitingToken})).record.status,'cancelled');assert.equal((await call('/api/summary')).total,1);
 app.db.exec("UPDATE opening_loans SET outstanding=3,expectedReturn='2000-01-01',note='test-only inventory' WHERE id=1");
 assert.equal((await call('/api/admin/settings',{total:2,contactUrl:''},true)).status,409);
 await call('/api/admin/settings',{total:4,contactUrl:''},true);
 const d=await call('/api/register',registration('opening-d')),e=await call('/api/register',registration('opening-e'));
 assert.equal(e.record.standby,1);await call('/api/admin/action',{id:d.record.id,action:'lend'},true);
 assert.equal((await call('/api/admin/action',{id:e.record.id,action:'lend'},true)).status,409);
 assert.equal((await call('/api/summary')).borrowed,4);
 const requestId='00000000-0000-4000-8000-000000000010';
 assert.equal((await call('/api/admin/opening-return',{count:1,requestId})).status,401);
 const receipt=await call('/api/admin/opening-return',{count:1,requestId},true);assert.equal(receipt.opening.outstanding,2);assert.equal(receipt.summary.borrowed,3);
 await app.close();await start();const retry=await call('/api/admin/opening-return',{count:1,requestId},true);assert.deepEqual(retry.receipt,receipt.receipt);assert.equal(retry.summary.borrowed,3);
 assert.equal((await call('/api/admin/opening-return',{count:2,requestId},true)).status,409);
 assert.equal((await call('/api/admin/opening-return',{count:3,requestId:'00000000-0000-4000-8000-000000000011'},true)).status,409);
 const openingAdmin=await call('/api/admin/records',undefined,true);assert.equal(openingAdmin.opening.expectedReturn,'2000-01-01');assert.equal(openingAdmin.audit.filter(a=>a.action==='opening-return').length,1);
 assert.equal(JSON.stringify(await call('/api/summary')).includes('expectedReturn'),false);
 assert.equal((await call('/api/admin/logout',{},true)).status,200);assert.equal((await call('/api/admin/records',undefined,true)).status,401);
 }finally{await app?.close();rmSync(dir,{recursive:true,force:true});}
});

function remainingToken(a,b,winner){return winner.studentId===a.studentId?b.token:a.token;}
