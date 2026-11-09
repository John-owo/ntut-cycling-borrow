-- Competing applications do not hold assets until approval. Apply once after 019.
-- Preserve existing bookings and limit member access to each reservation's own booking code.
begin;
set local lock_timeout='15s';
do $$ begin
 if exists(select 1 from information_schema.columns where table_schema='private' and table_name='lifecycle_reservations' and column_name='allocation_declined') then
  raise exception '020 is already installed; do not replay';
 end if;
 if coalesce(pg_catalog.strpos(pg_catalog.pg_get_functiondef(to_regprocedure('private.lifecycle_member_window(uuid,timestamptz,timestamptz)')),'overdue loan'),0)=0 then
  raise exception 'Apply 019 before 020';
 end if;
end $$;

alter table private.lifecycle_reservations
 add column allocation_declined boolean not null default false,
 add constraint lifecycle_allocation_declined_state check(not allocation_declined or (status='cancelled' and approval='pending'));

-- Callers hold the lifecycle write locks. Keep the same treatment of unreturned loans,
-- but only approved reservations claim a slot.
create function private.lifecycle_assets_occupied(p_ids uuid[],p_start timestamptz,p_end timestamptz) returns boolean language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from private.lifecycle_reservation_assets ra
  join private.lifecycle_reservations r on r.id=ra.reservation_id
  where ra.asset_id=any(p_ids) and (
   (r.status='reserved' and r.approval='approved' and r.starts_at<p_end and r.ends_at>p_start)
   or (r.status='in_use' and ((r.starts_at<p_end and r.ends_at>p_start) or r.ends_at<=p_start))
  )
 )
$$;

create function private.lifecycle_booking_scope(p_token text) returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_hash text; v_id uuid;
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception 'Invalid member token'; end if;
 v_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex');
 select r.id into v_id from private.lifecycle_reservations r where r.access_hash=v_hash;
 if v_id is null then raise exception 'Invalid member token'; end if;
 return v_id;
end $$;

create or replace function private.lifecycle_reservation_json(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',r.id,'memberId',r.member_id,'borrower',r.borrower,
 'assetIds',coalesce((select jsonb_agg(ra.asset_id order by a.code) from private.lifecycle_reservation_assets ra join private.lifecycle_assets a on a.id=ra.asset_id where ra.reservation_id=r.id),'[]'::jsonb),
 'start',r.starts_at,'end',r.ends_at,'status',r.status,'approval',r.approval,'approvedAt',r.approved_at,'allocationDeclined',r.allocation_declined,'selfService',r.access_hash is not null,'createdAt',r.created_at,'pickedUpAt',r.picked_up_at,'returnedAt',r.returned_at,
 'consent',case when r.terms_accepted_at is null then null else jsonb_build_object('termsVersion',r.terms_version,'acceptedAt',r.terms_accepted_at) end,
 'inspections',coalesce((select jsonb_agg(jsonb_build_object('phase',i.phase,'checks',i.checks,'notes',i.notes,'abnormal',i.abnormal,'createdAt',i.created_at) order by i.created_at) from private.lifecycle_inspections i where i.reservation_id=r.id),'[]'::jsonb),
 'photos',coalesce((select jsonb_agg(private.lifecycle_photo_json(p) order by p.uploaded_at,p.id) from private.lifecycle_photos p where p.reservation_id=r.id),'[]'::jsonb),
 'signature',(select jsonb_build_object('name',s.name,'terms',s.terms,'termsVersion',s.terms_version,'signedAt',s.signed_at,'image','data:image/png;base64,'||pg_catalog.encode(s.image,'base64')) from private.lifecycle_signatures s where s.reservation_id=r.id))
 from private.lifecycle_reservations r where r.id=p_id
$$;

