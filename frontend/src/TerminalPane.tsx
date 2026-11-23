import { useEffect, useRef, useState } from 'react'
import { RESET_CONSOLE_HEIGHTS_EVENT } from './resetConsoleHeights'
import { copyText } from './clipboard'

interface Props {
  content: string
  emptyHint?: string
  height?: number
  // Schema dumps (PublishPanel) are indentation-sensitive - wrapping a
  // long nested-field line defeats the point of reading its structure at
  // a glance. Log/echo content (the default) wants wrapping instead, so
  // this is opt-in per caller, not a global behavior change.
  noWrap?: boolean
  // Unique per call site (e.g. a target id, topic name, tab id) - lets a
  // user-dragged resize survive reload. Only meaningful when resizable
  // (the default) - omit it for a one-off pane where persistence doesn't
  // matter, or when resizable is false, where there's nothing to persist.
  storageKey?: string
  // False for a pane that's meant to track a sibling's height instead of
  // setting its own (e.g. PublishPanel's schema dump sitting next to the
  // script editor) - an independent drag handle on the non-primary side
  // of a side-by-side pair just lets it drift out of alignment. Default
  // true: every other caller (process logs, topic echo, action/service
  // history) wants its own independent drag-resize.
  resizable?: boolean
  // Floats a small Clear button in the pane's top-right corner (opposite
  // the native resize handle, which sits bottom-right) instead of adding
  // a header row above the pane just to hold one button - most callers
  // don't want a manual clear at all (echo/schema panes clear themselves
  // naturally by re-rendering), so this is opt-in, not a prop every caller
  // has to think about.
  onClear?: () => void
}

const MIN_HEIGHT_PX = 80

function loadPersistedHeight(storageKey: string | undefined): number | undefined {
  if (!storageKey) return undefined
  try {
    const raw = localStorage.getItem(`dashboard.terminalHeight.${storageKey}`)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n >= MIN_HEIGHT_PX ? n : undefined
  } catch {
    return undefined
  }
}

// Shared by the Control tab's process logs, the Graph tab's topic echo, and
// PublishPanel's schema dump - same drag-resizable terminal box either way,
// anchored to latest content unless noWrap turns that off for a horizontal-
// scroll reading experience instead. Callers pre-format their own content
// into one string (raw log lines vs. YAML-ish echo vs. schema text are
// different formatting concerns); this component only owns the look.
export default function TerminalPane({ content, emptyHint, height, noWrap, storageKey, resizable = true, onClear }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Read once at mount, not on every render - a resize's own ResizeObserver
  // firing shouldn't re-derive this and fight the DOM's current (dragged)
  // height. React only needs this for the *initial* inline height.
  const initialHeightRef = useRef<number | undefined>(loadPersistedHeight(storageKey) ?? height)
  // Whether the pane is actually scrolling right now - only matters for
  // where the Copy/Clear button row sits (nudged left of the scrollbar's
  // own width when there's one to avoid, flush against the edge when
  // there isn't).
  const [hasScrollbar, setHasScrollbar] = useState(false)
  // Bumped by the reset-all-console-heights event below to force a re-render
  // after mutating initialHeightRef directly - the ref change alone wouldn't
  // re-derive `currentHeight`/`style` further down, since those only run
  // during a render.
  const [, forceRerender] = useState(0)

  useEffect(() => {
    if (!resizable) return
    function onResetAll() {
      initialHeightRef.current = height
      forceRerender((n) => n + 1)
    }
    window.addEventListener(RESET_CONSOLE_HEIGHTS_EVENT, onResetAll)
    return () => window.removeEventListener(RESET_CONSOLE_HEIGHTS_EVENT, onResetAll)
  }, [resizable, height])

  useEffect(() => {
    if (!resizable || !storageKey || !ref.current) return
    const el = ref.current
    // The browser's own drag-resize handle changes the element's height
    // directly - this is what actually notices that and persists it,
    // rather than any explicit "stop dragging" event (resize:vertical has
    // no such event of its own).
    const observer = new ResizeObserver((entries) => {
      const h = Math.round(entries[0].contentRect.height)
      if (h < MIN_HEIGHT_PX) return
      try {
        localStorage.setItem(`dashboard.terminalHeight.${storageKey}`, String(h))
      } catch {
        // storage disabled/full - resize still works, just won't survive reload
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [storageKey])

  useEffect(() => {
    if (!content || !ref.current) return
    const el = ref.current
    const checkOverflow = () => setHasScrollbar(el.scrollHeight > el.clientHeight)
    checkOverflow()
    // Content growing/shrinking (new log lines, a Clear) and the pane
    // itself being dragged taller/shorter can each independently flip
    // whether it's actually scrolling - both need to re-check.
    const observer = new ResizeObserver(checkOverflow)
    observer.observe(el)
    return () => observer.disconnect()
  }, [content])

  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await copyText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('clipboard write failed', err)
    }
  }

  const inner = content ? content : emptyHint ? <span className="hint">{emptyHint}</span> : null
  // Resizable panes anchor to the ref captured once at mount, so a caller
  // re-rendering with the same initial `height` prop can't fight a live
  // drag. A non-resizable pane has no drag to protect, so it tracks
  // `height` directly, live, render after render - that's the whole
  // point of resizable=false (e.g. PublishPanel's schema pane following
  // the script editor's current drag-resized height).
  const currentHeight = resizable ? initialHeightRef.current : height
  // `resize: none` here overrides the `.terminal-pane` class's own
  // `resize: vertical` (inline style wins the cascade) - so a
  // non-resizable pane still shares every other terminal-pane look, just
  // without the drag handle.
  const style = {
    ...(currentHeight ? { height: `${currentHeight}px` } : {}),
    ...(resizable ? {} : { resize: 'none' as const }),
  }

  // Floats over the pane's corner rather than reserving its own header
  // row - the wrapper is what makes "float in a fixed corner regardless
  // of scroll position" possible, since the buttons are a sibling of the
  // scrolling box, not a child that would scroll away with the content.
  // Copy shows on every pane with content (Help tab's static command
  // snippets already have their own separate copy button and don't go
  // through this component at all, so nothing to double up there); Clear
  // stays opt-in via onClear, same as before.
  const actions =
    content ? (
      <div className={`terminal-pane-actions${hasScrollbar ? ' with-scrollbar' : ''}`}>
        <button type="button" className="terminal-pane-btn accent" title="Copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        {onClear && (
          <button type="button" className="terminal-pane-btn danger" title="Clear" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
    ) : null

  if (noWrap) {
    // Vertical scroll (outer) and horizontal scroll (inner) are split
    // across two boxes on purpose, not one box with both overflow-x and
    // overflow-y set to auto - on a single box, the vertical scrollbar's
    // own width eats into the content area, which can push a line that
    // just barely fit into needing horizontal scroll too (a phantom
    // scrollbar for a few pixels nothing visibly needs). The inner box's
    // width comes from its parent - already net of the outer's vertical
    // scrollbar - so its own horizontal-overflow check is against a
    // stable number instead of one that shifts depending on whether the
    // outer happens to be scrolling vertically.
    return (
      <div className="terminal-pane-wrap">
        <div ref={ref} className="terminal-pane no-wrap-outer" style={style}>
          <div className="no-wrap-inner">{inner}</div>
        </div>
        {actions}
      </div>
    )
  }

  return (
    <div className="terminal-pane-wrap">
      <div ref={ref} className="terminal-pane" style={style}>
        {inner}
      </div>
      {actions}
    </div>
  )
}
