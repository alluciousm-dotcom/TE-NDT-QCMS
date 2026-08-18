import React, { useRef, useState } from 'react'
import { uploadDocument, runAiReview } from '../lib/api'
import { Field, ErrorNote } from './ui'

const MAX_BYTES = 15 * 1024 * 1024
const ACCEPTED = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic']
const METHODS = ['PT', 'MT', 'UT', 'RT']

export default function UploadForm({ subjectId, documentTypes, onDone }) {
  const fileInputRef = useRef(null)
  const [typeId, setTypeId] = useState('')
  const [method, setMethod] = useState('')
  const [level, setLevel] = useState('')
  const [file, setFile] = useState(null)
  const [issuedOn, setIssuedOn] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
  const [neverExpires, setNeverExpires] = useState(false)
  const [stage, setStage] = useState(null)
  const [error, setError] = useState(null)

  const type = documentTypes.find((t) => t.id === typeId)
  const busy = stage !== null

  // A file input's displayed filename is the browser's own state, not
  // React's — setFile(null) alone leaves the old name showing in the picker
  // even though nothing is actually selected anymore. Clearing the DOM
  // element itself (via the ref) is the only way to actually reset it.
  function clearFileInput() {
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function pickFile(e) {
    const f = e.target.files?.[0] ?? null
    setError(null)
    if (f && f.size > MAX_BYTES) {
      setError('That file is larger than 15 MB. Scan at a lower resolution and try again.')
      setFile(null)
      clearFileInput()
      return
    }
    if (f && !ACCEPTED.includes(f.type)) {
      setError('Upload a PDF, JPEG or PNG. Other formats cannot be reviewed.')
      setFile(null)
      clearFileInput()
      return
    }
    setFile(f)
  }

  async function submit() {
    setError(null)
    if (!type) { setError('Choose which certificate this is.'); return }
    if (type.per_method && !method) { setError('Choose which NDT method this certificate covers.'); return }
    if (type.per_method && !level) { setError('Choose the certified level.'); return }
    if (!file) { setError('Choose a file to upload.'); return }
    if (type.requires_expiry && !neverExpires && !expiresOn) {
      setError(`${type.name} needs an expiry date, or tick "does not expire" if this certificate has none.`)
      return
    }
    if (issuedOn && expiresOn && issuedOn > expiresOn) {
      setError('The expiry date is before the issue date. Check both.')
      return
    }

    try {
      setStage('Uploading')
      const { doc, requestId } = await uploadDocument({
        subjectId, documentType: type, file, issuedOn,
        expiresOn: neverExpires ? '' : expiresOn, neverExpires,
        method: type.per_method ? method : null,
        level: type.per_method ? Number(level) : null
      })

      setStage('Reviewing')
      try {
        await runAiReview(doc.id, requestId)
      } catch {
        // The document is stored and logged. A failed review is recorded and
        // the manager reviews it unaided.
      }

      setTypeId(''); setMethod(''); setLevel(''); setFile(null); setIssuedOn(''); setExpiresOn(''); setNeverExpires(false)
      clearFileInput()
      onDone?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setStage(null)
    }
  }

  return (
    <div>
      <Field label="Which certificate is this?">
        <select
          value={typeId}
          onChange={(e) => { setTypeId(e.target.value); setMethod(''); setLevel(''); setError(null) }}
        >
          <option value="">Choose a certificate</option>
          {documentTypes.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </Field>

      {type?.description && <p className="hint">{type.description}</p>}

      {type?.per_method && (
        <div className="grid grid-2">
          <Field label="Which NDT method does this cover?" hint="A separate certificate can be uploaded for each method you hold.">
            <select value={method} onChange={(e) => { setMethod(e.target.value); setError(null) }}>
              <option value="">Choose a method</option>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Certified level" hint="Approving this certificate records the level automatically.">
            <select value={level} onChange={(e) => { setLevel(e.target.value); setError(null) }}>
              <option value="">Choose a level</option>
              <option value="1">Level 1</option>
              <option value="2">Level 2</option>
              <option value="3">Level 3</option>
            </select>
          </Field>
        </div>
      )}

      <Field label="File" hint="PDF, JPEG or PNG, up to 15 MB. Scan the whole page including any stamp.">
        <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.heic" onChange={pickFile} />
      </Field>

      <div className="grid grid-2" style={{ marginTop: 14 }}>
        <Field label="Issued on">
          <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
        </Field>
        <Field label={type?.requires_expiry && !neverExpires ? 'Expires on' : 'Expires on (optional)'}>
          <input
            type="date" value={expiresOn} disabled={neverExpires}
            onChange={(e) => setExpiresOn(e.target.value)}
          />
        </Field>
      </div>

      {type?.requires_expiry && (
        <label className="row" style={{ marginTop: 10, fontWeight: 400 }}>
          <input
            type="checkbox" style={{ width: 'auto' }}
            checked={neverExpires}
            onChange={(e) => { setNeverExpires(e.target.checked); if (e.target.checked) setExpiresOn(''); setError(null) }}
          />
          This certificate does not expire
        </label>
      )}

      <div style={{ marginTop: 16 }}>
        <ErrorNote error={error} onDismiss={() => setError(null)} />
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <button className="primary" onClick={submit} disabled={busy}>
          {stage === 'Uploading' ? 'Uploading' : stage === 'Reviewing' ? 'Checking the document' : 'Upload certificate'}
        </button>
        {stage === 'Reviewing' && (
          <span className="small muted">Reading the document so your manager sees what to check.</span>
        )}
      </div>
    </div>
  )
}
