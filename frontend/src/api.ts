export type ProcessState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed' | 'exited'

// added/removed/changed target or tree ids from a from-disk config reload
// (see config_routes.py's own _diff_by_id) - "changed" is full-content
// comparison, so relabeling or editing one field counts, not just add/remove.
export interface ConfigDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

export interface TargetFlagOption {
  name: string
  label: string
  arg: string
}

export interface TargetFlag {
  name: string
  // Optional - a toggle needs it (falls back to name if blank, a blank
  // button isn't usable), select/text usually don't (options are
  // self-explanatory; text already has its own placeholder).
  label?: string
  arg?: string
  type?: 'toggle' | 'select' | 'text'
  options?: TargetFlagOption[]
  // type: text only - hint text shown in the Control tab's input.
  placeholder?: string
}

export interface TargetStatus {
  id: string
  label: string
  category: string
  kind: 'run' | 'launch' | 'windows'
  state: ProcessState
  pid: number | null
  exit_code: number | null
  flags: TargetFlag[]
  // The required platform (e.g. "wsl") if this target's `requires`
  // unambiguously needs a platform this dashboard_server can never
  // satisfy this session - see conditions.platform_lockout() server-side.
  // null means not locked out this way (may still have an ordinary unmet
  // `requires`, handled by the dependency dialog instead). ControlTab
  // hides a locked-out target entirely rather than showing it disabled.
  platform_locked_out: string | null
  // A pid still alive under this target_id from a PREVIOUS dashboard_server
  // run that never went through stop() - null means no known orphan. This
  // instance has no Popen for it (no logs, no clean exit code), only
  // liveness - see the backend's pid_registry.py for why.
  orphan_pid: number | null
}

export interface PlatformInfo {
  platform: 'wsl' | 'native'
  windows_companion_available: boolean
}

export interface ParamDescriptor {
  name: string
  type: string
  type_id: number
  value: unknown
  read_only: boolean
  description: string
}

export interface TopicInfo {
  name: string
  types: string[]
  publisher_count: number
  subscriber_count: number
  qos_mismatch: boolean
  fake_publish_count: number
}

export interface InterfaceEndpoint {
  topic: string
  types: string[]
}

export interface ServiceEndpoint {
  name: string
  types: string[]
}

export interface NodeInterfaces {
  publishers: InterfaceEndpoint[]
  subscribers: InterfaceEndpoint[]
  services: ServiceEndpoint[]
  clients: ServiceEndpoint[]
  action_servers: ServiceEndpoint[]
  action_clients: ServiceEndpoint[]
  has_parameters: boolean
}

export interface BatteryConfig {
  enabled: boolean
  spawn_monitor: boolean
  state_topic: string
  bms_topic: string
  hdas_msg_path: string
  capital_mode: 'auto' | 'percent' | 'raw'
  warn_pct: number
  critical_pct: number
  stale_sec: number
}

export interface BatteryStatus {
  enabled: boolean
  topic: string
  data: { percentage: number | null; voltage: number | null; current: number | null; age_sec: number } | null
  stale: boolean
  level: 'ok' | 'warn' | 'critical' | 'unknown'
  monitor: { state: 'disabled' | 'stopped' | 'running' | 'exited' | 'failed'; message: string | null; log: string[] }
}

export interface HzResult {
  // The dashboard's OWN subscription (what the backend received, 5s window).
  rate_hz: number | null
  sample_count: number
  // The real `ros2 topic hz` figure; null until its first line or when stale.
  ros2_hz?: number | null
  ros2_error?: string | null
  error?: string
}

export interface BtTreeConfig {
  id: string
  label: string
  package: string
  tree_file: string
  target_id: string | null
  groot2_port: number | null
  // full_path (BtNode's own field) -> desired stub outcome. Edited via the
  // BT tab's stub-edit mode, saved through the same config PUT flow as
  // every other field here.
  stub_leaves: Record<string, 'success' | 'failure'>
  // Shows MissionControls (Run / Next step / Cancel) above the graph. Only
  // meaningful for hri_bt_main trees - those are the processes serving
  // /behaviour_tree/run_mission and /behaviour_tree/demo/*.
  mission_control: boolean
}

