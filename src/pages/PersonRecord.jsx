import React, { useCallback, useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  getPersonMatrix, getProfile, listDocuments, listDocumentTypes, listReviews,
  listAudits, decideDocument, deleteDocument, openAudit, decideAudit, signedUrl, logRecordView, runAiReview,
  listDepots, updateProfileDetails, listNdtQualifications, setNdtQualification, recordEmploymentEnd
} from '../lib/api'
import { Panel, Loading, ErrorNote, Pill, ValidityStrip, Findings, Field, Empty } from '../components/ui'
import UploadForm from '../components/UploadForm'
import PdfPreview from '../components/PdfPreview'
import { formatDate, formatDateTime, expiryPhrase } from '../lib/format'
import { useSession } from '../App'

const NDT_METHODS = ['PT', 'MT', 'UT', 'RT']
const NDT_LEVELS = [1, 2, 3, 4]

function ReviewSummary({ review }) {
  if (!review) return <p className="small muted">Not reviewed yet.</p>
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <Pill state={review.verdict}>{review.verdict.replace('_', ' ')}</Pill>
        <span className="mono muted">
          {review.confidence !== null ? `confidence ${Number(review.confidence).toFixed(2)}` : ''}
        </span>
        <span className="mono muted">{review.model}</span>
        <span className="mono muted">prompt {review.prompt_version}</span>
      </div>
      <Findings findings={review.findings} />
      {review.extracted && (
        <p className="small muted" style={{ marginTop: 10 }}>
          Read from the document: holder {review.extracted.holder_name ?? 'not found'},
          issued {review.extracted.issued_on ?? 'not found'},
          expires {review.extracted.expires_on ?? 'not found'}
          {review.extracted.id_number ? `, ID number ${review.extracted.id_number}` : ''}
          {review.extracted.position ? `, position ${review.extracted.position}` : ''}.
        </p>
      )}
      <p className="small muted" style={{ marginTop: 8 }}>
        This is a reading aid. The compliance decision stays with the manager.
      </p>
    </div>
  )
}

