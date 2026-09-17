-- 003: abuse controls and officer tooling. Apply after 001 and 002 in the SQL editor.
-- Adds anonymous registration throttling, officer bulk cancel, readable audit actors,
-- a bounded audit payload for polling, and a full JSON export for backups.
begin;

-- Throttle log. Stores only a SHA-256 of the client address (or 'unknown'), never the raw IP.
create table private.register_attempts(id bigint generated always as identity primary key, client_hash text not null, at timestamptz not null default now());
create index register_attempts_at on private.register_attempts(at);
create index register_attempts_client on private.register_attempts(client_hash, at);
alter table private.register_attempts enable row level security;
revoke all on private.register_attempts from public,anon,authenticated;

create function private.client_hash() returns text language plpgsql stable security definer set search_path='' as $$
declare v_headers jsonb; v_ip text; v_chain text;
begin
 begin v_headers:=nullif(current_setting('request.headers',true),'')::jsonb; exception when others then v_headers:=null; end;
 if v_headers is null then return null; end if;
 v_chain:=v_headers->>'x-forwarded-for';
 v_ip:=coalesce(nullif(btrim(v_headers->>'cf-connecting-ip'),''), nullif(btrim(v_headers->>'x-real-ip'),''),
  case when v_chain is null then null else nullif(btrim(split_part(v_chain,',',greatest(1,array_length(string_to_array(v_chain,','),1)))),'') end);
 if v_ip is null then return null; end if;
 return pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_ip,'UTF8')),'hex');
end $$;

-- Must be called while the settings row is locked so counts are serialized.
-- Limits: 15 new registration attempts per minute, 90 per hour, 300 per day site-wide; 10 per client per 10 minutes.
create function private.check_register_throttle() returns void language plpgsql security definer set search_path='' as $$
declare v_client text:=private.client_hash(); v_now timestamptz:=clock_timestamp(); v_n bigint;
begin
 delete from private.register_attempts where at < v_now - interval '1 day';
 select count(*) into v_n from private.register_attempts where at > v_now - interval '1 minute';
 if v_n>=15 then raise exception using message='目前登記人數較多，請一分鐘後再試', errcode='PT429'; end if;
 select count(*) into v_n from private.register_attempts where at > v_now - interval '1 hour';
 if v_n>=90 then raise exception using message='目前登記人數較多，請稍後再試', errcode='PT429'; end if;
 select count(*) into v_n from private.register_attempts where at > v_now - interval '1 day';
 if v_n>=300 then raise exception using message='今日登記次數已達上限，請明天再試或聯絡幹部', errcode='PT429'; end if;
 if v_client is not null then
  select count(*) into v_n from private.register_attempts where client_hash=v_client and at > v_now - interval '10 minutes';
  if v_n>=10 then raise exception using message='此網路短時間內登記次數過多，請稍後再試', errcode='PT429'; end if;
 end if;
 insert into private.register_attempts(client_hash,at) values(coalesce(v_client,'unknown'),v_now);
end $$;

