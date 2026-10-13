-- Original photos move from the database to the club's Google Drive, with a 1 GiB budget. Apply once after 016,
-- and only after the lifecycle-photo Edge Function is deployed with its Google secrets (see supabase/README.md).
-- The Edge Function checks the image bytes, stores them in Drive and records the file here with the service role;
-- members' pages no longer send photo bytes to the database. Photos already stored in the database stay there,
-- remain readable and still count toward the budget. Nothing is moved, rewritten or deleted.
begin;
set local lock_timeout='15s';
do $$ begin
 if exists(select 1 from information_schema.columns where table_schema='private' and table_name='lifecycle_photos' and column_name='drive_file_id') then
  raise exception '017 is already installed; do not replay';
 end if;
 if not exists(select 1 from pg_proc where proname='lifecycle_photo_gate' and pronamespace='private'::regnamespace) then
  raise exception 'Apply 016 before 017';
 end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then raise exception 'service_role is required'; end if;
end $$;

-- Each photo is stored in exactly one place: database bytes (before 017) or a Drive file.
alter table private.lifecycle_photos
 alter column bytes drop not null,
 add column drive_file_id text unique check(drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
 add constraint lifecycle_photos_one_store check((bytes is null)<>(drive_file_id is null));

create or replace function private.lifecycle_photo_backend() returns text language sql stable security definer set search_path='' as $$
 select 'drive'::text
$$;
create or replace function private.lifecycle_photo_budget() returns bigint language sql stable security definer set search_path='' as $$
 select 1073741824::bigint
$$;

-- With data requested, a Drive photo returns its file ID; the Edge Function fetches the bytes.
create or replace function private.lifecycle_photo_json(p private.lifecycle_photos,p_data boolean default false) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'reservationId',p.reservation_id,'assetId',p.asset_id,'phase',p.phase,'slot',p.slot,'mime',p.mime,'size',p.size,'sha256',p.sha256,'uploadedAt',p.uploaded_at)
  || case when not p_data then '{}'::jsonb
          when p.bytes is not null then jsonb_build_object('data',pg_catalog.encode(p.bytes,'base64'))
          else jsonb_build_object('driveFileId',p.drive_file_id) end
$$;

-- check: may this member upload this photo now (no write)? commit: record the Drive file, re-checking every
-- rule under the lifecycle lock. read: a photo of this member's booking. The receipt ignores driveFileId, so a
-- retried request returns the first result and stored=false tells the Edge Function to delete its extra file.
create function public.lifecycle_photo_service(p_action text,p_token text,p_payload jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 v_member private.lifecycle_members; v_photo private.lifecycle_photos; v_scope uuid; v_hash text;
 v_request jsonb; v_existing jsonb; v_result jsonb; v_size bigint; v_now timestamptz;
begin
 perform set_config('response.headers','[{"Cache-Control":"no-store"}]',true);
 if p_action is null or p_action not in ('check','commit','read') then raise exception 'Unknown photo service action'; end if;
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception 'Invalid member token'; end if;
 v_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex');
 if p_action='commit' then
  perform 1 from private.settings where id=1 for update;
  perform 1 from private.lifecycle_settings where id=1 for update;
 end if;
 -- Same credential rules as lifecycle(): a member credential sees all its bookings, a booking key only its own.
 select * into v_member from private.lifecycle_members where token_hash=v_hash;
 if not found then
  select r.id into v_scope from private.lifecycle_reservations r where r.access_hash=v_hash;
  if not found then raise exception 'Invalid member token'; end if;
  select m.* into v_member from private.lifecycle_members m join private.lifecycle_reservations r on r.member_id=m.id where r.id=v_scope;
 end if;
 if p_action='read' then
  if not private.lifecycle_keys(p_payload,array['id']) then raise exception 'Invalid payload'; end if;
  select p.* into v_photo from private.lifecycle_photos p join private.lifecycle_reservations r on r.id=p.reservation_id
   where p.id=private.lifecycle_uuid(p_payload->>'id') and r.member_id=v_member.id and (v_scope is null or r.id=v_scope);
  if not found then raise exception 'Photo not found'; end if;
  return jsonb_build_object('photo',private.lifecycle_photo_json(v_photo,true));
 end if;
 if not private.lifecycle_keys(p_payload,array['requestId','reservationId','assetId','phase','slot','mime','size','sha256','driveFileId'])
    or not (p_payload ?& array['requestId','reservationId','assetId','phase','slot','mime','size','sha256'])
    or (p_action='commit')<>(p_payload ? 'driveFileId') then raise exception 'Invalid photo'; end if;
 if jsonb_typeof(p_payload->'size')<>'number' or (p_payload->>'size') !~ '^[0-9]{1,10}$' or (p_payload->>'sha256') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid photo data'; end if;
 v_size:=(p_payload->>'size')::bigint; v_request:=p_payload-'driveFileId'; v_now:=clock_timestamp();
 v_existing:=private.lifecycle_receipt('member',v_member.id,'photo',v_request);
 if v_existing is not null then return jsonb_build_object('result',v_existing,'stored',false); end if;
 perform private.lifecycle_photo_gate(v_member.id,v_scope,v_request,v_size,v_now);
 if p_action='check' then return jsonb_build_object('ready',true); end if;
 if (p_payload->>'driveFileId') !~ '^[A-Za-z0-9_-]{10,200}$' then raise exception 'Invalid Drive file'; end if;
 insert into private.lifecycle_photos(id,reservation_id,asset_id,phase,slot,mime,bytes,size,sha256,drive_file_id)
  values(pg_catalog.gen_random_uuid(),private.lifecycle_uuid(v_request->>'reservationId'),private.lifecycle_uuid(v_request->>'assetId'),
   v_request->>'phase',v_request->>'slot',v_request->>'mime',null,v_size,v_request->>'sha256',p_payload->>'driveFileId') returning * into v_photo;
 insert into private.lifecycle_events(actor_type,actor_id,action,reservation_id,details)
  values('member',v_member.id,'photo',v_photo.reservation_id,jsonb_build_object('photoId',v_photo.id,'phase',v_photo.phase,'slot',v_photo.slot,'storage','drive'));
 v_result:=jsonb_build_object('photo',private.lifecycle_photo_json(v_photo));
 perform private.lifecycle_save_receipt('member',v_member.id,'photo',v_request,v_result);
 return jsonb_build_object('result',v_result,'stored',true);
end $$;

revoke all on all functions in schema private from public,anon,authenticated;
revoke all on function public.lifecycle_photo_service(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.lifecycle_photo_service(text,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
