-- Close the legacy waiting list and separate the numbered fleet from its aggregate total. Apply once after 013.
-- Members can no longer register, look up or be lent a bike through the legacy queue, and officers can no
-- longer change its total, loan count or schedules. Existing legacy rows stay intact: officers may still
-- return, cancel and export them. Marking numbered bikes available and member pickups no longer count
-- against the legacy total, and the legacy summary counts only legacy loans again.
begin;
set local lock_timeout='15s';
do $$ begin
 if to_regprocedure('private.lifecycle_fleet_guard()') is null then
  raise exception '014 is already installed; do not replay';
 end if;
end $$;

drop trigger lifecycle_fleet_guard on private.lifecycle_assets;
drop trigger lifecycle_settings_inventory_guard on private.settings;
drop trigger lifecycle_opening_inventory_guard on private.opening_loans;
drop function private.lifecycle_fleet_guard();
drop function private.lifecycle_inventory_guard();

create or replace function private.borrowed_count() returns bigint language sql volatile security definer set search_path='' as $$
 select (select count(*) from private.records where status='borrowed')
      + (select outstanding from private.opening_loans where id=1)
$$;

-- Existing rows may still be returned, cancelled or annotated; nothing may enter the queue or go out on loan.
create or replace function private.lifecycle_legacy_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status in ('waiting','borrowed') and (tg_op='INSERT' or old.status<>new.status) then
  raise exception '舊版借車登記已關閉，請改用社車預約';
 end if;
 return new;
end $$;

