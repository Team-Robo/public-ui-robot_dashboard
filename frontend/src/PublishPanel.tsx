import { useState } from 'react'
import PublishInstance from './PublishInstance'
import { usePersistentState } from './usePersistentState'

const TABS_KEY = 'dashboard.publish.tabs'
const ACTIVE_TAB_KEY = 'dashboard.publish.activeTab'
// Pre-multi-tab single-instance storage key - if someone already had a
// script sitting here from before this existed, carry it forward as tab
// 1 instead of silently losing it the first time this code runs.
const LEGACY_FORM_KEY = 'dashboard.publish.form'
const LEGACY_TAB_ID = 'legacy'

interface TabMeta {
  id: string
  label: string
}

function loadInitialTabs(): TabMeta[] {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (raw) return JSON.parse(raw) as TabMeta[]
  } catch {
    // fall through to the fresh/migrated default below
  }
  try {
    const legacyForm = localStorage.getItem(LEGACY_FORM_KEY)
    if (legacyForm && !localStorage.getItem(`dashboard.publish.form.${LEGACY_TAB_ID}`)) {
      localStorage.setItem(`dashboard.publish.form.${LEGACY_TAB_ID}`, legacyForm)
    }
  } catch {
    // storage disabled - nothing to carry over, just start fresh below
  }
  return [{ id: LEGACY_TAB_ID, label: 'Script 1' }]
}

function newTabId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// Multiple independent fake-publish scripts at once (one per real topic
// you want to feed), each in its own sub-tab - the whole reason this is a
// tab system and not just a bigger form. Every open tab's PublishInstance
// stays mounted regardless of which one is active (display:none on the
// inactive ones, not unmounted) specifically so a script publishing to
// /tf in the background keeps ticking while you're looking at /cmd_vel's
// tab - the same "still running until you actually close it" rule
// PublishInstance already applies to a single script, just extended to
// "close the tab" instead of "leave the page."
export default function PublishPanel() {
  const [tabs, setTabs] = usePersistentState<TabMeta[]>(TABS_KEY, loadInitialTabs())
  const [activeTabId, setActiveTabId] = usePersistentState<string>(ACTIVE_TAB_KEY, tabs[0]?.id ?? LEGACY_TAB_ID)
  const [runningMap, setRunningMap] = useState<Record<string, boolean>>({})

  function addTab() {
    const id = newTabId()
    setTabs((prev) => [...prev, { id, label: `Script ${prev.length + 1}` }])
    setActiveTabId(id)
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      if (prev.length <= 1) return prev // always keep at least one tab open
      const next = prev.filter((t) => t.id !== id)
      if (activeTabId === id) setActiveTabId(next[next.length - 1].id)
      return next
    })
    setRunningMap((prev) => {
      const { [id]: _removed, ...rest } = prev
      return rest
    })
  }

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <h3>Publish to a topic</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginBottom: '0.75rem' }}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`subtab-button${tab.id === activeTabId ? ' active' : ''}`}
            onClick={() => setActiveTabId(tab.id)}
          >
            {runningMap[tab.id] && <span className="subtab-running-dot" title="publishing" />}
            {tab.label}
            {tabs.length > 1 && (
              <span
                className="subtab-close"
                title="close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                ×
              </span>
            )}
          </div>
        ))}
        <button className="subtab-add" title="new script" onClick={addTab}>
          +
        </button>
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} style={{ display: tab.id === activeTabId ? 'block' : 'none' }}>
          <PublishInstance
            tabId={tab.id}
            onRunningChange={(running) => setRunningMap((prev) => (prev[tab.id] === running ? prev : { ...prev, [tab.id]: running }))}
          />
        </div>
      ))}
    </div>
  )
}
