import { useEffect, useRef, useState } from 'react'
import { api } from './api'

// Operator bar for hri_bt_main trees (behavior_trees.yaml `mission_control:
// true`), shown above the graph. Everything goes through the generic
// /api/graph/services/<name>/call route - all std_srvs/Trigger services
// hri_bt_main already serves:
//   /behaviour_tree/run_mission         Run mission
//   /behaviour_tree/cancel_mission      Cancel
//   /behaviour_tree/get_mission_status  polled - message is {"run_id","state","reason"} JSON
//   /behaviour_tree/demo/continue       Next step - releases the waiting OperatorGate
//   /behaviour_tree/demo/current_step   polled - message is the waiting step's text
//   /behaviour_tree/demo/get_dialogue   polled - message is {"memory": {...}, "dialogue": [...]}
//                                       JSON (cog-behaviour_tree's dialogue_log.hpp)
// The demo services only exist in builds with demo_nodes.hpp; against an
// older hri_bt_main those polls just fail and the panels stay empty.
//
// Next step is only enabled while a step is actually waiting, and the BT
// itself refuses a press when none is - so a double click can't skip a step
// that hasn't started yet.

const POLL_MS = 1000

interface TriggerResponse {
  success: boolean
  message: string
}

interface DialogueEntry {
  t: number
  speaker: string // robot / guest / host / llm / note
  text: string
}

interface DialogueState {
  memory: Record<string, Record<string, string>>
  dialogue: DialogueEntry[]
}

const SPEAKER_COLOR: Record<string, string> = {
  robot: 'var(--accent)',
  llm: 'var(--text-dim)',
  note: 'var(--warn)', // e.g. "no TTS - the line above was printed, not spoken"
}

async function trigger(service: string): Promise<TriggerResponse> {
  const { response } = await api.callService(service, {})
  return response as TriggerResponse
}

export default function MissionControls() {
  const [mission, setMission] = useState<{ state: string; reason: string } | null>(null)
  const [step, setStep] = useState('')
  const [reachable, setReachable] = useState(true)
  const [busy, setBusy] = useState(false)
  const [lastMessage, setLastMessage] = useState('')
  const [dialogue, setDialogue] = useState<DialogueState>({ memory: {}, dialogue: [] })
  const logRef = useRef<HTMLDivElement>(null)

  // Keep the newest line in view as the conversation grows.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [dialogue.dialogue.length])

  async function poll() {
    try {
      const status = await trigger('behaviour_tree/get_mission_status')
      const parsed = JSON.parse(status.message) as { state?: string; reason?: string }
      setMission({ state: parsed.state ?? '?', reason: parsed.reason ?? '' })
      setReachable(true)
    } catch {
      setMission(null)
      setReachable(false)
    }
    try {
      const current = await trigger('behaviour_tree/demo/current_step')
      setStep(current.success ? current.message : '')
    } catch {
      setStep('')
    }
    try {
      const state = await trigger('behaviour_tree/demo/get_dialogue')
      setDialogue(JSON.parse(state.message) as DialogueState)
    } catch {
      // older hri_bt_main, or not running - keep the last state on screen
    }
  }

  useEffect(() => {
    poll()
    const interval = setInterval(poll, POLL_MS)
    return () => clearInterval(interval)
  }, [])

  async function press(service: string) {
    setBusy(true)
    try {
      const r = await trigger(service)
      setLastMessage(r.message)
    } catch (err) {
      setLastMessage(String(err))
    } finally {
      setBusy(false)
      poll()
    }
  }

  const running = mission?.state === 'RUNNING'
  const stateColor = running ? 'var(--ok)' : mission?.state === 'COMPLETE' ? 'var(--accent)' : mission?.state === 'IDLE' ? 'var(--text-dim)' : 'var(--warn)'

  return (
    <div
      style={{
        marginTop: '0.5rem',
        padding: '0.5rem 0.6rem',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.4rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <button className="action" disabled={busy || !reachable || running} onClick={() => press('behaviour_tree/run_mission')}>
          Run mission
        </button>
        <button
          className={step ? 'action active' : 'action'}
          disabled={busy || !step}
          onClick={() => press('behaviour_tree/demo/continue')}
          style={{ fontWeight: 600, minWidth: '8rem' }}
        >
          Next step ▶
        </button>
        <button className="action" disabled={busy || !running} onClick={() => press('behaviour_tree/cancel_mission')}>
          Cancel
        </button>
        <span className="hint">
          {reachable ? (
            <>
              mission: <span style={{ color: stateColor, fontWeight: 600 }}>{mission?.state}</span>
              {mission?.reason ? ` (${mission.reason})` : ''}
            </>
          ) : (
            'hri_bt_main not reachable (is the tree process running?)'
          )}
        </span>
      </div>
      <div style={{ fontSize: '0.95rem', color: step ? 'var(--warn)' : 'var(--text-dim)' }}>
        {step ? `Waiting for operator: ${step}` : running ? 'Robot is acting on its own - nothing to press.' : 'No step waiting.'}
      </div>
      {lastMessage && <div className="hint">last: {lastMessage}</div>}

      <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ minWidth: '12rem' }}>
          <div className="hint" style={{ marginBottom: '0.2rem' }}>
            Memory
          </div>
          {Object.keys(dialogue.memory).length === 0 && <div className="hint">nothing remembered yet</div>}
          {Object.entries(dialogue.memory).map(([slot, facts]) => (
            <table key={slot} style={{ borderCollapse: 'collapse', marginBottom: '0.3rem' }}>
              <tbody>
                <tr>
                  <td colSpan={2} style={{ fontWeight: 600 }}>
                    {slot}
                  </td>
                </tr>
                {Object.entries(facts).map(([k, v]) => (
                  <tr key={k}>
                    <td className="hint" style={{ paddingRight: '0.6rem' }}>
                      {k}
                    </td>
                    <td>{v || <span className="hint">(not heard)</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: '18rem' }}>
          <div className="hint" style={{ marginBottom: '0.2rem' }}>
            Conversation
          </div>
          <div
            ref={logRef}
            style={{
              maxHeight: '11rem',
              overflowY: 'auto',
              fontSize: '0.9rem',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              padding: '0.3rem 0.5rem',
            }}
          >
            {dialogue.dialogue.length === 0 && <div className="hint">nothing said yet</div>}
            {dialogue.dialogue.map((e, i) => (
              <div key={i} style={{ color: SPEAKER_COLOR[e.speaker] ?? 'var(--text)' }}>
                <span className="hint" style={{ display: 'inline-block', width: '3.5rem' }}>
                  {e.t.toFixed(0)}s
                </span>
                <span style={{ display: 'inline-block', width: '3.5rem', fontWeight: 600 }}>{e.speaker}</span>
                {e.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
