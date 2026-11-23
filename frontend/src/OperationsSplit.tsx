import { PointerEvent as ReactPointerEvent, ReactNode, useEffect, useRef, useState } from 'react'
import BigEstopButton from './BigEstopButton'

// Content column defaults to a 7:3 flex-grow ratio against the estop
// column (a real percentage split, responsive to whatever the viewport
// is) until the user actually drags the divider, at which point it's
// pinned to a measured px width and persisted.
const DEFAULT_CONTENT_STYLE = { flex: '7 1 0%' }
const MIN_CONTENT_PX = 320
const MIN_ESTOP_PX = 220
const STORAGE_KEY = 'dashboard.operationsSplitWidth'

function loadPersistedWidth(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n >= MIN_CONTENT_PX ? n : null
  } catch {
    return null
  }
}

// The "just in case" split - active tab keeps working normally on the
// left, a giant e-stop sits on the right where most tabs already leave
// the space unused. The divider is a dedicated element spanning the
// row's full height, grabbable anywhere along it - not CSS `resize`,
// which only ever offers a single corner-sized grab target and can't be
// made to span a seam. Drag is real pointer-event tracking: mousedown on
// the divider arms a window-level pointermove/pointerup pair (so the
// drag keeps tracking even if the cursor leaves the divider itself
// mid-drag), and the width only gets written to storage once, on
// pointerup - not on every intermediate pixel.
export default function OperationsSplit({ children }: { children: ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [contentWidth, setContentWidth] = useState<number | null>(loadPersistedWidth)
  const [dragging, setDragging] = useState(false)

  function onDividerPointerDown(e: ReactPointerEvent) {
    e.preventDefault()
    setDragging(true)
  }

  useEffect(() => {
    if (!dragging) return
    function clamp(w: number): number {
      const row = rowRef.current
      const maxContentPx = row ? row.getBoundingClientRect().width - MIN_ESTOP_PX : w
      return Math.round(Math.min(Math.max(w, MIN_CONTENT_PX), maxContentPx))
    }
    function onMove(e: globalThis.PointerEvent) {
      const row = rowRef.current
      if (!row) return
      setContentWidth(clamp(e.clientX - row.getBoundingClientRect().left))
    }
    function onUp() {
      setDragging(false)
      setContentWidth((w) => {
        if (w !== null) {
          try {
            localStorage.setItem(STORAGE_KEY, String(w))
          } catch {
            // storage disabled/full - resize still works, just won't survive reload
          }
        }
        return w
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging])

  return (
    <div className={`operations-split${dragging ? ' dragging' : ''}`} ref={rowRef}>
      <div className="operations-split-content" style={contentWidth ? { flex: `0 0 ${contentWidth}px` } : DEFAULT_CONTENT_STYLE}>
        {children}
      </div>
      <div className="operations-split-divider" onPointerDown={onDividerPointerDown} />
      <div className="operations-split-estop">
        <BigEstopButton />
      </div>
    </div>
  )
}
