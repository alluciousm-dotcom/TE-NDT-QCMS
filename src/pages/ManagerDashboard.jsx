import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  listPeople, listDepots, getComplianceMatrix, listAllQualifications, listAllAudits
} from '../lib/api'
import { Panel, Loading, ErrorNote, Readout, BarList, StatusBar, Donut } from '../components/ui'
import { STATE_LABEL } from '../lib/format'

const METHODS = ['PT', 'MT', 'UT', 'RT']

const STATE_TONE = {
  valid: 'pass', expiring: 'watch', pending: 'steel', expired: 'fail', rejected: 'fail', missing: 'idle'
}
const STATE_ORDER = ['valid', 'expiring', 'pending', 'expired', 'rejected', 'missing']

export default function ManagerDashboard() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [region, setRegion] = useState('')

  useEffect(() => {
    Promise.all([listPeople(), listDepots(), getComplianceMatrix(), listAllQualifications(), listAllAudits()])
      .then(([people, depots, matrix, quals, audits]) => setData({ people, depots, matrix, quals, audits }))
      .catch((e) => setError(e.message))
  }, [])

  if (error) return <ErrorNote error={error} />
  if (!data) return <Loading what="the dashboard" />

  const { people, depots, matrix, quals, audits } = data

  const scopedIds = new Set(
    (region ? people.filter((p) => p.depot_code === region) : people).map((p) => p.id)
  )
  const sMatrix = region ? matrix.filter((r) => scopedIds.has(r.subject_id)) : matrix
  const sQuals = region ? quals.filter((q) => scopedIds.has(q.subject_id)) : quals
  const sAudits = region ? audits.filter((a) => scopedIds.has(a.subject_id)) : audits
  const sPeople = region ? people.filter((p) => scopedIds.has(p.id)) : people

  const trackedIds = new Set(sMatrix.map((r) => r.subject_id))
  const blockingIds = new Set(
    sMatrix.filter((r) => ['missing', 'expired', 'rejected'].includes(r.state)).map((r) => r.subject_id)
  )
  const pendingDocs = sMatrix.filter((r) => r.state === 'pending').length
  const expiringSoonIds = new Set(
    sMatrix.filter((r) => r.days_remaining !== null && r.days_remaining >= 0 && r.days_remaining <= 90).map((r) => r.subject_id)
  )

  const stateCounts = STATE_ORDER.map((state) => ({
    label: STATE_LABEL[state] ?? state,
    tone: STATE_TONE[state],
    value: sMatrix.filter((r) => r.state === state).length
  }))
  const validCount = sMatrix.filter((r) => r.state === 'valid').length
  const compliancePct = sMatrix.length ? Math.round((validCount / sMatrix.length) * 100) : 0

  const forecast = [
    { label: '≤ 30 days', tone: 'watch', value: sMatrix.filter((r) => r.days_remaining !== null && r.days_remaining >= 0 && r.days_remaining <= 30).length },
    { label: '31–60 days', tone: 'watch', value: sMatrix.filter((r) => r.days_remaining !== null && r.days_remaining > 30 && r.days_remaining <= 60).length },
    { label: '61–90 days', tone: 'steel', value: sMatrix.filter((r) => r.days_remaining !== null && r.days_remaining > 60 && r.days_remaining <= 90).length }
  ]

  const methodRows = METHODS.map((m) => ({
    label: m,
    value: sQuals.filter((q) => q.method === m).length
  }))

  const depotRows = depots
    .map((d) => ({ key: d.code, label: `${d.name} (${d.code})`, value: people.filter((p) => p.depot_code === d.code).length }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)

  const roleRows = ['staff', 'supervisor', 'manager'].map((role) => ({
    label: role, value: sPeople.filter((p) => p.role === role).length
  }))

  const openAudits = sAudits.filter((a) => a.state === 'open' || a.state === 'reopened').length
  const passedAudits = sAudits.filter((a) => a.state === 'passed').length
  const failedAudits = sAudits.filter((a) => a.state === 'failed').length
  const decidedAudits = passedAudits + failedAudits
  const passRate = decidedAudits ? Math.round((passedAudits / decidedAudits) * 100) : null

  const regionName = region ? depots.find((d) => d.code === region)?.name ?? region : null

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">Centralised view</p>
          <h1>Manager dashboard</h1>
        </div>
        <div className="row">
          <select value={region} onChange={(e) => setRegion(e.target.value)} style={{ width: 220 }}>
            <option value="">All regions</option>
            {depots.map((d) => <option key={d.code} value={d.code}>{d.name} ({d.code})</option>)}
          </select>
          {region && <button className="small" onClick={() => setRegion('')}>Clear filter</button>}
        </div>
      </div>

      {region && (
        <div className="notice">
          Showing {regionName} only. Click the region again in "Personnel by region" below, or use "Clear filter", to see everyone.
        </div>
      )}

      <div className="grid grid-3">
        <Readout value={trackedIds.size} label="Personnel tracked (staff + supervisors)" />
        <Readout value={blockingIds.size} label="Not cleared for site" tone={blockingIds.size ? 'fail' : 'pass'} />
        <Readout value={expiringSoonIds.size} label="People with a certificate expiring within 90 days" tone={expiringSoonIds.size ? 'watch' : undefined} />
      </div>
      <div className="grid grid-3">
        <Readout value={pendingDocs} label="Documents awaiting a manager decision" />
        <Readout value={openAudits} label="Audits open" />
        <Readout value={passRate === null ? '—' : `${passRate}%`} label="Audit pass rate (decided audits)" tone={passRate === null ? undefined : passRate >= 80 ? 'pass' : passRate >= 50 ? 'watch' : 'fail'} />
      </div>

      <Panel title="Certificate status overview">
        {sMatrix.length === 0 ? (
          <p className="small muted">No mandatory certificate records for this selection.</p>
        ) : (
          <Donut segments={stateCounts} centerLabel={`${compliancePct}%`} centerSub="Compliant" />
        )}
      </Panel>

      <div className="grid grid-2">
        <Panel title="Certification expiry forecast (next 90 days)">
          <BarList rows={forecast} />
        </Panel>
        <Panel title="Qualified personnel by NDT method">
          <BarList rows={methodRows} />
          <p className="hint" style={{ marginTop: 10 }}>Counts people holding any level in that method, not certificate documents.</p>
        </Panel>
      </div>

      <div className="grid grid-2">
        <Panel title="Personnel by region" action={region && <span className="small muted">filtering: {regionName}</span>}>
          <BarList
            rows={depotRows}
            selectedKey={region}
            onSelect={(key) => setRegion((current) => (current === key ? '' : key))}
          />
          <p className="hint" style={{ marginTop: 10 }}>Click a region to filter the whole dashboard by it.</p>
        </Panel>
        <Panel title="Personnel by role">
          <BarList rows={roleRows} />
        </Panel>
      </div>

      <Panel title="Audit summary">
        <div className="grid grid-3">
          <Readout value={sAudits.length} label="Total audits" />
          <Readout value={passedAudits} label="Passed" tone="pass" />
          <Readout value={failedAudits} label="Failed" tone={failedAudits ? 'fail' : undefined} />
        </div>
      </Panel>

      <Panel title="Quick links">
        <div className="row">
          <Link to="/roster" className="btn">Roster</Link>
          <Link to="/people" className="btn">People</Link>
          <Link to="/trail" className="btn">Audit trail</Link>
        </div>
      </Panel>
    </div>
  )
}
