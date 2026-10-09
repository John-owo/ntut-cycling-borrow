import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const migrations=['001_borrow.sql','002_opening_loans.sql','003_abuse_controls.sql','004_borrowed_adjustment.sql','005_borrow_purpose.sql','006_public_rpc_security.sql','007_officer_session_security.sql','008_member_schedule.sql','009_reservation_lifecycle.sql'];
const officer='00000000-0000-4000-8000-000000000001';
const outsider='00000000-0000-4000-8000-000000000003';
const session='00000000-0000-4000-8000-000000000002';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const token=n=>String(n).repeat(64);
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
 for(const file of migrations) await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 await db.query('insert into auth.users values($1,$2),($3,$4)',[officer,'officer@example.test',outsider,'outsider@example.test']);
 await db.query('insert into private.admins values($1)',[officer]);
 await db.query('insert into auth.sessions values($1,$2,null)',[session,officer]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:officer,session_id:session,aal:'aal1'})]);
 await db.exec('update private.settings set total=10');
 const rpc=async(action,payload={},t=null,role='anon')=>{
  await db.exec(`set role ${role}`);
  try{return (await db.query('select public.lifecycle($1,$2,$3::jsonb) r',[action,t,JSON.stringify(payload)])).rows[0].r;}
  finally{await db.exec('reset role');}
 };
 const admin=async(action,payload={},id=officer)=>{
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,session_id:session,aal:'aal1'})]);
  await db.exec('set role authenticated');
  try{return (await db.query('select public.lifecycle_admin($1,$2::jsonb) r',[action,JSON.stringify(payload)])).rows[0].r;}
  finally{await db.exec('reset role');}
 };
 return {db,rpc,admin};
}

test('009 lifecycle migrations, private grants, booking and return evidence',async()=>{
 const {db,rpc,admin}=await setup();
 try {
  assert.equal((await db.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname like 'lifecycle_%' and c.relkind='r' and c.relrowsecurity")).rows[0].n,11);
  for(const role of ['anon','authenticated']) for(const table of ['lifecycle_members','lifecycle_photos','lifecycle_signatures','lifecycle_requests'])
   assert.equal((await db.query('select has_table_privilege($1,$2,$3) p',[role,`private.${table}`,'SELECT'])).rows[0].p,false);
  for(const role of ['anon','authenticated']) assert.equal((await db.query("select has_function_privilege($1,'private.lifecycle_member_core(text,text,jsonb)','execute') p",[role])).rows[0].p,false);
  await db.query("select set_config('request.method','GET',false)");
  assert.equal((await rpc('calendar',{start:iso(0),end:iso(86400000)})).message,'POST required');
  await db.query("select set_config('request.method','POST',false)");
  await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({prefer:'tx=rollback'})]);
  assert.equal((await rpc('calendar',{start:iso(0),end:iso(86400000)})).message,'Rollback mode unsupported');
  await db.query("select set_config('request.headers','',false)");
  assert.equal((await rpc('calendar',{start:iso(0),end:iso(86400000)})).bookings.length,0);
  assert.equal((await rpc('me',{},token(1))).message,'Invalid member token');
  assert.equal((await admin('list',{},outsider).catch(e=>e.message)).includes('permission'),true);
  const setting=await admin('settings',{location:'Club office',instructions:'Bring student ID',terms:'Test borrow rules'});
  assert.equal(setting.settings.termsVersion.length,64);
  const bike=(await admin('asset',{code:'B-001',name:'Bike one',kind:'bike',state:'available',reason:'Inventory verified'})).asset;
  const accessory=(await admin('asset',{code:'H-001',name:'Helmet one',kind:'accessory',state:'available',reason:'Inventory verified'})).asset;
  const member=(await admin('member',{studentId:'TEST001',name:'Rider',contact:'test contact',validUntil:iso(10*86400000),active:true,token:token(1),reason:'Identity checked'})).member;
  assert.equal(member.token,undefined);
  const start=iso(3000),end=iso(3600000);
  const booking={requestId:uuid(10),assetIds:[bike.id,accessory.id],start,end};
  const reserved=await rpc('reserve',booking,token(1));
  assert.equal(reserved.reservation.status,'reserved',JSON.stringify(reserved));
  assert.equal((await rpc('reserve',booking,token(1))).reservation.id,reserved.reservation.id);
  assert.match((await rpc('reserve',{...booking,end:iso(7200000)},token(1))).message,/Request ID reused/);
  assert.equal((await rpc('calendar',{start:iso(0),end:iso(86400000)})).bookings.length,1);
  assert.equal((await rpc('me',{},token(1))).reservations.length,1);
  await new Promise(resolve=>setTimeout(resolve,3100));
  for(const slot of ['left','right','drivetrain','damage']) {const uploaded=await rpc('photo',{requestId:uuid(20+['left','right','drivetrain','damage'].indexOf(slot)),reservationId:reserved.reservation.id,assetId:bike.id,phase:'pickup',slot,mime:'image/png',data:photo},token(1));assert.ok(uploaded.photo?.id,JSON.stringify(uploaded));}
  assert.equal((await rpc('pickup',{requestId:uuid(30),reservationId:reserved.reservation.id,checks,notes:'Ready',signature:{name:'Rider',accepted:true,termsVersion:setting.settings.termsVersion,image:signature}},token(1))).reservation.status,'in_use');
  assert.equal((await rpc('photo_read',{id:(await rpc('me',{},token(1))).reservations[0].photos[0].id},token(1))).photo.data,photo);
  for(const slot of ['left','right','drivetrain','damage']) assert.ok((await rpc('photo',{requestId:uuid(40+['left','right','drivetrain','damage'].indexOf(slot)),reservationId:reserved.reservation.id,assetId:bike.id,phase:'return',slot,mime:'image/png',data:photo},token(1))).photo?.id);
  const back=await rpc('return',{requestId:uuid(50),reservationId:reserved.reservation.id,checks,notes:'All complete',abnormal:false},token(1));
  assert.equal(back.reservation.status,'returned');assert.equal(back.reservation.photos.length,8);
  assert.equal(back.reservation.inspections.length,2);
  assert.equal(back.reservation.signature.terms,'Test borrow rules');
  const dump=await admin('export');assert.equal(dump.photos.length,8);assert.equal(dump.members[0].token_hash.length,64);
  assert.equal((await db.query('select count(*)::int n from private.lifecycle_events where action=$1',['export'])).rows[0].n,1);
 }finally{await db.close();}
});

