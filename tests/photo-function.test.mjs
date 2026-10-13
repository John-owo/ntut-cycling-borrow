import test from 'node:test';
import assert from 'node:assert/strict';
import {driveClient,createPhotoHandler} from '../supabase/functions/lifecycle-photo/handler.js';

const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});

test('Drive client refreshes once, uploads multipart into the folder and removes a short upload',async()=>{
 const calls=[];let size=null;
 const fetch=async(url,init={})=>{calls.push({url,init});
  if(url==='https://oauth2.googleapis.com/token'){const form=new URLSearchParams(init.body);assert.equal(form.get('grant_type'),'refresh_token');assert.equal(form.get('refresh_token'),'refresh-fixture');return json({access_token:'access-fixture',expires_in:3600});}
  assert.equal(init.headers.Authorization,'Bearer access-fixture');
  if(url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart')){
   const body=Buffer.from(init.body).toString('latin1'),boundary=init.headers['Content-Type'].match(/boundary=(.+)$/)[1];
   assert.ok(body.startsWith(`--${boundary}\r\n`));assert.ok(body.endsWith(`\r\n--${boundary}--`));
   const meta=JSON.parse(body.split('\r\n\r\n')[1].split('\r\n')[0]);assert.deepEqual(meta.parents,['folder-fixture']);assert.equal(meta.mimeType,'image/png');assert.equal(meta.appProperties.slot,'left');
   return json({id:'file_fixture_0001',size:String(size??4)});}
  if(init.method==='DELETE')return new Response(null,{status:204});
  if(url.includes('alt=media'))return new Response(new Uint8Array([1,2,3,4]));
  throw new Error('unexpected '+url);};
 const drive=driveClient({clientId:'client',clientSecret:'secret',refreshToken:'refresh-fixture',folderId:'folder-fixture',fetch});
 assert.equal(await drive.upload(new Uint8Array([1,2,3,4]),{name:'a.png',mime:'image/png',properties:{slot:'left'}}),'file_fixture_0001');
 assert.deepEqual([...await drive.download('file_fixture_0001')],[1,2,3,4]);
 size=3;await assert.rejects(drive.upload(new Uint8Array([1,2,3,4]),{name:'a.png',mime:'image/png',properties:{slot:'left'}}),/unavailable/);
 assert.equal(calls.filter(c=>c.url.includes('oauth2')).length,1,'access token is reused');
 assert.ok(calls.some(c=>c.init.method==='DELETE'&&c.url.includes('file_fixture_0001')),'a size mismatch deletes the stored file');
 await assert.rejects(driveClient({clientId:'',clientSecret:'',refreshToken:'',folderId:'',fetch}).upload(new Uint8Array(4),{}),/not configured/);
});

test('Photo function answers CORS preflight, rejects bad requests before any network call and keeps errors generic',async()=>{
 let network=0;const handler=createPhotoHandler({env:()=>'',fetch:async()=>{network++;throw new Error('no network');}});
 const send=(body,method='POST')=>handler(new Request('https://example.test/functions/v1/lifecycle-photo',{method,...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})}));
 const preflight=await send(null,'OPTIONS');assert.equal(preflight.status,204);assert.match(preflight.headers.get('access-control-allow-headers'),/apikey/);
 assert.equal((await send(null,'GET')).status,405);
 assert.equal((await send('{')).status,400);
 assert.equal((await send({action:'photo',token:'short',payload:{}})).status,400);
 const token='a'.repeat(64),base={requestId:crypto.randomUUID(),reservationId:crypto.randomUUID(),assetId:crypto.randomUUID(),phase:'pickup',slot:'left',mime:'image/png'};
 assert.equal((await (await send({action:'photo',token,payload:{...base,data:'not base64!'}})).json()).message,'Invalid photo data');
 assert.equal((await (await send({action:'photo',token,payload:{...base,data:Buffer.alloc(40).toString('base64')}})).json()).message,'Photo signature mismatch');
 assert.equal((await (await send({action:'photo',token,payload:{...base,extra:1,data:'AAAA'}})).json()).message,'Invalid photo');
 const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(20)]).toString('base64');
 const unconfigured=await send({action:'photo',token,payload:{...base,data:png}});assert.equal(unconfigured.status,503);
 assert.equal(network,0);
 const failing=createPhotoHandler({env:k=>({SUPABASE_URL:'https://example.test',SUPABASE_SERVICE_ROLE_KEY:'k'})[k]||'',fetch:async()=>{throw new TypeError('socket detail')}});
 const crashed=await failing(new Request('https://example.test/f',{method:'POST',body:JSON.stringify({action:'photo_read',token,payload:{id:crypto.randomUUID()}})}));
 assert.equal(crashed.status,502);assert.doesNotMatch(JSON.stringify(await crashed.json()),/socket/);
});
