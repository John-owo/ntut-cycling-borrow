-- Numbered-asset reservation lifecycle. Apply once after 008; legacy records stay intact.
begin;

create table private.lifecycle_settings (
 id integer primary key check (id=1), location text not null default '',
 instructions text not null default '', terms text not null default '',
 terms_version text not null default '', updated_at timestamptz not null default now()
);
insert into private.lifecycle_settings(id) values(1);
create table private.lifecycle_assets (
 id uuid primary key, code text not null unique, name text not null,
 kind text not null check(kind in ('bike','accessory')),
 state text not null check(state in ('available','inspection','maintenance','retired')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table private.lifecycle_members (
 id uuid primary key, student_id text not null unique, name text not null,
 contact text not null, valid_until timestamptz not null, active boolean not null,
 token_hash text not null unique, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table private.lifecycle_reservations (
 id uuid primary key, member_id uuid not null references private.lifecycle_members(id),
 borrower jsonb not null,
 starts_at timestamptz not null, ends_at timestamptz not null,
 status text not null check(status in ('reserved','in_use','returned','inspection','cancelled')),
 created_at timestamptz not null default now(), picked_up_at timestamptz,
 returned_at timestamptz, updated_at timestamptz not null default now(),
 check(ends_at>starts_at)
);
create table private.lifecycle_reservation_assets (
 reservation_id uuid not null references private.lifecycle_reservations(id),
 asset_id uuid not null references private.lifecycle_assets(id),
 primary key(reservation_id,asset_id)
);
create index lifecycle_asset_booking on private.lifecycle_reservation_assets(asset_id,reservation_id);
create table private.lifecycle_photos (
 id uuid primary key, reservation_id uuid not null references private.lifecycle_reservations(id),
 asset_id uuid not null references private.lifecycle_assets(id),
 phase text not null check(phase in ('pickup','return')),
 slot text not null check(slot in ('left','right','drivetrain','damage')),
 mime text not null check(mime in ('image/jpeg','image/png','image/webp')),
 bytes bytea not null, size integer not null check(size>0 and size<=8388608),
 sha256 text not null, uploaded_at timestamptz not null default now()
);
create index lifecycle_photo_order on private.lifecycle_photos(reservation_id,phase,uploaded_at);
create table private.lifecycle_inspections (
 id uuid primary key, reservation_id uuid not null references private.lifecycle_reservations(id),
 phase text not null check(phase in ('pickup','return')),
 checks jsonb not null, notes text not null, abnormal boolean not null,
 created_at timestamptz not null default now(), unique(reservation_id,phase)
);
create table private.lifecycle_signatures (
 reservation_id uuid primary key references private.lifecycle_reservations(id),
 name text not null, terms text not null, terms_version text not null,
 image bytea not null, signed_at timestamptz not null default now()
);
create table private.lifecycle_events (
 id bigint generated always as identity primary key, actor_type text not null,
 actor_id uuid, action text not null, reservation_id uuid,
 details jsonb not null default '{}'::jsonb, at timestamptz not null default now()
);
create table private.lifecycle_notifications (
 id bigint generated always as identity primary key,
 reservation_id uuid not null references private.lifecycle_reservations(id),
 message text not null, created_at timestamptz not null default now(),
 resolved_at timestamptz, resolved_by uuid
);
create table private.lifecycle_requests (
 actor_type text not null check(actor_type in ('member','staff')),
 actor_id uuid not null, request_id uuid not null, action text not null,
 payload_hash text not null, result jsonb not null,
 created_at timestamptz not null default now(),
 primary key(actor_type,actor_id,request_id)
);

-- No direct Data API access, including to sequences and binaries.
alter table private.lifecycle_settings enable row level security;
alter table private.lifecycle_assets enable row level security;
alter table private.lifecycle_members enable row level security;
alter table private.lifecycle_reservations enable row level security;
alter table private.lifecycle_reservation_assets enable row level security;
alter table private.lifecycle_photos enable row level security;
alter table private.lifecycle_inspections enable row level security;
alter table private.lifecycle_signatures enable row level security;
alter table private.lifecycle_events enable row level security;
alter table private.lifecycle_notifications enable row level security;
alter table private.lifecycle_requests enable row level security;
revoke all on table private.lifecycle_settings,private.lifecycle_assets,
 private.lifecycle_members,private.lifecycle_reservations,private.lifecycle_reservation_assets,
 private.lifecycle_photos,private.lifecycle_inspections,private.lifecycle_signatures,
 private.lifecycle_events,private.lifecycle_notifications,private.lifecycle_requests
 from public,anon,authenticated;

create function private.lifecycle_immutable() returns trigger language plpgsql security definer set search_path='' as $$
begin raise exception 'Original evidence is immutable'; end $$;
create trigger lifecycle_photos_immutable before update or delete on private.lifecycle_photos
 for each row execute function private.lifecycle_immutable();
create trigger lifecycle_signatures_immutable before update or delete on private.lifecycle_signatures
 for each row execute function private.lifecycle_immutable();
create trigger lifecycle_inspections_immutable before update or delete on private.lifecycle_inspections
 for each row execute function private.lifecycle_immutable();
create trigger lifecycle_events_immutable before update or delete on private.lifecycle_events
 for each row execute function private.lifecycle_immutable();

create function private.lifecycle_keys(p jsonb,p_allowed text[]) returns boolean language sql immutable security definer set search_path='' as $$
 select jsonb_typeof(p)='object' and not exists(select 1 from jsonb_object_keys(p) k where k<>all(p_allowed))
$$;
create function private.lifecycle_text(p text,p_max integer,p_multiline boolean default false) returns boolean language sql immutable security definer set search_path='' as $$
 select p is not null and length(btrim(p)) between 1 and p_max
 and (case when p_multiline then regexp_replace(p,E'[\r\n]','','g') else p end) !~ '[[:cntrl:]]'
$$;
create function private.lifecycle_time(p text) returns timestamptz language plpgsql immutable security definer set search_path='' as $$
declare v timestamptz;
begin
 if p is null or p !~ '^\d{4}-\d{2}-\d{2}T' or p !~ '(Z|[+-]\d{2}:\d{2})$' then raise exception 'Invalid timestamp'; end if;
 v:=p::timestamptz;
 if not isfinite(v) then raise exception 'Invalid timestamp'; end if;
 return v;
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'Invalid timestamp';
end $$;
create function private.lifecycle_uuid(p text) returns uuid language plpgsql immutable security definer set search_path='' as $$
begin
 if p is null or p !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid UUID'; end if;
 return p::uuid;
end $$;
create function private.lifecycle_asset_json(a private.lifecycle_assets) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'kind',a.kind,'state',a.state)
$$;
create function private.lifecycle_member_json(m private.lifecycle_members) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',m.id,'studentId',m.student_id,'name',m.name,'contact',m.contact,'validUntil',m.valid_until,'active',m.active)
$$;
create function private.lifecycle_photo_json(p private.lifecycle_photos,p_data boolean default false) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'reservationId',p.reservation_id,'assetId',p.asset_id,'phase',p.phase,'slot',p.slot,'mime',p.mime,'size',p.size,'sha256',p.sha256,'uploadedAt',p.uploaded_at)
  || case when p_data then jsonb_build_object('data',pg_catalog.encode(p.bytes,'base64')) else '{}'::jsonb end
$$;
create function private.lifecycle_settings_json() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('location',location,'instructions',instructions,'terms',terms,'termsVersion',terms_version)
 from private.lifecycle_settings where id=1
$$;
create function private.lifecycle_reservation_json(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',r.id,'memberId',r.member_id,'borrower',r.borrower,
 'assetIds',coalesce((select jsonb_agg(ra.asset_id order by a.code) from private.lifecycle_reservation_assets ra join private.lifecycle_assets a on a.id=ra.asset_id where ra.reservation_id=r.id),'[]'::jsonb),
 'start',r.starts_at,'end',r.ends_at,'status',r.status,'createdAt',r.created_at,'pickedUpAt',r.picked_up_at,'returnedAt',r.returned_at,
 'inspections',coalesce((select jsonb_agg(jsonb_build_object('phase',i.phase,'checks',i.checks,'notes',i.notes,'abnormal',i.abnormal,'createdAt',i.created_at) order by i.created_at) from private.lifecycle_inspections i where i.reservation_id=r.id),'[]'::jsonb),
 'photos',coalesce((select jsonb_agg(private.lifecycle_photo_json(p) order by p.uploaded_at,p.id) from private.lifecycle_photos p where p.reservation_id=r.id),'[]'::jsonb),
 'signature',(select jsonb_build_object('name',s.name,'terms',s.terms,'termsVersion',s.terms_version,'signedAt',s.signed_at,'image','data:image/png;base64,'||pg_catalog.encode(s.image,'base64')) from private.lifecycle_signatures s where s.reservation_id=r.id))
 from private.lifecycle_reservations r where r.id=p_id
$$;
create function private.lifecycle_receipt(p_actor_type text,p_actor uuid,p_action text,p_payload jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_id uuid; v_old private.lifecycle_requests; v_hash text;
begin
 v_id:=private.lifecycle_uuid(p_payload->>'requestId');
 v_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_action||':'||p_payload::text,'UTF8')),'hex');
 select * into v_old from private.lifecycle_requests where actor_type=p_actor_type and actor_id=p_actor and request_id=v_id;
 if found then
  if v_old.action<>p_action or v_old.payload_hash<>v_hash then raise exception 'Request ID reused with different payload'; end if;
  return v_old.result;
 end if;
 return null;
