import { useState } from 'react'
import { usePersistentState } from '../usePersistentState'
import { copyText } from '../clipboard'

interface HelpEntry {
  title: string
  description: string
  commands: string[]
  source: string
  // 'dashboard' = applies to this tool's own core features (Visualization
  // tab, Foxglove Bridge) regardless of which robot package you're running.
  // 'package' = tied to one specific package (person_pose_python) - real, but
  // not something every dashboard user hits, so rendered with less weight
  // below rather than mixed in at the same prominence.
  scope: 'dashboard' | 'package'
}

// Hand-authored, not scraped - re-check against `source` if these drift.
const ENTRIES: HelpEntry[] = [
  {
    title: 'Potential fix: RViz2 zero-size window under WSLg',
    description:
      "Not a universal issue - some WSLg setups hit RViz2 rendering as an empty window (Qt/Wayland). On one machine the cause was /mnt/shared_memory missing entirely (Weston's shared-memory frame buffer path breaks, not a GPU/driver issue - QT_QPA_PLATFORM=xcb/LIBGL_ALWAYS_SOFTWARE=1 were red herrings). If you hit this, try the commands below.",
    commands: [
      'sudo mkdir -p /mnt/shared_memory\nsudo mount -t tmpfs tmpfs /mnt/shared_memory',
      "# Persist across WSL restarts - merge into /etc/wsl.conf's existing [boot] section:\ncommand = mkdir -p /mnt/shared_memory && mount -t tmpfs tmpfs /mnt/shared_memory",
    ],
    source: 'not committed anywhere - confirmed working on one machine only',
    scope: 'dashboard',
  },
  {
    title: 'foxglove_bridge is heavy on raw point clouds',
    description:
      'Heavy raw clouds can clog the Foxglove/Lichtblick websocket bridge - rate-cap before publishing instead of sending it raw. For example, if the source is lidar_filter:',
    commands: ['ros2 run lidar_filter cloud_throttle.py --ros-args -p target_fps:=5.0'],
    source: 'src/lidar_filter/README.md',
    scope: 'dashboard',
  },
  {
    title: 'person_pose_python needs its venv on PYTHONPATH',
    description:
      "The dashboard's process supervisor already injects this for person_pose_python - this is only needed if you're running it by hand outside the dashboard.",
    commands: [
      'PYTHONPATH=~/pose-env/lib/python3.10/site-packages:$PYTHONPATH \\\n  ros2 run person_pose_python person_pose_python',
    ],
    source: 'README.md',
    scope: 'package',
  },
  {
    title: 'One-time: fix person_pose_python to run on CUDA instead of CPU',
    description: '~/pose-env was created with a CPU-only PyTorch build - reinstall with CUDA support.',
    commands: [
      'source ~/pose-env/bin/activate\npip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121',
    ],
    source: 'README.md',
    scope: 'package',
  },
]

export default function HelpTab() {
  const [copied, setCopied] = useState<string | null>(null)
  // Persisted, same as every other expand/collapse control in the app now.
  const [packageExpanded, setPackageExpanded] = usePersistentState('dashboard.help.packageExpanded', false)

  async function copy(text: string) {
    try {
      await copyText(text)
      setCopied(text)
      setTimeout(() => setCopied(null), 1500)
    } catch (err) {
      console.error('clipboard write failed', err)
    }
  }

  function renderEntry(entry: HelpEntry) {
    return (
      <div key={entry.title} style={{ marginBottom: '1.5rem' }}>
        <h3>{entry.title}</h3>
        <p>{entry.description}</p>
        {entry.commands.map((cmd) => (
          <div key={cmd} style={{ position: 'relative', marginBottom: '0.5rem' }}>
            {/* .terminal-pane's min-height: 80px and resize: vertical are
                for live/scrollable panes - neither makes sense for a
                static command snippet, so both get overridden here on top
                of the height: auto this already had (min-height alone
                still floors the box at 80px regardless of height). */}
            <pre className="terminal-pane" style={{ height: 'auto', minHeight: 0, resize: 'none' }}>
              {cmd}
            </pre>
            <button className="action" onClick={() => copy(cmd)}>
              {copied === cmd ? 'Copied' : 'Copy'}
            </button>
          </div>
        ))}
        <p className="hint">source: {entry.source}</p>
      </div>
    )
  }

  const dashboardEntries = ENTRIES.filter((e) => e.scope === 'dashboard')
  const packageEntries = ENTRIES.filter((e) => e.scope === 'package')

  return (
    <div>
      <p className="hint">
        Things this dashboard can't do automatically yet - copy/paste commands instead.
      </p>
      {dashboardEntries.map(renderEntry)}
      {packageEntries.length > 0 && (
        <>
          <h3 className="tree-row group" style={{ cursor: 'pointer' }} onClick={() => setPackageExpanded((v) => !v)}>
            <span className="tree-caret">{packageExpanded ? '▾' : '▸'}</span> Package-specific notes{' '}
            <span className="hint">({packageEntries.length})</span>
          </h3>
          {packageExpanded && (
            <>
              <p className="hint">Tied to one specific package, not a dashboard feature.</p>
              {packageEntries.map(renderEntry)}
            </>
          )}
        </>
      )}
    </div>
  )
}