create or replace function private.lifecycle_apply_core(p_payload jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 v_member private.lifecycle_members; v_member_id uuid; v_existing jsonb; v_result jsonb; v_id uuid; v_ids uuid[];
 v_start timestamptz; v_end timestamptz; v_hash text; v_actor uuid; v_student text; v_name text;
 v_storage jsonb; v_now timestamptz; v_consent_version text;
begin
 if not private.lifecycle_keys(p_payload,array['requestId','studentId','name','assetIds','start','end','key','accepted','termsVersion']) or not (p_payload ?& array['requestId','studentId','name','assetIds','start','end','key','accepted','termsVersion']) then raise exception 'Invalid application'; end if;
 if not coalesce((p_payload->>'key') ~ '^[a-f0-9]{64}$',false) then raise exception 'Invalid booking key'; end if;
 v_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_payload->>'key','UTF8')),'hex');
 v_actor:=pg_catalog.md5('apply:'||v_hash)::uuid;
 perform 1 from private.settings where id=1 for update;
 perform 1 from private.lifecycle_settings where id=1 for update;
 v_now:=clock_timestamp();
 v_existing:=private.lifecycle_receipt('applicant',v_actor,'apply',p_payload);
 if v_existing is not null then return v_existing; end if;
 v_student:=upper(btrim(p_payload->>'studentId')); v_name:=btrim(p_payload->>'name');
 if v_student !~ '^[A-Z0-9-]{1,30}$' or not private.lifecycle_text(v_name,80) then raise exception 'Invalid student ID or name'; end if;
 if exists(select 1 from private.lifecycle_members where token_hash=v_hash) or exists(select 1 from private.lifecycle_reservations where access_hash=v_hash) then raise exception 'Booking key already used'; end if;
 select * into v_member from private.lifecycle_members where student_id=v_student for update;
 if found then
  if not v_member.active then raise exception 'Membership inactive'; end if;
  v_member_id:=v_member.id;
 end if;
 if not private.lifecycle_policy_ready() then raise exception 'Borrow policy incomplete'; end if;
 v_consent_version:=private.lifecycle_consent(p_payload);
 v_start:=private.lifecycle_time(p_payload->>'start'); v_end:=private.lifecycle_time(p_payload->>'end');
 if v_start<v_now or v_end<=v_start or v_end>v_start+interval '5 days' then raise exception 'Invalid reservation window'; end if;
 if jsonb_typeof(p_payload->'assetIds')<>'array' or jsonb_array_length(p_payload->'assetIds')<1 or jsonb_array_length(p_payload->'assetIds')>20 then raise exception 'Invalid assets'; end if;
 select array_agg(private.lifecycle_uuid(x.value)) into v_ids from jsonb_array_elements_text(p_payload->'assetIds') x;
 if (select count(distinct x) from unnest(v_ids) x)<>cardinality(v_ids) then raise exception 'Duplicate asset'; end if;
 if (select count(*) from private.lifecycle_assets a where a.id=any(v_ids))<>cardinality(v_ids)
    or (select count(*) from private.lifecycle_assets a where a.id=any(v_ids) and a.kind='bike')<>1
    or exists(select 1 from private.lifecycle_assets a where a.id=any(v_ids) and a.state<>'available') then raise exception 'Asset unavailable'; end if;
 if exists(select 1 from private.records where student_id=v_student and status='borrowed') then raise exception 'Existing legacy loan or application'; end if;
 perform private.lifecycle_member_window(v_member_id,v_start,v_end);
 if private.lifecycle_assets_occupied(v_ids,v_start,v_end) then raise exception 'Reservation conflict'; end if;
 v_storage:=private.lifecycle_storage_json();
 if (v_storage->>'usedBytes')::bigint+(v_storage->>'reservedBytes')::bigint+67108864>(v_storage->>'budgetBytes')::bigint then raise exception 'Photo capacity reserved for existing loans; contact officers'; end if;
 if v_member_id is null then
  -- Unusable random credential: this identity is reached only through booking keys.
  v_member_id:=pg_catalog.gen_random_uuid();
  insert into private.lifecycle_members(id,student_id,name,contact,valid_until,active,token_hash)
   values(v_member_id,v_student,v_name,'','2099-12-31T00:00:00Z',true,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.gen_random_uuid()::text||pg_catalog.gen_random_uuid()::text,'UTF8')),'hex'));
 end if;
 v_id:=pg_catalog.gen_random_uuid();
 insert into private.lifecycle_reservations(id,member_id,borrower,starts_at,ends_at,status,access_hash,approval,terms_version,terms_accepted_at)
  values(v_id,v_member_id,jsonb_build_object('studentId',v_student,'name',v_name,'contact',''),v_start,v_end,'reserved',v_hash,'pending',v_consent_version,v_now);
 insert into private.lifecycle_reservation_assets(reservation_id,asset_id) select v_id,x from unnest(v_ids) x;
 insert into private.lifecycle_events(actor_type,actor_id,action,reservation_id,details) values('member',v_member_id,'apply',v_id,jsonb_build_object('selfService',true));
 v_result:=jsonb_build_object('reservation',private.lifecycle_reservation_json(v_id));
 return private.lifecycle_save_receipt('applicant',v_actor,'apply',p_payload,v_result);
end $$;