end $$;
create function private.lifecycle_save_receipt(p_actor_type text,p_actor uuid,p_action text,p_payload jsonb,p_result jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 insert into private.lifecycle_requests(actor_type,actor_id,request_id,action,payload_hash,result)
 values(p_actor_type,p_actor,private.lifecycle_uuid(p_payload->>'requestId'),p_action,
 pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_action||':'||p_payload::text,'UTF8')),'hex'),p_result);
 return p_result;
end $$;
create function private.lifecycle_checks(p jsonb,p_all_true boolean) returns boolean language sql immutable security definer set search_path='' as $$
 select private.lifecycle_keys(p,array['frame','tires','brakes','gears','accessories'])
 and p ?& array['frame','tires','brakes','gears','accessories']
 and not exists(select 1 from jsonb_each(p) x where jsonb_typeof(x.value)<>'boolean' or (p_all_true and x.value<>'true'::jsonb))
$$;
create function private.lifecycle_all_photos(p_id uuid,p_phase text) returns boolean language sql stable security definer set search_path='' as $$
 select count(distinct slot)=4 from private.lifecycle_photos where reservation_id=p_id and phase=p_phase
$$;
create function private.lifecycle_policy_ready() returns boolean language sql stable security definer set search_path='' as $$
 select location<>'' and instructions<>'' and terms<>'' from private.lifecycle_settings where id=1