// The FULL supervisor.models.TargetConfig shape - config-GUI editing needs
// every field that can go in targets.yaml, not just the display subset
// TargetStatus carries.
export interface FullTargetConfig {
  id: string
  label: string
  category: string
  kind: 'run' | 'launch' | 'windows'
  package: string | null
  executable: string | null
  launch_file: string | null
  // kind: windows only - the command handed to the Windows companion's
  // /processes/<id>/start instead of `ros2 run`/`ros2 launch`.
  cmd: string[] | null
  args: string[]
  flags: TargetFlag[]
  env: Record<string, string>
  cwd: string | null
  autostart: boolean
  ready_node_name: string | null
  ready_timeout_sec: number
  estop_exempt: boolean
  // Boolean precondition expression tree (see supervisor/conditions.py) -
  // `all`/`any`/`not` + target/node/topic/etc. leaves. null = no dependency.
  requires: Record<string, unknown> | null
}

export interface DependencyStatus {
  met: boolean
  reason: string
  // Transitive closure (deps of deps), deps-first, excluding the target.
  missing_targets: string[]
  // Non-target prerequisites (device:/file:/topic:/custom:...) that are unmet.
  // The dashboard only auto-starts `target:` deps - these are the operator's.
  external_prereqs: string[]
}

// Thrown by jsonFetch when a start is refused - not a generic HTTP error.
// Control tab routes on kind:
//   'precondition'  -> open the in-app "start dependencies?" prompt
//   'spawn_failure' -> the dependency chain failed to OPEN (a node crashed
//                      coming up) - open the chain-failure popup (retry /
//                      stop all / cancel); the toast separately reports the
//                      crashed node.
export class DependencyNotMetError extends Error {
  reason: string
  missingTargets: string[]
  kind: 'precondition' | 'spawn_failure'
  constructor(reason: string, missingTargets: string[], kind: 'precondition' | 'spawn_failure' = 'precondition') {
    super(reason)
    this.reason = reason
    this.missingTargets = missingTargets
    this.kind = kind
  }
}

export interface ConfigSaveResult {
  applied: boolean
  path: string
  skipped_removals?: string[]
  // True when this save was based on a stale version - the backend still
  // applied additions/updates, but skipped any deletion this save implied
  // (see config_routes.py's _merge_commented_list). The caller should
  // treat its own local list as untrustworthy at that point and re-fetch.
  conflict: boolean
}

export interface BtNode {
  type: string
  instance_name: string
  uid: number | null
  // Stable per-instance address (segments only at SubTree crossings,
  // matching BT.CPP's own fullPath() - confirmed live that intermediate
  // control nodes like Sequence/WithGaze never contribute a segment) -
  // this is the key stub_leaves is keyed on, NOT instance_name alone
  // (which repeats across sibling scopes, e.g. every GreetAndSeatGuest
  // call has its own "DetectPerson").
  full_path: string
  ports: Record<string, string>
  children: BtNode[]
  subtree_id?: string
  note?: string
}

export interface BtTreeStructure {
  tree_id: string
  root: BtNode
}

export interface BtNodeStatus {
  prev: string
  current: string
}

export type BtLiveStatus = Record<string, BtNodeStatus>

// Auth is off entirely unless the backend has DASHBOARD_PASSCODE set (see
// dashboard/auth.py) - these helpers are always-present but no-op against a
// server with auth disabled, since the token is just never checked there.
const TOKEN_STORAGE_KEY = 'dashboard.authToken'
let authToken: string | null = localStorage.getItem(TOKEN_STORAGE_KEY)
let onUnauthorized: (() => void) | null = null

export function setAuthToken(token: string | null): void {
  authToken = token
  if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token)
  else localStorage.removeItem(TOKEN_STORAGE_KEY)
}

export function getAuthToken(): string | null {
  return authToken
}

