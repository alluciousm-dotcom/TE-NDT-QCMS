import React, { useEffect, useState, createContext, useContext } from 'react'
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { getProfile } from './lib/api'
import { Loading } from './components/ui'
import SignIn from './pages/SignIn'
import Roster from './pages/Roster'
import MyRecord from './pages/MyRecord'
import PersonRecord from './pages/PersonRecord'
import AuditTrail from './pages/AuditTrail'
import People from './pages/People'
import MyProfile from './pages/MyProfile'
import ManagerDashboard from './pages/ManagerDashboard'

const SessionContext = createContext(null)
export const useSession = () => useContext(SessionContext)

function Shell({ profile, children }) {
  const navigate = useNavigate()
  const isManager = profile.role === 'manager'
  const isStaff = profile.role === 'staff'

  async function signOut() {
    await supabase.auth.signOut()
    navigate('/')
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">TE_NDT_QCMS <span>PERSONNEL COMPLIANCE</span></div>
          <nav className="nav">
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
              {isStaff ? 'My record' : 'Roster'}
            </NavLink>
            {isManager && <NavLink to="/dashboard" className={({ isActive }) => (isActive ? 'active' : '')}>Dashboard</NavLink>}
            {isManager && <NavLink to="/people" className={({ isActive }) => (isActive ? 'active' : '')}>People</NavLink>}
            {!isStaff && <NavLink to="/trail" className={({ isActive }) => (isActive ? 'active' : '')}>Audit trail</NavLink>}
            <NavLink to="/account" className={({ isActive }) => (isActive ? 'active' : '')}>
              {profile.avatar_url && (
                <img
                  src={profile.avatar_url} alt=""
                  style={{ width: 20, height: 20, borderRadius: '50%', objectFit: 'cover', verticalAlign: 'middle', marginRight: 6 }}
                />
              )}
              My profile
            </NavLink>
            <div className="whoami">
              <strong>{profile.full_name}</strong>
              {profile.role}
            </div>
            <button className="small" onClick={signOut}>Sign out</button>
          </nav>
        </div>
      </header>
      <main>{children}</main>
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (!data.session) setReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (!s) { setProfile(null); setReady(true) }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session?.user) return
    let cancelled = false
    getProfile(session.user.id)
      .then((p) => { if (!cancelled) setProfile(p) })
      .catch(() => { if (!cancelled) setProfile(null) })
      .finally(() => { if (!cancelled) setReady(true) })
    return () => { cancelled = true }
  }, [session])

  const refreshProfile = () => {
    if (!session?.user) return
    getProfile(session.user.id).then(setProfile).catch(() => {})
  }

  if (!ready) return <Loading what="your account" />
  if (!session) return <SignIn />
  if (!profile) {
    return (
      <div className="signin-wrap">
        <div className="signin">
          <h2>Account not set up</h2>
          <p className="small muted">
            Your sign in worked, but no personnel record is linked to it yet. Ask a compliance
            manager to complete your onboarding.
          </p>
          <button onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    )
  }

  const isStaff = profile.role === 'staff'

  return (
    <SessionContext.Provider value={{ session, profile, refreshProfile }}>
      <Shell profile={profile}>
        <Routes>
          <Route path="/" element={isStaff ? <MyRecord /> : <Roster />} />
          <Route path="/people/:id" element={<PersonRecord />} />
          <Route path="/people" element={profile.role === 'manager' ? <People /> : <Navigate to="/" />} />
          <Route path="/dashboard" element={profile.role === 'manager' ? <ManagerDashboard /> : <Navigate to="/" />} />
          <Route path="/trail" element={isStaff ? <Navigate to="/" /> : <AuditTrail />} />
          <Route path="/account" element={<MyProfile />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </Shell>
    </SessionContext.Provider>
  )
}
