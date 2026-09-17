-- Run once in the Supabase SQL editor. No personal data is stored in public.
begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.settings(id integer primary key check(id=1), total integer check(total >= 0 and total <= 10000), contact_url text not null default '');
insert into private.settings(id) values(1);
create table private.admins(user_id uuid primary key references auth.users(id));
create table private.records(id bigint generated always as identity primary key, student_id text not null, name text not null, contact_type text not null, contact text not null, token_hash text unique not null, status text not null check(status in ('waiting','borrowed','returned','cancelled')), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), bike_note text not null default '');
create unique index active_student on private.records(student_id) where status in ('waiting','borrowed');
create table private.audit(id bigint generated always as identity primary key, actor uuid not null, action text not null, record_id bigint, at timestamptz not null default now(), details jsonb not null default '{}');
alter table private.settings enable row level security;
alter table private.admins enable row level security;
alter table private.records enable row level security;
alter table private.audit enable row level security;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;

create function private.require_admin() returns uuid language plpgsql security definer set search_path='' as $$
declare v_actor uuid := auth.uid();
begin
 if v_actor is null or not exists(select 1 from private.admins where user_id=v_actor) then raise exception using message='請先以管理員身分登入',errcode='42501'; end if;
 return v_actor;
end $$;

create function private.summary_json() returns jsonb language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('total',s.total,'contactUrl',s.contact_url,'borrowed',c.borrowed,'available',s.total-c.borrowed,'waiting',c.waiting,'updatedAt',clock_timestamp())
 from private.settings s cross join (select count(*) filter(where status='borrowed') borrowed,count(*) filter(where status='waiting') waiting from private.records)c where s.id=1
$$;
create function private.record_json(p_id bigint) returns jsonb language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('id',r.id,'studentId',r.student_id,'name',r.name,'contactType',r.contact_type,'contact',r.contact,'status',r.status,'createdAt',r.created_at,'updatedAt',r.updated_at,'bikeNote',r.bike_note,'position',q.position,'standby',case when q.position is null or s.total is null then null else greatest(0,q.position-(s.total-c.borrowed)) end)
 from private.records r cross join private.settings s
 cross join (select count(*) borrowed from private.records where status='borrowed') c
 cross join lateral (select case when r.status='waiting' then (select count(*) from private.records where status='waiting' and id<=r.id) else null end position)q
 where r.id=p_id and s.id=1
$$;

create function public.summary() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform 1 from private.settings where id=1 for share;
 return private.summary_json();
end $$;

