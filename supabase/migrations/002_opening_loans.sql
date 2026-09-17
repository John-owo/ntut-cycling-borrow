-- Schema only: production inventory is initialized separately by authorized SQL.
begin;
create table private.opening_loans(id integer primary key check(id=1), outstanding integer not null default 0 check(outstanding>=0), expected_return date, note text not null default '');
insert into private.opening_loans(id) values(1);
create table private.opening_returns(request_id uuid primary key, count integer not null check(count>0), receipt jsonb not null);
alter table private.opening_loans enable row level security;
alter table private.opening_returns enable row level security;
revoke all on private.opening_loans,private.opening_returns from public,anon,authenticated;
create function private.borrowed_count() returns bigint language sql volatile security definer set search_path='' as $$
 select (select count(*) from private.records where status='borrowed') + (select outstanding from private.opening_loans where id=1)
$$;
create function private.opening_json() returns jsonb language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('outstanding',outstanding,'expectedReturn',expected_return,'note',note) from private.opening_loans where id=1
$$;
create or replace function private.summary_json() returns jsonb language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('total',s.total,'contactUrl',s.contact_url,'borrowed',c.borrowed,'available',s.total-c.borrowed,'waiting',c.waiting,'updatedAt',clock_timestamp())
 from private.settings s cross join (select private.borrowed_count() borrowed,count(*) filter(where status='waiting') waiting from private.records)c where s.id=1
$$;

create or replace function private.record_json(p_id bigint) returns jsonb language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('id',r.id,'studentId',r.student_id,'name',r.name,'contactType',r.contact_type,'contact',r.contact,'status',r.status,'createdAt',r.created_at,'updatedAt',r.updated_at,'bikeNote',r.bike_note,'position',q.position,'standby',case when q.position is null or s.total is null then null else greatest(0,q.position-(s.total-c.borrowed)) end)
 from private.records r cross join private.settings s
 cross join (select private.borrowed_count() borrowed) c
 cross join lateral (select case when r.status='waiting' then (select count(*) from private.records where status='waiting' and id<=r.id) else null end position)q
 where r.id=p_id and s.id=1
$$;

create or replace function public.admin_records() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.require_admin();
 perform 1 from private.settings where id=1 for share;
 return jsonb_build_object('opening',private.opening_json(),'summary',private.summary_json(),'records',coalesce((select jsonb_agg(private.record_json(id) order by id) from private.records),'[]'::jsonb),'audit',coalesce((select jsonb_agg(jsonb_build_object('id',id,'actor',actor,'action',action,'recordId',record_id,'at',at,'details',details) order by id desc) from (select * from private.audit order by id desc)a),'[]'::jsonb));
end $$;

create or replace function public.admin_action(p_id bigint,p_action text,p_bike_note text default null) returns jsonb language plpgsql security definer set search_path='' as $$
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
  select private.borrowed_count() into v_borrowed;
  if v_total is null or v_borrowed>=v_total then raise exception '目前沒有尚未借出的車輛'; end if;
 end if;
 update private.records set status=v_target,updated_at=clock_timestamp(),bike_note=coalesce(p_bike_note,v_old.bike_note) where id=p_id;
 insert into private.audit(actor,action,record_id,details) values(v_actor,p_action,p_id,jsonb_build_object('bikeNote',coalesce(p_bike_note,v_old.bike_note)));
 return jsonb_build_object('record',private.record_json(p_id),'summary',private.summary_json());
end $$;

create or replace function public.admin_settings(p_total integer,p_contact_url text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_borrowed bigint;
begin
 v_actor:=private.require_admin();
 if p_total is null or p_total<0 or p_total>10000 or p_contact_url is null or length(p_contact_url)>500 or (p_contact_url<>'' and p_contact_url !~ '^https://[^[:space:]]+$') then raise exception '設定格式不正確'; end if;
 perform 1 from private.settings where id=1 for update;
 select private.borrowed_count() into v_borrowed;
 if p_total<v_borrowed then raise exception '總車數不可低於已借出數量'; end if;
 update private.settings set total=p_total,contact_url=p_contact_url where id=1;
 insert into private.audit(actor,action,details) values(v_actor,'settings',jsonb_build_object('total',p_total,'contactUrl',p_contact_url));
 return jsonb_build_object('summary',private.summary_json());
end $$;

create function public.admin_return_opening(p_count integer,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_outstanding integer; v_previous private.opening_returns; v_receipt jsonb;
begin
 v_actor:=private.require_admin();
 if p_count is null or p_count<1 or p_request_id is null then raise exception '歸還數量或操作識別碼格式不正確'; end if;
 perform 1 from private.settings where id=1 for update;
 select * into v_previous from private.opening_returns where request_id=p_request_id;
 if found then
  if v_previous.count<>p_count then raise exception '操作識別碼已用於不同歸還數量'; end if;
  return jsonb_build_object('receipt',v_previous.receipt,'opening',private.opening_json(),'summary',private.summary_json());
 end if;
 select outstanding into v_outstanding from private.opening_loans where id=1;
 if p_count>v_outstanding then raise exception '歸還數量不可超過期初尚未歸還數量'; end if;
 update private.opening_loans set outstanding=outstanding-p_count where id=1;
 v_receipt:=jsonb_build_object('requestId',p_request_id,'count',p_count,'actor',v_actor,'at',clock_timestamp(),'remaining',v_outstanding-p_count);
 insert into private.opening_returns(request_id,count,receipt) values(p_request_id,p_count,v_receipt);
 insert into private.audit(actor,action,details) values(v_actor,'opening-return',v_receipt);
 return jsonb_build_object('receipt',v_receipt,'opening',private.opening_json(),'summary',private.summary_json());
end $$;
revoke all on function private.borrowed_count(),private.opening_json() from public,anon,authenticated;
revoke all on function public.admin_return_opening(integer,uuid) from public,anon,authenticated;
grant execute on function public.admin_return_opening(integer,uuid) to authenticated;
commit;

