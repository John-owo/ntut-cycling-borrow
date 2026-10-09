import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {buildLifecycleRelease} from '../scripts/lifecycle-release.mjs';

test('Both loan generations share inventory, eligibility and complete private backups',async()=>{
 assert.equal(readFileSync(new URL('../supabase/releases/20261009-lifecycle.sql',import.meta.url),'utf8').replaceAll('\r\n','\n'),buildLifecycleRelease().replaceAll('\r\n','\n'),'reviewed release SQL matches migrations');
 const db=new PGlite(),actor=randomUUID(),session=randomUUID();
 const query=async(sql,args=[])=>(await db.query(`select ${sql} as value`,args)).rows[0].value;
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
  for(const file of readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(f=>/^00[1-8]_.*\.sql$/.test(f)).sort())await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  await db.exec(buildLifecycleRelease());
  assert.equal((await db.query('select count(*) n from private.lifecycle_assets')).rows[0].n,8);
  await db.query('insert into auth.users values($1,$2)',[actor,'fixture@example.test']);
  await db.query('insert into private.admins values($1)',[actor]);await db.query('insert into auth.sessions values($1,$2,null)',[session,actor]);
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:actor,session_id:session,aal:'aal2'})]);
  await query("public.admin_settings(4,'')");await db.exec('update private.opening_loans set outstanding=1 where id=1');
  await admin('settings',{location:'合成測試地點',instructions:'測試指引\n第二行',terms:'隔離測試規範\n不可用於真實借用'});
  const assets=[];for(let i=1;i<=3;i++)assets.push((await admin('asset',{code:`QA-${i}`,name:'合成測試車',kind:'bike',state:'available',reason:'synthetic inventory reconciliation'})).asset);
  await assert.rejects(admin('asset',{code:'QA-4',name:'extra',kind:'bike',state:'available',reason:'test'}),/總車數|盤點/);
  const reg=await query("public.register('OLD-A','Old member','line','synthetic-only',$1)",['a'.repeat(64)]);
  await assert.rejects(query('public.admin_action($1,$2,null)',[reg.record.id,'lend']),/盤點|預約流程/);
  await admin('asset',{...assets[2],state:'maintenance',reason:'synthetic physical allocation to legacy queue'});
  await query('public.admin_action($1,$2,null)',[reg.record.id,'lend']);
  const validUntil=new Date(Date.now()+7*86400000).toISOString();
  await admin('member',{studentId:'OLD-A',name:'Old member',contact:'synthetic',validUntil,active:true,token:'b'.repeat(64),reason:'test'});
  const start=new Date(Date.now()+3600000).toISOString(),end=new Date(Date.now()+7200000).toISOString();
  await assert.rejects(member('reserve','b'.repeat(64),{requestId:randomUUID(),assetIds:[assets[0].id],start,end}),/Legacy|legacy|登記|borrow|loan/i);
  await admin('member',{studentId:'NEW-B',name:'New member',contact:'synthetic',validUntil,active:true,token:'c'.repeat(64),reason:'test'});
  const booking=(await member('reserve','c'.repeat(64),{requestId:randomUUID(),assetIds:[assets[0].id],start,end})).reservation;
  const duplicate=await query("public.register('NEW-B','New member','line','synthetic-only',$1)",['d'.repeat(64)]);
  assert.match(duplicate.message,/已有有效/);
  // Fixture status only: the separate lifecycle tests exercise all pickup gates.
  await db.query("update private.lifecycle_reservations set status='in_use',picked_up_at=now() where id=$1",[booking.id]);
  const summary=await query('public.summary()');assert.equal(summary.borrowed,3);assert.equal(summary.available,1);
  await assert.rejects(query("public.admin_set_borrowed(1,3,1,$1,'fixture')",[randomUUID()]),/不可低於/);
  await assert.rejects(query("public.admin_settings(3,'')"),/盤點|庫存/);
  await assert.rejects(db.exec('update private.opening_loans set outstanding=2 where id=1'),/盤點|庫存/);
  const backup=await query('public.admin_export()');assert.ok(backup.lifecycle);assert.equal(backup.records.length,1);assert.equal(backup.lifecycle.reservations.length,1);
  assert.ok(!JSON.stringify(backup).includes('c'.repeat(64)),'backup contains hashes, never raw membership credentials');
  await db.exec('set role anon');
  await assert.rejects(query('public.admin_export()'),/permission denied/);
  await assert.rejects(db.exec('select * from private.lifecycle_photos'),/permission denied/);
 }finally{await db.close();}
});