test('009 rejects overlap and bypasses; abnormal return quarantines original evidence',async()=>{
 const {db,rpc,admin}=await setup();
 try {
  const b1=(await admin('asset',{code:'B-1',name:'Road bike',kind:'bike',state:'available',reason:'Counted'})).asset;
  const b2=(await admin('asset',{code:'B-2',name:'Hybrid bike',kind:'bike',state:'available',reason:'Counted'})).asset;
  const kit=(await admin('asset',{code:'K-1',name:'Light set',kind:'accessory',state:'available',reason:'Counted'})).asset;
  for(let i=1;i<=3;i++) await admin('member',{studentId:`R${i}`,name:`Rider ${i}`,contact:'test-only',validUntil:iso(7*86400000),active:true,token:token(i),reason:'Verified'});
  const start=iso(2000),end=iso(3600000);
  const req={requestId:uuid(100),assetIds:[b1.id,kit.id],start,end};
  assert.match((await rpc('reserve',req,token(1))).message,/policy incomplete/);
  const setting=await admin('settings',{location:'Office',instructions:'Bring ID\nCheck bike',terms:'Rule A\nRule B'});
  assert.equal(setting.settings.instructions.includes('\n'),true);
  const one=(await rpc('reserve',req,token(1))).reservation;
  assert.equal(JSON.stringify(await rpc('calendar',{start:iso(0),end:iso(86400000)})).includes('studentId'),false);
  assert.match((await rpc('reserve',{requestId:uuid(101),assetIds:[b1.id],start,end},token(2))).message,/conflict/i);
  assert.match((await rpc('reserve',{requestId:uuid(102),assetIds:[b2.id,kit.id],start,end},token(2))).message,/conflict/i);
  assert.match((await rpc('reserve',{requestId:uuid(103),assetIds:[b1.id,b1.id],start,end},token(2))).message,/Duplicate/);
  const adjacent=(await rpc('reserve',{requestId:uuid(104),assetIds:[b1.id],start:end,end:iso(7200000)},token(2))).reservation;
  assert.equal(adjacent.status,'reserved');
  assert.match((await rpc('photo_read',{id:uuid(999)},token(2))).message,/not found/i);
  await new Promise(resolve=>setTimeout(resolve,2100));
  assert.match((await rpc('photo',{requestId:uuid(106),reservationId:one.id,assetId:b2.id,phase:'pickup',slot:'left',mime:'image/png',data:photo},token(1))).message,/assigned bike/);
  assert.match((await rpc('photo',{requestId:uuid(107),reservationId:one.id,assetId:b1.id,phase:'return',slot:'left',mime:'image/png',data:photo},token(1))).message,/phase/);
  assert.match((await rpc('photo',{requestId:uuid(108),reservationId:one.id,assetId:b1.id,phase:'pickup',slot:'left',mime:'image/jpeg',data:photo},token(1))).message,/signature mismatch/);
  assert.match((await rpc('pickup',{requestId:uuid(105),reservationId:one.id,checks,notes:'',signature:{name:'Rider 1',accepted:true,termsVersion:setting.settings.termsVersion,image:signature}},token(1))).message,/incomplete/i);
  for(const [index,slot] of ['left','right','drivetrain','damage'].entries()){
   const result=await rpc('photo',{requestId:uuid(110+index),reservationId:one.id,assetId:b1.id,phase:'pickup',slot,mime:'image/png',data:photo},token(1));
   assert.ok(result.photo?.id,JSON.stringify(result));
  }
  for(let i=0;i<8;i++) assert.ok((await rpc('photo',{requestId:uuid(150+i),reservationId:one.id,assetId:b1.id,phase:'pickup',slot:'damage',mime:'image/png',data:photo},token(1))).photo?.id);
  assert.match((await rpc('photo',{requestId:uuid(159),reservationId:one.id,assetId:b1.id,phase:'pickup',slot:'damage',mime:'image/png',data:photo},token(1))).message,/Photo limit/);
  assert.match((await rpc('pickup',{requestId:uuid(105),reservationId:one.id,checks:{...checks,brakes:false},notes:'',signature:{name:'Rider 1',accepted:true,termsVersion:setting.settings.termsVersion,image:signature}},token(1))).message,/incomplete/i);
  assert.match((await rpc('pickup',{requestId:uuid(105),reservationId:one.id,checks,notes:'',signature:{name:'Rider 1',accepted:true,termsVersion:'wrong',image:signature}},token(1))).message,/mismatch/i);
  const member=(await admin('list')).members.find(m=>m.studentId==='R1');
  await assert.rejects(admin('member',{id:member.id,studentId:'R1',name:'Someone else',contact:'test-only',validUntil:iso(7*86400000),active:true,reason:'Attempted change'}),/identity cannot change/);
  await admin('member',{id:member.id,studentId:'R1',name:'Rider 1',contact:'test-only',validUntil:iso(1000),active:true,reason:'Shorten expiry'});
  assert.match((await rpc('pickup',{requestId:uuid(105),reservationId:one.id,checks,notes:'',signature:{name:'Rider 1',accepted:true,termsVersion:setting.settings.termsVersion,image:signature}},token(1))).message,/Membership inactive/);
  await admin('member',{id:member.id,studentId:'R1',name:'Rider 1',contact:'test-only',validUntil:iso(7*86400000),active:true,reason:'Verified extension'});
  const picked=await rpc('pickup',{requestId:uuid(105),reservationId:one.id,checks,notes:'既有車況'.repeat(150),signature:{name:'Rider 1',accepted:true,termsVersion:setting.settings.termsVersion,image:signature}},token(1));
  assert.equal(picked.reservation.status,'in_use');
  assert.match((await rpc('return',{requestId:uuid(120),reservationId:one.id,checks,notes:'',abnormal:false},token(1))).message,/incomplete/i);
  const originalId=picked.reservation.photos[0].id;
  assert.match((await rpc('photo_read',{id:originalId},token(2))).message,/not found/i);
  await assert.rejects(db.query('delete from private.lifecycle_photos where id=$1',[originalId]),/immutable/i);
  for(const [index,slot] of ['left','right','drivetrain','damage'].entries()){
   const result=await rpc('photo',{requestId:uuid(130+index),reservationId:one.id,assetId:b1.id,phase:'return',slot,mime:'image/png',data:photo},token(1));
   assert.ok(result.photo?.id,JSON.stringify(result));
  }
  const bad={requestId:uuid(120),reservationId:one.id,checks:{...checks,tires:false},notes:'Tire damage',abnormal:false};
  const returned=await rpc('return',bad,token(1));
  assert.equal(returned.reservation.status,'inspection');
  assert.equal(returned.reservation.inspections[1].abnormal,true);
  assert.equal((await rpc('return',bad,token(1))).reservation.id,one.id);
  assert.match((await rpc('return',{...bad,notes:'changed'},token(1))).message,/reused/i);
  const listing=await admin('list');
  assert.equal(listing.assets.find(a=>a.id===b1.id).state,'inspection');
  assert.equal(listing.assets.find(a=>a.id===kit.id).state,'inspection');
  assert.equal(listing.notifications.length,1);
  assert.match((await rpc('reserve',{requestId:uuid(160),assetIds:[b2.id],start:iso(60000),end:iso(3600000)},token(1))).message,/active reservation/);
  await assert.rejects(admin('asset',{id:b1.id,code:'B-1',name:'Road bike',kind:'bike',state:'available',reason:'Unreviewed'}),/Resolve active loan first/);
  await assert.rejects(admin('resolve',{requestId:uuid(140),reservationId:one.id,reason:'Repair needed',state:'maintenance'}),/Cancel bookings/);
  assert.equal((await admin('cancel',{requestId:uuid(141),reservationId:adjacent.id,reason:'Damage review'})).reservation.status,'cancelled');
  const resolved=await admin('resolve',{requestId:uuid(140),reservationId:one.id,reason:'Repair needed',state:'maintenance'});
  assert.equal(resolved.reservation.status,'returned');
  assert.equal((await admin('list')).notifications[0].resolvedBy,officer);
  assert.equal((await admin('photo_read',{id:originalId})).photo.data,photo);
 }finally{await db.close();}
});

