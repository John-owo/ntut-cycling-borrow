-- Apply after 007. Existing records and legacy registration RPCs are preserved.
begin;
alter table private.records
 add column inspection_at timestamptz,
 add column rental_at timestamptz,
 add column return_at timestamptz,
 add column rental_note text not null default '',
 add column return_note text not null default '',
 add column schedule_confirmed_at timestamptz;
create or replace function private.record_json(p_id bigint) returns jsonb language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('id',r.id,'studentId',r.student_id,'name',r.name,'contactType',r.contact_type,'contact',r.contact,'purpose',r.purpose,'inspectionAt',r.inspection_at,'rentalAt',r.rental_at,'returnAt',r.return_at,'rentalNote',r.rental_note,'returnNote',r.return_note,'scheduleConfirmedAt',r.schedule_confirmed_at,'status',r.status,'createdAt',r.created_at,'updatedAt',r.updated_at,'bikeNote',r.bike_note,'position',q.position,'standby',case when q.position is null or s.total is null then null else greatest(0,q.position-(s.total-c.borrowed)) end)
 from private.records r cross join private.settings s
 cross join (select private.borrowed_count() borrowed) c
 cross join lateral (select case when r.status='waiting' then (select count(*) from private.records where status='waiting' and id<=r.id) else null end position) q
 where r.id=p_id and s.id=1
$$;

create or replace function private.public_record(p_record jsonb) returns jsonb language sql immutable security definer set search_path='' as $$
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p_record)
 where key=any(array['id','studentId','name','status','createdAt','updatedAt','position','standby','purpose','inspectionAt','rentalAt','returnAt','rentalNote','returnNote','scheduleConfirmedAt'])
$$;

