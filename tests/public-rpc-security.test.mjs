import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('Public RPC security: persistent rejected-request budgets and least-data responses',async t=>{
 const db=new PGlite();
 const officer='00000000-0000-4000-8000-000000000001';
 const keys=['createdAt','id','name','position','purpose','standby','status','studentId','updatedAt'].sort();
 const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
 // Model a PostgREST transaction and read its response settings before COMMIT.
 // This verifies SQL semantics, not an actual HTTP gateway deployment.
 async function rpc(fn,args=[],{source='test-source',method='POST',readOnly=false,role='anon',prefer=''}={}) {
  await db.exec(`begin${readOnly?' read only':''}`);
  try {
   await db.query("select set_config('request.headers',$1,true),set_config('request.method',$2,true),set_config('response.status','',true),set_config('request.jwt.claim.sub',$3,true)",[JSON.stringify({'x-forwarded-for':source,prefer}),method,officer]);
   await db.exec(`set local role ${role}`);
   const result=(await scalar(`select public.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).result;
   const config=await scalar("select current_setting('response.status',true) status,current_setting('response.headers',true) headers");
   await db.exec('commit');
   return {body:result,status:Number(config.status||200),headers:JSON.parse(config.headers||'[]')};
  } catch(error) {await db.exec('rollback');throw error;}
 }
 const registration=(student,token='a'.repeat(64),purpose=true)=>[student,'Test member','line','private-contact',token,...(purpose?['group_ride']:[])];
 const count=async(bucket)=>Number((await scalar('select coalesce(sum(attempts),0) n from private.public_rpc_budgets where bucket=$1',[bucket])).n);
 try {
  await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key,email text); create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  for(const file of ['001_borrow.sql','002_opening_loans.sql','003_abuse_controls.sql','004_borrowed_adjustment.sql','005_borrow_purpose.sql','006_public_rpc_security.sql'])await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  await db.query('insert into auth.users(id,email) values($1,$2)',[officer,'officer@example.test']);
  await db.query('insert into private.admins(user_id) values($1)',[officer]);
  await db.exec('update private.settings set total=10 where id=1');

  await t.test('Every public version is guarded; private implementations and counters are inaccessible',async()=>{
   const fns=(await db.query("select p.oid,p.proname,p.prosecdef,p.provolatile,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('register','lookup','summary')")).rows;
   assert.equal(fns.length,4);
   for(const f of fns){assert.ok(f.prosecdef);assert.equal(f.provolatile,'v');assert.ok(f.proconfig.includes('search_path=""'));}
   const privateFns=(await db.query("select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private'")).rows;
   for(const role of ['anon','authenticated']) {
    for(const f of privateFns)assert.equal((await scalar('select has_function_privilege($1,$2::oid,\'execute\') allowed',[role,f.oid])).allowed,false,`${role}: ${f.proname}`);
    for(const f of fns)assert.equal((await scalar('select has_function_privilege($1,$2::oid,\'execute\') allowed',[role,f.oid])).allowed,true);
    await db.exec(`set role ${role}`);
    try {
     await assert.rejects(db.query('select * from private.public_rpc_budgets'),/permission denied/);
     await assert.rejects(db.query('select private.summary_core()'),/permission denied/);
    }finally{await db.exec('reset role');}
   }
   assert.equal((await scalar("select relrowsecurity from pg_class where oid='private.public_rpc_budgets'::regclass")).relrowsecurity,true);
  });

  await t.test('Both register versions, retries and lookup expose only the explicit public fields; officers keep complete records',async()=>{
   const a=await rpc('register',registration('A'));
   const b=await rpc('register',registration('B','b'.repeat(64),false));
   assert.equal(a.status,200);assert.equal(b.status,200);
   for(const r of [a,b])assert.deepEqual(Object.keys(r.body.record).sort(),keys);
   assert.equal((await rpc('register',registration('A'))).body.record.id,a.body.record.id);
   assert.equal((await rpc('register',registration('B','b'.repeat(64),false))).body.record.id,b.body.record.id);
   assert.equal((await scalar('select count(*)::int n from private.records')).n,2);
   assert.equal((await scalar('select count(*)::int n from private.register_attempts')).n,2,'retries do not consume success cap');
   await db.query('update private.records set bike_note=$1 where id=$2',['officer-only note',a.body.record.id]);
   const found=await rpc('lookup',['a'.repeat(64)]);
   assert.deepEqual(Object.keys(found.body.record).sort(),keys);
   assert.doesNotMatch(JSON.stringify(found.body),/private-contact|officer-only|token_hash|contactType/);
   const admin=await rpc('admin_records',[],{role:'authenticated'});
   assert.equal(admin.body.records[0].contact,'private-contact');
   assert.equal(admin.body.records[0].bikeNote,'officer-only note');
  });

  await t.test('Invalid and duplicate registrations commit the request count and share the two-version budget',async()=>{
   await db.exec('truncate private.public_rpc_budgets');
   const duplicate=await rpc('register',registration('A','c'.repeat(64)));
   assert.equal(duplicate.status,400);assert.match(duplicate.body.message,/已有有效/);
   assert.deepEqual(Object.keys(duplicate.body).sort(),['code','details','hint','message']);
   assert.equal(await count('register'),1);
   for(let i=1;i<30;i++){
    const invalid=await rpc('register',registration('Z','invalid',i%2===0));
    assert.equal(invalid.status,400);assert.equal(invalid.body.code,'P0001');
    assert.equal(await count('register'),i+1);
   }
   const denied=await rpc('register',registration('C','c'.repeat(64)));
   assert.equal(denied.status,429);assert.equal(denied.body.code,'PT429');
   assert.ok(denied.headers.some(h=>h['Retry-After']==='600'));
   await rpc('register',registration('C','c'.repeat(64),false));
   assert.equal(await count('register'),31,'denied count is capped');
   assert.equal((await scalar('select count(*)::int n from private.records')).n,2);
   assert.equal((await scalar('select count(*)::int n from private.register_attempts')).n,2,'failed attempts are not successful allocations');
   assert.equal((await rpc('register',registration('C','c'.repeat(64)),{source:'other-source'})).status,200);
   await db.exec("update private.public_rpc_budgets set started_at=clock_timestamp()-interval '11 minutes'");
   assert.equal((await rpc('register',registration('A'))).status,200,'window resets and retry remains idempotent');
  });

  await t.test('The global successful-registration cap survives and an identical retry still resolves',async()=>{
   await db.exec('truncate private.public_rpc_budgets');
   const before=(await scalar('select count(*)::int n from private.register_attempts')).n;
   await db.query("insert into private.register_attempts(client_hash) select 'synthetic-cap' from generate_series(1,$1::integer)",[15-before]);
   const denied=await rpc('register',registration('D','d'.repeat(64)));
   assert.equal(denied.status,429);assert.match(denied.body.message,/一分鐘/);
   assert.equal(await count('register'),1);
   assert.equal((await rpc('register',registration('A'))).status,200);
   assert.equal((await scalar('select count(*)::int n from private.register_attempts')).n,15);
   await db.exec("delete from private.register_attempts where client_hash='synthetic-cap'");
  });

  await t.test('Missing source headers share a fallback budget instead of skipping protection',async()=>{
   await db.exec('truncate private.public_rpc_budgets');
   await rpc('summary',[],{source:null});
   await rpc('lookup',['invalid'],{source:null});
   assert.equal((await scalar("select attempts from private.public_rpc_budgets where client_hash='unknown' and bucket='read'")).attempts,2);
  });

  await t.test('summary and invalid lookup share 1200/min; method/read-only routes cannot bypass the budget',async()=>{
   await db.exec('truncate private.public_rpc_budgets');
   const invalid=await rpc('lookup',['bad']);assert.equal(invalid.status,400);
   assert.equal(await count('read'),1);
   await db.exec("update private.public_rpc_budgets set attempts=1199 where bucket='read'");
   assert.equal((await rpc('summary')).status,200);
   assert.equal((await rpc('lookup',['a'.repeat(64)])).status,429);
   assert.equal((await rpc('summary')).status,429);
   assert.equal(await count('read'),1201);
   for(const method of ['GET','HEAD']) {
    const denied=await rpc('lookup',['a'.repeat(64)],{method,readOnly:true});
    assert.equal(denied.status,405);assert.equal(denied.body.record,undefined);
   }
   assert.equal((await rpc('summary',[],{readOnly:true})).status,405);
   assert.equal(await count('read'),1201);
   assert.equal((await rpc('summary',[],{source:'different-source'})).status,200);
  });

  await t.test('Explicit rollback preference cannot read data or register even if server overrides are enabled later',async()=>{
   await db.exec('truncate private.public_rpc_budgets');
   const recordsBefore=(await scalar('select count(*)::int n from private.records')).n;
   for(const prefer of ['tx=rollback','return=representation, TX = RollBack , count=exact','tx=commit,tx=rollback']){
    for(const [fn,args] of [['summary',[]],['lookup',['a'.repeat(64)]],['register',registration('ROLLBACK','e'.repeat(64))],['register',registration('ROLLBACK','e'.repeat(64),false)]]){
     const denied=await rpc(fn,args,{prefer});
     assert.equal(denied.status,400);assert.match(denied.body.message,/回滾/);
     assert.equal(denied.body.record,undefined);assert.equal(denied.body.total,undefined);
     assert.ok(denied.headers.some(h=>h['Cache-Control']==='no-store'));
    }
   }
   assert.equal((await scalar('select count(*)::int n from private.records')).n,recordsBefore);
   assert.equal(await count('read'),0);assert.equal(await count('register'),0);
   assert.equal((await rpc('summary',[],{prefer:'return=representation, tx=commit'})).status,200);
  });

  await t.test('Unexpected SQL errors are redacted while request count persists; stale counter cleanup is bounded',async()=>{
   await db.exec('truncate private.public_rpc_budgets');
   await db.exec("create or replace function private.lookup_core(p_token text) returns jsonb language plpgsql security definer set search_path='' as $$ begin raise exception using message='secret internal table / contact',errcode='XX001'; end $$;");
   const failure=await rpc('lookup',['a'.repeat(64)]);
   assert.equal(failure.status,500);assert.equal(failure.body.code,'XX000');
   assert.doesNotMatch(JSON.stringify(failure),/secret|XX001|table|contact/);
   assert.equal(await count('read'),1);
   await db.exec("insert into private.public_rpc_budgets select 'expired-'||n,'read',clock_timestamp()-interval '2 days',1 from generate_series(1,250) n");
   await rpc('summary');
   assert.equal((await scalar("select count(*)::int n from private.public_rpc_budgets where client_hash like 'expired-%'")).n,150);
   await rpc('summary');
   assert.equal((await scalar("select count(*)::int n from private.public_rpc_budgets where client_hash like 'expired-%'")).n,50);
   await rpc('summary');
   assert.equal((await scalar("select count(*)::int n from private.public_rpc_budgets where client_hash like 'expired-%'")).n,0);
  });
 }finally{await db.close();}
});