$$;

-- Admission reserves the worst-case size of every mandatory unfilled slot.
-- Original history counts forever; optional duplicate photos cannot consume
-- another active borrower's return allocation. This is an application budget,
-- not a replacement for monitoring the provider's database quota.
create function private.lifecycle_storage_json() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('usedBytes',(select coalesce(sum(size),0) from private.lifecycle_photos),
  'reservedBytes',coalesce((select sum((4-(select count(distinct p.slot) from private.lifecycle_photos p where p.reservation_id=r.id and p.phase=phase.name))*8388608::bigint)
   from private.lifecycle_reservations r cross join (values ('pickup'),('return')) phase(name)
   where r.status='reserved' or (r.status='in_use' and phase.name='return')),0),
  'budgetBytes',201326592,'maxPhotoBytes',8388608)
$$;

create function private.lifecycle_member_core(p_action text,p_token text,p_payload jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 v_member private.lifecycle_members; v_res private.lifecycle_reservations;
 v_asset private.lifecycle_assets; v_photo private.lifecycle_photos;
 v_existing jsonb; v_result jsonb; v_id uuid; v_asset_id uuid; v_ids uuid[];
 v_start timestamptz; v_end timestamptz; v_data bytea; v_mime text;
 v_phase text; v_slot text; v_checks jsonb; v_signature jsonb;
 v_name text; v_note text; v_abnormal boolean; v_storage jsonb; v_now timestamptz:=clock_timestamp();
begin
 if p_action='calendar' then
  if not private.lifecycle_keys(p_payload,array['start','end']) or not (p_payload ?& array['start','end']) then raise exception 'Invalid calendar range'; end if;
  v_start:=private.lifecycle_time(p_payload->>'start'); v_end:=private.lifecycle_time(p_payload->>'end');
  if v_end<=v_start or v_end>v_start+interval '42 days' then raise exception 'Invalid calendar range'; end if;
  return jsonb_build_object(
   'assets',coalesce((select jsonb_agg(private.lifecycle_asset_json(a) order by a.code) from private.lifecycle_assets a),'[]'::jsonb),
   'bookings',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'assetIds',(select jsonb_agg(ra.asset_id order by a.code) from private.lifecycle_reservation_assets ra join private.lifecycle_assets a on a.id=ra.asset_id where ra.reservation_id=r.id),'start',r.starts_at,'end',r.ends_at,'status',r.status) order by r.starts_at,r.id)
      from private.lifecycle_reservations r where r.status in ('reserved','in_use') and ((r.starts_at<v_end and r.ends_at>v_start) or r.status='in_use')),'[]'::jsonb),
   'settings',private.lifecycle_settings_json(),'updatedAt',v_now);
 end if;
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception 'Invalid member token'; end if;
 select * into v_member from private.lifecycle_members where token_hash=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex');
 if not found then raise exception 'Invalid member token'; end if;
 if p_action='me' then
  if not private.lifecycle_keys(p_payload,array[]::text[]) then raise exception 'Invalid payload'; end if;
  return jsonb_build_object('member',private.lifecycle_member_json(v_member),'reservations',coalesce((select jsonb_agg(private.lifecycle_reservation_json(r.id) order by r.created_at desc) from private.lifecycle_reservations r where r.member_id=v_member.id),'[]'::jsonb),'settings',private.lifecycle_settings_json());
 end if;
 if p_action='photo_read' then
  if not private.lifecycle_keys(p_payload,array['id']) then raise exception 'Invalid payload'; end if;
  v_id:=private.lifecycle_uuid(p_payload->>'id');
  select p.* into v_photo from private.lifecycle_photos p join private.lifecycle_reservations r on r.id=p.reservation_id where p.id=v_id and r.member_id=v_member.id;
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
 select * into v_member from private.lifecycle_members where token_hash=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex') for update;
 if not found then raise exception 'Invalid member token'; end if;
 v_now:=clock_timestamp();
 v_existing:=private.lifecycle_receipt('member',v_member.id,p_action,p_payload);
 if v_existing is not null then return v_existing; end if;
 if p_action='reserve' then
  if not private.lifecycle_keys(p_payload,array['requestId','assetIds','start','end']) or not (p_payload ?& array['requestId','assetIds','start','end']) then raise exception 'Invalid reservation'; end if;
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
  if exists(select 1 from private.records where student_id=v_member.student_id and status in ('waiting','borrowed')) then raise exception 'Existing legacy loan or application'; end if;
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
  select * into v_res from private.lifecycle_reservations where id=v_id and member_id=v_member.id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if not exists(select 1 from private.lifecycle_reservation_assets ra join private.lifecycle_assets a on a.id=ra.asset_id where ra.reservation_id=v_id and ra.asset_id=v_asset_id and a.kind='bike') then raise exception 'Photo must belong to assigned bike'; end if;
  if v_slot not in ('left','right','drivetrain','damage') or v_mime not in ('image/jpeg','image/png','image/webp') then raise exception 'Invalid photo type'; end if;
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
  select * into v_res from private.lifecycle_reservations where id=v_id and member_id=v_member.id for update;
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
    if not v_member.active or v_member.valid_until<v_res.ends_at then raise exception 'Membership inactive'; end if;
    if exists(select 1 from private.records where student_id=v_member.student_id and status in ('waiting','borrowed')) then raise exception 'Existing legacy loan or application'; end if;
    if exists(select 1 from private.lifecycle_reservations where member_id=v_member.id and status='in_use') then raise exception 'Member already has an active loan'; end if;
    if exists(select 1 from private.lifecycle_reservation_assets ra join private.lifecycle_assets a on a.id=ra.asset_id where ra.reservation_id=v_id and a.state<>'available') then raise exception 'Asset unavailable'; end if;
    if exists(select 1 from private.lifecycle_reservation_assets mine join private.lifecycle_reservation_assets other on other.asset_id=mine.asset_id join private.lifecycle_reservations active on active.id=other.reservation_id where mine.reservation_id=v_id and active.id<>v_id and active.status='in_use') then raise exception 'Asset still in use'; end if;
    if (select count(*) from private.records where status='borrowed')+
       (select outstanding from private.opening_loans where id=1)+
       (select count(*) from private.lifecycle_reservations where status='in_use') >=
       (select total from private.settings where id=1) then raise exception 'No physical inventory available'; end if;
    v_signature:=p_payload->'signature';
    if not private.lifecycle_keys(v_signature,array['name','accepted','termsVersion','image']) or not (v_signature ?& array['name','accepted','termsVersion','image']) or v_signature->'accepted'<>'true'::jsonb then raise exception 'Signature required'; end if;
    v_name:=btrim(v_signature->>'name');
    if not private.lifecycle_text(v_name,80) or v_name<>v_member.name or v_signature->>'termsVersion'<>(select terms_version from private.lifecycle_settings where id=1) then raise exception 'Signature or terms mismatch'; end if;
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

