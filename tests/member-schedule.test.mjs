import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('008 schedules preserve privacy, throttles, legacy registration and officer gates',async()=>{
 const db=new PGlite(),actor='00000000-0000-4000-8000-000000000001',sid='00000000-0000-4000-8000-000000000002';
 const rpc=async(fn,args=[],role='anon')=>{await db.exec(`set role ${role}`);try{return (await db.query(`select public.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;}finally{await db.exec('reset role');}};
 try{
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create table auth.mfa_factors(id uuid primary key,user_id uuid,status text,factor_type text,friendly_name text);
 create function auth.jwt() returns jsonb language sql as $$ select current_setting('request.jwt.claims',true)::jsonb $$;
 create function auth.uid() returns uuid language sql as $$ select (auth.jwt()->>'sub')::uuid $$;`);
 for(const file of ['001_borrow.sql','002_opening_loans.sql','003_abuse_controls.sql','004_borrowed_adjustment.sql','005_borrow_purpose.sql','006_public_rpc_security.sql','007_officer_session_security.sql','008_member_schedule.sql'])await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 await db.query('insert into auth.users values($1,$2)',[actor,'officer@example.test']);
 await db.query('insert into private.admins values($1)',[actor]);

 await db.query('insert into auth.sessions values($1,$2,null)',[sid,actor]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:actor,session_id:sid,aal:'aal1'})]);await db.exec('update private.settings set total=10');
 const args=['S1','Test','instagram','private-contact','a'.repeat(64),'personal_ride','2026-10-01T08:00:00Z','2026-10-01T09:00:00Z','2026-10-02T09:00:00Z','rental note\nsecond line','return note'];
 const a=await rpc('register',args);assert.ok(a.record,a.message);assert.equal(a.record.rentalNote,args[9]);assert.equal(a.record.scheduleConfirmedAt,null);assert.equal(a.record.contact,undefined);assert.equal(a.record.bikeNote,undefined);
 assert.equal((await rpc('register',args)).record.id,a.record.id);
 const changed=[...args];changed[9]='changed';assert.ok((await rpc('register',changed)).message);
 const bad=[...args];bad[8]=bad[7];assert.ok((await rpc('register',bad)).message);
 assert.equal(Number((await db.query("select attempts from private.public_rpc_budgets where bucket='register'")).rows[0].attempts),4);
 await assert.rejects(rpc('admin_confirm_schedule',[a.record.id]),/permission denied/);
 await assert.rejects(rpc('admin_action',[a.record.id,'lend',null],'authenticated'));
 const c=await rpc('admin_confirm_schedule',[a.record.id],'authenticated');assert.ok(c.record.scheduleConfirmedAt);
 assert.equal((await rpc('admin_confirm_schedule',[a.record.id],'authenticated')).record.scheduleConfirmedAt,c.record.scheduleConfirmedAt);
 assert.equal((await rpc('lookup',[args[4]])).record.scheduleConfirmedAt,c.record.scheduleConfirmedAt);
 assert.equal((await db.query("select count(*)::int n from private.audit where action='confirm-schedule'")).rows[0].n,1);
 assert.equal((await rpc('admin_action',[a.record.id,'lend',null],'authenticated')).record.status,'borrowed');
 const legacy=await rpc('register',['S2','Legacy','line','contact','b'.repeat(64)]);assert.equal(legacy.record.inspectionAt,null);
 await assert.rejects(rpc('admin_confirm_schedule',[legacy.record.id],'authenticated'));
 await db.exec('update private.opening_loans set outstanding=9');await assert.rejects(rpc('admin_action',[legacy.record.id,'lend',null],'authenticated'));
 await db.exec('delete from auth.sessions');await assert.rejects(rpc('admin_confirm_schedule',[a.record.id],'authenticated'),/session expired/);
 for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'private.register_core(text,text,text,text,text,text,text,text,text,text,text)','execute') allowed",[role])).rows[0].allowed,false);
 }finally{await db.close();}
});
