import { createApp } from './app.mjs';
const username=process.env.ADMIN_USERNAME;
const password=process.env.ADMIN_PASSWORD;
if(!username||!password){console.error('請以 ADMIN_USERNAME 與 ADMIN_PASSWORD 環境變數建立個別管理員；密碼至少 12 字元。');process.exit(1);}
const app=createApp({dbPath:process.env.DB_PATH});
try{app.addAdmin(username,password);console.log('管理員已建立。');}catch{console.error('建立失敗：請檢查帳號是否重複及密碼長度。');process.exitCode=1;}finally{await app.close();}
