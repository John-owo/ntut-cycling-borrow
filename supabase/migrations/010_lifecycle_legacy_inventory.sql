-- Coexistence with the legacy queue: one inventory ceiling and one active identity.
begin;

create or replace function private.borrowed_count() returns bigint language sql volatile security definer set search_path='' as $$
 select (select count(*) from private.records where status='borrowed')
      + (select outstanding from private.opening_loans where id=1)
      + (select count(*) from private.lifecycle_reservations where status='in_use')
$$;

create function private.lifecycle_legacy_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform 1 from private.settings where id=1 for update;
 if new.status in ('waiting','borrowed') and exists(
  select 1 from private.lifecycle_members m join private.lifecycle_reservations r on r.member_id=m.id
  where m.student_id=new.student_id and r.status in ('reserved','in_use','inspection')
 ) then raise exception '此學號已有有效登記或借用；請使用原查詢碼或聯絡幹部'; end if;
 -- Aggregate historical loans do not identify a numbered bike. Never silently
 -- lend an asset already assigned to the new fleet through the old queue.
 if new.status='borrowed' and (tg_op='INSERT' or old.status<>'borrowed') and
  (select count(*) from private.lifecycle_assets where kind='bike' and state='available')
  + (select count(*) from private.records where status='borrowed')
  + (select outstanding from private.opening_loans where id=1)
  >= coalesce((select total from private.settings where id=1),0)
 then raise exception '請先盤點編號車輛；可用編號車須由預約流程交車'; end if;
 return new;
end $$;
create trigger lifecycle_legacy_guard before insert or update on private.records
 for each row execute function private.lifecycle_legacy_guard();

create function private.lifecycle_fleet_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare v_total integer; v_numbered bigint; v_legacy bigint;
begin
 select total into v_total from private.settings where id=1 for update;
 if new.kind='bike' and new.state='available' then
  select count(*) into v_numbered from private.lifecycle_assets where kind='bike' and state='available' and id<>new.id;
  select (select count(*) from private.records where status='borrowed')+(select outstanding from private.opening_loans where id=1) into v_legacy;
  if v_total is null or v_numbered+v_legacy+1>v_total then
   raise exception '可用編號車與既有借出數超過總車數，請先完成實車盤點';
  end if;
 end if;
 return new;
end $$;
create trigger lifecycle_fleet_guard before insert or update on private.lifecycle_assets
 for each row execute function private.lifecycle_fleet_guard();
revoke all on function private.lifecycle_legacy_guard(),private.lifecycle_fleet_guard() from public,anon,authenticated;

create function private.lifecycle_inventory_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare v_total integer; v_opening integer;
begin
 if tg_table_name='settings' then v_total:=new.total; select outstanding into v_opening from private.opening_loans where id=1;
 else select total into v_total from private.settings where id=1 for update; v_opening:=new.outstanding; end if;
 if (select count(*) from private.lifecycle_assets where kind='bike' and state='available')>0 and
  (v_total is null or (select count(*) from private.lifecycle_assets where kind='bike' and state='available')
   +(select count(*) from private.records where status='borrowed')+v_opening>v_total)
 then raise exception '庫存與可用編號車衝突，請先完成實車盤點'; end if;
 return new;
end $$;
create trigger lifecycle_settings_inventory_guard before update on private.settings
 for each row execute function private.lifecycle_inventory_guard();
create trigger lifecycle_opening_inventory_guard before update on private.opening_loans
 for each row execute function private.lifecycle_inventory_guard();
revoke all on function private.lifecycle_inventory_guard() from public,anon,authenticated;

-- Keep the proven adjustment retry protocol, counting both generations of loans.
create or replace function public.admin_set_borrowed(p_borrowed integer,p_expected_borrowed integer,p_expected_opening integer,p_request_id uuid,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_total integer; v_old_borrowed bigint; v_old_opening integer; v_real bigint; v_new_opening integer; v_previous private.borrowed_adjustments; v_payload jsonb; v_receipt jsonb; v_reason text;
begin
 v_actor:=private.require_admin(); v_reason:=btrim(p_reason);
 if p_borrowed is null or p_borrowed<0 or p_borrowed>10000 or p_expected_borrowed is null or p_expected_borrowed<0 or p_expected_borrowed>10000 or p_expected_opening is null or p_expected_opening<0 or p_expected_opening>10000 or p_request_id is null or v_reason is null or length(v_reason)=0 or length(v_reason)>500 or p_reason ~ '[[:cntrl:]]' then raise exception '已借出數量、調整原因或操作識別碼格式不正確'; end if;
 select total into v_total from private.settings where id=1 for update;
 v_payload:=jsonb_build_object('borrowed',p_borrowed,'expectedBorrowed',p_expected_borrowed,'expectedOpening',p_expected_opening,'reason',v_reason);
 select * into v_previous from private.borrowed_adjustments where request_id=p_request_id;
 if found then
  if v_previous.payload<>v_payload then raise exception '操作識別碼已用於不同調整內容'; end if;
  return jsonb_build_object('receipt',v_previous.receipt,'opening',private.opening_json(),'summary',private.summary_json());
 end if;
 select outstanding into v_old_opening from private.opening_loans where id=1;
 v_real:=private.borrowed_count()-v_old_opening; v_old_borrowed:=v_real+v_old_opening;
 if v_total is null then raise exception '幹部尚未設定社車總數'; end if;
 if p_borrowed>v_total then raise exception '已借出數量不可超過總車數'; end if;
 if p_borrowed<v_real then raise exception '已借出數量不可低於社員借用紀錄數量'; end if;
 if p_expected_borrowed<>v_old_borrowed or p_expected_opening<>v_old_opening then raise exception '數量已變更，請重新載入後再調整'; end if;
 v_new_opening:=p_borrowed-v_real;
 if v_new_opening+(select count(*) from private.records where status='borrowed')
  +(select count(*) from private.lifecycle_assets where kind='bike' and state='available')>v_total
 then raise exception '調整數量與可用編號車衝突，請先盤點車輛狀態'; end if;
 update private.opening_loans set outstanding=v_new_opening where id=1;
 v_receipt:=jsonb_build_object('requestId',p_request_id,'actor',v_actor,'at',clock_timestamp(),'reason',v_reason,'oldBorrowed',v_old_borrowed,'newBorrowed',p_borrowed,'oldOpening',v_old_opening,'newOpening',v_new_opening,'realBorrowed',v_real);
 insert into private.borrowed_adjustments(request_id,payload,receipt) values(p_request_id,v_payload,v_receipt);
 insert into private.audit(actor,action,details) values(v_actor,'borrowed-adjustment',v_receipt);
 return jsonb_build_object('receipt',v_receipt,'opening',private.opening_json(),'summary',private.summary_json());
end $$;

-- Existing backup entrypoint must cover new original evidence as well.
alter function public.admin_export() set schema private;
alter function private.admin_export() rename to admin_export_legacy;
revoke all on function private.admin_export_legacy() from public,anon,authenticated;
create function public.admin_export() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.require_admin();
 return private.admin_export_legacy() || jsonb_build_object('lifecycle',public.lifecycle_admin('export','{}'::jsonb));
end $$;
revoke all on function public.admin_export() from public,anon,authenticated;
grant execute on function public.admin_export() to authenticated;
commit;
notify pgrst,'reload schema';
