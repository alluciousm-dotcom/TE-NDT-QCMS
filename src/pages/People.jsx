import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  listPeople, listDepots, setUserRole, assignSupervisor, provisionPerson, resetPersonPassword
} from '../lib/api'
import { Panel, Loading, ErrorNote, Empty, Field } from '../components/ui'
import { formatDate } from '../lib/format'
import { useSession } from '../App'

const BLANK_NEW_PERSON = { sapNo: '', fullName: '', depotCode: '', role: 'staff', supervisorDiscipline: '' }

export default function People() {
  const { profile } = useSession()
  const [people, setPeople] = useState(null)
  const [depots, setDepots] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [pending, setPending] = useState({})
  const [assign, setAssign] = useState({ supervisor: '', staff: '' })
  const [newPerson, setNewPerson] = useState(BLANK_NEW_PERSON)
  const [notice, setNotice] = useState(null)

  const load = useCallback(() => {
    Promise.all([listPeople(), listDepots()])
      .then(([p, d]) => { setPeople(p); setDepots(d) })
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => { load() }, [load])

  async function changeRole(person) {
    const next = pending[person.id]
    setError(null)
    if (!next || next === person.role) { setError('Choose a different role first.'); return }
    setBusy(person.id)
    try {
      await setUserRole(person.id, next, `Changed from ${person.role} to ${next}`)
      setPending((p) => ({ ...p, [person.id]: '' }))
      load()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  async function link() {
    setError(null)
    if (!assign.supervisor || !assign.staff) { setError('Choose both a supervisor and a staff member.'); return }
    setBusy('assign')
    try {
      await assignSupervisor(assign.supervisor, assign.staff)
      setAssign({ supervisor: '', staff: '' })
      load()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  async function addPerson(e) {
    e.preventDefault()
    setError(null); setNotice(null)
    if (!newPerson.sapNo.trim()) { setError('Enter a SAP number.'); return }
    if (!newPerson.depotCode) { setError('Choose a region.'); return }
    if (newPerson.role === 'supervisor' && !newPerson.supervisorDiscipline) {
      setError('Choose whether this supervisor is QA or OPS.'); return
    }
    setBusy('add')
    try {
      await provisionPerson(newPerson)
      setNotice(`Account created. Sign-in SAP number is ${newPerson.sapNo.trim()}; the starting password is the same.`)
      setNewPerson(BLANK_NEW_PERSON)
      load()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  async function resetPassword(person) {
    setError(null); setNotice(null)
    setBusy(`reset-${person.id}`)
    try {
      await resetPersonPassword(person.id, null)
      setNotice(`${person.full_name}'s password has been reset back to their SAP number (${person.sap_no}).`)
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  if (error && !people) return <ErrorNote error={error} />
  if (!people) return <Loading what="personnel" />

  const supervisors = people.filter((p) => p.role === 'supervisor')
  const staff = people.filter((p) => p.role === 'staff')
  const depotName = (code) => depots.find((d) => d.code === code)?.name ?? code ?? '—'

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">Access and assignment</p>
          <h1>People</h1>
        </div>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {notice && (
        <div className="notice">
          {notice} <button className="link" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <Panel title="Add a person">
        <form onSubmit={addPerson}>
          <div className="grid grid-2">
            <Field label="SAP number">
              <input
                value={newPerson.sapNo}
                onChange={(e) => setNewPerson((p) => ({ ...p, sapNo: e.target.value }))}
                placeholder="6428"
              />
            </Field>
            <Field label="Full name (optional)" hint="Leave blank if it isn't known yet — confirm it once their Proof of Employment is reviewed.">
              <input
                value={newPerson.fullName}
                onChange={(e) => setNewPerson((p) => ({ ...p, fullName: e.target.value }))}
                placeholder="Confirmed once documents are reviewed"
              />
            </Field>
          </div>
          <div className="grid grid-2" style={{ marginTop: 14 }}>
            <Field label="Region">
              <select
                value={newPerson.depotCode}
                onChange={(e) => setNewPerson((p) => ({ ...p, depotCode: e.target.value }))}
              >
                <option value="">Choose a region</option>
                {depots.map((d) => <option key={d.code} value={d.code}>{d.name} ({d.code})</option>)}
              </select>
            </Field>
            <Field label="Role">
              <select
                value={newPerson.role}
                onChange={(e) => setNewPerson((p) => ({ ...p, role: e.target.value, supervisorDiscipline: '' }))}
              >
                <option value="staff">Staff</option>
                <option value="supervisor">Supervisor</option>
                <option value="manager">Manager</option>
              </select>
            </Field>
          </div>
          {newPerson.role === 'supervisor' && (
            <div style={{ marginTop: 14 }}>
              <Field label="Discipline">
                <select
                  value={newPerson.supervisorDiscipline}
                  onChange={(e) => setNewPerson((p) => ({ ...p, supervisorDiscipline: e.target.value }))}
                >
                  <option value="">Choose QA or OPS</option>
                  <option value="QA">QA</option>
                  <option value="OPS">OPS</option>
                </select>
              </Field>
            </div>
          )}
          <div className="row" style={{ marginTop: 14 }}>
            <button className="primary" type="submit" disabled={busy === 'add'}>
              {busy === 'add' ? 'Adding' : 'Add person'}
            </button>
            <span className="small muted">
              The SAP number is also the starting sign-in password. They can change it once signed in.
            </span>
          </div>
        </form>
      </Panel>

      <Panel title={`${people.length} people`} bodyless>
        {people.length === 0 ? (
          <Empty title="Nobody has been added yet">
            Add the first person above.
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>SAP no.</th>
                <th>Region</th>
                <th>Role</th>
                <th>Added</th>
                <th style={{ width: 260 }}>Change role</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/people/${p.id}`}>{p.full_name}</Link>
                  </td>
                  <td className="mono muted">{p.sap_no ?? '—'}</td>
                  <td className="mono muted">{depotName(p.depot_code)}</td>
                  <td className="mono">
                    {p.role}{p.supervisor_discipline ? ` (${p.supervisor_discipline})` : ''}
                  </td>
                  <td className="mono muted">{formatDate(p.created_at)}</td>
                  <td>
                    {p.id === profile.id ? (
                      <span className="small muted">You cannot change your own role</span>
                    ) : (
                      <div className="row">
                        <select
                          value={pending[p.id] ?? ''}
                          onChange={(e) => setPending((s) => ({ ...s, [p.id]: e.target.value }))}
                          style={{ width: 130 }}
                        >
                          <option value="">Keep as {p.role}</option>
                          <option value="staff">staff</option>
                          <option value="supervisor">supervisor</option>
                          <option value="manager">manager</option>
                        </select>
                        <button className="small" disabled={busy === p.id} onClick={() => changeRole(p)}>
                          Apply
                        </button>
                      </div>
                    )}
                  </td>
                  <td>
                    <button className="small" disabled={busy === `reset-${p.id}`} onClick={() => resetPassword(p)}>
                      Reset password
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Assign a supervisor">
        <div className="grid grid-2">
          <Field label="Supervisor">
            <select
              value={assign.supervisor}
              onChange={(e) => setAssign((a) => ({ ...a, supervisor: e.target.value }))}
            >
              <option value="">Choose a supervisor</option>
              {supervisors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name}{s.supervisor_discipline ? ` (${s.supervisor_discipline})` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Staff member">
            <select
              value={assign.staff}
              onChange={(e) => setAssign((a) => ({ ...a, staff: e.target.value }))}
            >
              <option value="">Choose a staff member</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
            </select>
          </Field>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="primary" disabled={busy === 'assign'} onClick={link}>
            Assign
          </button>
          <span className="small muted">
            A supervisor can see and upload for the staff assigned to them, and nobody else.
          </span>
        </div>
      </Panel>
    </div>
  )
}
