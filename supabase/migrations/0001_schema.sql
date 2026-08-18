-- TE_NDT_QCMS personnel compliance
-- 0001: core schema

create extension if not exists pgcrypto;

create type public.user_role             as enum ('manager','supervisor','staff');
create type public.doc_status            as enum ('pending','approved','rejected','superseded','deleted');
create type public.audit_state           as enum ('open','passed','failed','reopened');
create type public.ndt_method            as enum ('PT','MT','UT','RT');
create type public.supervisor_discipline as enum ('QA','OPS');

-- ------------------------------------------------------------------ depots

create table public.depots (
  code  text primary key,
  name  text not null
);

insert into public.depots (code, name) values
  ('BFN',    'Bloemfontein'),
  ('KZNDBN', 'Durban'),
  ('KZNSD',  'Richards Bay'),
  ('GMX',    'Germiston'),
  ('KDS',    'Koedoespoort'),
  ('WCSRX',  'Salt River'),
  ('UTH',    'Uitenhage-PE'),
  ('WCSLD',  'Saldanha');

-- ---------------------------------------------------------------- profiles

create table public.profiles (
  id                     uuid primary key references auth.users(id) on delete cascade,
  full_name              text not null,
  email                  text not null,
  sap_no                 text unique,
  depot_code             text references public.depots(code),
  role                   public.user_role not null default 'staff',
  supervisor_discipline  public.supervisor_discipline,
  id_number              text unique,
  position               text,
  avatar_url             text,
  employment_started_on  date,
  employment_ended_on    date,
  status                 text not null default 'active' check (status in ('invited','active','suspended')),
  created_at             timestamptz not null default now()
);

create index on public.profiles (role, status);
create index on public.profiles (depot_code);

-- A new auth user gets a profile automatically. Self sign-up (no metadata)
-- always starts as 'staff' with no depot. When a manager provisions the
-- account through the admin-people edge function, the metadata below carries
-- the role/depot/discipline chosen on the form, seeded here in one step; the
-- edge function writes its own audit row since it is the point of authority.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, sap_no, depot_code, role, supervisor_discipline)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.email,
    new.raw_user_meta_data ->> 'sap_no',
    new.raw_user_meta_data ->> 'depot_code',
    coalesce((new.raw_user_meta_data ->> 'role')::public.user_role, 'staff'),
    (new.raw_user_meta_data ->> 'supervisor_discipline')::public.supervisor_discipline
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------- assignments

create table public.staff_assignments (
  supervisor_id uuid not null references public.profiles(id) on delete cascade,
  staff_id      uuid not null references public.profiles(id) on delete cascade,
  assigned_by   uuid references public.profiles(id),
  assigned_at   timestamptz not null default now(),
  primary key (supervisor_id, staff_id)
);

create index on public.staff_assignments (staff_id);

-- --------------------------------------------------------- NDT method levels
-- One row per (method, level) a person actually holds. A person can hold
-- more than one level of the same method at once — PT Level 1 and PT Level 2
-- as two separate, independently certified rows — so level does not
-- overwrite level the way a new method's row would; only a renewal of the
-- exact same method+level replaces the earlier one. Set only through
-- set_ndt_qualification (0002) so a change is audited the same way a role
-- change is.

create table public.staff_ndt_qualifications (
  subject_id  uuid not null references public.profiles(id) on delete cascade,
  method      public.ndt_method not null,
  level       smallint not null check (level between 1 and 4),
  updated_at  timestamptz not null default now(),
  primary key (subject_id, method, level)
);

-- ---------------------------------------------------------- document types

create table public.document_types (
  id                       uuid primary key default gen_random_uuid(),
  code                     text unique not null,
  name                     text not null,
  description              text,
  mandatory                boolean not null default true,
  requires_expiry          boolean not null default true,
  default_validity_months  integer,
  manager_only             boolean not null default false,
  -- A person can hold this document once per NDT method rather than once
  -- overall — a Level 1 PT cert and a Level 2 MT cert coexist, neither
  -- supersedes the other. Only a new submission for the SAME method does.
  per_method               boolean not null default false,
  review_prompt            text,
  sort_order               integer not null default 100
);

-- manager_only: only a manager may upload this type (enforced in record_upload,
-- 0002). Today that is the log book only; staff and supervisors upload the rest.
insert into public.document_types
  (code, name, description, requires_expiry, default_validity_months, manager_only, per_method, sort_order, review_prompt) values
  ('Q-Cert',    'Qualification certificate', 'NDT method qualification certificate (PT/MT/UT/RT), per ASNT or equivalent scheme.', true,  60,   false, true,  10,
   'Confirm the certified method and level match the person''s recorded NDT qualification, and the certificate carries an issue and expiry date.'),
  ('Exam-R',    'Exam results',              'Results of the qualifying examination for the certified method.',                    false, null, false, false, 20,
   'Confirm the candidate name, method examined and a pass outcome are present.'),
  ('Class-Tr',  'Class training proof',      'Evidence of attendance on the accredited training course.',                          false, null, false, false, 30,
   'Confirm the training provider, course dates and candidate name are present.'),
  ('Log-B',     'Log book',                  'Logged inspection hours. Maintained and uploaded by the manager only.',              false, null, true,  false, 40,
   'Confirm logged hours are itemised by date and method and are signed off.'),
  ('ID-copy',   'Copy of ID',                'Passport or national identity document.',                                            false, null, false, false, 50,
   'Confirm the document is a passport or national ID and is legible. Read the ID number if printed.'),
  ('Eye-test',  'Eye test certificate',      'Near and colour vision acuity, required annually.',                                  true,  12,   false, false, 60,
   'Confirm both near vision acuity and colour perception results are recorded, and the test date.'),
  ('Employ-Pr', 'Proof of employment',       'Confirmation of current employment status.',                                         false, null, false, false, 70,
   'Confirm the letter names the employer and the employee, states their position and a start of employment date. Read the ID number if printed.');

