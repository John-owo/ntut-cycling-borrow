import {constants,copyFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Publish only the borrowing service. Preserved historical photos are not deploy assets.
export const borrowingFiles = Object.freeze([
  'index.html','admin.html','club.html','app.js','admin.js','api.js','i18n.js',
  'translations.js','style.css','brand-tokens.css','config.js','favicon.svg','ntut-club-logo.png',
]);
export function packagePages(destination) {
  const source=fileURLToPath(new URL('../public/',import.meta.url));
  const output=resolve(destination);
  mkdirSync(output); // Refuse an existing destination; preserve earlier package copies.
  for(const file of borrowingFiles)copyFileSync(join(source,file),join(output,file),constants.COPYFILE_EXCL);
  return output;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  packagePages(process.argv[2]||'.pages-site');
  console.log('Packaged borrowing-only static site');
}
