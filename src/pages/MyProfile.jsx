import React, { useState } from 'react'
import { updateMyName, changeMyPassword, uploadAvatar } from '../lib/api'
import { Panel, ErrorNote, Field } from '../components/ui'
import { useSession } from '../App'

const MAX_AVATAR_BYTES = 2 * 1024 * 1024

export default function MyProfile() {
  const { profile, refreshProfile } = useSession()
  const [fullName, setFullName] = useState(profile.full_name)
  const [nameBusy, setNameBusy] = useState(false)
  const [nameError, setNameError] = useState(null)
  const [nameSaved, setNameSaved] = useState(false)

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordError, setPasswordError] = useState(null)
  const [passwordSaved, setPasswordSaved] = useState(false)

  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarError, setAvatarError] = useState(null)

  async function saveName(e) {
    e.preventDefault()
    setNameError(null); setNameSaved(false)
    if (!fullName.trim()) { setNameError('Enter your name.'); return }
    setNameBusy(true)
    try {
      await updateMyName(profile.id, fullName.trim())
      setNameSaved(true)
      refreshProfile?.()
    } catch (e) { setNameError(e.message) } finally { setNameBusy(false) }
  }

  async function savePassword(e) {
    e.preventDefault()
    setPasswordError(null); setPasswordSaved(false)
    if (!oldPassword || !newPassword) { setPasswordError('Fill in both password fields.'); return }
    if (newPassword.length < 4) { setPasswordError('Choose a longer password.'); return }
    if (newPassword !== confirmPassword) { setPasswordError('The new passwords do not match.'); return }
    setPasswordBusy(true)
    try {
      await changeMyPassword({ sapNo: profile.sap_no, oldPassword, newPassword })
      setPasswordSaved(true)
      setOldPassword(''); setNewPassword(''); setConfirmPassword('')
    } catch (e) { setPasswordError(e.message) } finally { setPasswordBusy(false) }
  }

  async function pickAvatar(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setAvatarError(null)
    if (file.size > MAX_AVATAR_BYTES) { setAvatarError('That image is larger than 2 MB.'); return }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setAvatarError('Upload a JPEG, PNG or WEBP image.'); return
    }
    setAvatarBusy(true)
    try {
      await uploadAvatar(profile.id, file)
      refreshProfile?.()
    } catch (e) { setAvatarError(e.message) } finally { setAvatarBusy(false) }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">{profile.sap_no ?? 'Your account'}</p>
          <h1>My profile</h1>
        </div>
      </div>

      <Panel title="Photo">
        <div className="row" style={{ alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 64, height: 64, borderRadius: '50%', overflow: 'hidden',
              background: 'var(--panel-2, #eee)', display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
          >
            {profile.avatar_url
              ? <img src={profile.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span className="mono muted">{profile.full_name?.[0] ?? '?'}</span>}
          </div>
          <div>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={pickAvatar} disabled={avatarBusy} />
            <p className="hint">JPEG, PNG or WEBP, up to 2 MB.</p>
          </div>
        </div>
        <ErrorNote error={avatarError} onDismiss={() => setAvatarError(null)} />
      </Panel>

      <Panel title="Display name">
        <form onSubmit={saveName}>
          <Field label="Full name">
            <input value={fullName} onChange={(e) => { setFullName(e.target.value); setNameSaved(false) }} />
          </Field>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" type="submit" disabled={nameBusy}>
              {nameBusy ? 'Saving' : 'Save name'}
            </button>
            {nameSaved && <span className="small muted">Saved.</span>}
          </div>
          <ErrorNote error={nameError} onDismiss={() => setNameError(null)} />
        </form>
        <p className="hint" style={{ marginTop: 12 }}>
          Your SAP number, region and role are set by your manager. Ask them to correct any of those.
        </p>
      </Panel>

      <Panel title="Password">
        <form onSubmit={savePassword}>
          <Field label="Current password">
            <input
              type="password" autoComplete="current-password"
              value={oldPassword} onChange={(e) => { setOldPassword(e.target.value); setPasswordSaved(false) }}
            />
          </Field>
          <div className="grid grid-2" style={{ marginTop: 14 }}>
            <Field label="New password">
              <input
                type="password" autoComplete="new-password"
                value={newPassword} onChange={(e) => { setNewPassword(e.target.value); setPasswordSaved(false) }}
              />
            </Field>
            <Field label="Confirm new password">
              <input
                type="password" autoComplete="new-password"
                value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); setPasswordSaved(false) }}
              />
            </Field>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" type="submit" disabled={passwordBusy}>
              {passwordBusy ? 'Saving' : 'Change password'}
            </button>
            {passwordSaved && <span className="small muted">Password changed.</span>}
          </div>
          <ErrorNote error={passwordError} onDismiss={() => setPasswordError(null)} />
        </form>
        <p className="hint" style={{ marginTop: 12 }}>
          Locked out instead? Ask your manager to reset your password back to your SAP number.
        </p>
      </Panel>
    </div>
  )
}
