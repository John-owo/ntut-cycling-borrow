import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.mjs';

test('HTTP / SQLite: permissions, queue, concurrency, retries, persistence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bike-backend-'));const dbPath=join(dir,'db.sqlite');let app;let base;let bearer;
 const start=async(extra={})=>{app=createApp({dbPath,...extra});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;};
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
 // Officer bulk cancel skips non-waiting ids and audits each cancellation.
 const x1=await call('/api/register',registration('bulk-1')),x2=await call('/api/register',registration('bulk-2'));
 assert.equal((await call('/api/admin/cancel-many',{ids:[x1.record.id]})).status,401);
 assert.equal((await call('/api/admin/cancel-many',{ids:[]},true)).status,400);
 const bulk=await call('/api/admin/cancel-many',{ids:[x1.record.id,x2.record.id,winner.id,999999,x1.record.id]},true);
 assert.deepEqual(bulk.cancelled,[x1.record.id,x2.record.id].sort((a,b)=>a-b));assert.deepEqual(bulk.skipped,[winner.id,999999].sort((a,b)=>a-b));
 const afterBulk=await call('/api/admin/records',undefined,true);assert.equal(afterBulk.audit.filter(a=>a.action==='cancel'&&JSON.parse(a.details).bulk===true).length,2);
 // Export is officer-only, complete (keeps token hashes for restore) and audited.
 assert.equal((await call('/api/admin/export')).status,401);
 const dump=await call('/api/admin/export',undefined,true);assert.equal(dump.exportedBy,'president');assert.equal(dump.records.length,afterBulk.records.length);
 assert.ok(dump.records.every(r=>typeof r.tokenHash==='string'));assert.deepEqual(dump.admins,['president','vice']);
 assert.equal((await call('/api/admin/records',undefined,true)).audit[0].action,'export');
 assert.equal((await call('/api/admin/logout',{},true)).status,200);assert.equal((await call('/api/admin/records',undefined,true)).status,401);
 // Registration throttle: new attempts are capped, replays of an existing code are not.
 await app.close();await start({registerLimits:{minute:2,hour:90,day:300,client:10}});
 const t1=registration('throttle-1');assert.equal((await call('/api/register',t1)).status,200);assert.equal((await call('/api/register',registration('throttle-2'))).status,200);
 assert.equal((await call('/api/register',registration('throttle-3'))).status,429);
 assert.equal((await call('/api/register',t1)).status,200);
 await app.close();await start({registerLimits:{minute:15,hour:90,day:300,client:1}});
 assert.equal((await call('/api/register',registration('client-1'))).status,200);assert.equal((await call('/api/register',registration('client-2'))).status,429);
 }finally{await app?.close();rmSync(dir,{recursive:true,force:true});}
});

function remainingToken(a,b,winner){return winner.studentId===a.studentId?b.token:a.token;}

test('Borrowed adjustment: authenticated, bounded, stale-safe and permanent retries preserve member records',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bike-adjustment-'));const dbPath=join(dir,'db.sqlite');let app,base,bearer;
 const start=async()=>{app=createApp({dbPath});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;};
 const call=async(path,body,admin=true)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(admin?{Authorization:`Bearer ${bearer}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,...await r.json()};};
 let seq=100;const form=(borrowed,expectedBorrowed=3,expectedOpening=2)=>({borrowed,expectedBorrowed,expectedOpening,requestId:`00000000-0000-4000-8000-${String(seq++).padStart(12,'0')}`,reason:'  盤點更正  '});
 try{
 await start();app.addAdmin('officer','test-password-123');bearer=(await call('/api/admin/login',{username:'officer',password:'test-password-123'},false)).token;
 assert.equal((await call('/api/admin/borrowed',form(1))).status,409); // unset inventory
 await call('/api/admin/settings',{total:5,contactUrl:''});
 const member=await call('/api/register',{studentId:'REAL',name:'Member',contactType:'line',contact:'test',token:'a'.repeat(64)},false);
 await call('/api/admin/action',{id:member.record.id,action:'lend',bikeNote:'original'});
 app.db.exec('UPDATE opening_loans SET outstanding=2 WHERE id=1');
 const original=app.db.prepare('SELECT * FROM records').all();
 assert.equal((await call('/api/admin/borrowed',form(4),false)).status,401);
 for(const v of [-1,1.5,'4',6,0])assert.equal((await call('/api/admin/borrowed',form(v))).status,typeof v==='number'&&Number.isInteger(v)&&v>=0?409:400);
 for(const reason of ['', ' '.repeat(5),'x'.repeat(501)])assert.equal((await call('/api/admin/borrowed',{...form(4),reason})).status,400);
 assert.equal((await call('/api/admin/borrowed',form(4,2,2))).status,409);
 assert.equal((await call('/api/admin/borrowed',form(4,3,1))).status,409);
 const first=form(4);const changed=await call('/api/admin/borrowed',first);assert.equal(changed.status,200);assert.equal(changed.opening.outstanding,3);assert.equal(changed.summary.available,1);assert.equal(changed.receipt.reason,'盤點更正');
 await app.close();await start();
 const replay=await call('/api/admin/borrowed',first);assert.deepEqual(replay.receipt,changed.receipt);
 for(const change of [{borrowed:5},{expectedBorrowed:4},{expectedOpening:3},{reason:'different'}])assert.equal((await call('/api/admin/borrowed',{...first,...change})).status,409);
 const races=await Promise.all([call('/api/admin/borrowed',form(2,4,3)),call('/api/admin/borrowed',form(3,4,3))]);
 assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
 assert.deepEqual(app.db.prepare('SELECT * FROM records').all(),original);
 const current=await call('/api/admin/records');const zeroOpening=await call('/api/admin/borrowed',form(1,current.summary.borrowed,current.opening.outstanding));assert.equal(zeroOpening.opening.outstanding,0);
 const dump=await call('/api/admin/export');assert.equal(dump.borrowedAdjustments.length,3);assert.equal(dump.audit.filter(a=>a.action==='borrowed-adjustment').length,3);
 assert.deepEqual(JSON.parse(dump.borrowedAdjustments.find(a=>a.requestId===first.requestId).receipt),changed.receipt);
 }finally{await app?.close();rmSync(dir,{recursive:true,force:true});}
});
