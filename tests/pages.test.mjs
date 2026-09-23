import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,existsSync} from 'node:fs';
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
