-- Block new bookings while the student has an overdue bike (2026-10-17). Apply once after 018.
-- 018 let a member with an overdue in_use loan book another slot that pickup would then refuse. Now apply and
-- reserve refuse while any of the member's in_use bookings is past its return time; returning the bike lifts it.
-- Only private.lifecycle_member_window changes; a bike that is out but not yet due does not block.
begin;
set local lock_timeout='15s';
do $$ begin
 if to_regprocedure('private.lifecycle_member_window(uuid,timestamptz,timestamptz)') is null then
  raise exception 'Apply 018 before 019';
 end if;
 if pg_catalog.strpos(pg_catalog.pg_get_functiondef('private.lifecycle_member_window(uuid,timestamptz,timestamptz)'::regprocedure),'overdue loan')>0 then
  raise exception '019 is already installed; do not replay';
 end if;
end $$;

-- A member's own bookings: no overdue bike, at most two active, none overlapping [p_start,p_end). Callers hold the global lock.
create or replace function private.lifecycle_member_window(p_member uuid,p_start timestamptz,p_end timestamptz) returns void language plpgsql stable security definer set search_path='' as $$
begin
 if p_member is null then return; end if;
 if exists(select 1 from private.lifecycle_reservations where member_id=p_member and status='in_use' and ends_at<clock_timestamp()) then raise exception 'Member has an overdue loan; return it first'; end if;
 if (select count(*) from private.lifecycle_reservations where member_id=p_member and status in ('reserved','in_use','inspection'))>=2 then raise exception 'Member already has two active reservations'; end if;
 if exists(select 1 from private.lifecycle_reservations where member_id=p_member and status in ('reserved','in_use') and starts_at<p_end and ends_at>p_start) then raise exception 'Member already has a reservation in this time'; end if;
end $$;

revoke all on all functions in schema private from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
