-- 0003: row level security and storage
--
-- Reading is governed by policy. Writing is not: there are deliberately no
-- insert or update policies on documents, audits, profiles roles or audit_log.
-- Clients change state only through the security definer RPCs in 0002.

alter table public.profiles                  enable row level security;
alter table public.depots                    enable row level security;
alter table public.staff_assignments         enable row level security;
alter table public.staff_ndt_qualifications  enable row level security;
alter table public.document_types            enable row level security;
alter table public.documents                 enable row level security;
alter table public.compliance_audits         enable row level security;
alter table public.audit_log                 enable row level security;
alter table public.ai_review_log             enable row level security;

-- ---------------------------------------------------------------- profiles

create policy profiles_self on public.profiles
for select using (id = auth.uid());

create policy profiles_manager on public.profiles
for select using (public.current_role_of() = 'manager');

create policy profiles_supervisor on public.profiles
for select using (
  public.current_role_of() = 'supervisor' and public.supervises(id)
);

-- A person may change their own display name and avatar. Everything else on
-- this table (role, sap_no, depot, id number, position, discipline, status,
-- employment dates) is identity and employment data verified from documents
-- or HR records, so it only changes through update_profile / set_user_role /
-- record_employment_end (0002), which a manager calls and which audit.
create policy profiles_update_self on public.profiles
for update using (id = auth.uid())
with check (
  id = auth.uid()
  and role                  is not distinct from (select role                  from public.profiles where id = auth.uid())
  and sap_no                is not distinct from (select sap_no                from public.profiles where id = auth.uid())
  and depot_code             is not distinct from (select depot_code             from public.profiles where id = auth.uid())
  and supervisor_discipline  is not distinct from (select supervisor_discipline  from public.profiles where id = auth.uid())
  and id_number               is not distinct from (select id_number               from public.profiles where id = auth.uid())
  and position                 is not distinct from (select position                 from public.profiles where id = auth.uid())
  and employment_started_on    is not distinct from (select employment_started_on    from public.profiles where id = auth.uid())
  and employment_ended_on      is not distinct from (select employment_ended_on      from public.profiles where id = auth.uid())
  and status                    is not distinct from (select status                    from public.profiles where id = auth.uid())
);

-- ------------------------------------------------------------------ depots

create policy depots_read on public.depots
for select using (auth.uid() is not null);

-- ------------------------------------------------------------- assignments

create policy assignments_read on public.staff_assignments
for select using (
  public.current_role_of() = 'manager'
  or supervisor_id = auth.uid()
  or staff_id = auth.uid()
);

-- --------------------------------------------------------- NDT method levels

create policy ndt_quals_read on public.staff_ndt_qualifications
for select using (
  subject_id = auth.uid()
  or public.current_role_of() = 'manager'
  or public.supervises(subject_id)
);

-- ---------------------------------------------------------- document types

create policy doctypes_read on public.document_types
for select using (auth.uid() is not null);

-- --------------------------------------------------------------- documents

create policy documents_read on public.documents
for select using (
  subject_id = auth.uid()
  or public.current_role_of() = 'manager'
  or public.supervises(subject_id)
);

-- ------------------------------------------------------- compliance audits

create policy audits_read on public.compliance_audits
for select using (
  subject_id = auth.uid()
  or public.current_role_of() = 'manager'
  or public.supervises(subject_id)
);

-- --------------------------------------------------------------- AI review

create policy ai_review_read on public.ai_review_log
for select using (
  subject_id = auth.uid()
  or public.current_role_of() = 'manager'
  or public.supervises(subject_id)
);

-- --------------------------------------------------------------- audit log

create policy audit_read_manager on public.audit_log
for select using (public.current_role_of() = 'manager');

create policy audit_read_supervisor on public.audit_log
for select using (
  public.current_role_of() = 'supervisor' and public.supervises(subject_id)
);

create policy audit_read_self on public.audit_log
for select using (subject_id = auth.uid());

-- ----------------------------------------------------------------- storage
-- Private bucket. Files are reached only through short-lived signed URLs
-- created server side, never by a public object URL.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('compliance-docs', 'compliance-docs', false, 15728640,
        array['application/pdf','image/jpeg','image/png','image/heic'])
on conflict (id) do nothing;

-- Object path convention: {subject_id}/{document_type_code}/{uuid}.{ext}
-- The first path segment is the subject, which is what these policies check.

create policy storage_read on storage.objects
for select using (
  bucket_id = 'compliance-docs' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.current_role_of() = 'manager'
    or public.supervises(((storage.foldername(name))[1])::uuid)
  )
);

create policy storage_write on storage.objects
for insert with check (
  bucket_id = 'compliance-docs' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.current_role_of() = 'manager'
    or public.supervises(((storage.foldername(name))[1])::uuid)
  )
);

-- No update or delete policy. Superseded files stay where they are.

-- Public bucket. Avatars are low sensitivity and served directly as a public
-- URL rather than through signed URLs, so every <img> tag stays simple.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- Object path convention: {user_id}.{ext}, no subfolder. A person may only
-- write their own.

create policy avatars_write on storage.objects
for insert with check (bucket_id = 'avatars' and name like auth.uid()::text || '.%');

create policy avatars_update on storage.objects
for update using (bucket_id = 'avatars' and name like auth.uid()::text || '.%');

create policy avatars_delete on storage.objects
for delete using (bucket_id = 'avatars' and name like auth.uid()::text || '.%');
