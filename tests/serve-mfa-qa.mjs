// Synthetic Auth UI fixture. Loopback only, no Supabase connection or real secrets.
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
let enrolled=false,verified=false;
const summary={total:6,borrowed:0,available:6,waiting:0,contactUrl:'',updatedAt:new Date().toISOString()};
const auth=()=>({user:{email:'officer@example.test'},access_token:verified?'synthetic-aal2':'synthetic-aal1',refresh_token:'synthetic-refresh',expires_in:3600});
const server=http.createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 res.setHeader('Cache-Control','no-store');
 const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
 if(path.startsWith('/auth/')||path.startsWith('/rest/')){
  let body='';for await(const chunk of req)body+=chunk;
  const data=body?JSON.parse(body):{};
  if(path==='/auth/v1/token'){verified=false;send(200,auth());}
  else if(path==='/auth/v1/logout'){verified=false;send(200,{});}
  else if(path==='/rest/v1/rpc/admin_session_status')send(200,{enrolled,required:enrolled&&!verified,factors:enrolled?[{id:'fixture-factor',name:'Test authenticator'}]:[]});
  else if(path==='/auth/v1/factors')send(200,{id:'fixture-factor',totp:{secret:'JBSWY3DPEHPK3PXP'}});
  else if(path.endsWith('/fixture-factor/challenge'))send(200,{id:'fixture-challenge'});
  else if(path.endsWith('/fixture-factor/verify')){
   if(data.code!=='123456')send(422,{message:'Invalid TOTP code'});
   else{enrolled=true;verified=true;send(200,auth());}
  }
  else if(path==='/rest/v1/rpc/admin_records'){
   if(enrolled&&!verified)send(403,{message:'MFA_REQUIRED'});
   else send(200,{summary,opening:{outstanding:0,note:''},records:[],audit:[]});
  }else if(path==='/rest/v1/rpc/summary')send(200,summary);
  else send(404,{message:'Synthetic fixture: unsupported route'});
  return;
 }
 if(path==='/config.js'){
  res.writeHead(200,{'Content-Type':'text/javascript'});
  res.end(`window.BIKE_CONFIG=${JSON.stringify({mode:'supabase',supabaseUrl:`http://127.0.0.1:${server.address().port}`,supabaseKey:'synthetic-public-key'})}`);return;
 }
 const name=path==='/'?'admin.html':path.slice(1);
 if(!['admin.html','index.html','api.js','app.js','admin.js','i18n.js','translations.js','style.css','brand-tokens.css','favicon.svg','ntut-club-logo.png'].includes(name)){send(404,{});return;}
 const type=name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'image/svg+xml';
 res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(readFileSync(resolve('public',name)));
});
server.listen(0,'127.0.0.1',()=>console.log(`Synthetic MFA QA: http://127.0.0.1:${server.address().port}/admin.html`));
