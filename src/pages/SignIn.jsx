import React, { useState } from 'react'
import { supabase } from '../lib/supabase'
import { sapEmail, normalizePassword } from '../lib/auth'
import { Field, ErrorNote } from '../components/ui'

export default function SignIn() {
  const [sapNo, setSapNo] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (!sapNo.trim()) { setError('Enter your SAP number.'); return }
    if (!password) { setError('Enter your password.'); return }
    setBusy(true)
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: sapEmail(sapNo),
        password: normalizePassword(password)
      })
      if (error) throw new Error('SAP number or password is not recognised.')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="signin-wrap">
      <div className="signin">
        <p className="eyebrow">TE_NDT_QCMS</p>
        <h1 className="brand-lg">Personnel compliance</h1>
        <p className="small muted" style={{ marginTop: 6, marginBottom: 22 }}>
          Certification records for inspection personnel. Sign in with your SAP number.
        </p>

        <form onSubmit={submit}>
          <Field label="SAP number">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="username"
              value={sapNo}
              onChange={(e) => { setSapNo(e.target.value); setError(null) }}
              placeholder="XXXXX"
            />
          </Field>

          <Field label="Password" hint="New here? Your password is your SAP number.">
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null) }}
            />
          </Field>

          <div style={{ marginTop: 18 }}>
            <ErrorNote error={error} />
          </div>

          <button className="primary" type="submit" disabled={busy} style={{ width: '100%', marginTop: 14 }}>
            {busy ? 'Signing in' : 'Sign in'}
          </button>
        </form>

        <p className="small muted" style={{ marginTop: 16, textAlign: 'center' }}>
          Not onboarded yet? Ask your manager to add you.
        </p>
      </div>
    </div>
  )
}
