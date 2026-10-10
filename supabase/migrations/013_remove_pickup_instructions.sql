-- Retire the pickup-instructions field. Apply once after 012, BEFORE publishing the matching frontend.
-- The location and borrowing rules stay required; `instructions` is no longer required, stored or
-- returned, and an older cached page that still sends it is accepted and ignored. The existing
-- column and any text already saved in it are left untouched.
begin;
set local lock_timeout='15s';

create or replace function private.lifecycle_policy_ready() returns boolean language sql stable security definer set search_path='' as $$
 select location<>'' and terms<>'' from private.lifecycle_settings where id=1
$$;
create or replace function private.lifecycle_settings_json() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('location',location,'terms',terms,'termsVersion',terms_version)
 from private.lifecycle_settings where id=1
$$;

create or replace function private.lifecycle_admin_core(p_action text,p_payload jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
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
 if p_action not in ('asset','member','settings','resolve','cancel','approve','access') then raise exception 'Unknown admin lifecycle action'; end if;
 perform 1 from private.settings where id=1 for update;
 perform 1 from private.lifecycle_settings where id=1 for update;
 if p_action in ('resolve','cancel','approve','access') then
  v_existing:=private.lifecycle_receipt('staff',v_actor,p_action,p_payload);
  if v_existing is not null then return v_existing; end if;
  if p_action='approve' then
   if not private.lifecycle_keys(p_payload,array['requestId','reservationId']) or not (p_payload ?& array['requestId','reservationId']) then raise exception 'Invalid approval'; end if;
  elsif p_action='access' then
   if not private.lifecycle_keys(p_payload,array['requestId','reservationId','key']) or not (p_payload ?& array['requestId','reservationId','key']) or (p_payload->>'key') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid booking key'; end if;
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
   update private.lifecycle_reservations set approval='approved',approved_at=v_now,updated_at=v_now where id=v_id;
  elsif p_action='access' then
   if v_res.access_hash is null or v_res.status not in ('reserved','in_use') then raise exception 'Only active self-service bookings can get a new key'; end if;
   v_token:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_payload->>'key','UTF8')),'hex');
   if exists(select 1 from private.lifecycle_members where token_hash=v_token) then raise exception 'Generate another key'; end if;
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

revoke all on all functions in schema private from public,anon,authenticated;
revoke all on function public.lifecycle(text,text,jsonb),public.lifecycle_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.lifecycle(text,text,jsonb) to anon,authenticated;
grant execute on function public.lifecycle_admin(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
