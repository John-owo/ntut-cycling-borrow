-- 2026-10-08 club-provided bike labels. These are catalog entries only.
-- They remain in inspection until officers reconcile physical condition,
-- ownership and legacy inventory. Never infer availability from a photo.
begin;
do $$
declare
 v_code text; v_name text; v_existing private.lifecycle_assets;
begin
 perform 1 from private.settings where id=1 for update;
 perform 1 from private.lifecycle_settings where id=1 for update;
 for v_code,v_name in
  select * from (values
   ('1','亞士曼'),('2','普利碼'),('3','defy'),('4','scr'),
   ('5','KHS'),('6','TCR'),('7','HASA'),('8','平把登山車')
  ) as catalog(code,name)
 loop
  select * into v_existing from private.lifecycle_assets where code=v_code for update;
  if found then
   if v_existing.name<>v_name or v_existing.kind<>'bike' or v_existing.state<>'inspection' then
    raise exception 'Confirmed fleet code % already has different data; review manually',v_code;
   end if;
  else
   insert into private.lifecycle_assets(id,code,name,kind,state)
    values(pg_catalog.gen_random_uuid(),v_code,v_name,'bike','inspection');
  end if;
 end loop;
end $$;
commit;
