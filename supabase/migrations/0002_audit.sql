-- 0002: audit trail, AI review log, and the only sanctioned write path

-- ---------------------------------------------------------------- audit log

create table public.audit_log (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  actor_id      uuid references auth.users(id),
  actor_role    text not null check (actor_role in ('manager','supervisor','staff','system')),
  on_behalf_of  uuid references auth.users(id),
  action        text not null,
  entity_type   text not null,
  entity_id     uuid,
  subject_id    uuid references auth.users(id),
  outcome       text not null check (outcome in ('success','failure')),
  reason        text,
  before_state  jsonb,
  after_state   jsonb,
  metadata      jsonb not null default '{}'::jsonb,
  request_id    uuid not null,
  prev_hash     bytea,
  row_hash      bytea not null
);

create index on public.audit_log (subject_id, occurred_at desc);
create index on public.audit_log (actor_id, occurred_at desc);
create index on public.audit_log (action, occurred_at desc);
create index on public.audit_log (request_id);

-- Each row seals itself against the previous one. Editing history breaks the chain.
-- digest() is pgcrypto, which Supabase installs into the "extensions" schema,
-- not "public" — search_path has to include it explicitly or the call 404s.
create or replace function public.audit_log_seal()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  last_hash bytea;
  payload   text;
begin
  select row_hash into last_hash from public.audit_log order by id desc limit 1;
  new.prev_hash := last_hash;

  payload := coalesce(new.occurred_at::text,'')
          || coalesce(new.actor_id::text,'')
          || coalesce(new.actor_role,'')
          || coalesce(new.action,'')
          || coalesce(new.entity_type,'')
          || coalesce(new.entity_id::text,'')
          || coalesce(new.subject_id::text,'')
          || coalesce(new.outcome,'')
          || coalesce(new.before_state::text,'')
          || coalesce(new.after_state::text,'')
          || encode(coalesce(last_hash, ''::bytea), 'hex');

  new.row_hash := digest(payload, 'sha256');
  return new;
end;
$$;

create trigger trg_audit_log_seal
  before insert on public.audit_log
  for each row execute function public.audit_log_seal();

create or replace function public.audit_log_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;

create trigger trg_audit_log_no_change
  before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();

-- Nightly verification. Returns the first id where the chain breaks, or null.
create or replace function public.verify_audit_chain()
returns table (broken_at bigint, checked bigint)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r          record;
  prev       bytea := null;
  payload    text;
  n          bigint := 0;
begin
  for r in select * from public.audit_log order by id loop
    payload := coalesce(r.occurred_at::text,'')
            || coalesce(r.actor_id::text,'')
            || coalesce(r.actor_role,'')
            || coalesce(r.action,'')
            || coalesce(r.entity_type,'')
            || coalesce(r.entity_id::text,'')
            || coalesce(r.subject_id::text,'')
            || coalesce(r.outcome,'')
            || coalesce(r.before_state::text,'')
            || coalesce(r.after_state::text,'')
            || encode(coalesce(prev, ''::bytea), 'hex');

    if digest(payload, 'sha256') <> r.row_hash then
      broken_at := r.id; checked := n; return next; return;
    end if;

    prev := r.row_hash;
    n := n + 1;
  end loop;

  broken_at := null; checked := n; return next;
end;
$$;

-- ------------------------------------------------------------ AI review log

create table public.ai_review_log (
  id                bigint generated always as identity primary key,
  created_at        timestamptz not null default now(),
  document_id       uuid not null references public.documents(id) on delete cascade,
  subject_id        uuid not null references public.profiles(id) on delete cascade,
  request_id        uuid not null,
  model             text not null,
  prompt_version    text not null,
  prompt_hash       text not null,
  document_hash     text not null,
  verdict           text not null check (verdict in ('pass','fail','needs_review','error')),
  findings          jsonb not null default '[]'::jsonb,
  confidence        numeric(4,3),
  extracted         jsonb,
  prompt_tokens     integer,
  completion_tokens integer,
  cost_usd          numeric(10,6),
  latency_ms        integer,
  human_verdict     text,
  reviewed_by       uuid references public.profiles(id),
  reviewed_at       timestamptz,
  overridden        boolean generated always as
                      (human_verdict is not null and human_verdict is distinct from verdict) stored
);