// App.tsx registers this to drop back to the login screen the moment any
// request comes back 401 - covers both "never logged in" and "token
// expired because the server restarted" (tokens are in-memory server-side).
export function onAuthFailure(cb: () => void): void {
  onUnauthorized = cb
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`)
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) {
    setAuthToken(null)
    onUnauthorized?.()
    throw new Error('401 Unauthorized')
  }
  if (!res.ok) {
    const body = await res.text()
    // A 409 from /start whose detail is a dependency_not_met carries the
    // reason + which targets would need starting - surface that as a typed
    // error so the UI can offer the same prompt the pre-check would have.
    if (res.status === 409) {
      try {
        const parsed = JSON.parse(body)
        const detail = parsed?.detail
        if (detail?.error === 'dependency_not_met') {
          throw new DependencyNotMetError(
            detail.reason ?? 'dependency not met',
            detail.missing_targets ?? [],
            detail.kind ?? 'precondition',
          )
        }
      } catch (err) {
        if (err instanceof DependencyNotMetError) throw err
        // fall through to the generic error below if it wasn't that shape
      }
    }
    throw new Error(`${res.status} ${res.statusText}: ${body}`)
  }
  return res.json() as Promise<T>
}

// Same as jsonFetch, but also hands back the X-Config-Version response
// header - only the config-GUI endpoints (targets/behavior_trees) send
// this, for detecting a save based on a stale snapshot. Same-origin
// requests (this app is served from the same FastAPI process it calls)
// can read any response header without CORS exposing it explicitly.
async function jsonFetchWithVersion<T>(path: string, init?: RequestInit): Promise<{ data: T; version: string | null }> {
  const headers = new Headers(init?.headers)
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`)
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) {
    setAuthToken(null)
    onUnauthorized?.()
    throw new Error('401 Unauthorized')
  }
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${body}`)
  }
  return { data: (await res.json()) as T, version: res.headers.get('X-Config-Version') }
}

// Node names carry embedded "/"s for namespaced nodes (e.g. "ns/pose_node")
// and are matched server-side with a `:path` route converter - passed
// through raw here, not encodeURIComponent'd (which would escape the "/"s
// the converter is meant to accept).
export const api = {
  authStatus: () => jsonFetch<{ auth_required: boolean }>('/api/auth/status'),
  getBattery: () => jsonFetch<BatteryStatus>('/api/battery'),
  getBatteryConfig: () => jsonFetch<BatteryConfig>('/api/battery/config'),
  putBatteryConfig: (config: BatteryConfig) =>
    jsonFetch<BatteryConfig>('/api/battery/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }),
  restartBatteryMonitor: () => jsonFetch<Record<string, never>>('/api/battery/monitor/restart', { method: 'POST' }),
  login: async (passcode: string) => {
    const result = await jsonFetch<{ token: string }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode }),
    })
    setAuthToken(result.token)
    return result
  },
  logout: async () => {
    await jsonFetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    setAuthToken(null)
  },

  listTargets: () => jsonFetch<TargetStatus[]>('/api/targets'),
  getPlatform: () => jsonFetch<PlatformInfo>('/api/platform'),
  // Re-sources install/setup.zsh into dashboard_server's own environment -
  // picks up a package colcon-built after it started, without restarting
  // it. Also runs automatically every 5 min and after every targets/trees
  // save; this is just the manual "do it now" button (Misc tab).
  reloadEnvironment: () => jsonFetch<{ success: boolean; changed_keys: string[] }>('/api/environment/reload', { method: 'POST' }),
  // mode: 'normal' -> enforce `requires` (409 if unmet); 'force' -> start just
  // this target (ignore deps); 'deps' -> "Start dependencies too" (checked
  // chain). skipPreconditions (only along with mode 'deps') = node ids the
  // operator already said "start anyway" to this session - the walk passes
  // them without re-checking and keeps prompting on later unmet nodes.
  startTarget: (
    id: string,
    flags: string[] = [],
    mode: 'normal' | 'force' | 'deps' = 'normal',
    skipPreconditions: string[] = [],
    flagValues: Record<string, string> = {},
    // Per-OTHER-target flag selections for a 'deps' mode start - every
    // target besides `id` that the dependency chain might pull in along
    // the way, e.g. person_face auto-started as a dependency of
    // person_identity (not clicked directly) needs ITS OWN gpu flag here,
    // or it silently starts with none at all - confirmed live as a real
    // bug, not just a theoretical one. Only meaningful when mode === 'deps'.
    dependencyFlags?: Record<string, { flags: string[]; flag_values: Record<string, string> }>,
  ) =>
    jsonFetch<TargetStatus>(`/api/targets/${id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flags,
        flag_values: flagValues,
        ignore_dependencies: mode === 'force',
        start_dependencies: mode === 'deps',
        skip_preconditions: mode === 'deps' ? skipPreconditions : [],
        dependency_flags: mode === 'deps' ? (dependencyFlags ?? {}) : {},
      }),
    }),
  // flags: the target's CURRENTLY selected flags (before Start is even
  // clicked) - a `flag:` leaf in this target's own requires (see
  // conditions.py) needs to see them to evaluate correctly, same as the
  // real start gate does once Start is actually pressed.
  getTargetDependencies: (id: string, flags: string[] = []) => {
    const qs = flags.map((f) => `flags=${encodeURIComponent(f)}`).join('&')
    return jsonFetch<DependencyStatus>(`/api/targets/${id}/dependencies${qs ? `?${qs}` : ''}`)
  },
  stopTarget: (id: string) => jsonFetch<TargetStatus>(`/api/targets/${id}/stop`, { method: 'POST' }),
  restartTarget: (id: string) => jsonFetch<TargetStatus>(`/api/targets/${id}/restart`, { method: 'POST' }),
  // Clears the server-side log backlog a fresh /logs websocket connection
  // replays on connect - clearing only the frontend's own state looks
  // cleared until the next collapse/expand (or reload) reconnects and
  // brings the same old lines right back.
  clearTargetLogs: (id: string) => jsonFetch<{ cleared: boolean }>(`/api/targets/${id}/logs/clear`, { method: 'POST' }),
  // Manual kill of a pid from a PREVIOUS dashboard_server run (the orphan
  // tag on a target row) - Start also does this automatically before
  // spawning a fresh process for the same target, see the backend's
  // ProcessManager.start(). Both paths broadcast the same 'orphan_killed'
  // event over /api/events, which is what actually drives the toast.
  killOrphan: (id: string) => jsonFetch<{ killed: boolean }>(`/api/orphans/${id}/kill`, { method: 'POST' }),

  listNodes: () => jsonFetch<string[]>('/api/params/nodes'),
  listParameters: (nodeName: string) => jsonFetch<ParamDescriptor[]>(`/api/params/nodes/${nodeName}`),
  setParameter: (nodeName: string, paramName: string, value: unknown, typeId: number) =>
    jsonFetch<{ ok: boolean; reason: string }>(
      `/api/params/nodes/${nodeName}/params/${encodeURIComponent(paramName)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, type_id: typeId }),
      },
    ),

  estop: () => jsonFetch<{ estop_published: boolean; stopped_targets: string[] }>('/api/estop', { method: 'POST' }),

  listTopics: () => jsonFetch<TopicInfo[]>('/api/graph/topics'),
  listServices: () => jsonFetch<ServiceEndpoint[]>('/api/graph/services'),
  listActions: () => jsonFetch<ServiceEndpoint[]>('/api/graph/actions'),
  getNodeInterfaces: (nodeName: string) => jsonFetch<NodeInterfaces>(`/api/graph/nodes/${nodeName}`),
  getMessageSchema: (type: string) => jsonFetch<{ schema: string }>(`/api/graph/message_schema?type=${encodeURIComponent(type)}`),

  callService: (serviceName: string, request: Record<string, unknown>) =>
    jsonFetch<{ response: unknown }>(`/api/graph/services/${serviceName}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request }),
    }),

  sendActionGoal: (actionName: string, goal: Record<string, unknown>) =>
    jsonFetch<{ goal_id: string }>(`/api/graph/actions/${actionName}/send_goal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal }),
    }),
  cancelActionGoal: (actionName: string, goalId: string) =>
    jsonFetch<{ ok: boolean }>(`/api/graph/actions/${actionName}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal_id: goalId }),
    }),

  // topic/type echo back whatever actually ended up running - a script
  // declaring its own `extern ros_topic = "...";` default is
  // authoritative over what was typed into the Start form, and these
  // can differ from the topicName/type this was called with when that
  // happens.
  startFakePublish: (topicName: string, type: string, source: string) =>
    jsonFetch<{ session_id: string; topic: string; type: string }>(
      `/api/graph/topics/${topicName}/fake_publish/start`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, source }),
      },
    ),
  stopFakePublish: (topicName: string, sessionId: string) =>
    jsonFetch<{ ok: boolean }>(`/api/graph/topics/${topicName}/fake_publish/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    }),
  fakePublishStatus: (topicName: string, sessionId: string) =>
    jsonFetch<{ tick_count: number; error: string | null; done: boolean }>(
      `/api/graph/topics/${topicName}/fake_publish/status?session_id=${sessionId}`,
    ),

  startHz: (topicName: string) => jsonFetch<{ error: string | null }>(`/api/graph/topics/${topicName}/hz/start`, { method: 'POST' }),
  stopHz: (topicName: string) => jsonFetch<Record<string, never>>(`/api/graph/topics/${topicName}/hz/stop`, { method: 'POST' }),
  getHz: (topicName: string) => jsonFetch<HzResult>(`/api/graph/topics/${topicName}/hz`),

  listBtTrees: () => jsonFetch<BtTreeConfig[]>('/api/bt/trees'),
  getBtTreeStructure: (id: string) => jsonFetch<BtTreeStructure>(`/api/bt/trees/${id}/structure`),
  getBtLiveStructure: (id: string) => jsonFetch<BtTreeStructure>(`/api/bt/trees/${id}/live-structure`),
  getBtLiveStatus: (id: string) => jsonFetch<BtLiveStatus>(`/api/bt/trees/${id}/live-status`),

  // Re-read both live config files from disk into the running server -
  // for when the Settings GUI isn't the thing that changed them (hand-edit
  // of ~/.dashboard_targets.yaml / behavior_trees.yaml). Settings-save PUT
  // applies the editor's snapshot; this applies what's actually on disk.
  // *_diff: added/removed/changed ids since the PREVIOUS in-memory state
  // (not just current counts) - lets a caller toast what actually changed,
  // not just that a reload happened. code_changed: target ids whose
  // PACKAGE's installed files changed (a colcon rebuild) - a genuinely
  // separate signal from targets_diff, since a rebuild edits neither
  // targets.yaml nor any env var the environment-reload would catch.
  reloadConfig: () =>
    jsonFetch<{
      applied: boolean
      targets: number
      skipped_removals: string[]
      trees: number
      targets_diff: ConfigDiff
      trees_diff: ConfigDiff
      code_changed: string[]
    }>('/api/config/reload', { method: 'POST' }),
  getConfigTargets: () => jsonFetchWithVersion<FullTargetConfig[]>('/api/config/targets'),
  putConfigTargets: (targets: FullTargetConfig[], baseVersion: string | null) =>
    jsonFetchWithVersion<ConfigSaveResult>('/api/config/targets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(baseVersion ? { 'X-Config-Version': baseVersion } : {}) },
      body: JSON.stringify(targets),
    }),
  getConfigTrees: () => jsonFetchWithVersion<BtTreeConfig[]>('/api/config/behavior_trees'),
  putConfigTrees: (trees: BtTreeConfig[], baseVersion: string | null) =>
    jsonFetchWithVersion<ConfigSaveResult>('/api/config/behavior_trees', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(baseVersion ? { 'X-Config-Version': baseVersion } : {}) },
      body: JSON.stringify(trees),
    }),

  // Control tab's drag-to-reorder - persists as a separate target_order
  // list server-side (see supervisor/config.py), applies live, no
  // X-Config-Version dance since it never touches the targets: block
  // that the concurrent-edit merge logic cares about.
  reorderTargets: (order: string[]) =>
    jsonFetch<{ applied: boolean }>('/api/config/targets/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    }),

  // Turns pasted/imported YAML text into validated entries, folded into
  // the editor's current list by id (not a save - the existing PUT flow
  // still owns actually writing to disk). Accepts the whole file shape,
  // a bare list, or a single entry pasted alone.
  parseTargetsYaml: (yamlText: string) =>
    jsonFetch<FullTargetConfig[]>('/api/config/targets/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml_text: yamlText }),
    }),
  parseTreesYaml: (yamlText: string) =>
    jsonFetch<BtTreeConfig[]>('/api/config/behavior_trees/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml_text: yamlText }),
    }),
}

function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  // WebSocket connections can't carry an Authorization header from browser
  // JS - the token travels as a query param instead, checked server-side
  // per-handler (see check_token() call sites in supervisor/routes.py,
  // graph/routes.py).
  const sep = path.includes('?') ? '&' : '?'
  const tokenParam = authToken ? `${sep}token=${encodeURIComponent(authToken)}` : ''
  return `${proto}//${window.location.host}${path}${tokenParam}`
}