export default function PersonRecord() {
  const { id } = useParams()
  const { profile } = useSession()
  const isManager = profile.role === 'manager'
  // A supervisor only ever loads data for people they supervise — RLS sees
  // to that — so if this page has data, they're allowed to be here. The
  // delete_document RPC re-checks this server side regardless.
  const canDelete = profile.role === 'manager' || profile.role === 'supervisor'

  const [person, setPerson] = useState(null)
  const [matrix, setMatrix] = useState(null)
  const [docs, setDocs] = useState([])
  const [types, setTypes] = useState([])
  const [reviews, setReviews] = useState([])
  const [audits, setAudits] = useState([])
  const [depots, setDepots] = useState([])
  const [quals, setQuals] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [reason, setReason] = useState({})
  const [notes, setNotes] = useState('')

  const [openDocId, setOpenDocId] = useState(null)
  const [previewUrls, setPreviewUrls] = useState({})
  const [previewErrors, setPreviewErrors] = useState({})

  const [details, setDetails] = useState(null)
  const [detailsBusy, setDetailsBusy] = useState(false)
  const [detailsSaved, setDetailsSaved] = useState(false)
  // Keyed "METHOD-LEVEL" -> true. A person can hold more than one level of
  // the same method at once, so this is a set of independent toggles, not
  // one dropdown per method. initialQualSelections is the loaded baseline;
  // saveQualifications diffs against it to know what actually changed.
  const [qualSelections, setQualSelections] = useState({})
  const [initialQualSelections, setInitialQualSelections] = useState({})
  const [qualBusy, setQualBusy] = useState(false)
  const [endedOn, setEndedOn] = useState('')
  const [endBusy, setEndBusy] = useState(false)

  const load = useCallback(() => {
    Promise.all([
      getProfile(id), getPersonMatrix(id), listDocuments(id),
      listDocumentTypes(), listReviews(id), listAudits(id), listDepots(), listNdtQualifications(id)
    ])
      .then(([p, m, d, t, r, a, dep, q]) => {
        setPerson(p); setMatrix(m); setDocs(d); setTypes(t); setReviews(r); setAudits(a)
        setDepots(dep); setQuals(q)
        setDetails({
          fullName: p.full_name ?? '', sapNo: p.sap_no ?? '', depotCode: p.depot_code ?? '',
          idNumber: p.id_number ?? '', position: p.position ?? '', supervisorDiscipline: p.supervisor_discipline ?? ''
        })
        const sel = {}
        q.forEach((x) => { sel[`${x.method}-${x.level}`] = true })
        setQualSelections(sel)
        setInitialQualSelections(sel)
      })
      .catch((e) => setError(e.message))
  }, [id])

  useEffect(() => { load(); logRecordView(id) }, [load, id])

  async function decide(docId, status) {
    setError(null)
    if (status === 'rejected' && !reason[docId]?.trim()) {
      setError('Say what is wrong with the document. The person sees this and needs to know what to fix.')
      return
    }
    setBusy(docId)
    try {
      await decideDocument(docId, status, reason[docId] ?? null)
      setReason((r) => ({ ...r, [docId]: '' }))
      load()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  async function remove(doc) {
    setError(null)
    const text = reason[doc.id]?.trim()
    if (!text) {
      setError('Say why this document is being deleted. It stays visible with that reason attached.')
      return
    }
    if (!window.confirm(`Delete "${doc.file_name}"? It will drop off ${person.full_name}'s active record. This can't be undone from here.`)) {
      return
    }
    setBusy(doc.id)
    try {
      await deleteDocument(doc.id, text)
      setReason((r) => ({ ...r, [doc.id]: '' }))
      load()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  async function recheck(docId) {
    setBusy(docId)
    try { await runAiReview(docId); load() }
    catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  // Renders inline instead of window.open — a new tab triggered after an
  // await is silently blocked by most browsers since it no longer counts as
  // a direct result of the click. A signed link is fetched once per document
  // and cached; "Refresh" gets a fresh one if the 3-minute link has lapsed.
  async function loadPreview(doc) {
    setPreviewErrors((p) => ({ ...p, [doc.id]: null }))
    try {
      const { signedUrl: url } = await signedUrl(doc.storage_path, 180)
      setPreviewUrls((p) => ({ ...p, [doc.id]: url }))
    } catch (e) {
      setPreviewErrors((p) => ({ ...p, [doc.id]: e.message }))
    }
  }

  function toggleView(doc) {
    if (openDocId === doc.id) { setOpenDocId(null); return }
    setOpenDocId(doc.id)
    if (!previewUrls[doc.id]) loadPreview(doc)
  }

  async function audit(action) {
    setError(null)
    setBusy('audit')
    try {
      if (action === 'open') await openAudit(id)
      else {
        const current = audits.find((a) => a.state === 'open' || a.state === 'reopened')
        if (!current) throw new Error('Open an audit before recording a decision.')
        if (action === 'failed' && !notes.trim()) {
          throw new Error('A failed audit needs notes naming what must be addressed.')
        }
        await decideAudit(current.id, action, notes)
        setNotes('')
      }
      load()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  async function saveDetails(e) {
    e.preventDefault()
    setError(null); setDetailsSaved(false)
    if (details.supervisorDiscipline && person.role !== 'supervisor') {
      setError('Discipline only applies to supervisors. Change the role first from the People page.')
      return
    }
    setDetailsBusy(true)
    try {
      await updateProfileDetails(id, {
        fullName: details.fullName.trim() || null,
        sapNo: details.sapNo.trim() || null,
        depotCode: details.depotCode || null,
        idNumber: details.idNumber.trim() || null,
        position: details.position.trim() || null,
        supervisorDiscipline: details.supervisorDiscipline || null
      })
      setDetailsSaved(true)
      load()
    } catch (e) { setError(e.message) } finally { setDetailsBusy(false) }
  }

  async function saveQualifications() {
    setError(null)
    setQualBusy(true)
    try {
      for (const method of NDT_METHODS) {
        for (const level of NDT_LEVELS) {
          const key = `${method}-${level}`
          const was = !!initialQualSelections[key]
          const now = !!qualSelections[key]
          if (was !== now) await setNdtQualification(id, method, level, now)
        }
      }
      load()
    } catch (e) { setError(e.message) } finally { setQualBusy(false) }
  }

  async function endEmployment() {
    setError(null)
    if (!endedOn) { setError('Choose the last day of employment.'); return }
    setEndBusy(true)
    try {
      await recordEmploymentEnd(id, endedOn, 'Recorded by manager')
      setEndedOn('')
      load()
    } catch (e) { setError(e.message) } finally { setEndBusy(false) }
  }

  if (error && !person) return <ErrorNote error={error} />
  if (!person || !matrix) return <Loading what="this record" />

  const reviewFor = (docId) => reviews.find((r) => r.document_id === docId)
  const current = audits.find((a) => a.state === 'open' || a.state === 'reopened')
  const blocking = matrix.filter((r) => ['missing', 'expired', 'rejected'].includes(r.state))
  const pending = docs.filter((d) => d.status === 'pending')

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">
            <Link to={profile.role === 'manager' ? '/roster' : '/'}>Compliance</Link> / {person.sap_no ?? 'No SAP number'}
          </p>
          <h1>{person.full_name}</h1>
        </div>
        <div className="row">
          {current
            ? <Pill state={current.state}>{`Audit ${current.state}`}</Pill>
            : audits[0] && <Pill state={audits[0].state}>{`Last audit ${audits[0].state}`}</Pill>}
        </div>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      {isManager && details && (
        <Panel title="Personnel details">
          <form onSubmit={saveDetails}>
            <div className="grid grid-2">
              <Field label="Full name" hint="Fill this in once Proof of Employment has been reviewed.">
                <input
                  value={details.fullName}
                  onChange={(e) => setDetails((d) => ({ ...d, fullName: e.target.value }))}
                />
              </Field>
              <Field label="SAP number">
                <input
                  value={details.sapNo}
                  onChange={(e) => setDetails((d) => ({ ...d, sapNo: e.target.value }))}
                />
              </Field>
            </div>
            <div className="grid grid-2" style={{ marginTop: 14 }}>
              <Field label="Region">
                <select
                  value={details.depotCode}
                  onChange={(e) => setDetails((d) => ({ ...d, depotCode: e.target.value }))}
                >
                  <option value="">No region</option>
                  {depots.map((dp) => <option key={dp.code} value={dp.code}>{dp.name} ({dp.code})</option>)}
                </select>
              </Field>
              <Field label="ID number">
                <input
                  value={details.idNumber}
                  onChange={(e) => setDetails((d) => ({ ...d, idNumber: e.target.value }))}
                />
              </Field>
            </div>
            <div className="grid grid-2" style={{ marginTop: 14 }}>
              <Field label="Position">
                <input
                  value={details.position}
                  onChange={(e) => setDetails((d) => ({ ...d, position: e.target.value }))}
                  placeholder="NDT Technician"
                />
              </Field>
              {person.role === 'supervisor' && (
                <Field label="Discipline">
                  <select
                    value={details.supervisorDiscipline}
                    onChange={(e) => setDetails((d) => ({ ...d, supervisorDiscipline: e.target.value }))}
                  >
                    <option value="">Not set</option>
                    <option value="QA">QA</option>
                    <option value="OPS">OPS</option>
                  </select>
                </Field>
              )}
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" type="submit" disabled={detailsBusy}>
                {detailsBusy ? 'Saving' : 'Save details'}
              </button>
              {detailsSaved && <span className="small muted">Saved.</span>}
            </div>
          </form>
        </Panel>
      )}

      <Panel
        title="NDT method qualifications"
        action={<span className="small muted">A person can hold more than one level of the same method.</span>}
      >
        <div className="grid grid-2">
          {NDT_METHODS.map((method) => {
            const heldLevels = NDT_LEVELS.filter((level) => qualSelections[`${method}-${level}`])
            return (
              <Field key={method} label={method}>
                {isManager ? (
                  <div className="row">
                    {NDT_LEVELS.map((level) => {
                      const key = `${method}-${level}`
                      return (
                        <label key={level} className="row" style={{ gap: 4, fontWeight: 400 }}>
                          <input
                            type="checkbox" style={{ width: 'auto' }}
                            checked={!!qualSelections[key]}
                            onChange={(e) => setQualSelections((s) => ({ ...s, [key]: e.target.checked }))}
                          />
                          L{level}
                        </label>
                      )
                    })}
                  </div>
                ) : (
                  <p className="mono">
                    {heldLevels.length ? heldLevels.map((l) => `Level ${l}`).join(', ') : 'Not qualified'}
                  </p>
                )}
              </Field>
            )
          })}
        </div>
        {isManager && (
          <div className="row" style={{ marginTop: 12 }}>
            <button className="small" disabled={qualBusy} onClick={saveQualifications}>
              {qualBusy ? 'Saving' : 'Save qualifications'}
            </button>
          </div>
        )}
      </Panel>

      {isManager && person.status !== 'suspended' && (
        <Panel title="End of employment">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Last day of employment">
              <input type="date" value={endedOn} onChange={(e) => setEndedOn(e.target.value)} />
            </Field>
            <button className="reject" disabled={endBusy} onClick={endEmployment}>
              {endBusy ? 'Recording' : 'Record end of employment'}
            </button>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            This suspends the person's record and removes them from the active roster.
          </p>
        </Panel>
      )}
      {person.status === 'suspended' && person.employment_ended_on && (
        <div className="notice">
          Employment ended {formatDate(person.employment_ended_on)}. This record is suspended.
        </div>
      )}

      <Panel title="Certificate status">
        <ValidityStrip rows={matrix} />
        <p className="small muted" style={{ marginTop: 12 }}>
          {blocking.length === 0
            ? 'All mandatory certificates are on file and current.'
            : `Not cleared for site: ${blocking.map((b) => b.document_name).join(', ')}.`}
        </p>
      </Panel>

      {isManager && (
        <Panel title={current ? 'Record the audit decision' : 'Compliance audit'}>
          {current ? (
            <div>
              <p className="small muted">
                Opened {formatDateTime(current.opened_at)}. {pending.length} document
                {pending.length === 1 ? '' : 's'} awaiting a decision,
                {' '}{blocking.length} requirement{blocking.length === 1 ? '' : 's'} outstanding.
              </p>
              <Field
                label="Notes"
                hint="Required when failing an audit. The person sees this text, so name the specific document and what is wrong."
              >
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="approve" disabled={busy === 'audit'} onClick={() => audit('passed')}>
                  Pass audit
                </button>
                <button className="reject" disabled={busy === 'audit'} onClick={() => audit('failed')}>
                  Fail audit
                </button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button className="primary" disabled={busy === 'audit'} onClick={() => audit('open')}>
                Open an audit
              </button>
              <span className="small muted">
                {audits[0]
                  ? `Last decided ${formatDateTime(audits[0].decided_at)}.`
                  : 'No audit has been run for this person yet.'}
              </span>
            </div>
          )}
        </Panel>
      )}

      <Panel title={`Submitted documents (${docs.length})`} bodyless>
        {docs.length === 0 ? (
          <Empty title="Nothing on file">
            Upload on this person's behalf below, or ask them to submit their own certificates.
          </Empty>
        ) : (
          <div style={{ padding: '0 16px' }}>
            {docs.map((d) => {
              const review = reviewFor(d.id)
              return (
                <div key={d.id} style={{ borderBottom: '1px solid var(--line)', padding: '16px 0' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontWeight: 500 }}>
                        {d.document_types?.name}{d.method ? ` (${d.method}${d.level ? ` · Level ${d.level}` : ''})` : ''}
                      </div>
                      <div className="mono muted">
                        {d.file_name} · issued {formatDate(d.issued_on)} · {expiryPhrase(
                          d.expires_on ? Math.round((new Date(d.expires_on) - new Date()) / 86400000) : null
                        )}
                      </div>
                    </div>
                    <div className="row">
                      <Pill state={d.status} />
                      <button className="small" onClick={() => toggleView(d)}>
                        {openDocId === d.id ? 'Hide' : 'View'}
                      </button>
                    </div>
                  </div>

                  {openDocId === d.id && (
                    <div className="doc-preview">
                      {previewErrors[d.id] ? (
                        <ErrorNote
                          error={previewErrors[d.id]}
                          onDismiss={() => setPreviewErrors((p) => ({ ...p, [d.id]: null }))}
                        />
                      ) : !previewUrls[d.id] ? (
                        <p className="small muted">Loading preview…</p>
                      ) : (d.mime_type ?? '').includes('pdf') ? (
                        <PdfPreview url={previewUrls[d.id]} />
                      ) : (d.mime_type ?? '').startsWith('image/') && !(d.mime_type ?? '').includes('heic') ? (
                        <img
                          src={previewUrls[d.id]}
                          alt={d.file_name}
                          onError={() => setPreviewErrors((p) => ({
                            ...p, [d.id]: 'Could not render a preview for this file. Try "Open in a new tab" below.'
                          }))}
                        />
                      ) : (
                        <p className="small muted">
                          Preview isn't available for this file type ({d.mime_type ?? 'unknown'}).
                          Use "Open in a new tab" below.
                        </p>
                      )}
                      {previewUrls[d.id] && !previewErrors[d.id] && (
                        <div className="row" style={{ marginTop: 10 }}>
                          <a href={previewUrls[d.id]} target="_blank" rel="noopener noreferrer" className="small">
                            Open in a new tab
                          </a>
                          <button className="link" onClick={() => loadPreview(d)}>Refresh link</button>
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ marginTop: 12 }}>
                    <ReviewSummary review={review} />
                  </div>

                  {isManager && d.status === 'pending' && (
                    <div style={{ marginTop: 14 }}>
                      <Field label="Reason (required to reject or delete)">
                        <input
                          value={reason[d.id] ?? ''}
                          onChange={(e) => setReason((r) => ({ ...r, [d.id]: e.target.value }))}
                          placeholder="Expiry date is not legible on the scan"
                        />
                      </Field>
                      <div className="row" style={{ marginTop: 10 }}>
                        <button className="approve" disabled={busy === d.id} onClick={() => decide(d.id, 'approved')}>
                          Approve
                        </button>
                        <button className="reject" disabled={busy === d.id} onClick={() => decide(d.id, 'rejected')}>
                          Reject
                        </button>
                        <button className="small" disabled={busy === d.id} onClick={() => recheck(d.id)}>
                          Run the check again
                        </button>
                        <button className="reject" disabled={busy === d.id} onClick={() => remove(d)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  )}

                  {!isManager && canDelete && d.status === 'pending' && (
                    <div style={{ marginTop: 14 }}>
                      <Field label="Reason (required to delete)">
                        <input
                          value={reason[d.id] ?? ''}
                          onChange={(e) => setReason((r) => ({ ...r, [d.id]: e.target.value }))}
                          placeholder="Wrong file, uploaded by mistake"
                        />
                      </Field>
                      <div className="row" style={{ marginTop: 10 }}>
                        <button className="reject" disabled={busy === d.id} onClick={() => remove(d)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  )}

                  {canDelete && d.status === 'rejected' && (
                    <div style={{ marginTop: 14 }}>
                      <Field label="Reason (required to delete)">
                        <input
                          value={reason[d.id] ?? ''}
                          onChange={(e) => setReason((r) => ({ ...r, [d.id]: e.target.value }))}
                          placeholder="Duplicate of another submission"
                        />
                      </Field>
                      <div className="row" style={{ marginTop: 10 }}>
                        <button className="reject" disabled={busy === d.id} onClick={() => remove(d)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  )}

                  {d.status !== 'pending' && d.decided_at && (
                    <p className="small muted" style={{ marginTop: 10 }}>
                      {d.status === 'approved' ? 'Approved' : d.status === 'deleted' ? 'Deleted' : 'Rejected'}
                      {' '}{formatDateTime(d.decided_at)}
                      {d.decision_reason ? `: ${d.decision_reason}` : ''}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Panel>

      <Panel title="Upload on this person's behalf">
        <UploadForm subjectId={id} documentTypes={types} onDone={load} />
        <p className="hint" style={{ marginTop: 12 }}>
          Uploads made here are recorded against you as the uploader and against {person.full_name}
          {' '}as the subject.
        </p>
      </Panel>
    </div>
  )
}