create index on public.ai_review_log (document_id, created_at desc);
create index on public.ai_review_log (subject_id, created_at desc);

-- ---------------------------------------------------------------- internals

create or replace function public.current_role_of()
returns text language sql stable security definer set search_path = public as $$
  select role::text from public.profiles where id = auth.uid();
$$;

create or replace function public.supervises(p_staff uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff_assignments
    where supervisor_id = auth.uid() and staff_id = p_staff
  );
$$;

-- The only function that writes audit rows. Never granted to clients.
create or replace function public.write_audit(
  p_action text, p_entity_type text, p_entity_id uuid, p_subject uuid,
  p_outcome text, p_reason text, p_before jsonb, p_after jsonb, p_request uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log
    (actor_id, actor_role, action, entity_type, entity_id, subject_id,
     outcome, reason, before_state, after_state, request_id)
  values
    (auth.uid(), coalesce(public.current_role_of(), 'system'), p_action, p_entity_type,
     p_entity_id, p_subject, p_outcome, p_reason, p_before, p_after,
     coalesce(p_request, gen_random_uuid()));
end;
$$;

revoke all on function public.write_audit(text,text,uuid,uuid,text,text,jsonb,jsonb,uuid) from public, anon, authenticated;

-- =========================================================================
-- Sanctioned write path. Every state change below records its own audit row
-- in the same transaction. Direct table writes are blocked by RLS.
-- =========================================================================

create or replace function public.record_upload(
  p_subject uuid, p_type uuid, p_path text, p_file_name text, p_hash text,
  p_size bigint, p_mime text, p_issued date, p_expires date, p_request uuid,
  p_never_expires boolean default false, p_method public.ndt_method default null,
  p_level smallint default null
) returns public.documents
language plpgsql security definer set search_path = public as $$
declare
  v_role         text := public.current_role_of();
  v_manager_only boolean;
  v_per_method   boolean;
  v_doc          public.documents;
  v_prev         public.documents;
begin
  if v_role is null then
    raise exception 'no profile for caller';
  end if;
  if not (auth.uid() = p_subject or v_role = 'manager' or public.supervises(p_subject)) then
    perform public.write_audit('document.uploaded','document',null,p_subject,'failure',
      'caller not permitted', null, null, p_request);
    raise exception 'not permitted to upload for this person';
  end if;

  select manager_only, per_method into v_manager_only, v_per_method
    from public.document_types where id = p_type;
  if v_manager_only and v_role <> 'manager' then
    perform public.write_audit('document.uploaded','document',null,p_subject,'failure',
      'this document type is manager only', null, null, p_request);
    raise exception 'only a manager may upload this document type';
  end if;
  if v_per_method and p_method is null then
    raise exception 'choose which NDT method this certificate covers';
  end if;
  if v_per_method and (p_level is null or p_level not between 1 and 3) then
    raise exception 'choose the certified level (1, 2 or 3)';
  end if;
  if not v_per_method then
    p_method := null;
    p_level := null;
  end if;

  -- Scoped by method AND level: a new PT Level 2 certificate supersedes a
  -- person's previous PT Level 2 certificate only — never their PT Level 1,
  -- since a person can hold both at once as independent, coexisting
  -- qualifications. is not distinct from also makes this correct for
  -- ordinary (method-less) document types.
  select * into v_prev from public.documents
   where subject_id = p_subject and document_type_id = p_type and status not in ('superseded', 'deleted')
     and method is not distinct from p_method
     and level is not distinct from p_level
   order by created_at desc limit 1;

  insert into public.documents
    (subject_id, document_type_id, storage_path, file_name, file_hash, mime_type,
     size_bytes, issued_on, expires_on, never_expires, method, level, uploaded_by)
  values
    (p_subject, p_type, p_path, p_file_name, p_hash, p_mime,
     p_size, p_issued, p_expires, p_never_expires, p_method, p_level, auth.uid())
  returning * into v_doc;

  if v_prev.id is not null then
    update public.documents set status = 'superseded', superseded_by = v_doc.id
     where id = v_prev.id;
    perform public.write_audit('document.superseded','document',v_prev.id,p_subject,'success',
      'replaced by newer submission for the same method', to_jsonb(v_prev), to_jsonb(v_doc), p_request);
  end if;

  perform public.write_audit('document.uploaded','document',v_doc.id,p_subject,'success',
    null, null, to_jsonb(v_doc), p_request);

  return v_doc;
end;
$$;

create or replace function public.decide_document(
  p_document uuid, p_status public.doc_status, p_reason text, p_request uuid
) returns public.documents
language plpgsql security definer set search_path = public as $$
declare
  v_role   text := public.current_role_of();
  v_before public.documents;
  v_after  public.documents;
  v_qual_before public.staff_ndt_qualifications;
  v_qual_after  public.staff_ndt_qualifications;
begin
  if v_role <> 'manager' then
    raise exception 'only a manager may approve or reject a document';
  end if;
  if p_status not in ('approved','rejected') then
    raise exception 'decision must be approved or rejected';
  end if;
  if p_status = 'rejected' and coalesce(btrim(p_reason),'') = '' then
    raise exception 'a rejection needs a reason';
  end if;

  select * into v_before from public.documents where id = p_document;
  if v_before.id is null then raise exception 'document not found'; end if;

  update public.documents
     set status = p_status, decided_by = auth.uid(),
         decided_at = now(), decision_reason = p_reason
   where id = p_document
  returning * into v_after;

  perform public.write_audit(
    case when p_status = 'approved' then 'document.approved' else 'document.rejected' end,
    'document', p_document, v_after.subject_id, 'success', p_reason,
    to_jsonb(v_before), to_jsonb(v_after), p_request);

  -- Approving a per-method certificate is the manager's confirmation that
  -- it's real, so it writes the qualification directly rather than leaving
  -- the two to silently drift apart — the certificate and the recorded
  -- level are the same fact, decided at the same moment.
  if p_status = 'approved' and v_after.method is not null and v_after.level is not null then
    select * into v_qual_before from public.staff_ndt_qualifications
     where subject_id = v_after.subject_id and method = v_after.method and level = v_after.level;

    insert into public.staff_ndt_qualifications (subject_id, method, level, updated_at)
    values (v_after.subject_id, v_after.method, v_after.level, now())
    on conflict (subject_id, method, level) do update set updated_at = now()
    returning * into v_qual_after;

    perform public.write_audit('ndt_qualification.set','staff_ndt_qualification',null,v_after.subject_id,'success',
      'Set automatically by approving ' || v_after.method || ' Level ' || v_after.level || ' certificate',
      to_jsonb(v_qual_before), to_jsonb(v_qual_after), p_request);
  end if;

  return v_after;
end;
$$;

-- Retracts a mistaken upload (wrong file, wrong person, duplicate, test
-- upload) rather than truly deleting it: the row and the stored file stay,
-- audited like every other action, but the document drops out of the
-- person's active record and compliance status the same way a superseded
-- one does. Restricted to pending or rejected documents — an approved
-- certificate is live compliance evidence and can only be superseded by a
-- new submission, never deleted out from under someone.
create or replace function public.delete_document(
  p_document uuid, p_reason text, p_request uuid
) returns public.documents
language plpgsql security definer set search_path = public as $$
declare
  v_role   text := public.current_role_of();
  v_before public.documents;
  v_after  public.documents;
begin
  select * into v_before from public.documents where id = p_document;
  if v_before.id is null then raise exception 'document not found'; end if;

  if not (v_role = 'manager' or public.supervises(v_before.subject_id)) then
    perform public.write_audit('document.deleted','document',p_document,v_before.subject_id,'failure',
      'caller not permitted', null, null, p_request);
    raise exception 'only a manager, or the supervisor of this person, may delete a document';
  end if;
  if v_before.status not in ('pending','rejected') then
    raise exception 'only a pending or rejected document may be deleted; an approved certificate can only be superseded by a new submission';
  end if;
  if coalesce(btrim(p_reason),'') = '' then
    raise exception 'say why this document is being deleted';
  end if;

  update public.documents
     set status = 'deleted', decided_by = auth.uid(),
         decided_at = now(), decision_reason = p_reason
   where id = p_document
  returning * into v_after;

  perform public.write_audit('document.deleted','document',p_document,v_after.subject_id,'success',
    p_reason, to_jsonb(v_before), to_jsonb(v_after), p_request);

  return v_after;
end;
$$;

create or replace function public.open_audit(p_subject uuid, p_request uuid)
returns public.compliance_audits
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role_of();
  v_row  public.compliance_audits;
begin
  if v_role <> 'manager' then raise exception 'only a manager may open an audit'; end if;

  insert into public.compliance_audits (subject_id, opened_by)
  values (p_subject, auth.uid())
  returning * into v_row;

  perform public.write_audit('audit.opened','compliance_audit',v_row.id,p_subject,'success',
    null, null, to_jsonb(v_row), p_request);
  return v_row;
end;
$$;

create or replace function public.decide_audit(
  p_audit uuid, p_state public.audit_state, p_notes text, p_request uuid
) returns public.compliance_audits
language plpgsql security definer set search_path = public as $$
declare
  v_role   text := public.current_role_of();
  v_before public.compliance_audits;
  v_after  public.compliance_audits;
begin
  if v_role <> 'manager' then raise exception 'only a manager may decide an audit'; end if;
  if p_state not in ('passed','failed','reopened') then
    raise exception 'invalid audit decision';
  end if;
  if p_state = 'failed' and coalesce(btrim(p_notes),'') = '' then
    raise exception 'a failed audit needs notes naming what must be addressed';
  end if;

  select * into v_before from public.compliance_audits where id = p_audit;
  if v_before.id is null then raise exception 'audit not found'; end if;

  update public.compliance_audits
     set state = p_state,
         decided_by = case when p_state = 'reopened' then null else auth.uid() end,
         decided_at = case when p_state = 'reopened' then null else now() end,
         notes = p_notes
   where id = p_audit
  returning * into v_after;

  perform public.write_audit('audit.' || p_state::text, 'compliance_audit', p_audit,
    v_after.subject_id, 'success', p_notes, to_jsonb(v_before), to_jsonb(v_after), p_request);

  return v_after;
end;
$$;

create or replace function public.set_user_role(
  p_user uuid, p_role public.user_role, p_reason text, p_request uuid
) returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  v_role   text := public.current_role_of();
  v_before public.profiles;
  v_after  public.profiles;
begin
  if v_role <> 'manager' then raise exception 'only a manager may change a role'; end if;
  if p_user = auth.uid() then raise exception 'you cannot change your own role'; end if;

  select * into v_before from public.profiles where id = p_user;
  update public.profiles set role = p_role, status = 'active'
   where id = p_user returning * into v_after;

  perform public.write_audit('role.granted','profile',p_user,p_user,'success',p_reason,
    to_jsonb(v_before), to_jsonb(v_after), p_request);
  return v_after;
end;
$$;

-- Every argument but the subject is optional; pass null to leave a field
-- unchanged. sap_no, depot_code, id_number and position are identity and
-- employment details verified from documents or HR records, so only a
-- manager may set them, not the person themselves.
create or replace function public.update_profile(
  p_subject uuid, p_full_name text, p_sap_no text, p_depot_code text,
  p_id_number text, p_position text, p_supervisor_discipline public.supervisor_discipline,
  p_request uuid
) returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  v_role   text := public.current_role_of();
  v_before public.profiles;
  v_after  public.profiles;
begin
  if v_role <> 'manager' then raise exception 'only a manager may edit these details'; end if;

  select * into v_before from public.profiles where id = p_subject;
  if v_before.id is null then raise exception 'profile not found'; end if;

  update public.profiles set
    full_name             = coalesce(p_full_name, full_name),
    sap_no                = coalesce(p_sap_no, sap_no),
    depot_code             = coalesce(p_depot_code, depot_code),
    id_number              = coalesce(p_id_number, id_number),
    position                = coalesce(p_position, position),
    supervisor_discipline   = coalesce(p_supervisor_discipline, supervisor_discipline)
   where id = p_subject
  returning * into v_after;

  perform public.write_audit('profile.updated','profile',p_subject,p_subject,'success',
    null, to_jsonb(v_before), to_jsonb(v_after), p_request);
  return v_after;
end;
$$;

create or replace function public.record_employment_end(
  p_subject uuid, p_ended_on date, p_reason text, p_request uuid
) returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  v_before public.profiles;
  v_after  public.profiles;
begin
  if public.current_role_of() <> 'manager' then
    raise exception 'only a manager may record an end of employment';
  end if;

  select * into v_before from public.profiles where id = p_subject;
  if v_before.id is null then raise exception 'profile not found'; end if;

  update public.profiles set employment_ended_on = p_ended_on, status = 'suspended'
   where id = p_subject
  returning * into v_after;

  perform public.write_audit('employment.ended','profile',p_subject,p_subject,'success',p_reason,
    to_jsonb(v_before), to_jsonb(v_after), p_request);
  return v_after;
end;
$$;

-- A person can hold more than one level of the same method at once, so this
-- toggles one specific (method, level) pair on or off rather than setting
-- "the" level for a method — p_granted true adds/confirms it, false removes
-- it. A level change is audited the same way a role change is.
create or replace function public.set_ndt_qualification(
  p_subject uuid, p_method public.ndt_method, p_level smallint, p_granted boolean, p_request uuid
) returns public.staff_ndt_qualifications
language plpgsql security definer set search_path = public as $$
declare
  v_role   text := public.current_role_of();
  v_before public.staff_ndt_qualifications;
  v_after  public.staff_ndt_qualifications;
begin
  if v_role <> 'manager' then raise exception 'only a manager may set an NDT qualification'; end if;
  if p_level not between 1 and 4 then raise exception 'level must be between 1 and 4'; end if;

  select * into v_before from public.staff_ndt_qualifications
   where subject_id = p_subject and method = p_method and level = p_level;

  if not p_granted then
    delete from public.staff_ndt_qualifications
     where subject_id = p_subject and method = p_method and level = p_level;
    if v_before.subject_id is not null then
      perform public.write_audit('ndt_qualification.cleared','staff_ndt_qualification',null,p_subject,'success',
        null, to_jsonb(v_before), null, p_request);
    end if;
    return v_before;
  end if;

  insert into public.staff_ndt_qualifications (subject_id, method, level, updated_at)
  values (p_subject, p_method, p_level, now())
  on conflict (subject_id, method, level) do update set updated_at = now()
  returning * into v_after;

  perform public.write_audit('ndt_qualification.set','staff_ndt_qualification',null,p_subject,'success',
    null, to_jsonb(v_before), to_jsonb(v_after), p_request);
  return v_after;
end;
$$;

create or replace function public.assign_supervisor(
  p_supervisor uuid, p_staff uuid, p_request uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare v_role text := public.current_role_of();
begin
  if v_role <> 'manager' then raise exception 'only a manager may assign supervisors'; end if;

  insert into public.staff_assignments (supervisor_id, staff_id, assigned_by)
  values (p_supervisor, p_staff, auth.uid())
  on conflict do nothing;

  perform public.write_audit('supervisor.assigned','staff_assignment',p_staff,p_staff,'success',
    null, null, jsonb_build_object('supervisor_id', p_supervisor), p_request);
end;
$$;

-- Reading someone else's record is itself an auditable event.
create or replace function public.log_record_view(p_subject uuid, p_request uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or auth.uid() = p_subject then return; end if;
  perform public.write_audit('record.viewed','profile',p_subject,p_subject,'success',
    null, null, null, p_request);
end;
$$;
