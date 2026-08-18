import React from 'react'
import { STATE_LABEL, expiryPhrase } from '../lib/format'

export function Panel({ title, action, children, bodyless = false }) {
  return (
    <section className="panel">
      {(title || action) && (
        <header className="panel-head">
          <h3>{title}</h3>
          {action}
        </header>
      )}
      {bodyless ? children : <div className="panel-body">{children}</div>}
    </section>
  )
}

export function Pill({ state, children }) {
  return <span className={`pill ${state ?? 'missing'}`}>{children ?? STATE_LABEL[state] ?? state}</span>
}

export function Loading({ what = 'records' }) {
  return <p className="loading">Loading {what}</p>
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p className="small">{children}</p>
    </div>
  )
}

export function ErrorNote({ error, onDismiss }) {
  if (!error) return null
  return (
    <div className="error" role="alert">
      {String(error).replace(/^Error:\s*/, '')}
      {onDismiss && <> <button className="link" onClick={onDismiss}>Dismiss</button></>}
    </div>
  )
}

export function Readout({ value, label, tone }) {
  return (
    <div className={`readout${tone ? ` is-${tone}` : ''}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  )
}

/* Signature element. One cell per mandatory certificate, in a fixed order, so
   the same certificate always sits in the same column across every person.
   A supervisor learns the shape of a compliant record and spots gaps by eye. */
export function ValidityStrip({ rows, onSelect }) {
  return (
    <div className="strip" role="list" aria-label="Certificate status">
      {rows.map((r) => {
        const title = `${r.document_name}: ${STATE_LABEL[r.state]}` +
          (r.days_remaining !== null && r.days_remaining !== undefined
            ? ` \u2014 ${expiryPhrase(r.days_remaining)}` : '')
        return (
          <div
            key={`${r.document_type_id}-${r.method ?? ''}-${r.level ?? ''}`}
            role="listitem"
            className={`strip-cell s-${r.state}`}
            title={title}
            aria-label={title}
            onClick={onSelect ? () => onSelect(r) : undefined}
          >
            {r.method ? `${r.method}${r.level ?? ''}` : r.code.split('-')[0].slice(0, 4)}
          </div>
        )
      })}
    </div>
  )
}

export function Findings({ findings }) {
  if (!findings?.length) return <p className="small muted">No findings recorded.</p>
  return (
    <div>
      {findings.map((f, i) => (
        <div key={i} className={`finding ${f.severity}`}>
          <div className="field-name">{f.field}</div>
          <div className="small">{f.detail}</div>
        </div>
      ))}
    </div>
  )
}

/* Magnitude across fixed categories, one hue. Axis labels carry identity;
   color doesn't need to repeat it. onSelect (optional) makes rows clickable
   filter controls — a native title attribute is the hover tooltip. */
export function BarList({ rows, onSelect, selectedKey }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="barlist">
      {rows.map((r) => {
        const key = r.key ?? r.label
        const pct = Math.round((r.value / (max || 1)) * 100)
        return (
          <div
            className={`barlist-row${onSelect ? ' clickable' : ''}${selectedKey === key ? ' is-selected' : ''}`}
            key={key}
            title={`${r.label}: ${r.value}`}
            onClick={onSelect ? () => onSelect(key) : undefined}
          >
            <div className="barlist-label">{r.label}</div>
            <div className="barlist-track">
              <div className={`barlist-fill${r.tone ? ` tone-${r.tone}` : ''}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="barlist-value">{r.value}</div>
          </div>
        )
      })}
    </div>
  )
}

/* Part-to-whole as a ring rather than a flat bar — same rule as StatusBar:
   every segment has a title tooltip and a labelled legend entry, so color
   is never the only way to tell segments apart. */
export function Donut({ segments, size = 168, thickness = 24, centerLabel, centerSub, onSelect, selectedKey }) {
  const total = segments.reduce((n, s) => n + s.value, 0) || 1
  const visible = segments.filter((s) => s.value > 0)
  const r = (size - thickness) / 2
  const c = size / 2
  const circumference = 2 * Math.PI * r
  let offset = 0

  return (
    <div className="donut-row">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={centerSub ?? 'breakdown'}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--panel-2)" strokeWidth={thickness} />
        {visible.map((s) => {
          const key = s.key ?? s.label
          const frac = s.value / total
          const dash = frac * circumference
          const isSelected = selectedKey === key
          const el = (
            <circle
              key={key}
              cx={c} cy={c} r={r} fill="none"
              className={`tone-${s.tone}${onSelect ? ' donut-seg-clickable' : ''}`}
              stroke="currentColor"
              strokeWidth={isSelected ? thickness + 4 : thickness}
              strokeDasharray={`${Math.max(dash - 2, 0)} ${circumference - dash + 2}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${c} ${c})`}
              onClick={onSelect ? () => onSelect(key) : undefined}
            >
              <title>{`${s.label}: ${s.value} (${Math.round(frac * 100)}%)`}</title>
            </circle>
          )
          offset += dash
          return el
        })}
        {centerLabel !== undefined && (
          <>
            <text x={c} y={centerSub ? c - 3 : c + 6} textAnchor="middle" className="donut-value">{centerLabel}</text>
            {centerSub && <text x={c} y={c + 17} textAnchor="middle" className="donut-sub">{centerSub}</text>}
          </>
        )}
      </svg>
      <div className="statuslegend donut-legend">
        {visible.map((s) => {
          const key = s.key ?? s.label
          return (
            <div
              className={`statuslegend-item${onSelect ? ' clickable' : ''}${selectedKey === key ? ' is-selected' : ''}`}
              key={key}
              onClick={onSelect ? () => onSelect(key) : undefined}
            >
              <span className={`statuslegend-swatch tone-${s.tone}`} />
              {s.label} <span className="statuslegend-count">{s.value} ({Math.round((s.value / total) * 100)}%)</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* Part-to-whole across named states. Every segment is paired with a labelled
   legend entry — color never carries identity by itself. */
export function StatusBar({ segments }) {
  const total = segments.reduce((n, s) => n + s.value, 0) || 1
  const visible = segments.filter((s) => s.value > 0)
  return (
    <div>
      <div className="statusbar">
        {visible.map((s) => (
          <div
            key={s.label}
            className={`statusbar-seg tone-${s.tone}`}
            style={{ width: `${(s.value / total) * 100}%` }}
            title={`${s.label}: ${s.value}`}
          />
        ))}
      </div>
      <div className="statuslegend">
        {visible.map((s) => (
          <div className="statuslegend-item" key={s.label}>
            <span className={`statuslegend-swatch tone-${s.tone}`} />
            {s.label} <span className="statuslegend-count">{s.value} ({Math.round((s.value / total) * 100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function Field({ label, hint, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  )
}
