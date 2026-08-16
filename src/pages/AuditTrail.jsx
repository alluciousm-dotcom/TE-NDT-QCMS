import React, { useEffect, useState } from 'react'
import { listAuditTrail, verifyChain } from '../lib/api'
import { Panel, Loading, ErrorNote, Empty } from '../components/ui'
import { formatDateTime, fingerprint } from '../lib/format'

const ACTION_LABEL = {
  'document.uploaded': 'Document uploaded',
  'document.superseded': 'Document superseded',
  'document.approved': 'Document approved',
  'document.rejected': 'Document rejected',
  'ai_review.completed': 'Automated check completed',
  'audit.opened': 'Audit opened',
  'audit.passed': 'Audit passed',
  'audit.failed': 'Audit failed',
  'audit.reopened': 'Audit reopened',
  'role.granted': 'Role changed',
  'supervisor.assigned': 'Supervisor assigned',
  'record.viewed': 'Record viewed'
}

export default function AuditTrail() {
  const [rows, setRows] = useState(null)
  const [chain, setChain] = useState(null)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    listAuditTrail({ limit: 200 }).then(setRows).catch((e) => setError(e.message))
  }, [])

  async function check() {
    setChain('checking')
    try {
      const result = await verifyChain()
      setChain(result?.[0] ?? null)
    } catch (e) { setError(e.message); setChain(null) }
  }

  if (error && !rows) return <ErrorNote error={error} />
  if (!rows) return <Loading what="the audit trail" />

  const visible = rows.filter((r) => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return (ACTION_LABEL[r.action] ?? r.action).toLowerCase().includes(q)
      || r.action.toLowerCase().includes(q)
      || (r.reason ?? '').toLowerCase().includes(q)
  })

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">Append only · sealed on write</p>
          <h1>Audit trail</h1>
        </div>
        <div className="row">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by action or reason"
            style={{ width: 260 }}
          />
          <button onClick={check} disabled={chain === 'checking'}>
            {chain === 'checking' ? 'Verifying' : 'Verify the chain'}
          </button>
        </div>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      {chain && chain !== 'checking' && (
        <div className={chain.broken_at ? 'error' : 'notice'}>
          {chain.broken_at
            ? `The chain breaks at entry ${chain.broken_at}. Every entry after it is suspect. Escalate this now.`
            : `${chain.checked} entries verified. Each one seals the one before it, so no entry has been altered since it was written.`}
        </div>
      )}

      <Panel title={`${visible.length} entries`} bodyless>
        {visible.length === 0 ? (
          <Empty title="No entries match">Clear the filter to see the full trail.</Empty>
        ) : (
          <div style={{ padding: '4px 16px' }}>
            {visible.map((r) => (
              <div key={r.id} className="trail-row">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div className="trail-action">{ACTION_LABEL[r.action] ?? r.action}</div>
                    <div className="small muted">
                      {r.actor_role} · {formatDateTime(r.occurred_at)}
                      {r.outcome === 'failure' && ' · refused'}
                    </div>
                    {r.reason && <div className="small" style={{ marginTop: 4 }}>{r.reason}</div>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="fingerprint">{fingerprint(r.row_hash)}</div>
                    <div className="fingerprint">req {String(r.request_id).slice(0, 8)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <p className="small muted">
        Showing the most recent 200 entries. Each fingerprint is the first bytes of that entry's
        seal, which is computed from the entry's own content plus the seal of the entry before it.
      </p>
    </div>
  )
}
