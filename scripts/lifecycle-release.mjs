import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// One transaction for 009–011. Fingerprints stay inside the database and prove
// that the live legacy records/settings/opening balances were preserved.
const fingerprint=`select encode(sha256(convert_to(jsonb_build_object(
 'records',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb) from private.records r),
 'settings',(select to_jsonb(s) from private.settings s where id=1),
 'opening',(select to_jsonb(o) from private.opening_loans o where id=1))::text,'UTF8')),'hex')`;
export function buildLifecycleRelease(){
 const files=['009_reservation_lifecycle.sql','010_lifecycle_legacy_inventory.sql','011_confirmed_fleet_catalog.sql'];
 const body=files.map(file=>readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')
  .replace(/^\s*(?:begin|commit);\s*$/gmi,'')
  .replace(/^\s*notify pgrst\s*,\s*'reload schema';\s*$/gmi,'')).join('\n');
 return `begin;
set local lock_timeout='15s';
lock table private.records,private.settings,private.opening_loans in share row exclusive mode;
do $$ begin
 if to_regprocedure('public.lifecycle(text,text,jsonb)') is not null then raise exception 'Lifecycle is already installed; do not replay release'; end if;
end $$;
create temporary table lifecycle_release_baseline on commit drop as ${fingerprint};
alter table lifecycle_release_baseline enable row level security;
${body}
do $$ declare after_hash text; begin
 ${fingerprint} into after_hash;
 if after_hash<>(select encode from lifecycle_release_baseline) then raise exception 'Legacy data changed during release'; end if;
end $$;
notify pgrst,'reload schema';
commit;
select (select count(*) from private.records) as preserved_legacy_count,
 (select total from private.settings where id=1) as preserved_total,
 (select count(*) from private.lifecycle_assets where state='inspection') as pending_fleet,
 (select count(*) from private.lifecycle_reservations) as lifecycle_reservations;
`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(!process.argv[2])throw Error('Provide a new output .sql path');
 writeFileSync(resolve(process.argv[2]),buildLifecycleRelease(),{flag:'wx'});
 console.log('Prepared atomic lifecycle release; no database changes performed');
}
