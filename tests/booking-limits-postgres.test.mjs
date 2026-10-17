import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {buildLifecycleRelease} from '../scripts/lifecycle-release.mjs';

const sql=file=>readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
const key=()=>randomBytes(32).toString('hex'),iso=ms=>new Date(Date.now()+ms).toISOString(),hour=3600000;

async function setup({install=true}={}){
 const db=new PGlite(),officer=randomUUID(),session=randomUUID();
 let queue=Promise.resolve();
 const as=(role,text,args)=>{const run=queue.then(async()=>{await db.exec(`set role ${role}`);try{return (await db.query(`select ${text} as value`,args)).rows[0].value;}finally{await db.exec('reset role');}});queue=run.catch(()=>{});return run;};
 const rpc=(action,payload={},token=null)=>as('anon','public.lifecycle($1,$2,$3::jsonb)',[action,token,JSON.stringify(payload)]);
 const admin=(action,payload={})=>as('authenticated','public.lifecycle_admin($1,$2::jsonb)',[action,JSON.stringify(payload)]);
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
  create table auth.users(id uuid primary key,email text);
  create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
  create table auth.mfa_factors(id uuid primary key,user_id uuid,status text,factor_type text,friendly_name text);
  create function auth.jwt() returns jsonb language sql as $$select current_setting('request.jwt.claims',true)::jsonb$$;
  create function auth.uid() returns uuid language sql as $$select (auth.jwt()->>'sub')::uuid$$;`);
 for(const file of readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(f=>/^00[1-8]_.*\.sql$/.test(f)).sort())await db.exec(sql(file));
 await db.exec(buildLifecycleRelease());
 for(const file of ['012_self_service_booking.sql','013_remove_pickup_instructions.sql','014_close_legacy_queue.sql','015_bike_rider_height.sql','016_photo_capacity_accounting.sql','017_google_drive_photos.sql'])await db.exec(sql(file));
 if(install)await db.exec(sql('018_two_bookings_terms_consent.sql'));
 await db.query('insert into auth.users values($1,$2)',[officer,'fixture@example.test']);
 await db.query('insert into private.admins values($1)',[officer]);await db.query('insert into auth.sessions values($1,$2,null)',[session,officer]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:officer,session_id:session,aal:'aal2'})]);
 const policy=(await admin('settings',{location:'QA office',terms:'QA terms'})).settings;
 const bikes=[];for(let i=1;i<=4;i++)bikes.push((await admin('asset',{code:`QA-L${i}`,name:`Synthetic ${i}`,kind:'bike',state:'available',reason:'synthetic'})).asset);
 const apply=async(student,bike,start,end,extra={})=>{const k=key();return {...await rpc('apply',{requestId:randomUUID(),studentId:student,name:`Rider ${student}`,assetIds:[bike.id],start:iso(start),end:iso(end),key:k,accepted:true,termsVersion:policy.termsVersion,...extra}),key:k};};
 return {db,rpc,admin,policy,bikes,apply};
}

test('018 requires accepting the current borrow terms on every booking and records it',async()=>{
 const {db,rpc,admin,policy,bikes,apply}=await setup();
 try{
  await assert.rejects(db.exec(sql('018_two_bookings_terms_consent.sql')),/already installed/);await db.exec('rollback');
  assert.equal((await rpc('calendar',{start:iso(0),end:iso(24*hour)})).settings.bookingConsent,true);
  const {accepted,termsVersion,...bare}={requestId:randomUUID(),studentId:'C1',name:'Rider C1',assetIds:[bikes[0].id],start:iso(hour),end:iso(2*hour),key:key(),accepted:true,termsVersion:policy.termsVersion};
  assert.match((await rpc('apply',bare)).message,/Invalid application/);
  assert.match((await apply('C1',bikes[0],hour,2*hour,{accepted:false})).message,/terms must be accepted/);
  assert.match((await apply('C1',bikes[0],hour,2*hour,{termsVersion:'0'.repeat(64)})).message,/terms changed/);
  const booked=(await apply('C1',bikes[0],hour,2*hour)).reservation;
  assert.equal(booked.consent.termsVersion,policy.termsVersion);assert.ok(Date.parse(booked.consent.acceptedAt));
  assert.equal((await admin('list')).reservations.find(r=>r.id===booked.id).consent.termsVersion,policy.termsVersion);
  // Officers publish new terms: a page still holding the old version must reread them.
  const next=(await admin('settings',{location:'QA office',terms:'QA terms v2'})).settings;
  assert.match((await apply('C2',bikes[1],hour,2*hour)).message,/terms changed/);
  assert.ok((await apply('C2',bikes[1],hour,2*hour,{termsVersion:next.termsVersion})).reservation);
 }finally{await db.close();}
});

test('018 lets a student hold two non-overlapping bookings, and frees a slot when one is cancelled',async()=>{
 const {db,rpc,admin,policy,bikes,apply}=await setup();
 try{
  const first=(await apply('T1',bikes[0],hour,3*hour)).reservation;
  assert.match((await apply('T1',bikes[1],2*hour,4*hour)).message,/reservation in this time/,'own bookings may not overlap, even on another bike');
  const second=await apply('T1',bikes[1],3*hour,5*hour);
  assert.ok(second.reservation,'back-to-back is not an overlap');
  assert.match((await apply('t1',bikes[2],6*hour,7*hour)).message,/two active reservations/,'student IDs compare case-insensitively');
  assert.ok((await apply('T2',bikes[2],2*hour,4*hour)).reservation,'another student is unaffected');
  assert.equal((await rpc('cancel',{requestId:randomUUID(),reservationId:second.reservation.id,reason:'Plans changed'},second.key)).reservation.status,'cancelled');
  assert.ok((await apply('T1',bikes[0],6*hour,7*hour)).reservation,'a cancelled booking frees its slot; the same bike is fine when times do not overlap');
  // Fixture: the first bike goes out. A bike in hand still counts toward the two.
  await db.query("update private.lifecycle_reservations set status='in_use',picked_up_at=now() where id=$1",[first.id]);
  assert.match((await apply('T1',bikes[3],8*hour,9*hour)).message,/two active reservations/);
  // Member-token reservations share the same window.
  const token=key();
  await admin('member',{studentId:'M1',name:'Member one',contact:'ig',validUntil:iso(9*24*hour),active:true,token,reason:'Verified'});
  const reserve=(bike,start,end,extra={})=>rpc('reserve',{requestId:randomUUID(),assetIds:[bike.id],start:iso(start),end:iso(end),accepted:true,termsVersion:policy.termsVersion,...extra},token);
  assert.match((await reserve(bikes[3],hour,2*hour,{accepted:false})).message,/terms must be accepted/);
  assert.equal((await reserve(bikes[3],hour,2*hour)).reservation.consent.termsVersion,policy.termsVersion);
  assert.match((await reserve(bikes[2],90*60000,3*hour)).message,/reservation in this time/);
  assert.ok((await reserve(bikes[3],10*hour,11*hour)).reservation);
  assert.match((await reserve(bikes[3],12*hour,13*hour)).message,/two active reservations/);
 }finally{await db.close();}
});

test('018 refuses to install before 017 and keeps earlier bookings readable',async()=>{
 const {db,rpc,admin,bikes}=await setup({install:false});
 try{
  const old=(await rpc('apply',{requestId:randomUUID(),studentId:'OLD',name:'Rider OLD',assetIds:[bikes[0].id],start:iso(hour),end:iso(2*hour),key:key()})).reservation;
  assert.ok(old,'pre-018 pages apply without consent');
  await db.exec(sql('018_two_bookings_terms_consent.sql'));
  const listed=(await admin('list')).reservations.find(r=>r.id===old.id);
  assert.equal(listed.consent,null);assert.equal(listed.status,'reserved');
  const bare=new PGlite();
  try{await assert.rejects(bare.exec(sql('018_two_bookings_terms_consent.sql')),/Apply 017 before 018|does not exist/);}finally{await bare.close();}
 }finally{await db.close();}
});
