-- Apply after 005. Anonymous applications and officer review remain available.
-- Public RPCs now require POST: even reads write an abuse counter. GET/HEAD must
-- not bypass that counter in PostgREST's read-only transactions.
-- https://docs.postgrest.org/en/stable/references/transactions.html
-- Expected application errors return JSON + response.status instead of raising:
-- raising would roll back the counter. Keep PostgREST db-tx-end=commit: SQL
-- cannot control the server's transaction end policy. Explicit client requests
-- for tx=rollback are refused before reading data or registering. Verify actual
-- HTTP status and server transaction policy after deployment.
begin;

create table private.public_rpc_budgets (
 client_hash text not null,
 bucket text not null check (bucket in ('read','register')),
 started_at timestamptz not null,
 attempts integer not null,
 primary key (client_hash,bucket)
);
create index public_rpc_budgets_started on private.public_rpc_budgets(started_at);
alter table private.public_rpc_budgets enable row level security;
revoke all on private.public_rpc_budgets from public,anon,authenticated;

-- Reuse the configured source-address extraction from 003. Its proxy header
-- trust requires production gateway verification; spoofable or shared gateway
-- headers weaken source limits. Missing headers use one shared fallback bucket.
-- One row per source/budget, atomic upsert, capped count, at most 100 expired
-- rows cleaned per request. No per-request event log can grow under a flood.
create function private.consume_public_budget(p_bucket text) returns boolean language plpgsql volatile security definer set search_path='' as $$
declare v_now timestamptz:=clock_timestamp(); v_limit integer; v_window interval; v_count integer;
begin
 if p_bucket='read' then v_limit:=1200; v_window:=interval '1 minute';
 elsif p_bucket='register' then v_limit:=30; v_window:=interval '10 minutes';
 else raise exception 'Invalid internal budget'; end if;
 delete from private.public_rpc_budgets b using (
  select client_hash,bucket from private.public_rpc_budgets
  where started_at < v_now-interval '1 day' order by started_at limit 100 for update skip locked
 ) expired where b.client_hash=expired.client_hash and b.bucket=expired.bucket;
 insert into private.public_rpc_budgets as b(client_hash,bucket,started_at,attempts)
 values(coalesce(private.client_hash(),'unknown'),p_bucket,v_now,1)
 on conflict(client_hash,bucket) do update set
  started_at=case when b.started_at<=v_now-v_window then v_now else b.started_at end,
  attempts=case when b.started_at<=v_now-v_window then 1 else least(b.attempts+1,v_limit+1) end
 returning attempts into v_count;
 return v_count<=v_limit;
end $$;

-- The old success-only log remains a site-wide allocation cap. Source limits
-- move to the persisted request budget above (30/10 minutes suits shared NAT
-- better than the old 10). The settings lock in register serializes this log.
create or replace function private.check_register_throttle() returns void language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=clock_timestamp(); v_n bigint;
begin
 delete from private.register_attempts where at < v_now - interval '1 day';
 select count(*) into v_n from private.register_attempts where at > v_now - interval '1 minute';
 if v_n>=15 then raise exception using message='目前登記人數較多，請一分鐘後再試',errcode='PT429'; end if;
 select count(*) into v_n from private.register_attempts where at > v_now - interval '1 hour';
 if v_n>=90 then raise exception using message='目前登記人數較多，請稍後再試',errcode='PT429'; end if;
 select count(*) into v_n from private.register_attempts where at > v_now - interval '1 day';
 if v_n>=300 then raise exception using message='今日登記次數已達上限，請明天再試或聯絡幹部',errcode='PT429'; end if;
 insert into private.register_attempts(client_hash,at) values(coalesce(private.client_hash(),'unknown'),v_now);
end $$;

-- Move every legacy entry point out of the exposed schema. ACLs follow moved
-- functions, so explicitly revoke them before installing the guarded wrappers.
alter function public.summary() set schema private;
alter function private.summary() rename to summary_core;
alter function public.lookup(text) set schema private;
alter function private.lookup(text) rename to lookup_core;
alter function public.register(text,text,text,text,text) set schema private;
alter function private.register(text,text,text,text,text) rename to register_core;
alter function public.register(text,text,text,text,text,text) set schema private;
alter function private.register(text,text,text,text,text,text) rename to register_core;
revoke all on function private.summary_core(),private.lookup_core(text),private.register_core(text,text,text,text,text),private.register_core(text,text,text,text,text,text) from public,anon,authenticated;

create function private.public_record(p_record jsonb) returns jsonb language sql immutable security definer set search_path='' as $$
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p_record)
 where key=any(array['id','studentId','name','status','createdAt','updatedAt','position','standby','purpose'])
$$;

create function private.public_rpc_error(p_status integer,p_code text,p_message text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 perform set_config('response.status',p_status::text,true);
 if p_status=429 then
  perform set_config('response.headers','[{"Cache-Control":"no-store"},{"Retry-After":"600"}]',true);
 end if;
 return jsonb_build_object('code',p_code,'message',p_message,'details',null,'hint',null);
end $$;

create function private.public_rpc(p_kind text,p_args text[]) returns jsonb language plpgsql volatile security definer set search_path='' as $$
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
  else raise exception 'Invalid internal route'; end if;
  return jsonb_set(v_result,'{record}',private.public_record(v_result->'record'));
 exception
  when sqlstate 'PT429' then return private.public_rpc_error(429,'PT429',sqlerrm);
  when raise_exception then
   v_message:=sqlerrm;
   if v_message=any(array['查詢碼格式不正確','登記資料格式不正確','聯絡方式格式不正確','借車目的格式不正確','查詢碼已使用','幹部尚未設定社車總數','此學號已有有效登記或借用；請使用原查詢碼或聯絡幹部','查無登記，請確認查詢碼']) then
    return private.public_rpc_error(400,'P0001',v_message);
   end if;
   return private.public_rpc_error(500,'XX000','系統暫時無法處理，請稍後再試或聯絡幹部');
  when others then return private.public_rpc_error(500,'XX000','系統暫時無法處理，請稍後再試或聯絡幹部');
 end;
end $$;

create function public.summary() returns jsonb language sql volatile security definer set search_path='' as $$ select private.public_rpc('summary',array[]::text[]) $$;
create function public.lookup(p_token text) returns jsonb language sql volatile security definer set search_path='' as $$ select private.public_rpc('lookup',array[p_token]) $$;
create function public.register(p_student_id text,p_name text,p_contact_type text,p_contact text,p_token text) returns jsonb language sql volatile security definer set search_path='' as $$ select private.public_rpc('register',array[p_student_id,p_name,p_contact_type,p_contact,p_token]) $$;
create function public.register(p_student_id text,p_name text,p_contact_type text,p_contact text,p_token text,p_purpose text) returns jsonb language sql volatile security definer set search_path='' as $$ select private.public_rpc('register',array[p_student_id,p_name,p_contact_type,p_contact,p_token,p_purpose]) $$;

revoke all on function private.consume_public_budget(text),private.public_record(jsonb),private.public_rpc_error(integer,text,text),private.public_rpc(text,text[]),private.client_hash(),private.check_register_throttle() from public,anon,authenticated;
revoke all on function public.summary(),public.lookup(text),public.register(text,text,text,text,text),public.register(text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.summary(),public.lookup(text),public.register(text,text,text,text,text),public.register(text,text,text,text,text,text) to anon,authenticated;
commit;
notify pgrst, 'reload schema';