// Shared singleton socket, not one per caller - App.tsx (toast
// notifications) and ControlTab.tsx (the live target list) both subscribe
// to the same /api/events stream for the whole session; opening a second
// independent WebSocket was doubling both the server's broadcast fan-out
// and client-side JSON parsing for data the first connection already had.
// Opened on first subscriber, closed once the last one unsubscribes.
let eventsSocket: WebSocket | null = null
// Not every event on this stream is a full TargetStatus - 'removed' only
// carries {type, id}, 'orphan_killed' only {type, id, pid}. Typed as a
// TargetStatus subset with those extra fields rather than full TargetStatus
// so consumers narrow on `type` instead of assuming every field is present.
type DashboardEvent = Partial<TargetStatus> & { type: string; id: string; pid?: number }
const eventsListeners = new Set<(event: DashboardEvent) => void>()

function ensureEventsSocket(): void {
  if (eventsSocket) return
  const ws = new WebSocket(wsUrl('/api/events'))
  ws.onmessage = (msg) => {
    const event = JSON.parse(msg.data)
    for (const cb of eventsListeners) cb(event)
  }
  ws.onclose = () => {
    if (eventsSocket === ws) eventsSocket = null
  }
  eventsSocket = ws
}

export function connectEvents(onEvent: (event: DashboardEvent) => void): () => void {
  eventsListeners.add(onEvent)
  ensureEventsSocket()
  return () => {
    eventsListeners.delete(onEvent)
    if (eventsListeners.size === 0 && eventsSocket) {
      eventsSocket.close()
      eventsSocket = null
    }
  }
}

export function connectLogs(targetId: string, onLine: (line: string) => void): () => void {
  const ws = new WebSocket(wsUrl(`/api/targets/${targetId}/logs`))
  ws.onmessage = (msg) => onLine(JSON.parse(msg.data).line)
  return () => ws.close()
}

export function connectEcho(topicName: string, onMessage: (data: unknown) => void): () => void {
  const ws = new WebSocket(wsUrl(`/api/graph/topics/${topicName}/echo`))
  ws.onmessage = (msg) => onMessage(JSON.parse(msg.data))
  return () => ws.close()
}

export type ActionStreamItem =
  | { type: 'accepted'; ros_goal_id: number[] }
  | { type: 'feedback'; data: unknown }
  | { type: 'result'; status: number; data: unknown }
  | { type: 'rejected' }
  | { error: string }

export function connectActionStream(
  actionName: string,
  goalId: string,
  onItem: (item: ActionStreamItem) => void,
): () => void {
  const ws = new WebSocket(wsUrl(`/api/graph/actions/${actionName}/stream?goal_id=${goalId}`))
  ws.onmessage = (msg) => onItem(JSON.parse(msg.data))
  return () => ws.close()
}
