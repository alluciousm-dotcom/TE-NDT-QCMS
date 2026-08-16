import React, { useCallback, useEffect, useState } from 'react'
import { getPersonMatrix, listDocumentTypes, listDocuments, listAudits } from '../lib/api'
import { Panel, Loading, ErrorNote, Pill, ValidityStrip, Empty } from '../components/ui'
import UploadForm from '../components/UploadForm'
import { formatDate, expiryPhrase, STATE_LABEL } from '../lib/format'
import { useSession } from '../App'

export default function MyRecord() {
  const { profile } = useSession()
  const [matrix, setMatrix] = useState(null)
  const [types, setTypes] = useState([])
  const [docs, setDocs] = useState([])
  const [audits, setAudits] = useState([])
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    Promise.all([
      getPersonMatrix(profile.id),
      listDocumentTypes(),
      listDocuments(profile.id),
      listAudits(profile.id)
    ])
      .then(([m, t, d, a]) => { setMatrix(m); setTypes(t); setDocs(d); setAudits(a) })
      .catch((e) => setError(e.message))
  }, [profile.id])

  useEffect(() => { load() }, [load])

  if (error) return <ErrorNote error={error} />
  if (!matrix) return <Loading what="your record" />

  const outstanding = matrix.filter((r) => ['missing', 'expired', 'rejected', 'expiring'].includes(r.state))
  const latestAudit = audits[0]

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">{profile.sap_no ?? 'Personnel record'}</p>
          <h1>{profile.full_name}</h1>
        </div>
        {latestAudit && <Pill state={latestAudit.state}>{`Audit ${latestAudit.state}`}</Pill>}
      </div>

      <Panel title="Certificate status">
        <ValidityStrip rows={matrix} />
        <p className="small muted" style={{ marginTop: 12 }}>
          {outstanding.length === 0
            ? 'Everything is current. Nothing needs your attention.'
            : `${outstanding.length} item${outstanding.length === 1 ? '' : 's'} need${outstanding.length === 1 ? 's' : ''} attention below.`}
        </p>
      </Panel>

      {latestAudit?.state === 'failed' && latestAudit.notes && (
        <div className="error">
          <strong>Your last audit did not pass.</strong> {latestAudit.notes}
        </div>
      )}

      {outstanding.length > 0 && (
        <Panel title="What you need to submit" bodyless>
          <table>
            <thead>
              <tr>
                <th>Certificate</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {outstanding.map((r) => (
                <tr key={r.document_type_id}>
                  <td>{r.document_name}</td>
                  <td><Pill state={r.state} /></td>
                  <td className="small muted">
                    {r.state === 'missing'
                      ? 'Never submitted'
                      : r.state === 'rejected'
                        ? 'Rejected, submit a corrected copy'
                        : expiryPhrase(r.days_remaining)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel title="Upload a certificate">
        <UploadForm subjectId={profile.id} documentTypes={types} onDone={load} />
      </Panel>

      <Panel title="Everything you have submitted" bodyless>
        {docs.length === 0 ? (
          <Empty title="Nothing submitted yet">
            Upload your certificates above. Your manager reviews each one and records a decision.
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Certificate</th>
                <th>File</th>
                <th>Expires</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td>{d.document_types?.name}</td>
                  <td className="mono muted">{d.file_name}</td>
                  <td className="mono">{formatDate(d.expires_on)}</td>
                  <td>
                    <Pill state={d.status}>{STATE_LABEL[d.status] ?? d.status}</Pill>
                    {d.status === 'rejected' && d.decision_reason && (
                      <div className="small muted" style={{ marginTop: 4 }}>{d.decision_reason}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