-- Only a bike still out on the closed legacy list blocks a new booking; a stale waiting entry does not.
create or replace function private.lifecycle_apply_core(p_payload jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 v_member private.lifecycle_members; v_member_id uuid; v_existing jsonb; v_result jsonb; v_id uuid; v_ids uuid[];
 v_start timestamptz; v_end timestamptz; v_hash text; v_actor uuid; v_student text; v_name text;
 v_storage jsonb; v_now timestamptz;
begin
 if not private.lifecycle_keys(p_payload,array['requestId','studentId','name','assetIds','start','end','key']) or not (p_payload ?& array['requestId','studentId','name','assetIds','start','end','key']) then raise exception 'Invalid application'; end if;
 if (p_payload->>'key') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid booking key'; end if;
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
 v_start:=private.lifecycle_time(p_payload->>'start'); v_end:=private.lifecycle_time(p_payload->>'end');
 if v_start<v_now or v_end<=v_start or v_end>v_start+interval '5 days' then raise exception 'Invalid reservation window'; end if;
 if jsonb_typeof(p_payload->'assetIds')<>'array' or jsonb_array_length(p_payload->'assetIds')<1 or jsonb_array_length(p_payload->'assetIds')>20 then raise exception 'Invalid assets'; end if;
 select array_agg(private.lifecycle_uuid(x.value)) into v_ids from jsonb_array_elements_text(p_payload->'assetIds') x;
 if (select count(distinct x) from unnest(v_ids) x)<>cardinality(v_ids) then raise exception 'Duplicate asset'; end if;
 if (select count(*) from private.lifecycle_assets a where a.id=any(v_ids))<>cardinality(v_ids)
    or (select count(*) from private.lifecycle_assets a where a.id=any(v_ids) and a.kind='bike')<>1
    or exists(select 1 from private.lifecycle_assets a where a.id=any(v_ids) and a.state<>'available') then raise exception 'Asset unavailable'; end if;
 if exists(select 1 from private.records where student_id=v_student and status='borrowed') then raise exception 'Existing legacy loan or application'; end if;
 if v_member_id is not null and exists(select 1 from private.lifecycle_reservations where member_id=v_member_id and status in ('reserved','in_use','inspection')) then raise exception 'Member already has an active reservation'; end if;
 if exists(select 1 from private.lifecycle_reservation_assets ra join private.lifecycle_reservations r on r.id=ra.reservation_id
  where ra.asset_id=any(v_ids) and r.status in ('reserved','in_use') and
  ((r.starts_at<v_end and r.ends_at>v_start) or (r.status='in_use' and r.ends_at<=v_start))) then raise exception 'Reservation conflict'; end if;
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
 insert into private.lifecycle_reservations(id,member_id,borrower,starts_at,ends_at,status,access_hash,approval)
  values(v_id,v_member_id,jsonb_build_object('studentId',v_student,'name',v_name,'contact',''),v_start,v_end,'reserved',v_hash,'pending');
 insert into private.lifecycle_reservation_assets(reservation_id,asset_id) select v_id,x from unnest(v_ids) x;
 insert into private.lifecycle_events(actor_type,actor_id,action,reservation_id,details) values('member',v_member_id,'apply',v_id,jsonb_build_object('selfService',true));
 v_result:=jsonb_build_object('reservation',private.lifecycle_reservation_json(v_id));
 return private.lifecycle_save_receipt('applicant',v_actor,'apply',p_payload,v_result);
end $$;

-- Pickup no longer checks the legacy aggregate total; numbered bike availability is the only inventory gate.
create or replace function private.lifecycle_member_core(p_action text,p_token text,p_payload jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 v_member private.lifecycle_members; v_res private.lifecycle_reservations;
 v_asset private.lifecycle_assets; v_photo private.lifecycle_photos;
 v_existing jsonb; v_result jsonb; v_id uuid; v_asset_id uuid; v_ids uuid[];
 v_start timestamptz; v_end timestamptz; v_data bytea; v_mime text;
 v_phase text; v_slot text; v_checks jsonb; v_signature jsonb;
 v_name text; v_note text; v_abnormal boolean; v_storage jsonb; v_now timestamptz:=clock_timestamp();
 v_hash text; v_scope uuid; v_signer text;
begin
 if p_action='calendar' then
  if not private.lifecycle_keys(p_payload,array['start','end']) or not (p_payload ?& array['start','end']) then raise exception 'Invalid calendar range'; end if;
  v_start:=private.lifecycle_time(p_payload->>'start'); v_end:=private.lifecycle_time(p_payload->>'end');
  if v_end<=v_start or v_end>v_start+interval '42 days' then raise exception 'Invalid calendar range'; end if;
  return jsonb_build_object(
   'assets',coalesce((select jsonb_agg(private.lifecycle_asset_json(a) order by a.code) from private.lifecycle_assets a),'[]'::jsonb),
   'bookings',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'assetIds',(select jsonb_agg(ra.asset_id order by a.code) from private.lifecycle_reservation_assets ra join private.lifecycle_assets a on a.id=ra.asset_id where ra.reservation_id=r.id),'start',r.starts_at,'end',r.ends_at,'status',r.status,'pending',r.approval='pending') order by r.starts_at,r.id)
      from private.lifecycle_reservations r where r.status in ('reserved','in_use') and ((r.starts_at<v_end and r.ends_at>v_start) or r.status='in_use')),'[]'::jsonb),
   'settings',private.lifecycle_settings_json(),'updatedAt',v_now);
 end if;
 if p_action='apply' then return private.lifecycle_apply_core(p_payload); end if;
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception 'Invalid member token'; end if;
 -- A member credential sees all of that member's bookings; a booking key sees only its booking.
 v_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex');
 select * into v_member from private.lifecycle_members where token_hash=v_hash;
 if not found then
  select r.id into v_scope from private.lifecycle_reservations r where r.access_hash=v_hash;
  if not found then raise exception 'Invalid member token'; end if;
  select m.* into v_member from private.lifecycle_members m join private.lifecycle_reservations r on r.member_id=m.id where r.id=v_scope;
 end if;
 if p_action='me' then
  if not private.lifecycle_keys(p_payload,array[]::text[]) then raise exception 'Invalid payload'; end if;
  return jsonb_build_object('member',private.lifecycle_member_json(v_member),'reservations',coalesce((select jsonb_agg(private.lifecycle_reservation_json(r.id) order by r.created_at desc) from private.lifecycle_reservations r where r.member_id=v_member.id and (v_scope is null or r.id=v_scope)),'[]'::jsonb),'settings',private.lifecycle_settings_json());
 end if;
 if p_action='photo_read' then
  if not private.lifecycle_keys(p_payload,array['id']) then raise exception 'Invalid payload'; end if;
  v_id:=private.lifecycle_uuid(p_payload->>'id');
  select p.* into v_photo from private.lifecycle_photos p join private.lifecycle_reservations r on r.id=p.reservation_id where p.id=v_id and r.member_id=v_member.id and (v_scope is null or r.id=v_scope);
  if not found then raise exception 'Photo not found'; end if;
  return jsonb_build_object('photo',private.lifecycle_photo_json(v_photo,true));
 end if;
 if p_action not in ('reserve','photo','pickup','return','cancel') then raise exception 'Unknown lifecycle action'; end if;
 -- A single private row serializes every new booking, legacy inventory check, asset state
 -- change, and lifecycle transition. It also closes the read/check/insert gap.
 perform 1 from private.settings where id=1 for update;
 perform 1 from private.lifecycle_settings where id=1 for update;
 -- The first token lookup occurs before the global lock only to route reads.
 -- Re-read after waiting so a concurrent officer revocation or rotation wins.
 if v_scope is null then
  select * into v_member from private.lifecycle_members where token_hash=v_hash for update;
  if not found then raise exception 'Invalid member token'; end if;
 else
  select r.id into v_scope from private.lifecycle_reservations r where r.access_hash=v_hash;
  if not found then raise exception 'Invalid member token'; end if;
  select m.* into v_member from private.lifecycle_members m where m.id=(select member_id from private.lifecycle_reservations where id=v_scope) for update;
 end if;
 v_now:=clock_timestamp();
 v_existing:=private.lifecycle_receipt('member',v_member.id,p_action,p_payload);
 if v_existing is not null then return v_existing; end if;
 if p_action='reserve' then
  if not private.lifecycle_keys(p_payload,array['requestId','assetIds','start','end']) or not (p_payload ?& array['requestId','assetIds','start','end']) then raise exception 'Invalid reservation'; end if;
  if v_scope is not null then raise exception 'Use the booking form for a new reservation'; end if;
  if not v_member.active or v_member.valid_until<v_now then raise exception 'Membership inactive'; end if;
  if not private.lifecycle_policy_ready() then raise exception 'Borrow policy incomplete'; end if;
  v_start:=private.lifecycle_time(p_payload->>'start'); v_end:=private.lifecycle_time(p_payload->>'end');
  if v_start<v_now or v_end<=v_start or v_end>v_start+interval '5 days' or v_member.valid_until<v_end then raise exception 'Invalid reservation window'; end if;
  if jsonb_typeof(p_payload->'assetIds')<>'array' or jsonb_array_length(p_payload->'assetIds')<1 or jsonb_array_length(p_payload->'assetIds')>20 then raise exception 'Invalid assets'; end if;
  select array_agg(private.lifecycle_uuid(x.value)) into v_ids from jsonb_array_elements_text(p_payload->'assetIds') x;
  if (select count(distinct x) from unnest(v_ids) x)<>cardinality(v_ids) then raise exception 'Duplicate asset'; end if;
  if (select count(*) from private.lifecycle_assets a where a.id=any(v_ids))<>cardinality(v_ids)
     or (select count(*) from private.lifecycle_assets a where a.id=any(v_ids) and a.kind='bike')<>1
     or exists(select 1 from private.lifecycle_assets a where a.id=any(v_ids) and a.state<>'available') then raise exception 'Asset unavailable'; end if;
  if exists(select 1 from private.records where student_id=v_member.student_id and status='borrowed') then raise exception 'Existing legacy loan or application'; end if;
  if exists(select 1 from private.lifecycle_reservations where member_id=v_member.id and status in ('reserved','in_use','inspection')) then raise exception 'Member already has an active reservation'; end if;
  if exists(select 1 from private.lifecycle_reservation_assets ra join private.lifecycle_reservations r on r.id=ra.reservation_id
   where ra.asset_id=any(v_ids) and r.status in ('reserved','in_use') and
   ((r.starts_at<v_end and r.ends_at>v_start) or (r.status='in_use' and r.ends_at<=v_start))) then raise exception 'Reservation conflict'; end if;
  v_storage:=private.lifecycle_storage_json();
  if (v_storage->>'usedBytes')::bigint+(v_storage->>'reservedBytes')::bigint+67108864>(v_storage->>'budgetBytes')::bigint then raise exception 'Photo capacity reserved for existing loans; contact officers'; end if;
  v_id:=pg_catalog.gen_random_uuid();
  insert into private.lifecycle_reservations(id,member_id,borrower,starts_at,ends_at,status)
   values(v_id,v_member.id,jsonb_build_object('studentId',v_member.student_id,'name',v_member.name,'contact',v_member.contact),v_start,v_end,'reserved');
  insert into private.lifecycle_reservation_assets(reservation_id,asset_id) select v_id,x from unnest(v_ids) x;
  insert into private.lifecycle_events(actor_type,actor_id,action,reservation_id) values('member',v_member.id,'reserve',v_id);
  v_result:=jsonb_build_object('reservation',private.lifecycle_reservation_json(v_id));
 elsif p_action='photo' then
  if not private.lifecycle_keys(p_payload,array['requestId','reservationId','assetId','phase','slot','mime','data']) or not (p_payload ?& array['requestId','reservationId','assetId','phase','slot','mime','data']) then raise exception 'Invalid photo'; end if;
  v_id:=private.lifecycle_uuid(p_payload->>'reservationId'); v_asset_id:=private.lifecycle_uuid(p_payload->>'assetId');
  v_phase:=p_payload->>'phase'; v_slot:=p_payload->>'slot'; v_mime:=p_payload->>'mime';
  select * into v_res from private.lifecycle_reservations where id=v_id and member_id=v_member.id and (v_scope is null or id=v_scope) for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not exists(select 1 from private.lifecycle_reservation_assets ra join private.lifecycle_assets a on a.id=ra.asset_id where ra.reservation_id=v_id and ra.asset_id=v_asset_id and a.kind='bike') then raise exception 'Photo must belong to assigned bike'; end if;
  if v_slot not in ('left','right','drivetrain','damage') or v_mime not in ('image/jpeg','image/png','image/webp') then raise exception 'Invalid photo type'; end if;
  if v_phase='pickup' and v_res.approval<>'approved' then raise exception 'Officer approval required'; end if;
  if (v_phase='pickup' and (v_res.status<>'reserved' or v_now<v_res.starts_at or v_now>=v_res.ends_at))
     or (v_phase='return' and v_res.status<>'in_use') or v_phase not in ('pickup','return') then raise exception 'Invalid photo phase'; end if;
  if (select count(*) from private.lifecycle_photos where reservation_id=v_id and phase=v_phase)>=12 then raise exception 'Photo limit reached'; end if;
  if length(p_payload->>'data')>11184812 or (p_payload->>'data') !~ '^[A-Za-z0-9+/]+={0,2}$' then raise exception 'Invalid photo data'; end if;
  v_data:=pg_catalog.decode(p_payload->>'data','base64');
  if octet_length(v_data)<12 or octet_length(v_data)>8388608 then raise exception 'Photo size limit'; end if;
  if (v_mime='image/jpeg' and pg_catalog.encode(substring(v_data from 1 for 3),'hex')<>'ffd8ff')
    or (v_mime='image/png' and pg_catalog.encode(substring(v_data from 1 for 8),'hex')<>'89504e470d0a1a0a')
    or (v_mime='image/webp' and (substring(v_data from 1 for 4)<>pg_catalog.convert_to('RIFF','UTF8') or substring(v_data from 9 for 4)<>pg_catalog.convert_to('WEBP','UTF8'))) then raise exception 'Photo signature mismatch'; end if;
  v_storage:=private.lifecycle_storage_json();
  if (v_storage->>'usedBytes')::bigint+octet_length(v_data)+(v_storage->>'reservedBytes')::bigint
   -(case when exists(select 1 from private.lifecycle_photos where reservation_id=v_id and phase=v_phase and slot=v_slot) then 0 else 8388608 end)
   >(v_storage->>'budgetBytes')::bigint then raise exception 'Photo capacity reserved for mandatory return photos; contact officers'; end if;
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
  select * into v_res from private.lifecycle_reservations where id=v_id and member_id=v_member.id and (v_scope is null or id=v_scope) for update;
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
    -- Officer approval replaces the credential expiry for self-service bookings; a deactivated student ID stays blocked.
    if not v_member.active or (v_res.access_hash is null and v_member.valid_until<v_res.ends_at) then raise exception 'Membership inactive'; end if;
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

-- Closed legacy entry points, every overload included.
do $$
declare v_fn regprocedure;
begin
 for v_fn in select p.oid::regprocedure from pg_proc p where p.pronamespace='public'::regnamespace
  and p.proname in ('summary','register','lookup','admin_settings','admin_set_borrowed','admin_confirm_schedule') loop
  execute format('revoke all on function %s from public,anon,authenticated',v_fn);
 end loop;
end $$;

revoke all on all functions in schema private from public,anon,authenticated;
revoke all on function public.lifecycle(text,text,jsonb),public.lifecycle_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.lifecycle(text,text,jsonb) to anon,authenticated;
grant execute on function public.lifecycle_admin(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
