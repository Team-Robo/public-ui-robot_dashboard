import { ReactNode, useEffect, useRef } from 'react'

interface Props {
  onClose: () => void
  // Announced by a screen reader when the dialog opens - aria-label
  // rather than aria-labelledby + an id on some child heading, so the
  // caller doesn't have to thread an id through its own content just for
  // this; a plain string is enough for a small confirm-style dialog.
  ariaLabel: string
  children: ReactNode
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Shared fixed-overlay + centered-panel shell for a small confirm-style
// dialog (DependencyDialog, ChainFailureDialog - both were re-declaring
// this exact same inline-style block from scratch). Overlay click closes;
// the panel's own clicks stopPropagation so clicking inside it never
// dismisses a choice. Not used by SettingsModal - that one's a bigger,
// differently-shaped panel (header + tabs + scrollable content, its own
// width), not a fit for this small-dialog shell.
//
// Accessible by construction: role=dialog/aria-modal so a screen reader
// announces it as one, Escape closes it, focus moves into the panel on
// open and is trapped there (Tab/Shift+Tab cycle, never escape to the
// page behind it), and is restored to whatever had focus before the
// dialog opened once it closes - these dialogs have no visible "×" close
// icon of their own (Cancel serves that role, unlike SettingsModal).
export default function Modal({ onClose, ariaLabel, children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  // Read inside the listener via a ref, not a `[onClose]` effect
  // dependency - the caller passes a fresh closure every re-render (e.g.
  // ControlTab re-rendering while `busy` flips during a Start), and
  // re-running the mount effect on every one of those would keep
  // stealing focus back to the first button mid-interaction.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const focusable = () => (panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [])
    ;(focusable()[0] ?? panel)?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '1.25rem',
          width: 'min(560px, 92vw)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
          outline: 'none',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
