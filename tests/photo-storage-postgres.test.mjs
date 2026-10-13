import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {buildLifecycleRelease} from '../scripts/lifecycle-release.mjs';
import {createPhotoHandler} from '../supabase/functions/lifecycle-photo/handler.js';

const sql=file=>readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
const MiB=1024*1024,key=()=>randomBytes(32).toString('hex'),iso=ms=>new Date(Date.now()+ms).toISOString();
const png=Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000280806000000','hex');
const signature='data:image/png;base64,'+Buffer.concat([png,Buffer.alloc(150,1)]).toString('base64');
const checks={frame:true,tires:true,brakes:true,gears:true,accessories:true};
const slots=['left','right','drivetrain','damage'];

async function setup(){
 const db=new PGlite(),officer=randomUUID(),session=randomUUID();
 // One connection: serialize so concurrent calls never run under another call's role.
 let queue=Promise.resolve();
 const as=(role,text,args)=>{const run=queue.then(async()=>{await db.exec(`set role ${role}`);try{return (await db.query(`select ${text} as value`,args)).rows[0].value;}finally{await db.exec('reset role');}});queue=run.catch(()=>{});return run;};
 const rpc=(action,payload={},token=null)=>as('anon','public.lifecycle($1,$2,$3::jsonb)',[action,token,JSON.stringify(payload)]);
 const admin=(action,payload={})=>as('authenticated','public.lifecycle_admin($1,$2::jsonb)',[action,JSON.stringify(payload)]);
 const service=(action,token,payload)=>as('service_role','public.lifecycle_photo_service($1,$2,$3::jsonb)',[action,token,JSON.stringify(payload)]);
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
  create table auth.users(id uuid primary key,email text);
  create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
  create table auth.mfa_factors(id uuid primary key,user_id uuid,status text,factor_type text,friendly_name text);
  create function auth.jwt() returns jsonb language sql as $$select current_setting('request.jwt.claims',true)::jsonb$$;
  create function auth.uid() returns uuid language sql as $$select (auth.jwt()->>'sub')::uuid$$;`);
 for(const file of readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(f=>/^00[1-8]_.*\.sql$/.test(f)).sort())await db.exec(sql(file));
 await db.exec(buildLifecycleRelease());
 for(const file of ['012_self_service_booking.sql','013_remove_pickup_instructions.sql','014_close_legacy_queue.sql','015_bike_rider_height.sql'])await db.exec(sql(file));
 await db.query('insert into auth.users values($1,$2)',[officer,'fixture@example.test']);
 await db.query('insert into private.admins values($1)',[officer]);await db.query('insert into auth.sessions values($1,$2,null)',[session,officer]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:officer,session_id:session,aal:'aal2'})]);
 const policy=(await admin('settings',{location:'QA office',terms:'QA terms'})).settings;
 const bikes=[];for(let i=1;i<=4;i++)bikes.push((await admin('asset',{code:`QA-P${i}`,name:`Synthetic ${i}`,kind:'bike',state:'available',reason:'synthetic'})).asset);
 // Self-service booking, approved, already inside its pickup window.
 const book=async(bike,student)=>{const k=key(),r=await rpc('apply',{requestId:randomUUID(),studentId:student,name:`Rider ${student}`,assetIds:[bike.id],start:iso(60000),end:iso(7200000),key:k},null);
  assert.ok(r.reservation,JSON.stringify(r));await admin('approve',{requestId:randomUUID(),reservationId:r.reservation.id});return {key:k,id:r.reservation.id,bike,name:`Rider ${student}`};};
 const open=b=>db.query("update private.lifecycle_reservations set starts_at=now()-interval '1 minute' where id=$1",[b.id]);
 const pickup=b=>rpc('pickup',{requestId:randomUUID(),reservationId:b.id,checks,notes:'',signature:{name:b.name,accepted:true,termsVersion:policy.termsVersion,image:signature}},b.key);
 // Capacity-only fixtures: tiny bytes with recorded sizes, at most 8 MiB per row.
 const history=async size=>{const id=randomUUID();
  await db.query("insert into private.lifecycle_reservations(id,member_id,borrower,starts_at,ends_at,status) select $1,member_id,borrower,now()-interval '2 days',now()-interval '1 day','cancelled' from private.lifecycle_reservations limit 1",[id]);
  for(let left=size;left>0;left-=8*MiB)await db.query("insert into private.lifecycle_photos(id,reservation_id,asset_id,phase,slot,mime,bytes,size,sha256) values($1,$2,$3,'pickup','left','image/png',$4,$5,'fixture')",[randomUUID(),id,bikes[0].id,png,Math.min(left,8*MiB)]);};
 return {db,rpc,admin,service,bikes,book,open,pickup,history};
}

test('016 stops future bookings from filling the photo budget and protects return photos of bikes that are out',async()=>{
 const {db,rpc,admin,bikes,book,open,pickup,history}=await setup();
 try{
  // Before 016: three approved bookings without a single photo fill all 192 MiB and the fourth is refused.
  const booked=[];for(let i=0;i<3;i++)booked.push(await book(bikes[i],`OLD${i}`));
  assert.equal((await admin('list')).storage.reservedBytes,192*MiB);
  assert.match((await rpc('apply',{requestId:randomUUID(),studentId:'OLD3',name:'Rider OLD3',assetIds:[bikes[3].id],start:iso(60000),end:iso(7200000),key:key()})).message,/capacity reserved/);
  await db.exec(sql('016_photo_capacity_accounting.sql'));
  await assert.rejects(db.exec(sql('016_photo_capacity_accounting.sql')),/already installed/);await db.exec('rollback');
  assert.deepEqual((await admin('list')).storage,{usedBytes:0,reservedBytes:0,budgetBytes:192*MiB,maxPhotoBytes:8*MiB,backend:'database'});
  assert.equal((await rpc('calendar',{start:iso(0),end:iso(86400000)})).settings.photoStorage,'database');
  booked.push(await book(bikes[3],'NEW3'));
  // Taking a bike out reserves its four return photos.
  await open(booked[0]);
  for(const slot of slots)assert.ok((await rpc('photo',{requestId:randomUUID(),reservationId:booked[0].id,assetId:bikes[0].id,phase:'pickup',slot,mime:'image/png',data:png.toString('base64')},booked[0].key)).photo);
  assert.equal((await pickup(booked[0])).reservation.status,'in_use');
  assert.equal((await admin('list')).storage.reservedBytes,32*MiB);
  // Fill to the point where a second pickup would eat the first bike's return room.
  const used=(await admin('list')).storage.usedBytes;await history(160*MiB-used);
  await open(booked[1]);
  const pickupPhoto={reservationId:booked[1].id,assetId:bikes[1].id,phase:'pickup',slot:'left',mime:'image/png',data:png.toString('base64')};
  assert.match((await rpc('photo',{...pickupPhoto,requestId:randomUUID()},booked[1].key)).message,/mandatory return photos/);
  for(const slot of slots)assert.ok((await rpc('photo',{requestId:randomUUID(),reservationId:booked[0].id,assetId:bikes[0].id,phase:'return',slot,mime:'image/png',data:png.toString('base64')},booked[0].key)).photo,'return photos always fit');
  const storage=(await admin('list')).storage;assert.equal(storage.reservedBytes,0);assert.ok(storage.usedBytes+storage.reservedBytes<=storage.budgetBytes);
  // A pickup itself is refused while the room for that bike's return photos is not free.
  await db.query("insert into private.lifecycle_photos(id,reservation_id,asset_id,phase,slot,mime,bytes,size,sha256) select gen_random_uuid(),$1,$2,'pickup',s,'image/png',$3,1,'fixture' from unnest(array['left','right','drivetrain','damage']) s",[booked[1].id,bikes[1].id,png]);
  await history(storage.budgetBytes-storage.usedBytes-4-16*MiB);
  assert.match((await pickup(booked[1])).message,/mandatory return photos/);
 }finally{await db.close();}
});

test('017 stores new photos in Drive through the Edge Function handler with 1 GiB, keeping database photos readable',async()=>{
 const {db,rpc,admin,service,bikes,book,open,pickup}=await setup();
 try{
  await db.exec(sql('016_photo_capacity_accounting.sql'));
  const first=await book(bikes[0],'D1'),second=await book(bikes[1],'D2');await open(first);await open(second);
  const legacy=(await rpc('photo',{requestId:randomUUID(),reservationId:first.id,assetId:bikes[0].id,phase:'pickup',slot:'left',mime:'image/png',data:png.toString('base64')},first.key)).photo;
  await db.exec(sql('017_google_drive_photos.sql'));
  await assert.rejects(db.exec(sql('017_google_drive_photos.sql')),/already installed/);await db.exec('rollback');
  for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'public.lifecycle_photo_service(text,text,jsonb)','execute') p",[role])).rows[0].p,false);
  const storage=(await admin('list')).storage;assert.equal(storage.budgetBytes,1024*MiB);assert.equal(storage.backend,'drive');
  assert.equal((await rpc('calendar',{start:iso(0),end:iso(86400000)})).settings.photoStorage,'drive');
  assert.match((await rpc('photo',{requestId:randomUUID(),reservationId:first.id,assetId:bikes[0].id,phase:'pickup',slot:'right',mime:'image/png',data:png.toString('base64')},first.key)).message,/photo service/);
  assert.equal((await rpc('photo_read',{id:legacy.id},first.key)).photo.data,png.toString('base64'),'database photos stay readable');

  // Fake Drive and a PostgREST shim that runs the real SQL as the service role.
  const files=new Map(),deleted=[];
  const drive={async upload(bytes,{name,properties}){const id=`drive_${randomBytes(8).toString('hex')}`;files.set(id,{bytes:Buffer.from(bytes),name,properties});return id;},
   async download(id){return new Uint8Array(files.get(id).bytes);},async remove(id){deleted.push(id);files.delete(id);}};
  const fetchShim=async(url,init)=>{const body=JSON.parse(init.body),u=new URL(url);let value;
   if(u.pathname==='/rest/v1/rpc/lifecycle_photo_service'){assert.equal(init.headers.apikey,'service-secret');value=await service(body.p_action,body.p_token,body.p_payload).catch(e=>({message:e.message,error:true}));}
   else if(u.pathname==='/rest/v1/rpc/lifecycle_admin'){assert.equal(init.headers.Authorization,'Bearer officer-jwt');value=await admin(body.p_action,body.p_payload);}
   else throw new Error('unexpected '+url);
   return new Response(JSON.stringify(value),{status:value?.error?400:200,headers:{'Content-Type':'application/json'}});};
  const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'service-secret'};
  const handler=createPhotoHandler({env:k=>env[k]||'',fetch:fetchShim,drive});
  const call=async(body,headers={})=>{const r=await handler(new Request('https://example.supabase.co/functions/v1/lifecycle-photo',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}));return {status:r.status,...await r.json()};};
  const upload=(b,bike,phase,slot,requestId=randomUUID(),bytes=png)=>call({action:'photo',token:b.key,payload:{requestId,reservationId:b.id,assetId:bike.id,phase,slot,mime:'image/png',data:bytes.toString('base64')}});

  const requestId=randomUUID(),stored=await upload(first,bikes[0],'pickup','right',requestId);
  assert.equal(stored.status,200,JSON.stringify(stored));assert.equal(files.size,1);
  const row=(await db.query('select bytes,drive_file_id,size,sha256 from private.lifecycle_photos where id=$1',[stored.photo.id])).rows[0];
  assert.equal(row.bytes,null);assert.equal(row.size,png.length);assert.equal(row.sha256,createHash('sha256').update(png).digest('hex'));assert.ok(files.has(row.drive_file_id));
  assert.match([...files.values()][0].name,/^\d{8}-\d{6}_pickup_right_[0-9a-f]{8}\.png$/);
  // A retried request returns the first result and uploads nothing new.
  assert.equal((await upload(first,bikes[0],'pickup','right',requestId)).photo.id,stored.photo.id);assert.equal(files.size,1);
  // Two racing copies of one request: the loser's Drive file is deleted.
  const raceId=randomUUID(),race=await Promise.all([upload(first,bikes[0],'pickup','drivetrain',raceId),upload(first,bikes[0],'pickup','drivetrain',raceId)]);
  assert.equal(race[0].photo.id,race[1].photo.id);assert.equal(files.size,2);assert.ok(deleted.length<=1);
  // Database refusals never leave a Drive file behind.
  assert.equal((await upload(second,bikes[0],'pickup','left')).status,400);
  assert.equal((await upload(first,bikes[0],'pickup','left',randomUUID(),Buffer.from('ffd8ffe000104a4649460001','hex'))).message,'Photo signature mismatch');
  assert.equal((await call({action:'photo',token:key(),payload:{requestId:randomUUID(),reservationId:first.id,assetId:bikes[0].id,phase:'pickup',slot:'damage',mime:'image/png',data:png.toString('base64')}})).message,'Invalid member token');
  assert.equal(files.size,2);

  // Reads: members only their own booking, officers through their own session, bytes verified against the record.
  const read=await call({action:'photo_read',token:first.key,payload:{id:stored.photo.id}});
  assert.equal(read.photo.data,png.toString('base64'));assert.equal(read.photo.driveFileId,undefined);
  assert.equal((await call({action:'photo_read',token:first.key,payload:{id:legacy.id}})).photo.data,png.toString('base64'));
  assert.equal((await call({action:'photo_read',token:second.key,payload:{id:stored.photo.id}})).message,'Photo not found');
  assert.equal((await call({action:'photo_read',admin:true,payload:{id:stored.photo.id}},{authorization:'Bearer officer-jwt',apikey:'publishable'})).photo.data,png.toString('base64'));
  assert.equal((await call({action:'photo_read',admin:true,payload:{id:stored.photo.id}})).status,401);
  files.get(row.drive_file_id).bytes=Buffer.from(png).fill(0,20);
  assert.equal((await call({action:'photo_read',token:first.key,payload:{id:stored.photo.id}})).status,502,'tampered Drive bytes are refused');

  // The lifecycle still completes with Drive photos.
  assert.ok((await upload(first,bikes[0],'pickup','damage')).photo);
  assert.equal((await pickup(first)).reservation.status,'in_use');
  assert.equal((await admin('list')).storage.reservedBytes,32*MiB);
  const dump=await admin('export');assert.ok(dump.photos.some(p=>p.driveFileId===row.drive_file_id&&p.data===undefined));assert.ok(dump.photos.some(p=>p.id===legacy.id&&p.data));
  await assert.rejects(db.query("insert into private.lifecycle_photos(id,reservation_id,asset_id,phase,slot,mime,bytes,size,sha256) values(gen_random_uuid(),$1,$2,'pickup','left','image/png',null,1,'x')",[first.id,bikes[0].id]),/one_store/);
  await assert.rejects(db.query('delete from private.lifecycle_photos where id=$1',[stored.photo.id]),/immutable/i);
 }finally{await db.close();}
});
