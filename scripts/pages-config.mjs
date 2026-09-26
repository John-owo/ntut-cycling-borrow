import {readFileSync,writeFileSync} from 'node:fs';
const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_PUBLISHABLE_KEY || '';
if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) throw new Error('Set SUPABASE_URL to the project HTTPS origin.');
if(!key || key.startsWith('sb_secret_')) throw new Error('Use a publishable key, never a secret key.');
if(!key.startsWith('sb_publishable_')) {
  let payload;
  try {payload=JSON.parse(Buffer.from(key.split('.')[1],'base64url'));}catch{}
  if(payload?.role!=='anon')throw new Error('Only a publishable or legacy anon key may be included in the public website.');
}
writeFileSync('public/config.js',`// Public connection settings. No admin secrets.\nwindow.BIKE_CONFIG = Object.freeze(${JSON.stringify({mode:'supabase',apiBase:'',supabaseUrl:url,supabaseKey:key})});\n`);
// Production only connects to this project's API. Local development keeps its
// separate template policy; a different Supabase project is not a trusted sink.
for(const file of ['public/index.html','public/admin.html']) {
  const html=readFileSync(file,'utf8');
  if(!/connect-src [^;]+;/.test(html))throw new Error(`Missing connect-src policy in ${file}`);
  writeFileSync(file,html.replace(/connect-src [^;]+;/,`connect-src 'self' ${url};`));
}
