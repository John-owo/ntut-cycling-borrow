import { createApp } from './app.mjs';
const list=name=>(process.env[name]||'').split(',').map(v=>v.trim()).filter(Boolean);
const app=createApp({dbPath:process.env.DB_PATH,origins:list('ALLOWED_ORIGINS'),hosts:list('ALLOWED_HOSTS')});
const port=Number(process.env.PORT||4173);
app.server.listen(port,'127.0.0.1',()=>console.log(`Borrow system: http://127.0.0.1:${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
