import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('Officer security checks live session, allowlist and MFA on every privileged call',async()=>{
 const db=new PGlite();
 const actor='00000000-0000-4000-8000-000000000001',sid='00000000-0000-4000-8000-000000000002';
 const authenticated=async(sql)=>{await db.exec('set role authenticated');try{return await db.query(sql);}finally{await db.exec('reset role');}};
 const status=async()=>(await authenticated('select public.admin_session_status() as s')).rows[0].s;
 const admin=()=>authenticated('select public.admin_records()');
 const claim=async(aal='aal1',session=sid)=>db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:actor,session_id:session,aal})]);
 try{
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create table auth.mfa_factors(id uuid primary key,user_id uuid,status text,factor_type text,friendly_name text);
 create function auth.jwt() returns jsonb language sql as $$ select current_setting('request.jwt.claims',true)::jsonb $$;
 create function auth.uid() returns uuid language sql as $$ select (auth.jwt()->>'sub')::uuid $$;`);
 for(const file of ['001_borrow.sql','002_opening_loans.sql','003_abuse_controls.sql','004_borrowed_adjustment.sql','005_borrow_purpose.sql','006_public_rpc_security.sql','007_officer_session_security.sql'])await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 await db.query('insert into auth.users values($1,$2)',[actor,'officer@example.test']);
 await db.query('insert into private.admins values($1)',[actor]);
 await assert.rejects(authenticated('select private.require_officer_session()'),/permission denied/);
 await assert.rejects(authenticated('select private.require_admin()'),/permission denied/);
 for(const role of ['anon','authenticated']){
  const grants=(await db.query("select has_function_privilege($1,'private.require_officer_session()','EXECUTE') as helper, has_function_privilege($1,'private.require_admin()','EXECUTE') as admin",[role])).rows[0];
  assert.deepEqual(grants,{helper:false,admin:false});
 }
 await claim();await assert.rejects(admin(),/session expired/);
 await db.query('insert into auth.sessions values($1,$2,null)',[sid,actor]);
 await admin();assert.deepEqual(await status(),{enrolled:false,required:false,factors:[]});
 await db.query("insert into auth.mfa_factors values($1,$2,'unverified','totp','Test')",['00000000-0000-4000-8000-000000000003',actor]);
 await admin();await db.exec("update auth.mfa_factors set status='verified'");
 assert.equal((await status()).required,true);await assert.rejects(admin(),/MFA_REQUIRED/);
 await claim('aal2');await admin();assert.equal((await status()).required,false);
 await db.exec("update auth.sessions set not_after=now()-interval '1 minute'");await assert.rejects(admin(),/session expired/);
 await db.exec('update auth.sessions set not_after=null');await claim('aal2',null);await assert.rejects(admin(),/session expired/);
 await claim('aal2');await db.exec('delete from auth.sessions');await assert.rejects(admin(),/session expired/);
 await db.query('insert into auth.sessions values($1,$2,null)',[sid,actor]);await db.exec('delete from private.admins');await assert.rejects(status(),/Officer permission/);
 await db.exec('set role anon');await assert.rejects(db.query('select public.admin_session_status()'),/permission denied/);
 }finally{await db.close();}
});
