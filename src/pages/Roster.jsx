import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getComplianceMatrix } from '../lib/api'
import { Panel, Loading, Empty, ErrorNote, Readout, ValidityStrip } from '../components/ui'
import { useSession } from '../App'

const BLOCKING = new Set(['expired', 'missing', 'rejected'])

export default function Roster() {
  const { profile } = useSession()
  const navigate = useNavigate()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    getComplianceMatrix().then(setRows).catch((e) => setError(e.message))
  }, [])

  const people = useMemo(() => {
    if (!rows) return []
    const grouped = new Map()
    for (const r of rows) {
      if (!grouped.has(r.subject_id)) {
        grouped.set(r.subject_id, {
          id: r.subject_id, name: r.full_name, sapNo: r.sap_no, cells: []
        })
      }
      grouped.get(r.subject_id).cells.push(r)
    }
    return [...grouped.values()].map((p) => {
      const blocking = p.cells.filter((c) => BLOCKING.has(c.state)).length
      const expiring = p.cells.filter((c) => c.state === 'expiring').length
      const pending = p.cells.filter((c) => c.state === 'pending').length
      return { ...p, blocking, expiring, pending, clear: blocking === 0 && pending === 0 }
    }).sort((a, b) => b.blocking - a.blocking || b.expiring - a.expiring || a.name.localeCompare(b.name))
  }, [rows])

  const visible = people.filter((p) => {
    if (filter === 'blocking') return p.blocking > 0
    if (filter === 'expiring') return p.expiring > 0
    if (filter === 'pending') return p.pending > 0
    return true
  })

  const totals = {
    people: people.length,
    blocking: people.filter((p) => p.blocking > 0).length,
    expiring: people.filter((p) => p.blocking === 0 && p.expiring > 0).length,
    pending: people.reduce((n, p) => n + p.pending, 0)
  }

  if (error) return <ErrorNote error={error} />
  if (!rows) return <Loading what="the roster" />

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">
            {profile.role === 'manager' ? 'All personnel' : 'Personnel you supervise'}
          </p>
          <h1>Roster</h1>
        </div>
        <div className="row">
          {['all', 'blocking', 'expiring', 'pending'].map((f) => (
            <button
              key={f}
              className={`small${filter === f ? ' primary' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'Everyone' : f === 'blocking' ? 'Not cleared' : f === 'expiring' ? 'Expiring soon' : 'Awaiting review'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-3">
        <Readout value={totals.blocking} label="Personnel not cleared for site" tone={totals.blocking ? 'fail' : 'pass'} />
        <Readout value={totals.expiring} label="Cleared, but expiring within 30 days" tone={totals.expiring ? 'watch' : undefined} />
        <Readout value={totals.pending} label="Documents awaiting a manager decision" />
      </div>

      <Panel title={`${visible.length} of ${totals.people} personnel`} bodyless>
        {visible.length === 0 ? (
          <Empty title="Nothing here">
            {filter === 'all'
              ? 'No active staff records exist yet. Add people from the People page.'
              : 'No one matches this filter right now.'}
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th style={{ width: '42%' }}>Certificate status</th>
                <th className="num">Blocking</th>
                <th className="num">Expiring</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/people/${p.id}`)}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{p.name}</div>
                    <div className="mono muted">{p.sapNo ?? 'No SAP number'}</div>
                  </td>
                  <td><ValidityStrip rows={p.cells} /></td>
                  <td className="num" style={{ color: p.blocking ? 'var(--fail)' : 'var(--muted)' }}>
                    {p.blocking}
                  </td>
                  <td className="num" style={{ color: p.expiring ? 'var(--watch)' : 'var(--muted)' }}>
                    {p.expiring}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <p className="small muted">
        Each cell in the status row is one mandatory certificate, always in the same position.
        Hover a cell to read its expiry.
      </p>
    </div>
  )
}
