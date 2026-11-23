import { FormEvent, useState } from 'react'
import { api } from './api'

export default function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      await api.login(passcode)
      onSuccess()
    } catch {
      setError('Incorrect passcode.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '280px' }}>
        <h2 style={{ margin: 0 }}>RoboHome Dashboard</h2>
        <input type="password" placeholder="Passcode" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoFocus />
        {error && (
          <p className="hint" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <button className="action" type="submit" disabled={pending || !passcode}>
          {pending ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  )
}