create or replace function private.lifecycle_member_core(p_action text,p_token text,p_payload jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 v_member private.lifecycle_members; v_res private.lifecycle_reservations;
 v_photo private.lifecycle_photos;
 v_existing jsonb; v_result jsonb; v_id uuid; v_asset_id uuid;
 v_start timestamptz; v_end timestamptz; v_data bytea; v_mime text;
 v_phase text; v_slot text; v_checks jsonb; v_signature jsonb;
 v_name text; v_note text; v_abnormal boolean; v_now timestamptz:=clock_timestamp();
 v_scope uuid; v_signer text;
begin
 if p_action='calendar' then
  if not private.lifecycle_keys(p_payload,array['start','end']) or not (p_payload ?& array['start','end']) then raise exception 'Invalid calendar range'; end if;
  v_start:=private.lifecycle_time(p_payload->>'start'); v_end:=private.lifecycle_time(p_payload->>'end');
  if v_end<=v_start or v_end>v_start+interval '42 days' then raise exception 'Invalid calendar range'; end if;
  return jsonb_build_object(
   'assets',coalesce((select jsonb_agg(private.lifecycle_asset_json(a) order by a.code) from private.lifecycle_assets a),'[]'::jsonb),
   'bookings',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'assetIds',(select jsonb_agg(ra.asset_id order by a.code) from private.lifecycle_reservation_assets ra join private.lifecycle_assets a on a.id=ra.asset_id where ra.reservation_id=r.id),'start',r.starts_at,'end',r.ends_at,'status',r.status,'pending',r.approval='pending') order by r.starts_at,r.id)
      from private.lifecycle_reservations r where ((r.status='reserved' and r.approval='approved' and r.starts_at<v_end and r.ends_at>v_start)
             or r.status='in_use')),'[]'::jsonb),
   'settings',private.lifecycle_settings_json(),'updatedAt',v_now);
 end if;
 if p_action='apply' then return private.lifecycle_apply_core(p_payload); end if;
 v_scope:=private.lifecycle_booking_scope(p_token);
 select m.* into v_member from private.lifecycle_members m join private.lifecycle_reservations r on r.member_id=m.id where r.id=v_scope;
 if p_action='me' then
  if not private.lifecycle_keys(p_payload,array[]::text[]) then raise exception 'Invalid payload'; end if;
  return jsonb_build_object('member',private.lifecycle_member_json(v_member),'reservations',jsonb_build_array(private.lifecycle_reservation_json(v_scope)),'settings',private.lifecycle_settings_json());
 end if;
 if p_action='photo_read' then
  if not private.lifecycle_keys(p_payload,array['id']) then raise exception 'Invalid payload'; end if;
  v_id:=private.lifecycle_uuid(p_payload->>'id');
  select p.* into v_photo from private.lifecycle_photos p join private.lifecycle_reservations r on r.id=p.reservation_id where p.id=v_id and r.id=v_scope;
  if not found then raise exception 'Photo not found'; end if;
  return jsonb_build_object('photo',private.lifecycle_photo_json(v_photo,true));
 end if;
 if p_action not in ('photo','pickup','return','cancel') then raise exception 'Unknown lifecycle action'; end if;
 -- A single private row serializes every new booking, legacy inventory check, asset state
 -- change, and lifecycle transition. It also closes the read/check/insert gap.
 perform 1 from private.settings where id=1 for update;
 perform 1 from private.lifecycle_settings where id=1 for update;
 -- Re-read after waiting so an officer's concurrent key rotation wins.
 v_scope:=private.lifecycle_booking_scope(p_token);
 if private.lifecycle_uuid(p_payload->>'reservationId') is distinct from v_scope then raise exception 'Reservation not found'; end if;
 select m.* into v_member from private.lifecycle_members m join private.lifecycle_reservations r on r.member_id=m.id where r.id=v_scope for update of m;
 v_now:=clock_timestamp();
 v_existing:=private.lifecycle_receipt('member',v_member.id,p_action,p_payload);
 if v_existing is not null then return v_existing; end if;
 if p_action='photo' then
  if not private.lifecycle_keys(p_payload,array['requestId','reservationId','assetId','phase','slot','mime','data']) or not (p_payload ?& array['requestId','reservationId','assetId','phase','slot','mime','data']) then raise exception 'Invalid photo'; end if;
  if private.lifecycle_photo_backend()<>'database' then raise exception 'Photo uploads use the photo service'; end if;
  if length(p_payload->>'data')>11184812 or (p_payload->>'data') !~ '^[A-Za-z0-9+/]+={0,2}$' then raise exception 'Invalid photo data'; end if;
  v_data:=pg_catalog.decode(p_payload->>'data','base64');
  perform private.lifecycle_photo_gate(v_member.id,v_scope,p_payload,octet_length(v_data),v_now);
  v_id:=private.lifecycle_uuid(p_payload->>'reservationId'); v_phase:=p_payload->>'phase'; v_slot:=p_payload->>'slot'; v_mime:=p_payload->>'mime';
  if (v_mime='image/jpeg' and pg_catalog.encode(substring(v_data from 1 for 3),'hex')<>'ffd8ff')
    or (v_mime='image/png' and pg_catalog.encode(substring(v_data from 1 for 8),'hex')<>'89504e470d0a1a0a')
    or (v_mime='image/webp' and (substring(v_data from 1 for 4)<>pg_catalog.convert_to('RIFF','UTF8') or substring(v_data from 9 for 4)<>pg_catalog.convert_to('WEBP','UTF8'))) then raise exception 'Photo signature mismatch'; end if;
  v_asset_id:=pg_catalog.gen_random_uuid();
  insert into private.lifecycle_photos(id,reservation_id,asset_id,phase,slot,mime,bytes,size,sha256)
   values(v_asset_id,v_id,private.lifecycle_uuid(p_payload->>'assetId'),v_phase,v_slot,v_mime,v_data,octet_length(v_data),pg_catalog.encode(pg_catalog.sha256(v_data),'hex')) returning * into v_photo;
  insert into private.lifecycle_events(actor_type,actor_id,action,reservation_id,details)
   values('member',v_member.id,'photo',v_id,jsonb_build_object('photoId',v_photo.id,'phase',v_phase,'slot',v_slot));
  v_result:=jsonb_build_object('photo',private.lifecycle_photo_json(v_photo));
 else
  if p_action='pickup' then
   if not private.lifecycle_keys(p_payload,array['requestId','reservationId','checks','notes','signature']) or not (p_payload ?& array['requestId','reservationId','checks','notes','signature']) then raise exception 'Invalid pickup'; end if;
  elsif p_action='return' then
   if not private.lifecycle_keys(p_payload,array['requestId','reservationId','checks','notes','abnormal']) or not (p_payload ?& array['requestId','reservationId','checks','notes','abnormal']) then raise exception 'Invalid return'; end if;
  else
   if not private.lifecycle_keys(p_payload,array['requestId','reservationId','reason']) or not (p_payload ?& array['requestId','reservationId','reason']) then raise exception 'Invalid cancellation'; end if;
  end if;
  v_id:=private.lifecycle_uuid(p_payload->>'reservationId');
  select * into v_res from private.lifecycle_reservations where id=v_scope for update;
  if not found then raise exception 'Reservation not found'; end if;
  if p_action='cancel' then
   if v_res.status<>'reserved' or not private.lifecycle_text(p_payload->>'reason',500,true) then raise exception 'Cannot cancel reservation'; end if;
   update private.lifecycle_reservations set status='cancelled',updated_at=v_now where id=v_id;
   insert into private.lifecycle_events(actor_type,actor_id,action,reservation_id,details) values('member',v_member.id,'cancel',v_id,jsonb_build_object('reason',btrim(p_payload->>'reason')));
  else
   v_checks:=p_payload->'checks'; v_note:=p_payload->>'notes';
   if v_note is null or length(v_note)>1000 or regexp_replace(v_note,E'[\r\n]','','g') ~ '[[:cntrl:]]' then raise exception 'Invalid inspection notes'; end if;
   if not private.lifecycle_checks(v_checks,p_action='pickup') or not private.lifecycle_all_photos(v_id,p_action) then raise exception 'Inspection incomplete'; end if;
   if p_action='pickup' then
    if v_res.status<>'reserved' or v_now<v_res.starts_at or v_now>=v_res.ends_at then raise exception 'Pickup outside reservation'; end if;
    if v_res.approval<>'approved' then raise exception 'Officer approval required'; end if;
    -- Taking the bike out reserves its four return photos; refuse while that room is not free.
    if not private.lifecycle_photo_room(v_id,'pickup',null,0) then raise exception 'Photo capacity reserved for mandatory return photos; contact officers'; end if;
    if not v_member.active then raise exception 'Membership inactive'; end if;
    v_signer:=coalesce(nullif(btrim(v_res.borrower->>'name'),''),v_member.name);
    if exists(select 1 from private.records where student_id=v_member.student_id and status='borrowed') then raise exception 'Existing legacy loan or application'; end if;
    if exists(select 1 from private.lifecycle_reservations where member_id=v_member.id and status='in_use') then raise exception 'Member already has an active loan'; end if;
    if exists(select 1 from private.lifecycle_reservation_assets ra join private.lifecycle_assets a on a.id=ra.asset_id where ra.reservation_id=v_id and a.state<>'available') then raise exception 'Asset unavailable'; end if;
    if exists(select 1 from private.lifecycle_reservation_assets mine join private.lifecycle_reservation_assets other on other.asset_id=mine.asset_id join private.lifecycle_reservations active on active.id=other.reservation_id where mine.reservation_id=v_id and active.id<>v_id and active.status='in_use') then raise exception 'Asset still in use'; end if;
    v_signature:=p_payload->'signature';
    if not private.lifecycle_keys(v_signature,array['name','accepted','termsVersion','image']) or not (v_signature ?& array['name','accepted','termsVersion','image']) or v_signature->'accepted'<>'true'::jsonb then raise exception 'Signature required'; end if;
    v_name:=btrim(v_signature->>'name');
    if not private.lifecycle_text(v_name,80) or v_name<>v_signer or v_signature->>'termsVersion'<>(select terms_version from private.lifecycle_settings where id=1) then raise exception 'Signature or terms mismatch'; end if;
    if coalesce(length(v_signature->>'image'),0)>350000 or (v_signature->>'image') !~ '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$' then raise exception 'Invalid signature image'; end if;
    v_data:=pg_catalog.decode(substring(v_signature->>'image' from 23),'base64');
    if octet_length(v_data)<128 or octet_length(v_data)>262144 or pg_catalog.encode(substring(v_data from 1 for 8),'hex')<>'89504e470d0a1a0a'
       or substring(v_data from 13 for 4)<>pg_catalog.convert_to('IHDR','UTF8')
       or (pg_catalog.get_byte(v_data,16)*16777216+pg_catalog.get_byte(v_data,17)*65536+pg_catalog.get_byte(v_data,18)*256+pg_catalog.get_byte(v_data,19))<100
       or (pg_catalog.get_byte(v_data,20)*16777216+pg_catalog.get_byte(v_data,21)*65536+pg_catalog.get_byte(v_data,22)*256+pg_catalog.get_byte(v_data,23))<30 then raise exception 'Invalid signature image'; end if;
    insert into private.lifecycle_inspections(id,reservation_id,phase,checks,notes,abnormal) values(pg_catalog.gen_random_uuid(),v_id,'pickup',v_checks,v_note,false);
    insert into private.lifecycle_signatures(reservation_id,name,terms,terms_version,image) values(v_id,v_name,(select terms from private.lifecycle_settings where id=1),v_signature->>'termsVersion',v_data);
    update private.lifecycle_reservations set status='in_use',picked_up_at=v_now,updated_at=v_now where id=v_id;
    insert into private.lifecycle_events(actor_type,actor_id,action,reservation_id) values('member',v_member.id,'pickup',v_id);
   else
    if v_res.status<>'in_use' or jsonb_typeof(p_payload->'abnormal')<>'boolean' then raise exception 'Invalid return'; end if;
    v_abnormal:=(p_payload->>'abnormal')::boolean or exists(select 1 from jsonb_each(v_checks) x where x.value='false'::jsonb);
    insert into private.lifecycle_inspections(id,reservation_id,phase,checks,notes,abnormal) values(pg_catalog.gen_random_uuid(),v_id,'return',v_checks,v_note,v_abnormal);
    update private.lifecycle_reservations set status=case when v_abnormal then 'inspection' else 'returned' end,returned_at=v_now,updated_at=v_now where id=v_id;
    if v_abnormal then
     update private.lifecycle_assets set state='inspection',updated_at=v_now where id in (select asset_id from private.lifecycle_reservation_assets where reservation_id=v_id);
     insert into private.lifecycle_notifications(reservation_id,message) values(v_id,'Return requires officer inspection');
    end if;
    insert into private.lifecycle_events(actor_type,actor_id,action,reservation_id,details) values('member',v_member.id,'return',v_id,jsonb_build_object('abnormal',v_abnormal));
   end if;
  end if;
  v_result:=jsonb_build_object('reservation',private.lifecycle_reservation_json(v_id));
 end if;
 return private.lifecycle_save_receipt('member',v_member.id,p_action,p_payload,v_result);