create function private.lifecycle_admin_core(p_action text,p_payload jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 v_actor uuid; v_res private.lifecycle_reservations; v_asset private.lifecycle_assets;
 v_member private.lifecycle_members; v_photo private.lifecycle_photos;
 v_id uuid; v_existing jsonb; v_result jsonb; v_token text; v_reason text;
 v_state text; v_student text; v_now timestamptz:=clock_timestamp();
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
 if p_action not in ('asset','member','settings','resolve','cancel') then raise exception 'Unknown admin lifecycle action'; end if;
 perform 1 from private.settings where id=1 for update;
 perform 1 from private.lifecycle_settings where id=1 for update;
 if p_action in ('resolve','cancel') then
  v_existing:=private.lifecycle_receipt('staff',v_actor,p_action,p_payload);
  if v_existing is not null then return v_existing; end if;
  if p_action='resolve' then
   if not private.lifecycle_keys(p_payload,array['requestId','reservationId','reason','state']) or not (p_payload ?& array['requestId','reservationId','reason','state']) then raise exception 'Invalid resolution'; end if;
  else
   if not private.lifecycle_keys(p_payload,array['requestId','reservationId','reason']) or not (p_payload ?& array['requestId','reservationId','reason']) then raise exception 'Invalid cancellation'; end if;
  end if;
  v_id:=private.lifecycle_uuid(p_payload->>'reservationId'); v_reason:=btrim(p_payload->>'reason');
  if not private.lifecycle_text(v_reason,500,true) then raise exception 'Reason required'; end if;
  select * into v_res from private.lifecycle_reservations where id=v_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if p_action='resolve' then
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
  if not private.lifecycle_keys(p_payload,array['location','instructions','terms']) or not (p_payload ?& array['location','instructions','terms']) then raise exception 'Invalid settings'; end if;
  if not private.lifecycle_text(p_payload->>'location',500) or not private.lifecycle_text(p_payload->>'instructions',4000,true) or not private.lifecycle_text(p_payload->>'terms',10000,true) then raise exception 'Policy fields required'; end if;
  update private.lifecycle_settings set location=btrim(p_payload->>'location'),instructions=btrim(p_payload->>'instructions'),terms=btrim(p_payload->>'terms'),terms_version=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(btrim(p_payload->>'terms'),'UTF8')),'hex'),updated_at=v_now where id=1;
  insert into private.lifecycle_events(actor_type,actor_id,action,details) values('staff',v_actor,'settings',jsonb_build_object('termsVersion',(select terms_version from private.lifecycle_settings where id=1)));
  return jsonb_build_object('settings',private.lifecycle_settings_json());
 end if;
 if p_action='asset' then
  if not private.lifecycle_keys(p_payload,array['id','code','name','kind','state','reason']) or not (p_payload ?& array['code','name','kind','state','reason']) then raise exception 'Invalid asset'; end if;
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
   update private.lifecycle_assets set code=btrim(p_payload->>'code'),name=btrim(p_payload->>'name'),kind=p_payload->>'kind',state=v_state,updated_at=v_now where id=v_id returning * into v_asset;
  else
   v_id:=pg_catalog.gen_random_uuid();
   insert into private.lifecycle_assets(id,code,name,kind,state) values(v_id,btrim(p_payload->>'code'),btrim(p_payload->>'name'),p_payload->>'kind',v_state) returning * into v_asset;
  end if;
  insert into private.lifecycle_events(actor_type,actor_id,action,details) values('staff',v_actor,'asset',jsonb_build_object('assetId',v_id,'reason',v_reason));
  return jsonb_build_object('asset',private.lifecycle_asset_json(v_asset));
 end if;
 if not private.lifecycle_keys(p_payload,array['id','studentId','name','contact','validUntil','active','token','reason']) or not (p_payload ?& array['studentId','name','contact','validUntil','active','reason']) then raise exception 'Invalid member'; end if;
 v_student:=upper(btrim(p_payload->>'studentId')); v_reason:=btrim(p_payload->>'reason');
 if v_student !~ '^[A-Z0-9-]{1,30}$' or not private.lifecycle_text(p_payload->>'name',80) or not private.lifecycle_text(p_payload->>'contact',200) or not private.lifecycle_text(v_reason,500,true) or jsonb_typeof(p_payload->'active')<>'boolean' then raise exception 'Invalid member'; end if;
 if p_payload ? 'id' and p_payload->>'id' is not null then
  v_id:=private.lifecycle_uuid(p_payload->>'id');
  select * into v_member from private.lifecycle_members where id=v_id for update;
  if not found then raise exception 'Member not found'; end if;
  if (v_member.student_id<>v_student or v_member.name<>btrim(p_payload->>'name'))
    and exists(select 1 from private.lifecycle_reservations where member_id=v_id and status in ('reserved','in_use','inspection')) then raise exception 'Member identity cannot change during active loan'; end if;
  v_token:=p_payload->>'token';
  if v_token is not null and v_token !~ '^[a-f0-9]{64}$' then raise exception 'Invalid member token'; end if;
  update private.lifecycle_members set student_id=v_student,name=btrim(p_payload->>'name'),contact=btrim(p_payload->>'contact'),valid_until=private.lifecycle_time(p_payload->>'validUntil'),active=(p_payload->>'active')::boolean,token_hash=case when v_token is null then token_hash else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_token,'UTF8')),'hex') end,updated_at=v_now where id=v_id returning * into v_member;
 else
  v_token:=p_payload->>'token';
  if v_token is null or v_token !~ '^[a-f0-9]{64}$' then raise exception 'New member token required'; end if;
  v_id:=pg_catalog.gen_random_uuid();
  insert into private.lifecycle_members(id,student_id,name,contact,valid_until,active,token_hash)
   values(v_id,v_student,btrim(p_payload->>'name'),btrim(p_payload->>'contact'),private.lifecycle_time(p_payload->>'validUntil'),(p_payload->>'active')::boolean,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_token,'UTF8')),'hex')) returning * into v_member;
 end if;
 insert into private.lifecycle_events(actor_type,actor_id,action,details) values('staff',v_actor,'member',jsonb_build_object('memberId',v_id,'reason',v_reason));
 return jsonb_build_object('member',private.lifecycle_member_json(v_member));
