import { STATE_LABEL } from './format'

// The six document types that aren't per-method — Q-Cert is handled
// separately via NDT Qualifications, since a person can hold any number of
// method+level combinations rather than one fixed cell.
const FIXED_TYPES = [
  { code: 'Exam-R', label: 'Exam Results' },
  { code: 'Class-Tr', label: 'Class Training Proof' },
  { code: 'Log-B', label: 'Log Book' },
  { code: 'ID-copy', label: 'Copy of ID' },
  { code: 'Eye-test', label: 'Eye Test Certificate' },
  { code: 'Employ-Pr', label: 'Proof of Employment' }
]

// One row per person: SAP number, name, region, role, NDT qualifications,
// the status of each fixed document type, and a plain-language summary of
// what's outstanding — the same shape as the roster spreadsheet this
// replaced, adapted for the parts of the data model it didn't originally
// have (multiple levels per method, per-document review states).
export function buildExportRows({ people, depots, matrix, quals }) {
  const depotName = (code) => depots.find((d) => d.code === code)?.name ?? code ?? ''

  return people.map((p) => {
    const personMatrix = matrix.filter((r) => r.subject_id === p.id)
    const personQuals = quals.filter((q) => q.subject_id === p.id)

    const row = {
      'SAP No': p.sap_no ?? '',
      'Full Name': p.full_name ?? '',
      'Region': depotName(p.depot_code),
      'Role': p.role + (p.supervisor_discipline ? ` (${p.supervisor_discipline})` : ''),
      'NDT Qualifications': personQuals.map((q) => `${q.method} L${q.level}`).join(', ') || 'None'
    }

    for (const t of FIXED_TYPES) {
      const cell = personMatrix.find((r) => r.code === t.code)
      row[t.label] = cell ? (STATE_LABEL[cell.state] ?? cell.state) : 'Not tracked'
    }

    const outstanding = personMatrix.filter((r) => ['missing', 'expired', 'rejected'].includes(r.state))
    row['Not Cleared For Site'] = outstanding.length > 0 ? 'Yes' : 'No'
    row['Items Outstanding'] = outstanding.map((r) => r.document_name).join('; ')

    return row
  })
}

// PDF/Word are printed reports, not raw data — a 13-column table would be
// unreadably cramped on a page. Trims to the columns a reader actually scans
// for: who, where, what they're qualified in, and what's outstanding.
const REPORT_COLUMNS = ['SAP No', 'Full Name', 'Region', 'Role', 'NDT Qualifications', 'Not Cleared For Site', 'Items Outstanding']
export function buildReportRows(exportRows) {
  return exportRows.map((r) => Object.fromEntries(REPORT_COLUMNS.map((c) => [c, r[c]])))
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function downloadCsv(rows, filename) {
  if (rows.length === 0) return
  const headers = Object.keys(rows[0])
  const escape = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))]
  // Leading BOM so Excel opens the UTF-8 file without mangling names with
  // accented characters instead of guessing the wrong codepage.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  triggerDownload(blob, `${filename}.csv`)
}

// xlsx is loaded on demand — it's only needed if someone actually clicks
// "Download Excel", not on every dashboard visit. Same for jspdf/docx below.
export async function downloadExcel(rows, filename) {
  if (rows.length === 0) return
  const XLSX = await import('xlsx')
  const sheet = XLSX.utils.json_to_sheet(rows)
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Compliance')
  XLSX.writeFile(book, `${filename}.xlsx`)
}

// jsPDF's built-in fonts only render WinAnsi-safe characters reliably —
// anything outside that (em dashes, smart quotes, the "·" separator used
// elsewhere in the app) silently comes out as a replacement-character glyph
// instead of throwing, so it's easy to ship a mangled PDF without noticing.
// Word/CSV/Excel don't have this limitation; this sanitizer is PDF-only.
const PDF_UNSAFE = [
  [/[—–]/g, '-'],   // em dash, en dash
  [/[‘’]/g, "'"],   // smart single quotes
  [/[“”]/g, '"'],   // smart double quotes
  [/·/g, '-'],           // middle dot
  [/…/g, '...']          // ellipsis
]
function pdfSafe(value) {
  let s = String(value ?? '')
  for (const [pattern, replacement] of PDF_UNSAFE) s = s.replace(pattern, replacement)
  return s
}

export async function downloadPdf({ rows, summary, title, subtitle, filename }) {
  if (rows.length === 0) return
  const { jsPDF } = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')

  const doc = new jsPDF({ orientation: 'landscape' })

  doc.setFontSize(16)
  doc.text(pdfSafe(title), 14, 16)
  doc.setFontSize(10)
  doc.setTextColor(90)
  doc.text(pdfSafe(subtitle), 14, 23)

  doc.setFontSize(9)
  doc.setTextColor(0)
  doc.text(pdfSafe(summary.map(([label, value]) => `${label}: ${value}`).join('     ')), 14, 30)

  const headers = Object.keys(rows[0])
  autoTable(doc, {
    startY: 36,
    head: [headers.map(pdfSafe)],
    body: rows.map((r) => headers.map((h) => pdfSafe(r[h]))),
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [18, 70, 108] },
    margin: { left: 10, right: 10 }
  })

  doc.save(`${filename}.pdf`)
}

export async function downloadWord({ rows, summary, title, subtitle, filename }) {
  if (rows.length === 0) return
  const {
    Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, WidthType
  } = await import('docx')

  const headers = Object.keys(rows[0])
  const cell = (text, bold = false) => new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ''), bold })] })]
  })

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map((h) => cell(h, true)) }),
      ...rows.map((r) => new TableRow({ children: headers.map((h) => cell(r[h])) }))
    ]
  })

  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: subtitle }),
        new Paragraph({ text: summary.map(([label, value]) => `${label}: ${value}`).join('   ') }),
        new Paragraph({ text: '' }),
        table
      ]
    }]
  })

  const blob = await Packer.toBlob(doc)
  triggerDownload(blob, `${filename}.docx`)
}