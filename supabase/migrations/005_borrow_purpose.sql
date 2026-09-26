-- Record the borrower's stated purpose. Apply after 004, before deploying the new form.
-- Existing records remain intact with a null purpose (shown as 未記錄 to officers).
begin;

alter table private.records add column purpose text check (purpose in ('group_ride','personal_ride'));

create or replace function private.record_json(p_id bigint) returns jsonb language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('id',r.id,'studentId',r.student_id,'name',r.name,'contactType',r.contact_type,'contact',r.contact,'purpose',r.purpose,'status',r.status,'createdAt',r.created_at,'updatedAt',r.updated_at,'bikeNote',r.bike_note,'position',q.position,'standby',case when q.position is null or s.total is null then null else greatest(0,q.position-(s.total-c.borrowed)) end)
 from private.records r cross join private.settings s
 cross join (select private.borrowed_count() borrowed) c
 cross join lateral (select case when r.status='waiting' then (select count(*) from private.records where status='waiting' and id<=r.id) else null end position) q
 where r.id=p_id and s.id=1
$$;

-- Keep the five-argument registration route for already-open pages. New pages use
-- this six-argument route; both continue to share the existing throttle and locks.
create function public.register(p_student_id text,p_name text,p_contact_type text,p_contact text,p_token text,p_purpose text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id bigint; v_hash text; v_old private.records; v_student text:=upper(btrim(p_student_id)); v_name text:=btrim(p_name); v_type text:=btrim(p_contact_type); v_contact text:=btrim(p_contact); v_purpose text:=btrim(p_purpose);
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception '查詢碼格式不正確'; end if;
 if v_student is null or v_student !~ '^[a-zA-Z0-9-]{1,30}$' or v_name is null or length(v_name) not between 1 and 80 or v_type is null or length(v_type) not between 1 and 30 or v_contact is null or length(v_contact) not between 1 and 200 or (v_name||v_type||v_contact) ~ '[[:cntrl:]]' then raise exception '登記資料格式不正確'; end if;
 if v_type not in ('line','instagram') then raise exception '聯絡方式格式不正確'; end if;
 if v_purpose is null or v_purpose not in ('group_ride','personal_ride') then raise exception '借車目的格式不正確'; end if;
 perform 1 from private.settings where id=1 for update;
 v_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex');
 select * into v_old from private.records where token_hash=v_hash;
 if found then
  if v_old.student_id<>v_student or v_old.name<>v_name or v_old.contact_type<>v_type or v_old.contact<>v_contact or v_old.purpose is distinct from v_purpose then raise exception '查詢碼已使用'; end if;
  return jsonb_build_object('record',private.record_json(v_old.id),'summary',private.summary_json());
 end if;
 perform private.check_register_throttle();
 if (select total from private.settings where id=1) is null then raise exception '幹部尚未設定社車總數'; end if;
 if exists(select 1 from private.records where student_id=v_student and status in ('waiting','borrowed')) then raise exception '此學號已有有效登記或借用；請使用原查詢碼或聯絡幹部'; end if;
 insert into private.records(student_id,name,contact_type,contact,purpose,token_hash,status) values(v_student,v_name,v_type,v_contact,v_purpose,v_hash,'waiting') returning id into v_id;
 return jsonb_build_object('record',private.record_json(v_id),'summary',private.summary_json());
end $$;

revoke all on function public.register(text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.register(text,text,text,text,text,text) to anon,authenticated;
commit;

notify pgrst, 'reload schema';