end $$;

create function private.lifecycle_public_rpc(p_action text,p_token text,p_payload jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_headers jsonb; v_message text;
begin
 perform set_config('response.headers','[{"Cache-Control":"no-store"}]',true);
 begin v_headers:=nullif(current_setting('request.headers',true),'')::jsonb; exception when others then v_headers:=null; end;
 if exists(select 1 from regexp_split_to_table(coalesce(v_headers->>'prefer',''),',') preference where preference ~* '^\s*tx\s*=\s*rollback\s*$') then
  return private.public_rpc_error(400,'P0001','Rollback mode unsupported');
 end if;
 if coalesce(nullif(current_setting('request.method',true),''),'POST')<>'POST' or current_setting('transaction_read_only')='on' then
  return private.public_rpc_error(405,'25006','POST required');
 end if;
 -- Keep the budget outside the error-catching subtransaction: rejected calls count.
 if not private.consume_public_budget('read') then return private.public_rpc_error(429,'PT429','Too many requests'); end if;
 begin
  return private.lifecycle_member_core(p_action,p_token,p_payload);
 exception when others then
  v_message:=sqlerrm;
  if SQLSTATE='42501' then return private.public_rpc_error(403,SQLSTATE,'Permission denied'); end if;
  if SQLSTATE='23505' then return private.public_rpc_error(409,SQLSTATE,'Conflicting record'); end if;
  if SQLSTATE='P0001' then return private.public_rpc_error(400,SQLSTATE,v_message); end if;
  return private.public_rpc_error(400,'P0001','Invalid lifecycle request');
 end;
end $$;

create function public.lifecycle(p_action text,p_token text,p_payload jsonb) returns jsonb language sql volatile security definer set search_path='' as $$
 select private.lifecycle_public_rpc(p_action,p_token,p_payload)
$$;
create function public.lifecycle_admin(p_action text,p_payload jsonb) returns jsonb language sql volatile security definer set search_path='' as $$
 select private.lifecycle_admin_core(p_action,p_payload)
$$;
revoke all on all functions in schema private from public,anon,authenticated;
revoke all on function public.lifecycle(text,text,jsonb),public.lifecycle_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.lifecycle(text,text,jsonb) to anon,authenticated;
grant execute on function public.lifecycle_admin(text,jsonb) to authenticated;
revoke all on all sequences in schema private from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
