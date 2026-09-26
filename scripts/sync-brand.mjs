// Usage: node scripts/sync-brand.mjs /path/to/design-studio/brand/tokens.json [--check]
// The design studio owns the canonical JSON. This portal owns only its generated bridge.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const input=process.argv[2];if(!input)throw Error('Provide canonical design-studio/brand/tokens.json');
const raw=readFileSync(input,'utf8'),brand=JSON.parse(raw);
const required=['background','text','body','accent','muted','dark','onDark','supportOnDark','accentOnDark'];
for(const key of required)if(!/^#[0-9a-f]{6}$/i.test(brand.colors?.[key]))throw Error('Invalid color '+key);
if(brand.id!=='ntut-cycling')throw Error('Unexpected brand identity');
const digest=createHash('sha256').update(raw).digest('hex');
const css=`/* Generated from NTUT Cycling design-studio/brand/tokens.json; version ${brand.version}; SHA256 ${digest}.\n   Run scripts/sync-brand.mjs with the canonical JSON; do not edit generated values. */\n:root{\n${required.map(k=>`  --brand-${k}:${brand.colors[k]};`).join('\n')}\n}\n`;
const destination=new URL('../public/brand-tokens.css',import.meta.url);
if(process.argv.includes('--check')){if(readFileSync(destination,'utf8')!==css)throw Error('Brand bridge is stale');console.log('Brand bridge matches canonical tokens');}
else {writeFileSync(destination,css);console.log('Generated public/brand-tokens.css');}
