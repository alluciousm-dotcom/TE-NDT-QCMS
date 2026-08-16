import { supabase, functionsUrl } from './supabase'
import { normalizePassword, sapEmail } from './auth'

// Every action carries a request id. It is the join key between the audit
// trail, the AI review log and the operational logs.
export const newRequestId = () => crypto.randomUUID()

async function sha256Hex(file) {
  const buffer = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function unwrap({ data, error }) {
  if (error) throw new Error(error.message)
  return data
}

/* ------------------------------------------------------------------ read */

export const getProfile = (id) =>
  supabase.from('profiles').select('*').eq('id', id).single().then(unwrap)

export const listDocumentTypes = () =>
  supabase.from('document_types').select('*').order('sort_order').then(unwrap)

export const listPeople = () =>
  supabase.from('profiles').select('*').order('full_name').then(unwrap)

export const listDepots = () =>
  supabase.from('depots').select('*').order('name').then(unwrap)

export const listNdtQualifications = (subjectId) =>
  supabase.from('staff_ndt_qualifications').select('*').eq('subject_id', subjectId).then(unwrap)

export const listAllQualifications = () =>
  supabase.from('staff_ndt_qualifications').select('*').then(unwrap)

export const listAllAudits = () =>
  supabase.from('compliance_audits').select('*').then(unwrap)

export const getComplianceMatrix = () =>
  supabase.from('compliance_matrix').select('*').order('sort_order').then(unwrap)

export const getPersonMatrix = (subjectId) =>
  supabase.from('compliance_matrix').select('*').eq('subject_id', subjectId)
    .order('sort_order').then(unwrap)

export const listDocuments = (subjectId) =>
  supabase.from('documents')
    .select('*, document_types(code, name, requires_expiry)')
    .eq('subject_id', subjectId)
    .order('created_at', { ascending: false })
    .then(unwrap)

export const listReviews = (subjectId) =>
  supabase.from('ai_review_log').select('*').eq('subject_id', subjectId)
    .order('created_at', { ascending: false }).then(unwrap)

export const listAudits = (subjectId) =>
  supabase.from('compliance_audits').select('*').eq('subject_id', subjectId)
    .order('opened_at', { ascending: false }).then(unwrap)

export const listAuditTrail = ({ subjectId = null, limit = 100 } = {}) => {
  let q = supabase.from('audit_log').select('*').order('occurred_at', { ascending: false }).limit(limit)
  if (subjectId) q = q.eq('subject_id', subjectId)
  return q.then(unwrap)
}

export const verifyChain = () => supabase.rpc('verify_audit_chain').then(unwrap)

export const signedUrl = (path, seconds = 60) =>
  supabase.storage.from('compliance-docs').createSignedUrl(path, seconds).then(unwrap)

/* ----------------------------------------------------------------- write */
/* Nothing here writes to a table directly. Each call is an RPC that performs
   the change and records the audit row in the same transaction. */

export async function uploadDocument({ subjectId, documentType, file, issuedOn, expiresOn, neverExpires = false }) {
  const requestId = newRequestId()
  const hash = await sha256Hex(file)
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'bin'
  const path = `${subjectId}/${documentType.code}/${crypto.randomUUID()}.${ext}`

  const { error: upErr } = await supabase.storage
    .from('compliance-docs')
    .upload(path, file, { contentType: file.type, upsert: false })
  if (upErr) throw new Error(`Upload failed: ${upErr.message}`)

  const doc = await supabase.rpc('record_upload', {
    p_subject: subjectId,
    p_type: documentType.id,
    p_path: path,
    p_file_name: file.name,
    p_hash: hash,
    p_size: file.size,
    p_mime: file.type,
    p_issued: issuedOn || null,
    p_expires: expiresOn || null,
    p_never_expires: neverExpires,
    p_request: requestId
  }).then(unwrap)

  return { doc, requestId }
}

export const decideDocument = (documentId, status, reason) =>
  supabase.rpc('decide_document', {
    p_document: documentId, p_status: status,
    p_reason: reason ?? null, p_request: newRequestId()
  }).then(unwrap)

export const openAudit = (subjectId) =>
  supabase.rpc('open_audit', { p_subject: subjectId, p_request: newRequestId() }).then(unwrap)

export const decideAudit = (auditId, state, notes) =>
  supabase.rpc('decide_audit', {
    p_audit: auditId, p_state: state, p_notes: notes ?? null, p_request: newRequestId()
  }).then(unwrap)

export const setUserRole = (userId, role, reason) =>
  supabase.rpc('set_user_role', {
    p_user: userId, p_role: role, p_reason: reason ?? null, p_request: newRequestId()
  }).then(unwrap)

export const assignSupervisor = (supervisorId, staffId) =>
  supabase.rpc('assign_supervisor', {
    p_supervisor: supervisorId, p_staff: staffId, p_request: newRequestId()
  }).then(unwrap)

export const setNdtQualification = (subjectId, method, level) =>
  supabase.rpc('set_ndt_qualification', {
    p_subject: subjectId, p_method: method, p_level: level, p_request: newRequestId()
  }).then(unwrap)

export const updateProfileDetails = (subjectId, {
  fullName = null, sapNo = null, depotCode = null, idNumber = null, position = null, supervisorDiscipline = null
} = {}) =>
  supabase.rpc('update_profile', {
    p_subject: subjectId, p_full_name: fullName, p_sap_no: sapNo, p_depot_code: depotCode,
    p_id_number: idNumber, p_position: position, p_supervisor_discipline: supervisorDiscipline,
    p_request: newRequestId()
  }).then(unwrap)

export const recordEmploymentEnd = (subjectId, endedOn, reason) =>
  supabase.rpc('record_employment_end', {
    p_subject: subjectId, p_ended_on: endedOn, p_reason: reason ?? null, p_request: newRequestId()
  }).then(unwrap)

export const logRecordView = (subjectId) =>
  supabase.rpc('log_record_view', { p_subject: subjectId, p_request: newRequestId() })

/* ---------------------------------------------------------- admin actions */
/* Account creation and password resets touch auth.users, which needs the
   service role key. Both go through the admin-people edge function, never
   through a table the browser can reach. */

async function callAdminPeople(action, payload) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Your session has expired. Sign in again.')

  const res = await fetch(`${functionsUrl}/admin-people`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ action, request_id: newRequestId(), ...payload })
  })

  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? 'The request could not be completed')
  return body
}