create function public.register(p_student_id text,p_name text,p_contact_type text,p_contact text,p_token text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id bigint; v_hash text; v_old private.records; v_student text:=upper(btrim(p_student_id)); v_name text:=btrim(p_name); v_type text:=btrim(p_contact_type); v_contact text:=btrim(p_contact);
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception '查詢碼格式不正確'; end if;
 if v_student is null or v_student !~ '^[a-zA-Z0-9-]{1,30}$' or v_name is null or length(v_name) not between 1 and 80 or v_type is null or length(v_type) not between 1 and 30 or v_contact is null or length(v_contact) not between 1 and 200 or (v_name||v_type||v_contact) ~ '[[:cntrl:]]' then raise exception '登記資料格式不正確'; end if;
 perform 1 from private.settings where id=1 for update;
 if v_type not in ('phone','line','instagram') then raise exception '聯絡方式格式不正確'; end if;
 v_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex');
 select * into v_old from private.records where token_hash=v_hash;
 if found then
  if v_old.student_id<>v_student or v_old.name<>v_name or v_old.contact_type<>v_type or v_old.contact<>v_contact then raise exception '查詢碼已使用'; end if;
  return jsonb_build_object('record',private.record_json(v_old.id),'summary',private.summary_json());
 end if;
 if (select total from private.settings where id=1) is null then raise exception '幹部尚未設定社車總數'; end if;
 if exists(select 1 from private.records where student_id=v_student and status in ('waiting','borrowed')) then raise exception '此學號已有有效登記或借用；請使用原查詢碼或聯絡幹部'; end if;
 insert into private.records(student_id,name,contact_type,contact,token_hash,status) values(v_student,v_name,v_type,v_contact,v_hash,'waiting') returning id into v_id;
 return jsonb_build_object('record',private.record_json(v_id),'summary',private.summary_json());
end $$;

create function public.lookup(p_token text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id bigint;
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception '查詢碼格式不正確'; end if;
 perform 1 from private.settings where id=1 for share;
 select id into v_id from private.records where token_hash=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex');
 if not found then raise exception '查無登記，請確認查詢碼'; end if;
 return jsonb_build_object('record',private.record_json(v_id),'summary',private.summary_json());
end $$;

create function public.admin_records() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.require_admin();
 perform 1 from private.settings where id=1 for share;
 return jsonb_build_object('summary',private.summary_json(),'records',coalesce((select jsonb_agg(private.record_json(id) order by id) from private.records),'[]'::jsonb),'audit',coalesce((select jsonb_agg(jsonb_build_object('id',id,'actor',actor,'action',action,'recordId',record_id,'at',at,'details',details) order by id desc) from (select * from private.audit order by id desc)a),'[]'::jsonb));
end $$;

create function public.admin_action(p_id bigint,p_action text,p_bike_note text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_old private.records; v_target text; v_total integer; v_borrowed bigint;
begin
 v_actor:=private.require_admin();
 if p_id is null or p_id<1 or p_action is null or p_action not in ('lend','return','cancel') or length(p_bike_note)>500 then raise exception '操作格式不正確'; end if;
 select total into v_total from private.settings where id=1 for update;
 select * into v_old from private.records where id=p_id;
 if not found then raise exception '查無紀錄'; end if;
 v_target:=case p_action when 'lend' then 'borrowed' when 'return' then 'returned' else 'cancelled' end;
 if v_old.status=v_target then return jsonb_build_object('record',private.record_json(p_id),'summary',private.summary_json()); end if;
 if (p_action='lend' and v_old.status<>'waiting') or (p_action='return' and v_old.status<>'borrowed') or (p_action='cancel' and v_old.status<>'waiting') then raise exception '目前狀態不允許此操作'; end if;
 if p_action='lend' then
  select count(*) into v_borrowed from private.records where status='borrowed';
  if v_total is null or v_borrowed>=v_total then raise exception '目前沒有尚未借出的車輛'; end if;
 end if;
 update private.records set status=v_target,updated_at=clock_timestamp(),bike_note=coalesce(p_bike_note,v_old.bike_note) where id=p_id;
 insert into private.audit(actor,action,record_id,details) values(v_actor,p_action,p_id,jsonb_build_object('bikeNote',coalesce(p_bike_note,v_old.bike_note)));
 return jsonb_build_object('record',private.record_json(p_id),'summary',private.summary_json());
end $$;

create function public.admin_settings(p_total integer,p_contact_url text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_borrowed bigint;
begin
 v_actor:=private.require_admin();
 if p_total is null or p_total<0 or p_total>10000 or p_contact_url is null or length(p_contact_url)>500 or (p_contact_url<>'' and p_contact_url !~ '^https://[^[:space:]]+$') then raise exception '設定格式不正確'; end if;
 perform 1 from private.settings where id=1 for update;
 select count(*) into v_borrowed from private.records where status='borrowed';
 if p_total<v_borrowed then raise exception '總車數不可低於已借出數量'; end if;
 update private.settings set total=p_total,contact_url=p_contact_url where id=1;
 insert into private.audit(actor,action,details) values(v_actor,'settings',jsonb_build_object('total',p_total,'contactUrl',p_contact_url));
 return jsonb_build_object('summary',private.summary_json());
end $$;

revoke all on all functions in schema private from public,anon,authenticated;
revoke all on function public.summary(),public.register(text,text,text,text,text),public.lookup(text),public.admin_records(),public.admin_action(bigint,text,text),public.admin_settings(integer,text) from public,anon,authenticated;
grant execute on function public.summary(),public.register(text,text,text,text,text),public.lookup(text) to anon,authenticated;
grant execute on function public.admin_records(),public.admin_action(bigint,text,text),public.admin_settings(integer,text) to authenticated;
commit;
