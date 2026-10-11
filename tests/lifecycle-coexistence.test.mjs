import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {buildLifecycleRelease} from '../scripts/lifecycle-release.mjs';

const sql=file=>readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
const photo=Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000280806000000','hex').toString('base64');
const signature='data:image/png;base64,'+Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000280806000000','hex'),Buffer.alloc(150,1)]).toString('base64');
const checks={frame:true,tires:true,brakes:true,gears:true,accessories:true};

test('014 closes the legacy queue and frees the numbered fleet from the legacy total, keeping old records and backups',async()=>{
 assert.equal(readFileSync(new URL('../supabase/releases/20261009-lifecycle.sql',import.meta.url),'utf8').replaceAll('\r\n','\n'),buildLifecycleRelease().replaceAll('\r\n','\n'),'reviewed release SQL matches migrations');
 const db=new PGlite(),actor=randomUUID(),session=randomUUID();
 const query=async(sql,args=[])=>(await db.query(`select ${sql} as value`,args)).rows[0].value;
 const as=async(role,fn)=>{await db.exec(`set role ${role}`);try{return await fn();}finally{await db.exec('reset role');}};
 const admin=(action,payload={})=>query('public.lifecycle_admin($1,$2::jsonb)',[action,JSON.stringify(payload)]);
 const member=async(action,token,payload={})=>{
  const value=await query('public.lifecycle($1,$2,$3::jsonb)',[action,token,JSON.stringify(payload)]);
  if(value?.code&&value?.message)throw Error(value.message);return value;
 };
 try{
  await db.exec(`create role anon; create role authenticated; create schema auth;
   create table auth.users(id uuid primary key,email text);
   create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
   create table auth.mfa_factors(id uuid primary key,user_id uuid,status text,factor_type text,friendly_name text);
   create function auth.jwt() returns jsonb language sql as $$select current_setting('request.jwt.claims',true)::jsonb$$;
   create function auth.uid() returns uuid language sql as $$select (auth.jwt()->>'sub')::uuid$$;`);
  for(const file of readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(f=>/^00[1-8]_.*\.sql$/.test(f)).sort())await db.exec(sql(file));
  await db.exec(buildLifecycleRelease());
  assert.equal((await db.query('select count(*) n from private.lifecycle_assets')).rows[0].n,8);
  await db.query('insert into auth.users values($1,$2)',[actor,'fixture@example.test']);
  await db.query('insert into private.admins values($1)',[actor]);await db.query('insert into auth.sessions values($1,$2,null)',[session,actor]);
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:actor,session_id:session,aal:'aal2'})]);
  // Legacy state before the closure: a total of one bike, already out on the old queue, and one stale waiting entry.
  await query("public.admin_settings(1,'')");
  const out=await query("public.register('OLD-A','Old borrower','line','synthetic-only',$1)",['a'.repeat(64)]);
  await query('public.admin_action($1,$2,null)',[out.record.id,'lend']);
  const stale=await query("public.register('OLD-W','Old waiting','line','synthetic-only',$1)",['e'.repeat(64)]);
  await assert.rejects(admin('asset',{code:'QA-0',name:'blocked',kind:'bike',state:'available',reason:'test'}),/總車數|盤點/,'before 014 the legacy total caps the fleet');
  await db.exec(sql('012_self_service_booking.sql'));await db.exec(sql('013_remove_pickup_instructions.sql'));
  const before=(await db.query('select (select jsonb_agg(to_jsonb(r) order by id) from private.records r) r,(select to_jsonb(s) from private.settings s) s,(select to_jsonb(o) from private.opening_loans o) o')).rows[0];
  await db.exec(sql('014_close_legacy_queue.sql'));
  await assert.rejects(db.exec(sql('014_close_legacy_queue.sql')),/already installed/);await db.exec('rollback');
  assert.deepEqual((await db.query('select (select jsonb_agg(to_jsonb(r) order by id) from private.records r) r,(select to_jsonb(s) from private.settings s) s,(select to_jsonb(o) from private.opening_loans o) o')).rows[0],before,'014 leaves legacy rows untouched');

  // The numbered fleet is no longer capped by the legacy total.
  const policy=(await admin('settings',{location:'合成測試地點',terms:'隔離測試規範\n不可用於真實借用'})).settings;
  const assets=[];for(let i=1;i<=3;i++)assets.push((await admin('asset',{code:`QA-${i}`,name:'合成測試車',kind:'bike',state:'available',reason:'synthetic inventory reconciliation'})).asset);
  await db.exec("update private.settings set total=0 where id=1");await db.exec('update private.opening_loans set outstanding=0 where id=1');
  const validUntil=new Date(Date.now()+7*86400000).toISOString(),start=new Date(Date.now()+2000).toISOString(),end=new Date(Date.now()+3600000).toISOString();
  await admin('member',{studentId:'OLD-A',name:'Old borrower',contact:'synthetic',validUntil,active:true,token:'b'.repeat(64),reason:'test'});
  await assert.rejects(member('reserve','b'.repeat(64),{requestId:randomUUID(),assetIds:[assets[0].id],start,end}),/legacy/i,'a bike still out on the old list blocks a new booking');
  await admin('member',{studentId:'OLD-W',name:'Old waiting',contact:'synthetic',validUntil,active:true,token:'f'.repeat(64),reason:'test'});
  assert.ok((await member('reserve','f'.repeat(64),{requestId:randomUUID(),assetIds:[assets[1].id],start,end})).reservation,'a stale waiting entry no longer blocks booking');
  await admin('member',{studentId:'NEW-B',name:'New member',contact:'synthetic',validUntil,active:true,token:'c'.repeat(64),reason:'test'});
  const booking=(await member('reserve','c'.repeat(64),{requestId:randomUUID(),assetIds:[assets[0].id],start,end})).reservation;
  await new Promise(r=>setTimeout(r,2100));
  for(const slot of ['left','right','drivetrain','damage'])await member('photo','c'.repeat(64),{requestId:randomUUID(),reservationId:booking.id,assetId:assets[0].id,phase:'pickup',slot,mime:'image/png',data:photo});
  const picked=await member('pickup','c'.repeat(64),{requestId:randomUUID(),reservationId:booking.id,checks,notes:'',signature:{name:'New member',accepted:true,termsVersion:policy.termsVersion,image:signature}});
  assert.equal(picked.reservation.status,'in_use','pickup ignores the exhausted legacy total');
  assert.equal((await query('public.admin_records()')).summary.borrowed,1,'legacy count excludes numbered loans');

  // Legacy entry points are closed; existing rows can still be closed out.
  for(const role of ['anon','authenticated'])for(const fn of ['public.summary()','public.lookup(text)','public.register(text,text,text,text,text,text,text,text,text,text,text)','public.admin_settings(integer,text)','public.admin_set_borrowed(integer,integer,integer,uuid,text)','public.admin_confirm_schedule(bigint)'])
   assert.equal((await db.query('select has_function_privilege($1,$2,$3) p',[role,fn,'execute'])).rows[0].p,false,`${role} ${fn}`);
  for(const fn of ['public.lifecycle(text,text,jsonb)'])assert.equal((await db.query("select has_function_privilege('anon',$1,'execute') p",[fn])).rows[0].p,true);
  await assert.rejects(as('anon',()=>query("public.register('NEW-C','New','line','synthetic-only',$1,'group_ride',null,null,null,null,null)",['d'.repeat(64)])),/permission denied/);
  await assert.rejects(as('anon',()=>query('public.lookup($1)',['a'.repeat(64)])),/permission denied/);
  await assert.rejects(db.query("insert into private.records(student_id,name,contact_type,contact,token_hash,status) values('X','X','line','x',$1,'waiting')",['0'.repeat(64)]),/已關閉/);
  await assert.rejects(db.query("update private.records set status='borrowed' where id=$1",[stale.record.id]),/已關閉/);
  await assert.rejects(query('public.admin_action($1,$2,null)',[stale.record.id,'lend']),/已關閉|尚未借出/);
  assert.equal((await query('public.admin_action($1,$2,null)',[stale.record.id,'cancel'])).record.status,'cancelled');
  assert.equal((await query('public.admin_action($1,$2,null)',[out.record.id,'return'])).record.status,'returned');
  await assert.rejects(query('public.admin_action($1,$2,null)',[out.record.id,'lend']),/目前狀態|已關閉/);

  const backup=await query('public.admin_export()');assert.ok(backup.lifecycle);assert.equal(backup.records.length,2);assert.equal(backup.lifecycle.reservations.length,2);
  assert.ok(!JSON.stringify(backup).includes('c'.repeat(64)),'backup contains hashes, never raw membership credentials');
  await db.exec('set role anon');
  await assert.rejects(query('public.admin_export()'),/permission denied/);
  await assert.rejects(db.exec('select * from private.lifecycle_photos'),/permission denied/);
 }finally{await db.close();}
});
