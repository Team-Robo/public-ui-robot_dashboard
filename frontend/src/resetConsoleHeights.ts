// Every drag-resizable console in the app - TerminalPane instances (topic
// echo, service/action call history, control-tab process logs) and
// PublishInstance's script editor - persists under this one flat
// `dashboard.terminalHeight.*` localStorage namespace (see TerminalPane's
// and PublishInstance's own comments). Resetting "every console height"
// app-wide is therefore just: clear every key under that prefix, then tell
// currently mounted panes to drop back to their own default height - a
// cleared key alone wouldn't touch a pane that's already mounted, since
// each only reads localStorage once, at mount.
export const RESET_CONSOLE_HEIGHTS_EVENT = 'dashboard:reset-console-heights'

export function resetAllConsoleHeights() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('dashboard.terminalHeight.')) localStorage.removeItem(key)
    }
  } catch {
    // storage disabled/full - nothing was persisted to clear; mounted panes
    // still reset below.
  }
  window.dispatchEvent(new Event(RESET_CONSOLE_HEIGHTS_EVENT))
}
