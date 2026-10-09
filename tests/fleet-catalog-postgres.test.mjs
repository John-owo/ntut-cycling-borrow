import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const files=['001_borrow.sql','002_opening_loans.sql','003_abuse_controls.sql','004_borrowed_adjustment.sql','005_borrow_purpose.sql','006_public_rpc_security.sql','007_officer_session_security.sql','008_member_schedule.sql','009_reservation_lifecycle.sql','010_lifecycle_legacy_inventory.sql'];
const sql=file=>readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');

test('011 seeds only confirmed inspection bikes and preserves legacy inventory',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;
   create table auth.users(id uuid primary key,email text);
   create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
   create table auth.mfa_factors(id uuid primary key,user_id uuid,status text,factor_type text,friendly_name text);
   create function auth.jwt() returns jsonb language sql as $$ select current_setting('request.jwt.claims',true)::jsonb $$;
   create function auth.uid() returns uuid language sql as $$ select (auth.jwt()->>'sub')::uuid $$;`);
  for(const file of files) await db.exec(sql(file));
  await db.exec('update private.settings set total=7');
  await db.exec(sql('011_confirmed_fleet_catalog.sql'));
  const first=(await db.query('select id,code,name,kind,state from private.lifecycle_assets order by code')).rows;
  assert.deepEqual(first.map(a=>a.code),['1','2','3','4','5','6','7','8']);
  assert.deepEqual(first.map(a=>a.name),['亞士曼','普利碼','defy','scr','KHS','TCR','HASA','平把登山車']);
  assert.ok(first.every(a=>a.kind==='bike'&&a.state==='inspection'));
  assert.equal((await db.query('select total from private.settings where id=1')).rows[0].total,7);
  assert.equal((await db.query('select outstanding from private.opening_loans where id=1')).rows[0].outstanding,0);
  assert.equal((await db.query('select count(*)::int n from private.lifecycle_reservations')).rows[0].n,0);
  await db.exec(sql('011_confirmed_fleet_catalog.sql'));
  assert.deepEqual((await db.query('select id,code,name,kind,state from private.lifecycle_assets order by code')).rows,first);
  await db.exec("update private.lifecycle_assets set name='Disputed label' where code='1'");
  await assert.rejects(db.exec(sql('011_confirmed_fleet_catalog.sql')),/already has different data/);
  await db.exec('rollback');
  assert.equal((await db.query("select name from private.lifecycle_assets where code='1'")).rows[0].name,'Disputed label');
  assert.equal((await db.query('select total from private.settings where id=1')).rows[0].total,7);
 }finally{await db.close();}
});
