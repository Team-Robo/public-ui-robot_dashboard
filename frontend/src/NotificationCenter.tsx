import { useEffect, useState } from 'react'
import { AppNotification, dismiss, subscribeNotifications } from './notifications'

const THEME: Record<AppNotification['severity'], { color: string; icon: string }> = {
  error: { color: 'var(--danger, #e5484d)', icon: '⚠' },
  warn: { color: 'var(--warning, #e0a800)', icon: '⚠' },
  info: { color: 'var(--accent, #4c9aff)', icon: 'ℹ' },
}

// Non-intrusive stacked toasts pinned to the bottom-right. Click a toast (or
// its ×) to dismiss; they auto-dismiss on their own timer otherwise. The
// container is pointer-events:none so it never blocks the page beneath; each
// toast opts back in so it's still clickable. Mounted once in App.tsx.
export default function NotificationCenter() {
  const [items, setItems] = useState<AppNotification[]>([])
  useEffect(() => subscribeNotifications(setItems), [])
  if (items.length === 0) return null
  return (
    <div
      style={{
        position: 'fixed',
        bottom: '0.75rem',
        right: '0.75rem',
        zIndex: 2000,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        gap: '0.5rem',
        width: 'min(360px, 92vw)',
        // Cap by viewport height so many toasts never swallow the page; the
        // oldest scrolls off the top (overflow hidden) rather than pushing the
        // layout around. Column is bottom-anchored: newest sits at the bottom
        // and earlier ones ride up as fresh ones arrive.
        maxHeight: '60vh',
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {items.map((n) => {
        const theme = THEME[n.severity]
        return (
          <div
            key={n.id}
            onClick={() => dismiss(n.id)}
            role="status"
            style={{
              pointerEvents: 'auto',
              background: 'var(--bg-panel)',
              border: `1px solid ${theme.color}`,
              borderLeft: `4px solid ${theme.color}`,
              borderRadius: '6px',
              padding: '0.55rem 0.7rem',
              boxShadow: '0 10px 26px rgba(0,0,0,0.5)',
              cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span aria-hidden style={{ color: theme.color }}>{theme.icon}</span>
              <strong style={{ fontSize: '0.9rem', flex: 1 }}>{n.title}</strong>
              <span
                className="subtab-close"
                style={{ color: 'var(--text-dim)', fontSize: '1rem' }}
                onClick={(e) => {
                  e.stopPropagation()
                  dismiss(n.id)
                }}
              >
                ×
              </span>
            </div>
            {n.message && (
              <div style={{ marginTop: '0.25rem', fontSize: '0.85rem', color: 'var(--text-dim)' }}>{n.message}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}