test('009 reserves mandatory return photo capacity and permits first fleet activation',async()=>{
 const {db,rpc,admin}=await setup();
 try{
  const seeded=(await admin('asset',{code:'COUNTED',name:'Pending count',kind:'bike',state:'inspection',reason:'Initial inventory'})).asset;
  assert.equal((await admin('asset',{id:seeded.id,code:seeded.code,name:seeded.name,kind:'bike',state:'available',reason:'Physically verified'})).asset.state,'available');
  await admin('settings',{location:'QA office',instructions:'QA pickup',terms:'QA terms'});
  for(let i=1;i<=4;i++)await admin('member',{studentId:`CAP${i}`,name:`Capacity ${i}`,contact:'synthetic',validUntil:iso(7*86400000),active:true,token:token(i),reason:'QA'});
  const booked=[];
  for(let i=1;i<=3;i++)booked.push((await rpc('reserve',{requestId:uuid(200+i),assetIds:[seeded.id],start:iso(i*3600000),end:iso((i+1)*3600000-1000)},token(i))).reservation);
  assert.equal((await admin('list')).storage.reservedBytes,192*1024*1024);
  assert.match((await rpc('reserve',{requestId:uuid(204),assetIds:[seeded.id],start:iso(5*3600000),end:iso(6*3600000)},token(4))).message,/capacity reserved/);
  for(let i=1;i<=2;i++)await rpc('cancel',{requestId:uuid(210+i),reservationId:booked[i].id,reason:'QA cancellation'},token(i+1));
  // Capacity-only fixtures use tiny bytes and realistic size accounting; they
  // never represent actual uploaded evidence or touch a production database.
  const history=uuid(220);
  await db.query("insert into private.lifecycle_reservations(id,member_id,borrower,starts_at,ends_at,status) select $1,member_id,borrower,starts_at,ends_at,'cancelled' from private.lifecycle_reservations where id=$2",[history,booked[0].id]);
  for(let i=0;i<16;i++)await db.query("insert into private.lifecycle_photos(id,reservation_id,asset_id,phase,slot,mime,bytes,size,sha256) values($1,$2,$3,'pickup','left','image/png',$4,8388608,'fixture')",[uuid(230+i),history,seeded.id,Buffer.from(photo,'base64')]);
  await db.query('update private.lifecycle_reservations set starts_at=now()-interval \'1 minute\' where id=$1',[booked[0].id]);
  const payload={reservationId:booked[0].id,assetId:seeded.id,phase:'pickup',slot:'left',mime:'image/png',data:photo};
  assert.ok((await rpc('photo',{...payload,requestId:uuid(250)},token(1))).photo);
  const gap=8388608-Buffer.from(photo,'base64').length;
  await db.query("insert into private.lifecycle_photos(id,reservation_id,asset_id,phase,slot,mime,bytes,size,sha256) values($1,$2,$3,'pickup','left','image/png',$4,$5,'fixture')",[uuid(251),history,seeded.id,Buffer.from(photo,'base64'),gap]);
  assert.match((await rpc('photo',{...payload,requestId:uuid(252)},token(1))).message,/mandatory return photos/);
  for(const [i,slot]of ['right','drivetrain','damage'].entries())assert.ok((await rpc('photo',{...payload,slot,requestId:uuid(253+i)},token(1))).photo);
  const storage=(await admin('list')).storage;
  assert.equal(storage.reservedBytes,32*1024*1024);
  assert.ok(storage.usedBytes+storage.reservedBytes<=storage.budgetBytes);
 }finally{await db.close();}
});