create function private.register_core(p_student_id text,p_name text,p_contact_type text,p_contact text,p_token text,p_purpose text,p_inspection_at text,p_rental_at text,p_return_at text,p_rental_note text,p_return_note text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id bigint; v_hash text; v_old private.records; v_student text:=upper(btrim(p_student_id)); v_name text:=btrim(p_name); v_type text:=btrim(p_contact_type); v_contact text:=btrim(p_contact); v_purpose text:=btrim(p_purpose);
begin
 if p_inspection_at is null or p_rental_at is null or p_return_at is null or p_inspection_at !~ '^\d{4}-\d{2}-\d{2}T' or p_rental_at !~ '^\d{4}-\d{2}-\d{2}T' or p_return_at !~ '^\d{4}-\d{2}-\d{2}T' or p_inspection_at !~ '(Z|[+-]\d{2}:\d{2})$' or p_rental_at !~ '(Z|[+-]\d{2}:\d{2})$' or p_return_at !~ '(Z|[+-]\d{2}:\d{2})$' then raise exception '預計時間格式不正確'; end if;
 begin
  if not isfinite(p_inspection_at::timestamptz) or not isfinite(p_rental_at::timestamptz) or not isfinite(p_return_at::timestamptz) or p_inspection_at::timestamptz>p_rental_at::timestamptz or p_rental_at::timestamptz>=p_return_at::timestamptz then raise exception '預計時間格式不正確'; end if;
 exception when invalid_datetime_format or datetime_field_overflow then raise exception '預計時間格式不正確'; end;
 if p_rental_note is null or p_return_note is null or length(p_rental_note)>500 or length(p_return_note)>500 or regexp_replace(p_rental_note||p_return_note,E'[\\r\\n]','','g') ~ '[[:cntrl:]]' then raise exception '租用／歸還備註格式不正確'; end if;
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception '查詢碼格式不正確'; end if;
 if v_student is null or v_student !~ '^[a-zA-Z0-9-]{1,30}$' or v_name is null or length(v_name) not between 1 and 80 or v_type is null or length(v_type) not between 1 and 30 or v_contact is null or length(v_contact) not between 1 and 200 or (v_name||v_type||v_contact) ~ '[[:cntrl:]]' then raise exception '登記資料格式不正確'; end if;
 if v_type not in ('line','instagram') then raise exception '聯絡方式格式不正確'; end if;
 if v_purpose is null or v_purpose not in ('group_ride','personal_ride') then raise exception '借車目的格式不正確'; end if;
 perform 1 from private.settings where id=1 for update;
 v_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex');
 select * into v_old from private.records where token_hash=v_hash;
 if found then
  if v_old.student_id<>v_student or v_old.name<>v_name or v_old.contact_type<>v_type or v_old.contact<>v_contact or v_old.purpose is distinct from v_purpose or v_old.inspection_at is distinct from p_inspection_at::timestamptz or v_old.rental_at is distinct from p_rental_at::timestamptz or v_old.return_at is distinct from p_return_at::timestamptz or v_old.rental_note<>btrim(p_rental_note) or v_old.return_note<>btrim(p_return_note) then raise exception '查詢碼已使用'; end if;
  return jsonb_build_object('record',private.record_json(v_old.id),'summary',private.summary_json());
 end if;
 perform private.check_register_throttle();
 if (select total from private.settings where id=1) is null then raise exception '幹部尚未設定社車總數'; end if;
 if exists(select 1 from private.records where student_id=v_student and status in ('waiting','borrowed')) then raise exception '此學號已有有效登記或借用；請使用原查詢碼或聯絡幹部'; end if;
 insert into private.records(student_id,name,contact_type,contact,purpose,token_hash,status,inspection_at,rental_at,return_at,rental_note,return_note) values(v_student,v_name,v_type,v_contact,v_purpose,v_hash,'waiting',p_inspection_at::timestamptz,p_rental_at::timestamptz,p_return_at::timestamptz,btrim(p_rental_note),btrim(p_return_note)) returning id into v_id;
 return jsonb_build_object('record',private.record_json(v_id),'summary',private.summary_json());
end $$;

create or replace function private.public_rpc(p_kind text,p_args text[]) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb; v_message text; v_headers jsonb;
begin
 perform set_config('response.headers','[{"Cache-Control":"no-store"}]',true);
 begin v_headers:=nullif(current_setting('request.headers',true),'')::jsonb; exception when others then v_headers:=null; end;
 if exists(select 1 from regexp_split_to_table(coalesce(v_headers->>'prefer',''),',') preference
           where preference ~* '^\s*tx\s*=\s*rollback\s*$') then
  return private.public_rpc_error(400,'P0001','此端點不支援交易回滾模式');
 end if;
 if coalesce(nullif(current_setting('request.method',true),''),'POST')<>'POST'
    or current_setting('transaction_read_only')='on' then
  return private.public_rpc_error(405,'25006','請使用 POST 呼叫此端點');
 end if;
 -- Outside the exception block: rejected application calls retain this write.
 if not private.consume_public_budget(case when p_kind='register' then 'register' else 'read' end) then
  return private.public_rpc_error(429,'PT429','此網路短時間內請求次數過多，請稍後再試');
 end if;
 begin
  if p_kind='summary' then return private.summary_core();
  elsif p_kind='lookup' then v_result:=private.lookup_core(p_args[1]);
  elsif p_kind='register' and cardinality(p_args)=5 then
   v_result:=private.register_core(p_args[1],p_args[2],p_args[3],p_args[4],p_args[5]);
  elsif p_kind='register' and cardinality(p_args)=6 then
   v_result:=private.register_core(p_args[1],p_args[2],p_args[3],p_args[4],p_args[5],p_args[6]);
  elsif p_kind='register' and cardinality(p_args)=11 then
   v_result:=private.register_core(p_args[1],p_args[2],p_args[3],p_args[4],p_args[5],p_args[6],p_args[7],p_args[8],p_args[9],p_args[10],p_args[11]);
  else raise exception 'Invalid internal route'; end if;
  return jsonb_set(v_result,'{record}',private.public_record(v_result->'record'));
 exception
  when sqlstate 'PT429' then return private.public_rpc_error(429,'PT429',sqlerrm);
  when raise_exception then
   v_message:=sqlerrm;
   if v_message=any(array['預計時間格式不正確','租用／歸還備註格式不正確','查詢碼格式不正確','登記資料格式不正確','聯絡方式格式不正確','借車目的格式不正確','查詢碼已使用','幹部尚未設定社車總數','此學號已有有效登記或借用；請使用原查詢碼或聯絡幹部','查無登記，請確認查詢碼']) then
    return private.public_rpc_error(400,'P0001',v_message);
   end if;
   return private.public_rpc_error(500,'XX000','系統暫時無法處理，請稍後再試或聯絡幹部');
  when others then return private.public_rpc_error(500,'XX000','系統暫時無法處理，請稍後再試或聯絡幹部');
 end;
end $$;

create function public.register(p_student_id text,p_name text,p_contact_type text,p_contact text,p_token text,p_purpose text,p_inspection_at text,p_rental_at text,p_return_at text,p_rental_note text,p_return_note text) returns jsonb language sql volatile security definer set search_path='' as $$
 select private.public_rpc('register',array[p_student_id,p_name,p_contact_type,p_contact,p_token,p_purpose,p_inspection_at,p_rental_at,p_return_at,p_rental_note,p_return_note])
$$;
create function public.admin_confirm_schedule(p_id bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_old private.records;
begin
 v_actor:=private.require_admin();
 perform 1 from private.settings where id=1 for update;
 select * into v_old from private.records where id=p_id;
 if not found then raise exception '查無紀錄'; end if;
 if v_old.schedule_confirmed_at is null then
  if v_old.status<>'waiting' then raise exception '目前狀態不允許此操作'; end if;
  if v_old.inspection_at is null or v_old.rental_at is null or v_old.return_at is null then raise exception '尚未填寫完整預計時間'; end if;
  update private.records set schedule_confirmed_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_id;
  insert into private.audit(actor,action,record_id,details) values(v_actor,'confirm-schedule',p_id,jsonb_build_object('inspectionAt',v_old.inspection_at,'rentalAt',v_old.rental_at,'returnAt',v_old.return_at));
 end if;
 return jsonb_build_object('record',private.record_json(p_id),'summary',private.summary_json());
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
 if p_action='lend' and v_old.inspection_at is not null and v_old.schedule_confirmed_at is null then raise exception '請先確認社員已主動聯絡並確認時間'; end if;
 if p_action='lend' then
  select private.borrowed_count() into v_borrowed;
  if v_total is null or v_borrowed>=v_total then raise exception '目前沒有尚未借出的車輛'; end if;
 end if;
 update private.records set status=v_target,updated_at=clock_timestamp(),bike_note=coalesce(p_bike_note,v_old.bike_note) where id=p_id;
 insert into private.audit(actor,action,record_id,details) values(v_actor,p_action,p_id,jsonb_build_object('bikeNote',coalesce(p_bike_note,v_old.bike_note)));
 return jsonb_build_object('record',private.record_json(p_id),'summary',private.summary_json());
end $$;


revoke all on function private.register_core(text,text,text,text,text,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.register(text,text,text,text,text,text,text,text,text,text,text),public.admin_confirm_schedule(bigint) from public,anon,authenticated;
grant execute on function public.register(text,text,text,text,text,text,text,text,text,text,text) to anon,authenticated;
grant execute on function public.admin_confirm_schedule(bigint) to authenticated;
commit;
notify pgrst, 'reload schema';
