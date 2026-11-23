import { useState } from 'react'
import { api } from '../api'
import { describeCodeChanged, describeConfigDiff, notifyTargetsChanged } from '../configEvents'
import { notify } from '../notifications'
import HintIcon from '../HintIcon'

type ReloadResult =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'done'; success: boolean; changedKeys: string[] }
  | { status: 'error'; message: string }

type ConfigReloadResult =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'done'; targets: number; trees: number; skipped: string[] }
  | { status: 'error'; message: string }

// Catch-all for dashboard-level actions that don't belong under any
// specific tab - starts with just the environment-reload button. Add
// more sections here as they come up rather than forcing them into
// Settings (which is config-file editing - Targets/Trees/Shortcuts - not
// this kind of one-off action).
export default function MiscTab() {
  const [reload, setReload] = useState<ReloadResult>({ status: 'idle' })
  const [cfgReload, setCfgReload] = useState<ConfigReloadResult>({ status: 'idle' })

  async function doConfigReload() {
    setCfgReload({ status: 'busy' })
    try {
      const result = await api.reloadConfig()
      setCfgReload({ status: 'done', targets: result.targets, trees: result.trees, skipped: result.skipped_removals })
      // The Control tab caches its target list from mount/Settings-save - a
      // from-disk reload is the same category of change, so refresh it too.
      notifyTargetsChanged()
      // Same diff-toast App.tsx shows on page load - this button is the
      // other place a from-disk reload happens, so it gets the same signal.
      const lines = [
        ...describeConfigDiff('target', result.targets_diff),
        ...describeConfigDiff('tree', result.trees_diff),
        ...describeCodeChanged(result.code_changed),
      ]
      if (lines.length > 0) {
        notify({ title: 'Config changed since last load', message: lines.join(' · '), severity: 'info' })
      }
    } catch (err) {
      setCfgReload({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function doReload() {
    setReload({ status: 'busy' })
    try {
      const result = await api.reloadEnvironment()
      setReload({ status: 'done', success: result.success, changedKeys: result.changed_keys })
    } catch (err) {
      setReload({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div style={{ padding: '1.5rem', maxWidth: '640px' }}>
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        ROS Environment
        <HintIcon
          text={
            "dashboard_server's own PATH/PYTHONPATH/AMENT_PREFIX_PATH is a snapshot from when it started - a package " +
            'you colcon build afterward isn\'t in it, so a target fails to start with "package not found" until this ' +
            're-sources install/setup.zsh into it, without restarting. Already runs automatically every 5 min and ' +
            'after every Settings save; this button is only for "don\'t want to wait".'
          }
        />
      </h3>
      <button className="action" disabled={reload.status === 'busy'} onClick={doReload}>
        {reload.status === 'busy' ? 'Reloading…' : 'Reload ROS Environment'}
      </button>
      {reload.status === 'done' && (
        <p style={{ marginTop: '0.75rem' }}>
          {reload.success ? (
            reload.changedKeys.length > 0 ? (
              <>Reloaded - changed: {reload.changedKeys.join(', ')}</>
            ) : (
              'Reloaded - nothing changed.'
            )
          ) : (
            <span style={{ color: 'var(--danger)' }}>
              Reload failed - check dashboard_server's own log (couldn't find or source install/setup.zsh).
            </span>
          )}
        </p>
      )}
      {reload.status === 'error' && (
        <p style={{ marginTop: '0.75rem', color: 'var(--danger)' }}>Request failed: {reload.message}</p>
      )}

      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '1.5rem 0' }} />

      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        Target / Tree Config
        <HintIcon
          text={
            'The Control/BT tabs read ~/.dashboard_targets.yaml and ~/.dashboard_behavior_trees.yaml into memory at ' +
            "startup - a hand-edit outside the Settings GUI won't show up (and could get clobbered by a later Settings " +
            'save) until this re-reads both from disk and applies them live, no restart. Running processes are never ' +
            "disturbed; a target still running but removed from the file is reported back, not silently dropped."
          }
        />
      </h3>
      <button className="action" disabled={cfgReload.status === 'busy'} onClick={doConfigReload}>
        {cfgReload.status === 'busy' ? 'Reloading…' : 'Reload Targets & Trees from Disk'}
      </button>
      {cfgReload.status === 'done' && (
        <p style={{ marginTop: '0.75rem' }}>
          Reloaded - {cfgReload.targets} targets, {cfgReload.trees} trees.
          {cfgReload.skipped.length > 0 && (
            <> Didn't remove (still running): {cfgReload.skipped.join(', ')}.</>
          )}
        </p>
      )}
      {cfgReload.status === 'error' && (
        <p style={{ marginTop: '0.75rem', color: 'var(--danger)' }}>Request failed: {cfgReload.message}</p>
      )}
    </div>
  )
}
