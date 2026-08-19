-- 0004: standard job positions, manager-editable
--
-- Position was free text; in practice it needs to be a consistent picklist
-- so the same job title isn't spelled three different ways across the
-- roster. Seeded with the trades currently in use; a manager can add or
-- rename entries through add_position / update_position without a
-- migration. Deactivating (rather than deleting) keeps a person's existing
-- position intact even after it falls out of use, since profiles.position
-- stores the name as plain text, not a foreign key.

create table public.positions (
  id          uuid primary key default gen_random_uuid(),
  name        text unique not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into public.positions (name) values
  ('Turner Machinist'),
  ('Quality Assurer'),
  ('Operations Supervisor'),
  ('Specialist'),
  ('Artisan'),
  ('Mst Turner Machinist'),
  ('Artisan (NDT)'),
  ('NDT Inspector Level 1'),
  ('QC'),
  ('Turner & Machinist'),
  ('Master Fitter'),
  ('Senior Operator'),
  ('Fitter'),
  ('Operator'),
  ('Welder'),
  ('Snr Technical Worker'),
  ('Welder/pre-exam');

alter table public.positions enable row level security;

create policy positions_read on public.positions
for select using (auth.uid() is not null);

-- Adds a new position, or reactivates one previously deactivated under the
-- same name (case-insensitive) instead of creating a duplicate.
create or replace function public.add_position(p_name text, p_request uuid)
returns public.positions
language plpgsql security definer set search_path = public as $$
declare
  v_name     text := btrim(p_name);
  v_existing public.positions;
  v_row      public.positions;
begin
  if public.current_role_of() <> 'manager' then
    raise exception 'only a manager may add a position';
  end if;
  if coalesce(v_name, '') = '' then
    raise exception 'enter a position name';
  end if;

  select * into v_existing from public.positions where lower(name) = lower(v_name);
  if v_existing.id is not null then
    if v_existing.active then
      raise exception 'that position already exists';
    end if;
    update public.positions set active = true where id = v_existing.id returning * into v_row;
    perform public.write_audit('position.reactivated','position',v_row.id,null,'success',
      null, to_jsonb(v_existing), to_jsonb(v_row), p_request);
    return v_row;
  end if;

  insert into public.positions (name) values (v_name) returning * into v_row;
  perform public.write_audit('position.added','position',v_row.id,null,'success',
    null, null, to_jsonb(v_row), p_request);
  return v_row;
end;
$$;

-- Renames and/or (de)activates an existing position. Pass null for either
-- argument to leave that field unchanged.
create or replace function public.update_position(
  p_id uuid, p_name text, p_active boolean, p_request uuid
) returns public.positions
language plpgsql security definer set search_path = public as $$
declare
  v_before public.positions;
  v_after  public.positions;
begin
  if public.current_role_of() <> 'manager' then
    raise exception 'only a manager may edit a position';
  end if;

  select * into v_before from public.positions where id = p_id;
  if v_before.id is null then raise exception 'position not found'; end if;

  update public.positions set
    name   = coalesce(nullif(btrim(p_name), ''), name),
    active = coalesce(p_active, active)
   where id = p_id
  returning * into v_after;

  perform public.write_audit('position.updated','position',p_id,null,'success',
    null, to_jsonb(v_before), to_jsonb(v_after), p_request);
  return v_after;
end;
$$;
