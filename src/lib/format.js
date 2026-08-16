export function formatDate(value) {
  if (!value) return '\u2014'
  return new Date(value).toLocaleDateString('en-ZA', {
    year: 'numeric', month: 'short', day: '2-digit'
  })
}

export function formatDateTime(value) {
  if (!value) return '\u2014'
  return new Date(value).toLocaleString('en-ZA', {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
  })
}

export function formatBytes(n) {
  if (!n) return '\u2014'
  const units = ['B', 'kB', 'MB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

// Reads the way an inspector would say it: "expires in 12 days", "lapsed 4 days ago".
export function expiryPhrase(days) {
  if (days === null || days === undefined) return 'No expiry recorded'
  if (days < 0) return `Lapsed ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
  if (days === 0) return 'Expires today'
  return `Expires in ${days} day${days === 1 ? '' : 's'}`
}

export const STATE_LABEL = {
  valid: 'Valid',
  expiring: 'Expiring',
  expired: 'Lapsed',
  pending: 'Awaiting review',
  rejected: 'Rejected',
  missing: 'Not submitted'
}

// Hash chain seal, shown as a short fingerprint the way a serial number is read.
export function fingerprint(hex) {
  if (!hex) return '\u2014'
  const clean = hex.replace(/^\\x/, '')
  return clean.slice(0, 8).toUpperCase() + ' ' + clean.slice(8, 16).toUpperCase()
}
