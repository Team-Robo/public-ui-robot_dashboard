import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { comboMatches, getCombo } from './shortcuts'

interface EstopContextValue {
  busy: boolean
  trigger: () => void
}

const EstopContext = createContext<EstopContextValue | null>(null)

// Single owner of e-stop trigger state and the site-wide keyboard shortcut
// listener - now that there are two visible e-stop buttons (the header one
// and the big split-mode one), both need to share one in-flight request
// (so mashing either button, or the shortcut, can't fire two overlapping
// estop calls) and both need to flip to "STOPPING..." together, not just
// whichever one was clicked.
export function EstopProvider({ children }: { children: ReactNode }) {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(busy)
  busyRef.current = busy

  async function trigger() {
    if (busyRef.current) return
    setBusy(true)
    try {
      const result = await api.estop()
      console.log('estop dispatched', result)
    } catch (err) {
      console.error('estop request failed', err)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    // Fires regardless of what element has focus - including inside a text
    // input - on purpose: panic shouldn't depend on where the cursor was.
    // Safe because the combo requires 2+ modifiers, not a bare key, so it
    // can't collide with normal typing. Re-reads the bound combo from
    // storage on every keydown (not captured in a closure) so a rebind
    // made in Settings applies immediately without this listener needing
    // to be told about it.
    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat || busyRef.current) return
      if (comboMatches(e, getCombo('estop'))) {
        e.preventDefault()
        trigger()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return <EstopContext.Provider value={{ busy, trigger }}>{children}</EstopContext.Provider>
}

export function useEstop(): EstopContextValue {
  const ctx = useContext(EstopContext)
  if (!ctx) throw new Error('useEstop must be used within EstopProvider')
  return ctx
}
