import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

const files=['001_borrow.sql','002_opening_loans.sql','003_abuse_controls.sql','004_borrowed_adjustment.sql','005_borrow_purpose.sql','006_public_rpc_security.sql','007_officer_session_security.sql','008_member_schedule.sql','009_reservation_lifecycle.sql','010_lifecycle_legacy_inventory.sql'];
const sql=file=>readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
const officer='00000000-0000-4000-8000-000000000001',session='00000000-0000-4000-8000-000000000002';
let seq=0;const uuid=()=>`00000000-0000-4000-8000-${String(++seq).padStart(12,'0')}`;
const key=()=>randomBytes(32).toString('hex');
const photo=Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000280806000000','hex').toString('base64');
const signature='data:image/png;base64,'+Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000280806000000','hex'),Buffer.alloc(150,1)]).toString('base64');
const checks={frame:true,tires:true,brakes:true,gears:true,accessories:true};
const iso=ms=>new Date(Date.now()+ms).toISOString();

async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
  create table auth.users(id uuid primary key,email text);
  create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
  create table auth.mfa_factors(id uuid primary key,user_id uuid,status text,factor_type text,friendly_name text);
  create function auth.jwt() returns jsonb language sql as $$ select current_setting('request.jwt.claims',true)::jsonb $$;
  create function auth.uid() returns uuid language sql as $$ select (auth.jwt()->>'sub')::uuid $$;`);
 for(const file of files) await db.exec(sql(file));
 await db.exec('update private.settings set total=10');
 await db.exec(sql('011_confirmed_fleet_catalog.sql'));
 await db.query('insert into auth.users values($1,$2)',[officer,'officer@example.test']);
 await db.query('insert into private.admins values($1)',[officer]);
 await db.query('insert into auth.sessions values($1,$2,null)',[session,officer]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:officer,session_id:session,aal:'aal1'})]);
 const rpc=async(action,payload={},t=null)=>{await db.exec('set role anon');try{return (await db.query('select public.lifecycle($1,$2,$3::jsonb) r',[action,t,JSON.stringify(payload)])).rows[0].r;}finally{await db.exec('reset role');}};
 const admin=async(action,payload={})=>{await db.exec('set role authenticated');try{return (await db.query('select public.lifecycle_admin($1,$2::jsonb) r',[action,JSON.stringify(payload)])).rows[0].r;}finally{await db.exec('reset role');}};
 return {db,rpc,admin};
}

test('012 installs once, keeps prior bookings approved and credentials working',async()=>{
 const {db,rpc,admin}=await setup();
 try{
  const policy=(await admin('settings',{location:'Office',instructions:'Bring ID',terms:'Rules'})).settings;
  const bike=(await admin('asset',{code:'B-1',name:'Bike',kind:'bike',state:'available',reason:'Counted'})).asset;
  const old=key();
  await admin('member',{studentId:'OLD1',name:'Old rider',contact:'x',validUntil:iso(9*86400000),active:true,token:old,reason:'Verified'});
  const before=(await rpc('reserve',{requestId:uuid(),assetIds:[bike.id],start:iso(2000),end:iso(3600000)},old)).reservation;
  await db.exec(sql('012_self_service_booking.sql'));
  await assert.rejects(db.exec(sql('012_self_service_booking.sql')),/already installed/);await db.exec('rollback');
  const mine=(await rpc('me',{},old)).reservations[0];
  assert.equal(mine.id,before.id);assert.equal(mine.approval,'approved');assert.equal(mine.selfService,false);
  for(const role of ['anon','authenticated']) assert.equal((await db.query("select has_function_privilege($1,'private.lifecycle_apply_core(jsonb)','execute') p",[role])).rows[0].p,false);
  assert.equal((await db.query("select has_table_privilege('anon','private.lifecycle_reservations','SELECT') p")).rows[0].p,false);
  await new Promise(r=>setTimeout(r,2100));
  for(const slot of ['left','right','drivetrain','damage']) assert.ok((await rpc('photo',{requestId:uuid(),reservationId:before.id,assetId:bike.id,phase:'pickup',slot,mime:'image/png',data:photo},old)).photo?.id);
  assert.equal((await rpc('pickup',{requestId:uuid(),reservationId:before.id,checks,notes:'',signature:{name:'Old rider',accepted:true,termsVersion:policy.termsVersion,image:signature}},old)).reservation.status,'in_use');
 }finally{await db.close();}
});

test('012 self-service application, officer approval, scoped key and reissue',async()=>{
 const {db,rpc,admin}=await setup();
 try{
  await db.exec(sql('012_self_service_booking.sql'));
  const k=key(),k2=key();
  const bike=(await admin('asset',{code:'B-1',name:'Bike',kind:'bike',state:'available',reason:'Counted'})).asset;
  const bike2=(await admin('asset',{code:'B-2',name:'Bike two',kind:'bike',state:'available',reason:'Counted'})).asset;
  const apply={requestId:uuid(),studentId:'t100',name:'Self rider',assetIds:[bike.id],start:iso(2000),end:iso(3600000),key:k};
  assert.match((await rpc('apply',apply)).message,/policy incomplete/);
  const policy=(await admin('settings',{location:'Office',instructions:'Bring ID',terms:'Rules'})).settings;
  const applied=await rpc('apply',{...apply,requestId:uuid()});
  const booking=applied.reservation;
  assert.equal(booking.approval,'pending',JSON.stringify(applied));assert.equal(booking.selfService,true);
  assert.deepEqual(booking.borrower,{studentId:'T100',name:'Self rider',contact:''});
  assert.equal(JSON.stringify(applied).includes(k),false);
  assert.equal((await db.query("select count(*)::int n from private.lifecycle_requests where actor_type='applicant'")).rows[0].n,1);
  assert.match((await rpc('apply',{...apply,requestId:uuid(),key:k2})).message,/conflict|already|active/i);
  assert.match((await rpc('apply',{...apply,requestId:uuid(),assetIds:[bike2.id],key:k2})).message,/active reservation/);
  assert.match((await rpc('apply',{...apply,requestId:uuid(),studentId:'bad id',key:k2,assetIds:[bike2.id]})).message,/Invalid student/);
  const cal=await rpc('calendar',{start:iso(0),end:iso(86400000)});
  assert.equal(cal.bookings[0].pending,true);assert.equal(JSON.stringify(cal).includes('Self rider'),false);
  assert.equal((await rpc('me',{},k)).reservations.length,1);
  assert.match((await rpc('reserve',{requestId:uuid(),assetIds:[bike2.id],start:iso(7200000),end:iso(9000000)},k)).message,/booking form/);
  await new Promise(r=>setTimeout(r,2100));
  const shot=slot=>({requestId:uuid(),reservationId:booking.id,assetId:bike.id,phase:'pickup',slot,mime:'image/png',data:photo});
  assert.match((await rpc('photo',shot('left'),k)).message,/approval/);
  assert.equal((await admin('list')).reservations.find(r=>r.id===booking.id).approval,'pending');
  assert.equal((await admin('approve',{requestId:uuid(),reservationId:booking.id})).reservation.approval,'approved');
  assert.match(await admin('approve',{requestId:uuid(),reservationId:booking.id}).catch(e=>e.message),/does not need approval/);
  for(const slot of ['left','right','drivetrain','damage']) assert.ok((await rpc('photo',shot(slot),k)).photo?.id);
  const sign={requestId:uuid(),reservationId:booking.id,checks,notes:'',signature:{name:'Someone else',accepted:true,termsVersion:policy.termsVersion,image:signature}};
  assert.match((await rpc('pickup',sign,k)).message,/mismatch/);
  assert.equal((await rpc('pickup',{...sign,requestId:uuid(),signature:{...sign.signature,name:'Self rider'}},k)).reservation.status,'in_use');
  const k3=key();
  assert.equal((await admin('access',{requestId:uuid(),reservationId:booking.id,key:k3})).reservation.id,booking.id);
  assert.match((await rpc('me',{},k)).message,/Invalid member token/);
  const photos=(await rpc('me',{},k3)).reservations[0].photos;
  assert.equal((await rpc('photo_read',{id:photos[0].id},k3)).photo.data,photo);
  const other=key();
  assert.ok((await rpc('apply',{requestId:uuid(),studentId:'T200',name:'Other',assetIds:[bike2.id],start:iso(7200000),end:iso(9000000),key:other})).reservation);
  assert.match((await rpc('photo_read',{id:photos[0].id},other)).message,/not found/i);
  assert.match((await rpc('return',{requestId:uuid(),reservationId:booking.id,checks,notes:'',abnormal:false},other)).message,/not found/i);
  for(const slot of ['left','right','drivetrain','damage']) assert.ok((await rpc('photo',{...shot(slot),requestId:uuid(),phase:'return'},k3)).photo?.id);
  assert.equal((await rpc('return',{requestId:uuid(),reservationId:booking.id,checks,notes:'',abnormal:false},k3)).reservation.status,'returned');
  assert.match(await admin('access',{requestId:uuid(),reservationId:booking.id,key:key()}).catch(e=>e.message),/Only active/);
  const member=(await admin('list')).members.find(m=>m.studentId==='T100');
  await admin('member',{id:member.id,studentId:'T100',name:'Self rider',contact:'ig',validUntil:member.validUntil,active:false,reason:'Blocked'});
  assert.match((await rpc('apply',{requestId:uuid(),studentId:'T100',name:'Self rider',assetIds:[bike.id],start:iso(9000000),end:iso(9900000),key:key()})).message,/Membership inactive/);
  const dump=await admin('export');assert.equal(JSON.stringify(dump).includes(k3),false);
 }finally{await db.close();}
});
