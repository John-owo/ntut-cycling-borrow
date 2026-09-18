-- Adjust the total via untracked/opening loans, preserving all member records.
begin;
create table private.borrowed_adjustments(request_id uuid primary key, payload jsonb not null, receipt jsonb not null);
alter table private.borrowed_adjustments enable row level security;
revoke all on private.borrowed_adjustments from public,anon,authenticated;
create function public.admin_set_borrowed(p_borrowed integer,p_expected_borrowed integer,p_expected_opening integer,p_request_id uuid,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_total integer; v_old_borrowed bigint; v_old_opening integer; v_real bigint; v_new_opening integer; v_previous private.borrowed_adjustments; v_payload jsonb; v_receipt jsonb; v_reason text;
begin
 v_actor:=private.require_admin();
 v_reason:=btrim(p_reason);
 if p_borrowed is null or p_borrowed<0 or p_borrowed>10000 or p_expected_borrowed is null or p_expected_borrowed<0 or p_expected_borrowed>10000 or p_expected_opening is null or p_expected_opening<0 or p_expected_opening>10000 or p_request_id is null or v_reason is null or length(v_reason)=0 or length(v_reason)>500 or p_reason ~ '[[:cntrl:]]' then raise exception '已借出數量、調整原因或操作識別碼格式不正確'; end if;
 select total into v_total from private.settings where id=1 for update;
 v_payload:=jsonb_build_object('borrowed',p_borrowed,'expectedBorrowed',p_expected_borrowed,'expectedOpening',p_expected_opening,'reason',v_reason);
 select * into v_previous from private.borrowed_adjustments where request_id=p_request_id;
 if found then
  if v_previous.payload<>v_payload then raise exception '操作識別碼已用於不同調整內容'; end if;
  return jsonb_build_object('receipt',v_previous.receipt,'opening',private.opening_json(),'summary',private.summary_json());
 end if;
 select outstanding into v_old_opening from private.opening_loans where id=1;
 select count(*) into v_real from private.records where status='borrowed';
 v_old_borrowed:=v_real+v_old_opening;
 if v_total is null then raise exception '幹部尚未設定社車總數'; end if;
 if p_borrowed>v_total then raise exception '已借出數量不可超過總車數'; end if;
 if p_borrowed<v_real then raise exception '已借出數量不可低於社員借用紀錄數量'; end if;
 if p_expected_borrowed<>v_old_borrowed or p_expected_opening<>v_old_opening then raise exception '數量已變更，請重新載入後再調整'; end if;
 v_new_opening:=p_borrowed-v_real;
 update private.opening_loans set outstanding=v_new_opening where id=1;
 v_receipt:=jsonb_build_object('requestId',p_request_id,'actor',v_actor,'at',clock_timestamp(),'reason',v_reason,'oldBorrowed',v_old_borrowed,'newBorrowed',p_borrowed,'oldOpening',v_old_opening,'newOpening',v_new_opening,'realBorrowed',v_real);
 insert into private.borrowed_adjustments(request_id,payload,receipt) values(p_request_id,v_payload,v_receipt);
 insert into private.audit(actor,action,details) values(v_actor,'borrowed-adjustment',v_receipt);
 return jsonb_build_object('receipt',v_receipt,'opening',private.opening_json(),'summary',private.summary_json());
end $$;
revoke all on function public.admin_set_borrowed(integer,integer,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.admin_set_borrowed(integer,integer,integer,uuid,text) to authenticated;
create or replace function public.admin_export() returns jsonb language plpgsql security definer set search_path='' as $$
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
  'borrowedAdjustments',coalesce((select jsonb_agg(to_jsonb(b)) from private.borrowed_adjustments b),'[]'::jsonb),
  'openingReturns',coalesce((select jsonb_agg(to_jsonb(o)) from private.opening_returns o),'[]'::jsonb),
  'admins',coalesce((select jsonb_agg(coalesce(u.email,a.user_id::text)) from private.admins a left join auth.users u on u.id=a.user_id),'[]'::jsonb));
end $$;

commit;

