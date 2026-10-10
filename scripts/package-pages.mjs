import {constants,copyFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {confirmedFleet} from '../public/fleet-catalog.js';

const fleetPhotos=confirmedFleet.flatMap(bike=>bike.photos.map(photo=>photo.src.replace(/^\.\//,'')));
if(fleetPhotos.some(file=>!/^fleet-reference-20261008\/bike-0[1-7]-S__\d+_0-20261009\.jpg$/.test(file)))throw new Error('Unexpected fleet photo path');

// Publish only the borrowing service. Preserved historical photos are not deploy assets.
export const borrowingFiles = Object.freeze([
  'index.html','admin.html','club.html','admin.js','api.js','i18n.js',
  'translations.js','style.css','brand-tokens.css','config.js','favicon.svg','ntut-club-logo.png',
  'lifecycle.js','lifecycle.css','fleet-catalog.js',...fleetPhotos,
]);
export function packagePages(destination) {
  const source=fileURLToPath(new URL('../public/',import.meta.url));
  const output=resolve(destination);
  mkdirSync(output); // Refuse an existing destination; preserve earlier package copies.
  for(const file of borrowingFiles){
    mkdirSync(dirname(join(output,file)),{recursive:true});
    copyFileSync(join(source,file),join(output,file),constants.COPYFILE_EXCL);
  }
  return output;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  packagePages(process.argv[2]||'.pages-site');
  console.log('Packaged borrowing-only static site');
}