-- --------------------------------------------------------------- documents

create table public.documents (
  id               uuid primary key default gen_random_uuid(),
  subject_id       uuid not null references public.profiles(id) on delete cascade,
  document_type_id uuid not null references public.document_types(id),
  storage_path     text not null,
  file_name        text not null,
  file_hash        text not null,
  mime_type        text,
  size_bytes       bigint,
  issued_on        date,
  expires_on       date,
  never_expires    boolean not null default false,
  -- Which NDT method (and level) this document covers. Only set (and only
  -- meaningful) when document_types.per_method is true; null everywhere
  -- else. Approving a per_method document writes this straight into
  -- staff_ndt_qualifications (see decide_document, 0002) — the certificate
  -- and the recorded qualification would otherwise silently drift apart.
  method           public.ndt_method,
  level            smallint check (level between 1 and 4),
  status           public.doc_status not null default 'pending',
  uploaded_by      uuid not null references public.profiles(id),
  superseded_by    uuid references public.documents(id),
  decided_by       uuid references public.profiles(id),
  decided_at       timestamptz,
  decision_reason  text,
  ai_verdict       text,
  created_at       timestamptz not null default now()
);

create index on public.documents (subject_id, document_type_id, created_at desc);
create index on public.documents (status);

-- --------------------------------------------------------- compliance runs

create table public.compliance_audits (
  id          uuid primary key default gen_random_uuid(),
  subject_id  uuid not null references public.profiles(id) on delete cascade,
  state       public.audit_state not null default 'open',
  opened_by   uuid not null references public.profiles(id),
  opened_at   timestamptz not null default now(),
  decided_by  uuid references public.profiles(id),
  decided_at  timestamptz,
  notes       text
);

create index on public.compliance_audits (subject_id, opened_at desc);

-- --------------------------------------------------------- compliance view
-- One row per staff member per mandatory document requirement, with the
-- current state of its most recent non-superseded submission.
--
-- For an ordinary (non per_method) type that's one row per person, as before.
-- For a per_method type (Q-Cert today) it's one row per (method, level)
-- combination the person EITHER holds a recorded qualification for OR has
-- already submitted a document for — a person can hold more than one level
-- of the same method at once (PT Level 1 and PT Level 2 both on file), so
-- these are independent rows, not one overwriting the other. Uploading a PT
-- Level 2 certificate surfaces "Qualification certificate (PT · Level 2)"
-- immediately, even before a manager confirms it, alongside any existing
-- PT Level 1 row rather than replacing it. This is what the dashboard reads.

create or replace view public.compliance_matrix
with (security_invoker = on) as
select
  p.id                as subject_id,
  p.full_name,
  p.sap_no,
  p.depot_code,
  dt.id               as document_type_id,
  dt.code,
  case when dt.per_method and req.method is not null
       then dt.name || ' (' || req.method || ' · Level ' || req.level::text || ')'
       else dt.name
  end                 as document_name,
  dt.requires_expiry,
  dt.sort_order,
  d.id                as document_id,
  d.status,
  d.expires_on,
  d.ai_verdict,
  d.created_at        as submitted_at,
  case
    when d.id is null                                                                     then 'missing'
    when d.status = 'rejected'                                                             then 'rejected'
    when d.status = 'pending'                                                               then 'pending'
    when dt.requires_expiry and not d.never_expires and d.expires_on is null                then 'pending'
    when dt.requires_expiry and not d.never_expires and d.expires_on <  current_date        then 'expired'
    when dt.requires_expiry and not d.never_expires and d.expires_on <= current_date + 30    then 'expiring'
    else 'valid'
  end as state,
  case when d.never_expires or d.expires_on is null then null
       else (d.expires_on - current_date) end as days_remaining,
  d.never_expires,
  req.method,
  req.level
from public.profiles p
cross join public.document_types dt
cross join lateral (
  select nq.method, nq.level
  from public.staff_ndt_qualifications nq
  where dt.per_method and nq.subject_id = p.id
  union
  select dd.method, dd.level
  from public.documents dd
  where dt.per_method and dd.subject_id = p.id and dd.document_type_id = dt.id
    and dd.method is not null and dd.level is not null
  union all
  select null::public.ndt_method, null::smallint where not dt.per_method
) req
left join lateral (
  select dd.*
  from public.documents dd
  where dd.subject_id = p.id
    and dd.document_type_id = dt.id
    and dd.status not in ('superseded', 'deleted')
    and dd.method is not distinct from req.method
    and dd.level is not distinct from req.level
  order by dd.created_at desc
  limit 1
) d on true
where p.role in ('staff', 'supervisor')
  and p.status <> 'suspended'
  and dt.mandatory;