create or replace function public.register(p_student_id text,p_name text,p_contact_type text,p_contact text,p_token text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id bigint; v_hash text; v_old private.records; v_student text:=upper(btrim(p_student_id)); v_name text:=btrim(p_name); v_type text:=btrim(p_contact_type); v_contact text:=btrim(p_contact);
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception '查詢碼格式不正確'; end if;
 if v_student is null or v_student !~ '^[a-zA-Z0-9-]{1,30}$' or v_name is null or length(v_name) not between 1 and 80 or v_type is null or length(v_type) not between 1 and 30 or v_contact is null or length(v_contact) not between 1 and 200 or (v_name||v_type||v_contact) ~ '[[:cntrl:]]' then raise exception '登記資料格式不正確'; end if;
 if v_type not in ('phone','line','instagram') then raise exception '聯絡方式格式不正確'; end if;
 perform 1 from private.settings where id=1 for update;
 v_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex');
 select * into v_old from private.records where token_hash=v_hash;
 if found then
  if v_old.student_id<>v_student or v_old.name<>v_name or v_old.contact_type<>v_type or v_old.contact<>v_contact then raise exception '查詢碼已使用'; end if;
  return jsonb_build_object('record',private.record_json(v_old.id),'summary',private.summary_json());
 end if;
 perform private.check_register_throttle();
 if (select total from private.settings where id=1) is null then raise exception '幹部尚未設定社車總數'; end if;
 if exists(select 1 from private.records where student_id=v_student and status in ('waiting','borrowed')) then raise exception '此學號已有有效登記或借用；請使用原查詢碼或聯絡幹部'; end if;
 insert into private.records(student_id,name,contact_type,contact,token_hash,status) values(v_student,v_name,v_type,v_contact,v_hash,'waiting') returning id into v_id;
 return jsonb_build_object('record',private.record_json(v_id),'summary',private.summary_json());
end $$;

-- Audit rows with the actor's email (falls back to the UUID) and a bounded window for polling.
create function private.audit_json(p_limit integer) returns jsonb language sql volatile security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'actor',coalesce(u.email,a.actor::text),'actorId',a.actor,'action',a.action,'recordId',a.record_id,'at',a.at,'details',a.details) order by a.id desc),'[]'::jsonb)
 from (select * from private.audit order by id desc limit p_limit) a left join auth.users u on u.id=a.actor
$$;

create or replace function public.admin_records() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.require_admin();
 perform 1 from private.settings where id=1 for share;
 return jsonb_build_object('opening',private.opening_json(),'summary',private.summary_json(),'records',coalesce((select jsonb_agg(private.record_json(id) order by id) from private.records),'[]'::jsonb),'audit',private.audit_json(500));
end $$;

-- Cancel many waiting registrations at once (spam cleanup). Non-waiting ids are skipped and reported.
create function public.admin_cancel_many(p_ids bigint[]) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_id bigint; v_cancelled bigint[]:='{}'; v_skipped bigint[]:='{}';
begin
 v_actor:=private.require_admin();
 if p_ids is null or cardinality(p_ids)<1 or cardinality(p_ids)>500 then raise exception '取消清單格式不正確'; end if;
 perform 1 from private.settings where id=1 for update;
 for v_id in select distinct x from unnest(p_ids) x where x is not null order by x loop
  update private.records set status='cancelled',updated_at=clock_timestamp() where id=v_id and status='waiting';
  if found then
   v_cancelled:=v_cancelled||v_id;
   insert into private.audit(actor,action,record_id,details) values(v_actor,'cancel',v_id,jsonb_build_object('bulk',true));
  else v_skipped:=v_skipped||v_id; end if;
 end loop;
 return jsonb_build_object('cancelled',to_jsonb(v_cancelled),'skipped',to_jsonb(v_skipped),'summary',private.summary_json());
end $$;

-- Full export for backups. Officer only; contains personal data and is itself audited.
create function public.admin_export() returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid;
begin
 v_actor:=private.require_admin();
 perform 1 from private.settings where id=1 for share;
 insert into private.audit(actor,action,details) values(v_actor,'export','{}'::jsonb);
 return jsonb_build_object(
  'exportedAt',clock_timestamp(),
  'exportedBy',(select coalesce(u.email,v_actor::text) from auth.users u where u.id=v_actor),
  'settings',(select jsonb_build_object('total',total,'contactUrl',contact_url) from private.settings where id=1),
  'opening',private.opening_json(),
  'records',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from private.records r),'[]'::jsonb),
  'audit',coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from private.audit a),'[]'::jsonb),
  'openingReturns',coalesce((select jsonb_agg(to_jsonb(o)) from private.opening_returns o),'[]'::jsonb),
  'admins',coalesce((select jsonb_agg(coalesce(u.email,a.user_id::text)) from private.admins a left join auth.users u on u.id=a.user_id),'[]'::jsonb));
end $$;

revoke all on function private.client_hash(),private.check_register_throttle(),private.audit_json(integer) from public,anon,authenticated;
revoke all on function public.admin_cancel_many(bigint[]),public.admin_export() from public,anon,authenticated;
grant execute on function public.admin_cancel_many(bigint[]),public.admin_export() to authenticated;
commit;
