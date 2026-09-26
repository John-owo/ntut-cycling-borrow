import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {packagePages,borrowingFiles} from '../scripts/package-pages.mjs';

test('Pages artifact contains only borrowing assets and preserves existing output',()=>{
 const output=join(mkdtempSync(join(tmpdir(),'bike-pages-')),'site');
 packagePages(output);
 assert.deepEqual(readdirSync(output).sort(),[...borrowingFiles].sort());
 for(const name of ['club.css','club-assets'])assert.equal(existsSync(join(output,name)),false);
 for(const name of ['index.html','admin.html']){
  const html=readFileSync(join(output,name),'utf8');
  assert.doesNotMatch(html,/club\.html|club\.css|club-assets|portal-nav/);
  for(const match of html.matchAll(/(?:src|href)="\.\/([^"#?]+)(?:[?#][^"]*)?"/g))assert.ok(existsSync(join(output,match[1])),match[1]);
 }
 const redirect=readFileSync(join(output,'club.html'),'utf8');
 assert.match(redirect,/http-equiv="refresh" content="0; url=\.\/index\.html"/);
 assert.doesNotMatch(redirect,/club-assets|團騎活動|加入我們/);
 const before=readFileSync(join(output,'ntut-club-logo.png'));
 assert.throws(()=>packagePages(output),{code:'EEXIST'});
 assert.deepEqual(readFileSync(join(output,'ntut-club-logo.png')),before);
 // Keep generated copies; image preservation policy also applies to QA artifacts.
});

test('Production connection policy only permits the configured Supabase project',()=>{
 const root=mkdtempSync(join(tmpdir(),'bike-production-csp-'));mkdirSync(join(root,'public'));
 for(const name of ['index.html','admin.html'])writeFileSync(join(root,'public',name),readFileSync(new URL('../public/'+name,import.meta.url)));
 const script=fileURLToPath(new URL('../scripts/pages-config.mjs',import.meta.url));
 const run=spawnSync(process.execPath,[script],{cwd:root,env:{...process.env,SUPABASE_URL:'https://test-project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test'},encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 for(const name of ['index.html','admin.html']){
  const html=readFileSync(join(root,'public',name),'utf8');
  assert.match(html,/connect-src 'self' https:\/\/test-project\.supabase\.co;/);
  assert.doesNotMatch(html,/https:\/\/\*\.supabase\.co|http:\/\/localhost|http:\/\/127\.0\.0\.1/);
 }
 const invalid=spawnSync(process.execPath,[script],{cwd:root,env:{...process.env,SUPABASE_URL:'https://test-project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_secret_test'},encoding:'utf8'});
 assert.notEqual(invalid.status,0);
});