end $$;

create or replace function private.lifecycle_admin_core(p_action text,p_payload jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 v_actor uuid; v_res private.lifecycle_reservations; v_asset private.lifecycle_assets;
 v_member private.lifecycle_members; v_photo private.lifecycle_photos;
 v_id uuid; v_existing jsonb; v_result jsonb; v_token text; v_reason text; v_min integer; v_max integer;
 v_state text; v_student text; v_contact text; v_ids uuid[]; v_now timestamptz;
begin
 v_actor:=private.require_admin();
 perform set_config('response.headers','[{"Cache-Control":"no-store"}]',true);
 if coalesce(nullif(current_setting('request.method',true),''),'POST')<>'POST' or current_setting('transaction_read_only')='on' then raise exception 'POST required'; end if;
 if p_action='list' then
  if not private.lifecycle_keys(p_payload,array[]::text[]) then raise exception 'Invalid payload'; end if;
  return jsonb_build_object(
   'assets',coalesce((select jsonb_agg(private.lifecycle_asset_json(a) order by a.code) from private.lifecycle_assets a),'[]'::jsonb),
   'members',coalesce((select jsonb_agg(private.lifecycle_member_json(m) order by m.student_id) from private.lifecycle_members m),'[]'::jsonb),
   'reservations',coalesce((select jsonb_agg(private.lifecycle_reservation_json(r.id) order by r.created_at desc) from private.lifecycle_reservations r),'[]'::jsonb),
   'settings',private.lifecycle_settings_json(),'storage',private.lifecycle_storage_json(),
   'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'actorType',e.actor_type,'actorId',e.actor_id,'action',e.action,'reservationId',e.reservation_id,'details',e.details,'at',e.at) order by e.id desc) from private.lifecycle_events e),'[]'::jsonb),
   'notifications',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'reservationId',n.reservation_id,'message',n.message,'createdAt',n.created_at,'resolvedAt',n.resolved_at,'resolvedBy',n.resolved_by) order by n.id desc) from private.lifecycle_notifications n),'[]'::jsonb));
 end if;
 if p_action='photo_read' then
  if not private.lifecycle_keys(p_payload,array['id']) then raise exception 'Invalid payload'; end if;
  select * into v_photo from private.lifecycle_photos where id=private.lifecycle_uuid(p_payload->>'id');
  if not found then raise exception 'Photo not found'; end if;
  return jsonb_build_object('photo',private.lifecycle_photo_json(v_photo,true));
 end if;
 if p_action='export' then
  if not private.lifecycle_keys(p_payload,array[]::text[]) then raise exception 'Invalid payload'; end if;
  insert into private.lifecycle_events(actor_type,actor_id,action) values('staff',v_actor,'export');
  return jsonb_build_object('assets',coalesce((select jsonb_agg(to_jsonb(a) order by a.code) from private.lifecycle_assets a),'[]'::jsonb),
   'members',coalesce((select jsonb_agg(to_jsonb(m) order by m.student_id) from private.lifecycle_members m),'[]'::jsonb),
   'reservations',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at) from private.lifecycle_reservations r),'[]'::jsonb),
   'reservationAssets',coalesce((select jsonb_agg(to_jsonb(ra)) from private.lifecycle_reservation_assets ra),'[]'::jsonb),
   'photos',coalesce((select jsonb_agg(private.lifecycle_photo_json(p,true) order by p.uploaded_at) from private.lifecycle_photos p),'[]'::jsonb),
   'inspections',coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at) from private.lifecycle_inspections i),'[]'::jsonb),
   'signatures',coalesce((select jsonb_agg(to_jsonb(s) - 'image' || jsonb_build_object('image','data:image/png;base64,'||pg_catalog.encode(s.image,'base64')) order by s.signed_at) from private.lifecycle_signatures s),'[]'::jsonb),
   'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from private.lifecycle_events e),'[]'::jsonb),
   'notifications',coalesce((select jsonb_agg(to_jsonb(n) order by n.id) from private.lifecycle_notifications n),'[]'::jsonb),
   'requests',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at) from private.lifecycle_requests q),'[]'::jsonb),
   'settings',(select to_jsonb(s) from private.lifecycle_settings s where id=1));
 end if;
 if p_action not in ('asset','member','settings','resolve','cancel','approve','access') then raise exception 'Unknown admin lifecycle action'; end if;
 perform 1 from private.settings where id=1 for update;
 perform 1 from private.lifecycle_settings where id=1 for update;
 v_now:=clock_timestamp();
 if p_action in ('resolve','cancel','approve','access') then
  v_existing:=private.lifecycle_receipt('staff',v_actor,p_action,p_payload);
  if v_existing is not null then return v_existing; end if;
  if p_action='approve' then
   if not private.lifecycle_keys(p_payload,array['requestId','reservationId']) or not (p_payload ?& array['requestId','reservationId']) then raise exception 'Invalid approval'; end if;
  elsif p_action='access' then
   if not private.lifecycle_keys(p_payload,array['requestId','reservationId','key']) or not (p_payload ?& array['requestId','reservationId','key']) or not coalesce((p_payload->>'key') ~ '^[a-f0-9]{64}$',false) then raise exception 'Invalid booking key'; end if;
  elsif p_action='resolve' then
   if not private.lifecycle_keys(p_payload,array['requestId','reservationId','reason','state']) or not (p_payload ?& array['requestId','reservationId','reason','state']) then raise exception 'Invalid resolution'; end if;
  else
   if not private.lifecycle_keys(p_payload,array['requestId','reservationId','reason']) or not (p_payload ?& array['requestId','reservationId','reason']) then raise exception 'Invalid cancellation'; end if;
  end if;
  v_id:=private.lifecycle_uuid(p_payload->>'reservationId'); v_reason:=btrim(p_payload->>'reason');
  if p_action in ('resolve','cancel') and not private.lifecycle_text(v_reason,500,true) then raise exception 'Reason required'; end if;
  select * into v_res from private.lifecycle_reservations where id=v_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if p_action='approve' then
   if v_res.status<>'reserved' or v_res.approval<>'pending' then raise exception 'Reservation does not need approval'; end if;
   if v_res.ends_at<=v_now then raise exception 'Reservation window has ended'; end if;
   select array_agg(ra.asset_id) into v_ids from private.lifecycle_reservation_assets ra where ra.reservation_id=v_id;
   if v_ids is null or exists(select 1 from private.lifecycle_assets a where a.id=any(v_ids) and a.state<>'available') then
    raise exception 'Asset unavailable';
   end if;
   if private.lifecycle_assets_occupied(v_ids,v_res.starts_at,v_res.ends_at) then raise exception 'Reservation conflict'; end if;
   update private.lifecycle_reservations set approval='approved',approved_at=v_now,updated_at=v_now where id=v_id;
   -- Close only requests that directly share an asset and overlap this approval.
   with declined as (
    update private.lifecycle_reservations r
      set status='cancelled',allocation_declined=true,updated_at=v_now
    where r.status='reserved' and r.approval='pending'
      and r.starts_at<v_res.ends_at and r.ends_at>v_res.starts_at
      and exists(select 1 from private.lifecycle_reservation_assets ra where ra.reservation_id=r.id and ra.asset_id=any(v_ids))
    returning r.id
   )
   insert into private.lifecycle_events(actor_type,actor_id,action,reservation_id,details)
    select 'staff',v_actor,'allocation_declined',d.id,jsonb_build_object('approvedReservationId',v_id) from declined d;
  elsif p_action='access' then
   if v_res.status not in ('reserved','in_use') then raise exception 'Only active bookings can get a new key'; end if;
   v_token:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_payload->>'key','UTF8')),'hex');
   if exists(select 1 from private.lifecycle_members where token_hash=v_token)
       or exists(select 1 from private.lifecycle_reservations where access_hash=v_token) then raise exception 'Generate another key'; end if;
   update private.lifecycle_reservations set access_hash=v_token,updated_at=v_now where id=v_id;
  elsif p_action='resolve' then
   v_state:=p_payload->>'state';
   if v_res.status<>'inspection' or v_state not in ('available','maintenance') then raise exception 'Cannot resolve reservation'; end if;
   -- If a later booking was placed before the abnormal return, do not silently
   -- release an asset into availability while that reservation still exists.
   if exists(select 1 from private.lifecycle_reservation_assets ra join private.lifecycle_reservation_assets other on other.asset_id=ra.asset_id join private.lifecycle_reservations r on r.id=other.reservation_id where ra.reservation_id=v_id and r.id<>v_id and (r.status='in_use' or (v_state='maintenance' and r.status='reserved'))) then raise exception 'Cancel bookings before changing state'; end if;
   update private.lifecycle_assets set state=v_state,updated_at=v_now where id in (select asset_id from private.lifecycle_reservation_assets where reservation_id=v_id);
   update private.lifecycle_reservations set status='returned',updated_at=v_now where id=v_id;
   update private.lifecycle_notifications set resolved_at=v_now,resolved_by=v_actor where reservation_id=v_id and resolved_at is null;
  else
   if v_res.status<>'reserved' then raise exception 'Cannot cancel reservation'; end if;
   update private.lifecycle_reservations set status='cancelled',updated_at=v_now where id=v_id;
  end if;
  insert into private.lifecycle_events(actor_type,actor_id,action,reservation_id,details) values('staff',v_actor,p_action,v_id,jsonb_build_object('reason',v_reason,'state',v_state));
  v_result:=jsonb_build_object('reservation',private.lifecycle_reservation_json(v_id));
  return private.lifecycle_save_receipt('staff',v_actor,p_action,p_payload,v_result);
 end if;
 if p_action='settings' then
  if not private.lifecycle_keys(p_payload,array['location','instructions','terms']) or not (p_payload ?& array['location','terms']) then raise exception 'Invalid settings'; end if;
  if not private.lifecycle_text(p_payload->>'location',500) or not private.lifecycle_text(p_payload->>'terms',10000,true) then raise exception 'Policy fields required'; end if;
  update private.lifecycle_settings set location=btrim(p_payload->>'location'),terms=btrim(p_payload->>'terms'),terms_version=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(btrim(p_payload->>'terms'),'UTF8')),'hex'),updated_at=v_now where id=1;
  insert into private.lifecycle_events(actor_type,actor_id,action,details) values('staff',v_actor,'settings',jsonb_build_object('termsVersion',(select terms_version from private.lifecycle_settings where id=1)));
  return jsonb_build_object('settings',private.lifecycle_settings_json());
 end if;
 if p_action='asset' then
  if not private.lifecycle_keys(p_payload,array['id','code','name','kind','state','reason','minHeight','maxHeight']) or not (p_payload ?& array['code','name','kind','state','reason']) then raise exception 'Invalid asset'; end if;
  v_reason:=btrim(p_payload->>'reason'); v_state:=p_payload->>'state';
  if not private.lifecycle_text(p_payload->>'code',40) or not private.lifecycle_text(p_payload->>'name',120) or not private.lifecycle_text(v_reason,500,true)
     or p_payload->>'kind' not in ('bike','accessory') or v_state not in ('available','inspection','maintenance','retired') then raise exception 'Invalid asset'; end if;
  if p_payload ? 'id' and p_payload->>'id' is not null then
   v_id:=private.lifecycle_uuid(p_payload->>'id');
   select * into v_asset from private.lifecycle_assets where id=v_id for update;
   if not found then raise exception 'Asset not found'; end if;
   if (v_asset.code<>p_payload->>'code' or v_asset.kind<>p_payload->>'kind') and exists(select 1 from private.lifecycle_reservation_assets where asset_id=v_id) then raise exception 'Booked asset identity cannot change'; end if;
   if v_state<>'available' and exists(select 1 from private.lifecycle_reservation_assets ra join private.lifecycle_reservations r on r.id=ra.reservation_id where ra.asset_id=v_id and r.status in ('reserved','in_use')) then raise exception 'Cancel bookings before changing state'; end if;
   if v_state='available' and exists(select 1 from private.lifecycle_reservation_assets ra join private.lifecycle_reservations r on r.id=ra.reservation_id where ra.asset_id=v_id and r.status in ('in_use','inspection')) then raise exception 'Resolve active loan first'; end if;
   -- An older page that omits the heights keeps the saved range.
   v_min:=case when p_payload ? 'minHeight' then private.lifecycle_height(p_payload->'minHeight') else v_asset.min_height_cm end;
   v_max:=case when p_payload ? 'maxHeight' then private.lifecycle_height(p_payload->'maxHeight') else v_asset.max_height_cm end;
   if p_payload->>'kind'<>'bike' then v_min:=null; v_max:=null; end if;
   if v_min>v_max then raise exception 'Invalid height range'; end if;
   update private.lifecycle_assets set code=btrim(p_payload->>'code'),name=btrim(p_payload->>'name'),kind=p_payload->>'kind',state=v_state,min_height_cm=v_min,max_height_cm=v_max,updated_at=v_now where id=v_id returning * into v_asset;
  else
   v_id:=pg_catalog.gen_random_uuid();
   v_min:=private.lifecycle_height(p_payload->'minHeight'); v_max:=private.lifecycle_height(p_payload->'maxHeight');
   if p_payload->>'kind'<>'bike' then v_min:=null; v_max:=null; end if;
   if v_min>v_max then raise exception 'Invalid height range'; end if;
   insert into private.lifecycle_assets(id,code,name,kind,state,min_height_cm,max_height_cm) values(v_id,btrim(p_payload->>'code'),btrim(p_payload->>'name'),p_payload->>'kind',v_state,v_min,v_max) returning * into v_asset;
  end if;
  insert into private.lifecycle_events(actor_type,actor_id,action,details) values('staff',v_actor,'asset',jsonb_build_object('assetId',v_id,'reason',v_reason));
  return jsonb_build_object('asset',private.lifecycle_asset_json(v_asset));
 end if;
 if not private.lifecycle_keys(p_payload,array['id','studentId','name','contact','validUntil','active','reason']) or not (p_payload ?& array['studentId','name','active','reason']) then raise exception 'Invalid member'; end if;
 v_student:=upper(btrim(p_payload->>'studentId')); v_reason:=btrim(p_payload->>'reason');
 v_contact:=coalesce(btrim(p_payload->>'contact'),'');
 if v_student !~ '^[A-Z0-9-]{1,30}$' or not private.lifecycle_text(p_payload->>'name',80) or (v_contact<>'' and not private.lifecycle_text(v_contact,200)) or not private.lifecycle_text(v_reason,500,true) or jsonb_typeof(p_payload->'active')<>'boolean' then raise exception 'Invalid member'; end if;
 if p_payload ? 'id' and p_payload->>'id' is not null then
  v_id:=private.lifecycle_uuid(p_payload->>'id');
  select * into v_member from private.lifecycle_members where id=v_id for update;
  if not found then raise exception 'Member not found'; end if;
  if (v_member.student_id<>v_student or v_member.name<>btrim(p_payload->>'name'))
    and exists(select 1 from private.lifecycle_reservations where member_id=v_id and status in ('reserved','in_use','inspection')) then raise exception 'Member identity cannot change during active loan'; end if;
  update private.lifecycle_members
    set student_id=v_student,name=btrim(p_payload->>'name'),contact=v_contact,
        valid_until=case when p_payload ? 'validUntil' then private.lifecycle_time(p_payload->>'validUntil') else valid_until end,
        active=(p_payload->>'active')::boolean,updated_at=v_now
    where id=v_id returning * into v_member;
 else
  v_id:=pg_catalog.gen_random_uuid();
  insert into private.lifecycle_members(id,student_id,name,contact,valid_until,active,token_hash)
   values(v_id,v_student,btrim(p_payload->>'name'),v_contact,
    case when p_payload ? 'validUntil' then private.lifecycle_time(p_payload->>'validUntil') else '2099-12-31T00:00:00Z'::timestamptz end,
    (p_payload->>'active')::boolean,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.gen_random_uuid()::text||pg_catalog.gen_random_uuid()::text,'UTF8')),'hex'))
   returning * into v_member;
 end if;
 insert into private.lifecycle_events(actor_type,actor_id,action,details) values('staff',v_actor,'member',jsonb_build_object('memberId',v_id,'reason',v_reason));
 return jsonb_build_object('member',private.lifecycle_member_json(v_member));