export const provisionPerson = ({ sapNo, fullName, depotCode, role, supervisorDiscipline }) =>
  callAdminPeople('provision', {
    sap_no: sapNo, full_name: fullName || null, depot_code: depotCode,
    role, supervisor_discipline: supervisorDiscipline || null
  })

export const resetPersonPassword = (subjectId, newPassword) =>
  callAdminPeople('reset_password', { subject_id: subjectId, new_password: newPassword || null })

/* -------------------------------------------------------------- own account */

export const updateMyName = (userId, fullName) =>
  supabase.from('profiles').update({ full_name: fullName }).eq('id', userId)
    .select().single().then(unwrap)

// Supabase changes a signed-in user's password with no further check, which
// would let anyone at an unlocked, already-signed-in browser take over the
// account. Re-authenticating with the current password first closes that.
export async function changeMyPassword({ sapNo, oldPassword, newPassword }) {
  const { error: verifyErr } = await supabase.auth.signInWithPassword({
    email: sapEmail(sapNo), password: normalizePassword(oldPassword)
  })
  if (verifyErr) throw new Error('Current password is not correct.')

  const { error } = await supabase.auth.updateUser({ password: normalizePassword(newPassword) })
  if (error) throw new Error(error.message)
}

export async function uploadAvatar(userId, file) {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
  const path = `${userId}.${ext}`
  const { error: upErr } = await supabase.storage
    .from('avatars')
    .upload(path, file, { contentType: file.type, upsert: true })
  if (upErr) throw new Error(`Upload failed: ${upErr.message}`)

  const { data } = supabase.storage.from('avatars').getPublicUrl(path)
  const avatarUrl = `${data.publicUrl}?v=${Date.now()}`

  const { error: profErr } = await supabase.from('profiles')
    .update({ avatar_url: avatarUrl }).eq('id', userId)
  if (profErr) throw new Error(profErr.message)

  return avatarUrl
}

/* --------------------------------------------------------------- AI review */

export async function runAiReview(documentId, requestId = newRequestId()) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Your session has expired. Sign in again.')

  const res = await fetch(`${functionsUrl}/ai-review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ document_id: documentId, request_id: requestId })
  })

  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? 'Review could not be completed')
  return body
}
