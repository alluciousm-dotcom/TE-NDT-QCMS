import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  listPeople, listDepots, getComplianceMatrix, listAllQualifications, listAllAudits
} from '../lib/api'
import { Panel, Loading, ErrorNote, Readout, BarList, StatusBar, Donut } from '../components/ui'
import { STATE_LABEL } from '../lib/format'
import { buildExportRows, buildReportRows, downloadCsv, downloadExcel, downloadPdf, downloadWord } from '../lib/export'

const EXPORT_FORMATS = [
  { value: 'csv', label: 'CSV' },
  { value: 'excel', label: 'Excel (.xlsx)' },
  { value: 'pdf', label: 'PDF report' },
  { value: 'word', label: 'Word report (.docx)' }
]

const METHODS = ['PT', 'MT', 'UT', 'RT']

const STATE_TONE = {
  valid: 'pass', expiring: 'watch', pending: 'steel', expired: 'fail', rejected: 'fail', missing: 'idle'
}
const STATE_ORDER = ['valid', 'expiring', 'pending', 'expired', 'rejected', 'missing']

export default function ManagerDashboard() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [region, setRegion] = useState('')
  const [exportFormat, setExportFormat] = useState('csv')
  const [exporting, setExporting] = useState(false)

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

  // Color follows the entity, never its rank: each method/region/role keeps
  // the same hue regardless of how the counts sort, so a slot never
  // "repaints" as numbers move around between visits.
  // Distinct people, not rows: someone holding both PT Level 1 and PT Level 2
  // is one qualified person, not two.
  const methodRows = METHODS.map((m, i) => ({
    label: m,
    tone: `cat-${i + 1}`,
    value: new Set(sQuals.filter((q) => q.method === m).map((q) => q.subject_id)).size
  }))

  const depotRows = depots
    .map((d, i) => ({
      key: d.code, label: `${d.name} (${d.code})`, tone: `cat-${i + 1}`,
      value: people.filter((p) => p.depot_code === d.code).length
    }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)

  const roleRows = ['staff', 'supervisor', 'manager'].map((role, i) => ({
    key: role, label: role, tone: `cat-${i + 1}`, value: sPeople.filter((p) => p.role === role).length
  }))

  const openAudits = sAudits.filter((a) => a.state === 'open' || a.state === 'reopened').length
  const passedAudits = sAudits.filter((a) => a.state === 'passed').length
  const failedAudits = sAudits.filter((a) => a.state === 'failed').length
  const decidedAudits = passedAudits + failedAudits
  const passRate = decidedAudits ? Math.round((passedAudits / decidedAudits) * 100) : null

  const regionName = region ? depots.find((d) => d.code === region)?.name ?? region : null

  const exportFilename = `te-ndt-qcms-compliance-${region || 'all-regions'}-${new Date().toISOString().slice(0, 10)}`
  const exportRows = () => buildExportRows({ people: sPeople, depots, matrix: sMatrix, quals: sQuals })
  const reportSummary = [
    ['Personnel tracked', trackedIds.size],
    ['Not cleared for site', blockingIds.size],
    ['Expiring within 90 days', expiringSoonIds.size],
    ['Awaiting a decision', pendingDocs]
  ]
  const reportTitle = 'TE-NDT QCMS Compliance Report'
  // jsPDF's default font doesn't reliably render "·" — plain ASCII only in
  // anything that ends up in the PDF report.
  const reportSubtitle = `${regionName ?? 'All regions'} - Generated ${new Date().toLocaleString('en-ZA')}`

  async function handleDownload() {
    setError(null)
    const rows = exportRows()
    if (rows.length === 0) { setError('Nothing to export for this selection.'); return }

    setExporting(true)
    try {
      if (exportFormat === 'csv') downloadCsv(rows, exportFilename)
      else if (exportFormat === 'excel') await downloadExcel(rows, exportFilename)
      else if (exportFormat === 'pdf') {
        await downloadPdf({ rows: buildReportRows(rows), summary: reportSummary, title: reportTitle, subtitle: reportSubtitle, filename: exportFilename })
      } else if (exportFormat === 'word') {
        await downloadWord({ rows: buildReportRows(rows), summary: reportSummary, title: reportTitle, subtitle: reportSubtitle, filename: exportFilename })
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setExporting(false)
    }
  }

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
          <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value)} style={{ width: 170 }}>
            {EXPORT_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <button className="small" onClick={handleDownload} disabled={exporting || sPeople.length === 0}>
            {exporting ? 'Preparing…' : 'Download'}
          </button>
        </div>
      </div>

      {region && (
        <div className="notice">
          Showing {regionName} only. Click the region again in "Personnel by region" below, or use "Clear filter", to see everyone.
          The download above will export just {regionName} too.
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
          <Donut
            segments={depotRows}
            centerLabel={people.length}
            centerSub="People"
            selectedKey={region}
            onSelect={(key) => setRegion((current) => (current === key ? '' : key))}
          />
          <p className="hint" style={{ marginTop: 10 }}>Click a region (ring or legend) to filter the whole dashboard by it.</p>
        </Panel>
        <Panel title="Personnel by role">
          <Donut segments={roleRows} centerLabel={sPeople.length} centerSub="People" />
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
          <Link to="/roster" className="btn">Compliance</Link>
          <Link to="/people" className="btn">People</Link>
          <Link to="/trail" className="btn">Audit trail</Link>
        </div>
      </Panel>
    </div>
  )
}