end $$;

create or replace function public.lifecycle_photo_service(p_action text,p_token text,p_payload jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 v_member private.lifecycle_members; v_photo private.lifecycle_photos; v_scope uuid;
 v_request jsonb; v_existing jsonb; v_result jsonb; v_size bigint; v_now timestamptz;
begin
 perform set_config('response.headers','[{"Cache-Control":"no-store"}]',true);
 if p_action is null or p_action not in ('check','commit','read') then raise exception 'Unknown photo service action'; end if;
 if p_action='commit' then
  perform 1 from private.settings where id=1 for update;
  perform 1 from private.lifecycle_settings where id=1 for update;
 end if;
 v_scope:=private.lifecycle_booking_scope(p_token);
 select m.* into v_member from private.lifecycle_members m join private.lifecycle_reservations r on r.member_id=m.id where r.id=v_scope;
 if p_action='read' then
  if not private.lifecycle_keys(p_payload,array['id']) then raise exception 'Invalid payload'; end if;
  select p.* into v_photo from private.lifecycle_photos p join private.lifecycle_reservations r on r.id=p.reservation_id
   where p.id=private.lifecycle_uuid(p_payload->>'id') and r.id=v_scope;
  if not found then raise exception 'Photo not found'; end if;
  return jsonb_build_object('photo',private.lifecycle_photo_json(v_photo,true));
 end if;
 if not private.lifecycle_keys(p_payload,array['requestId','reservationId','assetId','phase','slot','mime','size','sha256','driveFileId'])
    or not (p_payload ?& array['requestId','reservationId','assetId','phase','slot','mime','size','sha256'])
    or (p_action='commit')<>(p_payload ? 'driveFileId') then raise exception 'Invalid photo'; end if;
 if jsonb_typeof(p_payload->'size')<>'number' or (p_payload->>'size') !~ '^[0-9]{1,10}$' or (p_payload->>'sha256') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid photo data'; end if;
 v_size:=(p_payload->>'size')::bigint; v_request:=p_payload-'driveFileId'; v_now:=clock_timestamp();
 if private.lifecycle_uuid(v_request->>'reservationId') is distinct from v_scope then raise exception 'Reservation not found'; end if;
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
revoke all on function public.lifecycle(text,text,jsonb),public.lifecycle_admin(text,jsonb),public.lifecycle_photo_service(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.lifecycle(text,text,jsonb) to anon,authenticated;
grant execute on function public.lifecycle_admin(text,jsonb) to authenticated;
grant execute on function public.lifecycle_photo_service(text,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
