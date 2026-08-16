import React, { useCallback, useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  getPersonMatrix, getProfile, listDocuments, listDocumentTypes, listReviews,
  listAudits, decideDocument, openAudit, decideAudit, signedUrl, logRecordView, runAiReview,
  listDepots, updateProfileDetails, listNdtQualifications, setNdtQualification, recordEmploymentEnd
} from '../lib/api'
import { Panel, Loading, ErrorNote, Pill, ValidityStrip, Findings, Field, Empty } from '../components/ui'
import UploadForm from '../components/UploadForm'
import { formatDate, formatDateTime, expiryPhrase } from '../lib/format'
import { useSession } from '../App'

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

  const [details, setDetails] = useState(null)
  const [detailsBusy, setDetailsBusy] = useState(false)
  const [detailsSaved, setDetailsSaved] = useState(false)
  const [qualLevels, setQualLevels] = useState({ PT: '', MT: '', UT: '', RT: '' })
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
        setQualLevels({
          PT: q.find((x) => x.method === 'PT')?.level ?? '',
          MT: q.find((x) => x.method === 'MT')?.level ?? '',
          UT: q.find((x) => x.method === 'UT')?.level ?? '',
          RT: q.find((x) => x.method === 'RT')?.level ?? ''
        })
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

  async function recheck(docId) {
    setBusy(docId)
    try { await runAiReview(docId); load() }
    catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  async function view(path) {
    try {
      const { signedUrl: url } = await signedUrl(path, 60)
      window.open(url, '_blank', 'noopener')
    } catch (e) { setError(e.message) }
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
      const methods = ['PT', 'MT', 'UT', 'RT']
      for (const method of methods) {
        const current = quals.find((q) => q.method === method)?.level ?? null
        const next = qualLevels[method] === '' ? null : Number(qualLevels[method])
        if (next !== current) await setNdtQualification(id, method, next)
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
            <Link to={profile.role === 'manager' ? '/roster' : '/'}>Roster</Link> / {person.sap_no ?? 'No SAP number'}
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

      <Panel title="NDT method qualifications">
        <div className="grid grid-2">
          {['PT', 'MT', 'UT', 'RT'].map((method) => (
            <Field key={method} label={method}>
              {isManager ? (
                <select
                  value={qualLevels[method]}
                  onChange={(e) => setQualLevels((q) => ({ ...q, [method]: e.target.value }))}
                >
                  <option value="">Not qualified</option>
                  <option value="1">Level 1</option>
                  <option value="2">Level 2</option>
                  <option value="3">Level 3</option>
                </select>
              ) : (
                <p className="mono">{qualLevels[method] ? `Level ${qualLevels[method]}` : 'Not qualified'}</p>
              )}
            </Field>
          ))}
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
                      <div style={{ fontWeight: 500 }}>{d.document_types?.name}</div>
                      <div className="mono muted">
                        {d.file_name} · issued {formatDate(d.issued_on)} · {expiryPhrase(
                          d.expires_on ? Math.round((new Date(d.expires_on) - new Date()) / 86400000) : null
                        )}
                      </div>
                    </div>
                    <div className="row">
                      <Pill state={d.status} />
                      <button className="small" onClick={() => view(d.storage_path)}>Open file</button>
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <ReviewSummary review={review} />
                  </div>

                  {isManager && d.status === 'pending' && (
                    <div style={{ marginTop: 14 }}>
                      <Field label="Reason (required to reject)">
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
                      </div>
                    </div>
                  )}

                  {d.status !== 'pending' && d.decided_at && (
                    <p className="small muted" style={{ marginTop: 10 }}>
                      {d.status === 'approved' ? 'Approved' : 'Rejected'} {formatDateTime(d.decided_at)}
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
