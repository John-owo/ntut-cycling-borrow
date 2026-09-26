begin;
-- Check live Auth session state on every privileged call, including previously issued JWTs.
create function private.require_officer_session() returns uuid language plpgsql volatile security definer set search_path='' as $$
declare actor uuid := auth.uid(); sid text := auth.jwt()->>'session_id';
begin
 if actor is null or not exists(select 1 from private.admins where user_id=actor) then
  raise exception using message='Officer permission required',errcode='42501';
 end if;
 if sid is null or not exists(select 1 from auth.sessions s where s.id::text=sid and s.user_id=actor and (s.not_after is null or s.not_after>now())) then
  raise exception using message='Officer session expired; please sign in again',errcode='42501';
 end if;
 return actor;
end $$;
revoke all on function private.require_officer_session() from public,anon,authenticated;

create or replace function private.require_admin() returns uuid language plpgsql volatile security definer set search_path='' as $$
declare actor uuid := private.require_officer_session();
begin
 if exists(select 1 from auth.mfa_factors f where f.user_id=actor and f.status='verified') and coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception using message='MFA_REQUIRED',errcode='42501';
 end if;
 return actor;
end $$;

-- This endpoint exposes only the caller's security state, never member records.
create function public.admin_session_status() returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid := private.require_officer_session(); enrolled boolean; factors jsonb;
begin
 select exists(select 1 from auth.mfa_factors f where f.user_id=actor and f.status='verified') into enrolled;
 select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'name',coalesce(f.friendly_name,'Authenticator'))),'[]'::jsonb) into factors from auth.mfa_factors f where f.user_id=actor and f.status='verified' and f.factor_type='totp';
 return jsonb_build_object('enrolled',enrolled,'required',enrolled and coalesce(auth.jwt()->>'aal','')<>'aal2','factors',factors);
end $$;
revoke all on function public.admin_session_status() from public,anon;
grant execute on function public.admin_session_status() to authenticated;
notify pgrst, 'reload schema';
commit;
