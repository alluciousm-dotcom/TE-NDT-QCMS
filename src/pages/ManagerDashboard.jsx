import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  listPeople, listDepots, getComplianceMatrix, listAllQualifications, listAllAudits
} from '../lib/api'
import { Panel, Loading, ErrorNote, Readout, BarList, StatusBar } from '../components/ui'
import { STATE_LABEL } from '../lib/format'

const METHODS = ['PT', 'MT', 'UT', 'RT']

const STATE_TONE = {
  valid: 'pass', expiring: 'watch', pending: 'steel', expired: 'fail', rejected: 'fail', missing: 'idle'
}
const STATE_ORDER = ['valid', 'expiring', 'pending', 'expired', 'rejected', 'missing']

export default function ManagerDashboard() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    Promise.all([listPeople(), listDepots(), getComplianceMatrix(), listAllQualifications(), listAllAudits()])
      .then(([people, depots, matrix, quals, audits]) => setData({ people, depots, matrix, quals, audits }))
      .catch((e) => setError(e.message))
  }, [])

  if (error) return <ErrorNote error={error} />
  if (!data) return <Loading what="the dashboard" />

  const { people, depots, matrix, quals, audits } = data

  const trackedIds = new Set(matrix.map((r) => r.subject_id))
  const blockingIds = new Set(
    matrix.filter((r) => ['missing', 'expired', 'rejected'].includes(r.state)).map((r) => r.subject_id)
  )
  const pendingDocs = matrix.filter((r) => r.state === 'pending').length
  const expiringSoonIds = new Set(
    matrix.filter((r) => r.days_remaining !== null && r.days_remaining >= 0 && r.days_remaining <= 90).map((r) => r.subject_id)
  )

  const stateCounts = STATE_ORDER.map((state) => ({
    label: STATE_LABEL[state] ?? state,
    tone: STATE_TONE[state],
    value: matrix.filter((r) => r.state === state).length
  }))

  const forecast = [
    { label: '≤ 30 days', tone: 'watch', value: matrix.filter((r) => r.days_remaining !== null && r.days_remaining >= 0 && r.days_remaining <= 30).length },
    { label: '31–60 days', tone: 'watch', value: matrix.filter((r) => r.days_remaining !== null && r.days_remaining > 30 && r.days_remaining <= 60).length },
    { label: '61–90 days', tone: 'steel', value: matrix.filter((r) => r.days_remaining !== null && r.days_remaining > 60 && r.days_remaining <= 90).length }
  ]

  const methodRows = METHODS.map((m) => ({
    label: m,
    value: quals.filter((q) => q.method === m).length
  }))

  const depotRows = depots
    .map((d) => ({ label: `${d.name} (${d.code})`, value: people.filter((p) => p.depot_code === d.code).length }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)

  const roleRows = ['staff', 'supervisor', 'manager'].map((role) => ({
    label: role, value: people.filter((p) => p.role === role).length
  }))

  const openAudits = audits.filter((a) => a.state === 'open' || a.state === 'reopened').length
  const passedAudits = audits.filter((a) => a.state === 'passed').length
  const failedAudits = audits.filter((a) => a.state === 'failed').length
  const decidedAudits = passedAudits + failedAudits
  const passRate = decidedAudits ? Math.round((passedAudits / decidedAudits) * 100) : null

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">Centralised view</p>
          <h1>Manager dashboard</h1>
        </div>
      </div>

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

      <Panel title="Certificate status overview" bodyless>
        <div className="panel-body">
          <StatusBar segments={stateCounts} />
          <p className="small muted" style={{ marginTop: 12 }}>
            {matrix.length} certificate records across {trackedIds.size} people,
            {' '}{new Set(matrix.map((r) => r.document_type_id)).size} document types each.
          </p>
        </div>
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
        <Panel title="Personnel by region">
          <BarList rows={depotRows} />
        </Panel>
        <Panel title="Personnel by role">
          <BarList rows={roleRows} />
        </Panel>
      </div>

      <Panel title="Audit summary">
        <div className="grid grid-3">
          <Readout value={audits.length} label="Total audits" />
          <Readout value={passedAudits} label="Passed" tone="pass" />
          <Readout value={failedAudits} label="Failed" tone={failedAudits ? 'fail' : undefined} />
        </div>
      </Panel>

      <Panel title="Quick links">
        <div className="row">
          <Link to="/" className="btn">Roster</Link>
          <Link to="/people" className="btn">People</Link>
          <Link to="/trail" className="btn">Audit trail</Link>
        </div>
      </Panel>
    </div>
  )
}
