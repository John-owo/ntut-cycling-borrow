import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {buildLifecycleRelease} from '../scripts/lifecycle-release.mjs';

const sql=file=>readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');

test('015 stores an optional officer-entered rider-height range and publishes it on the calendar',async()=>{
 const db=new PGlite(),actor=randomUUID(),session=randomUUID();
 const query=async(text,args=[])=>(await db.query(`select ${text} as value`,args)).rows[0].value;
 const admin=async(action,payload={})=>{await db.exec('set role authenticated');try{return await query('public.lifecycle_admin($1,$2::jsonb)',[action,JSON.stringify(payload)]);}finally{await db.exec('reset role');}};
 const calendar=async()=>{await db.exec('set role anon');try{return await query('public.lifecycle($1,$2,$3::jsonb)',['calendar',null,JSON.stringify({start:new Date().toISOString(),end:new Date(Date.now()+86400000).toISOString()})]);}finally{await db.exec('reset role');}};
 try{
  await db.exec(`create role anon; create role authenticated; create schema auth;
   create table auth.users(id uuid primary key,email text);
   create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
   create table auth.mfa_factors(id uuid primary key,user_id uuid,status text,factor_type text,friendly_name text);
   create function auth.jwt() returns jsonb language sql as $$select current_setting('request.jwt.claims',true)::jsonb$$;
   create function auth.uid() returns uuid language sql as $$select (auth.jwt()->>'sub')::uuid$$;`);
  for(const file of readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(f=>/^00[1-8]_.*\.sql$/.test(f)).sort())await db.exec(sql(file));
  await db.exec(buildLifecycleRelease());
  for(const file of ['012_self_service_booking.sql','013_remove_pickup_instructions.sql','014_close_legacy_queue.sql'])await db.exec(sql(file));
  await db.query('insert into auth.users values($1,$2)',[actor,'fixture@example.test']);
  await db.query('insert into private.admins values($1)',[actor]);await db.query('insert into auth.sessions values($1,$2,null)',[session,actor]);
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:actor,session_id:session,aal:'aal2'})]);
  const before=(await admin('asset',{code:'QA-H',name:'合成測試車',kind:'bike',state:'inspection',reason:'synthetic'})).asset;
  await db.exec(sql('015_bike_rider_height.sql'));
  await assert.rejects(db.exec(sql('015_bike_rider_height.sql')),/already installed/);await db.exec('rollback');
  const seeded=(await calendar()).assets;assert.ok(seeded.length>=9);assert.ok(seeded.every(a=>a.minHeight===null&&a.maxHeight===null),'existing bikes start without a range');

  const set=(extra)=>admin('asset',{id:before.id,code:'QA-H',name:'合成測試車',kind:'bike',state:'available',reason:'synthetic fit',...extra});
  let a=(await set({minHeight:160,maxHeight:178})).asset;assert.equal(a.minHeight,160);assert.equal(a.maxHeight,178);
  a=(await set({})).asset;assert.deepEqual([a.minHeight,a.maxHeight],[160,178],'an older page that omits the heights keeps them');
  a=(await set({maxHeight:null})).asset;assert.deepEqual([a.minHeight,a.maxHeight],[160,null]);
  for(const bad of [{minHeight:99},{maxHeight:221},{minHeight:170.5},{minHeight:'170'},{minHeight:180,maxHeight:170}])
   await assert.rejects(set(bad),/height/i,JSON.stringify(bad));
  const fresh=(await admin('asset',{code:'QA-N',name:'新車',kind:'bike',state:'inspection',reason:'synthetic',minHeight:150,maxHeight:165})).asset;assert.deepEqual([fresh.minHeight,fresh.maxHeight],[150,165]);
  const helmet=(await admin('asset',{code:'QA-A',name:'安全帽',kind:'accessory',state:'available',reason:'synthetic',minHeight:150,maxHeight:165})).asset;assert.deepEqual([helmet.minHeight,helmet.maxHeight],[null,null],'accessories never carry a rider range');
  const published=(await calendar()).assets.find(x=>x.id===before.id);assert.deepEqual([published.minHeight,published.maxHeight],[160,null]);
  await assert.rejects(db.exec('update private.lifecycle_assets set min_height_cm=200,max_height_cm=150 where code=\'QA-N\''),/height_range/);
  for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'private.lifecycle_height(jsonb)','execute') p",[role])).rows[0].p,false);
 }finally{await db.close();}
});
