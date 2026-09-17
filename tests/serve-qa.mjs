// Isolated local UI QA only. Never points to the operational database.
import {createApp} from '../server/app.mjs';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const app=createApp({dbPath:join(mkdtempSync(join(tmpdir(),'bike-ui-qa-')),'qa.sqlite')});
app.addAdmin('qa-admin','qa-only-password-123');
app.db.prepare("UPDATE settings SET total=2,contactUrl='https://example.org/qa-only' WHERE id=1").run();
app.server.listen(4174,'127.0.0.1',()=>console.log('Isolated synthetic QA: http://127.0.0.1:4174'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
