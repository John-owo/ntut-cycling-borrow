import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {confirmedFleet} from '../public/fleet-catalog.js';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const manifest=JSON.parse(readFileSync(join(root,'docs/FLEET-PHOTO-MANIFEST-20261008.json'),'utf8'));

test('confirmed fleet catalog references only audited immutable JPEG copies',()=>{
 assert.deepEqual(confirmedFleet.map(a=>a.code),['1','2','3','4','5','6','7','8']);
 assert.deepEqual(confirmedFleet.map(a=>a.name),manifest.assets.map(a=>a.name));
 assert.deepEqual(confirmedFleet.map(a=>a.photos.length),[1,1,1,1,1,1,1,0]);
 for(const asset of confirmedFleet){
  const evidence=manifest.assets.find(a=>a.code===asset.code);
  assert.equal(asset.sourceUrl,evidence.folderUrl);
  for(const photo of asset.photos){
   const publicPath='public/'+photo.src.replace(/^\.\//,'');
   const file=evidence.photos.find(p=>p.publicPath===publicPath);
   assert.ok(file,publicPath);
   assert.ok(!file.hasGpsExif&&!file.hasPrivateExif&&!file.hasXmp);
   assert.ok(photo.alt.includes(asset.code));
   const contents=readFileSync(join(root,publicPath));
   assert.equal(contents.length,file.sizeBytes);
   assert.equal(createHash('sha256').update(contents).digest('hex'),file.sha256);
  }
 }
 assert.equal(manifest.assets.flatMap(a=>a.photos).length,14);
 assert.equal(manifest.assets.flatMap(a=>a.photos).filter(p=>p.publicPath).length,7);
});
