import { Dispatch, SetStateAction, useEffect, useMemo, useRef, useState } from 'react'
import { ActionStreamItem, api, connectActionStream, connectEcho, HzResult, NodeInterfaces, ServiceEndpoint, TopicInfo } from '../api'
import { goalStatusLabel, shortGoalId } from '../actionStatus'
import { formatEcho } from '../formatEcho'
import { useDraftStore } from '../useDraftStore'
import { usePersistentSet, usePersistentState } from '../usePersistentState'
import ActionsTreeView, { ActionStreamEntry } from '../ActionsTreeView'
import { buildNamespaceTree, collectGroupPrefixes } from '../namespaceTree'
import NodeInterfacesTreeView from '../NodeInterfacesTreeView'
import PublishPanel from '../PublishPanel'
import { resetAllConsoleHeights } from '../resetConsoleHeights'
import ServicesTreeView from '../ServicesTreeView'
import { buildTfTree } from '../tfTree'
import TfTreeView from '../TfTreeView'
import TopicsTreeView from '../TopicsTreeView'

const HZ_POLL_INTERVAL_MS = 1000
const GRAPH_POLL_INTERVAL_MS = 3000
const MAX_ECHO_MESSAGES = 50
const MAX_ACTION_STREAM_ENTRIES = 50

interface GoalStatusArray {
  status_list: { goal_info: { goal_id: { uuid: number[] } }; status: number }[]
}

interface TfMessage {
  transforms: { header: { frame_id: string }; child_frame_id: string }[]
}

// "What's running and what's it doing" - separate from Params (tuning
// values) and from the planned Lichtblick tab (visualizing topic data).
// Node/topic discovery + wiring is static graph metadata. `hz` and `echo`
// are real live subscriptions (dynamically resolving the topic's message
// type and subscribing to it) - verified empirically that create/
// destroy_subscription are safe to call after the executor is already
// spinning, and that the QoS profile returned by
// get_publishers_info_by_topic() must NOT be reused as-is (throws "invalid
// allocator" - only reliability/durability are copied). `hz` and `echo`
// share one real subscription per topic on the backend (ref-counted), not
// two. Echo is server-side rate-limited to 5 msg/sec regardless of the
// topic's actual publish rate, and large array/byte fields are truncated
// before being sent - both to avoid the "clogs the bridge" problem this
// workspace's own lidar_filter README already flagged for foxglove_bridge.
export default function GraphTab() {
  const [nodes, setNodes] = useState<string[]>([])
  const [topics, setTopics] = useState<TopicInfo[]>([])
  const [services, setServices] = useState<ServiceEndpoint[]>([])
  // Persisted - collapsed-group state is a pure display toggle everywhere
  // in this tab (no live subscription tied to it), safe to persist plainly.
  const [collapsedServiceGroups, setCollapsedServiceGroups] = usePersistentSet('dashboard.graph.collapsedServiceGroups')
  // Persisted too - expanding a service just reveals its request textarea,
  // no live subscription (unlike expandedTopics/expandedActions below).
  const [expandedServices, setExpandedServices] = usePersistentSet('dashboard.graph.expandedServices')
  // Persisted per service name, capped at the 100 most-recently-touched
  // namespaces (see useDraftStore) - just the currently-typed-in request
  // body, not a history, so a refresh doesn't lose what you were mid-way
  // through composing.
  const [requestInputByService, setRequestInputByService] = useDraftStore('dashboard.services.drafts')
  const [requestErrorByService, setRequestErrorByService] = useState<Record<string, string>>({})
  const [callingServices, setCallingServices] = useState<Set<string>>(new Set())
  const [responseByService, setResponseByService] = useState<Record<string, string>>({})
  const [actions, setActions] = useState<ServiceEndpoint[]>([])
  const [collapsedActionGroups, setCollapsedActionGroups] = usePersistentSet('dashboard.graph.collapsedActionGroups')
  const [collapsedNodeGroups, setCollapsedNodeGroups] = usePersistentSet('dashboard.graph.collapsedNodeGroups')
  // Persisted - safe the same way as Params tab's identical case: node
  // interfaces are eager-fetched for every node up front (see the effect
  // below), so restoring which ones were expanded doesn't need to also
  // restore a fetch-in-progress.
  const [expandedNodeLeaves, setExpandedNodeLeaves] = usePersistentSet('dashboard.graph.expandedNodeLeaves')
  const [interfacesByLeaf, setInterfacesByLeaf] = useState<Record<string, NodeInterfaces>>({})
  const [loadingLeaves, setLoadingLeaves] = useState<Set<string>>(new Set())
  const [errorByLeaf, setErrorByLeaf] = useState<Record<string, string>>({})
  const [collapsedTopicGroups, setCollapsedTopicGroups] = usePersistentSet('dashboard.graph.collapsedTopicGroups')
  // Persisted - but unlike the groups above, expanding a topic also starts
  // real hz/echo subscriptions (toggleExpand below), which a page reload
  // obviously tears down. The mount effect further down is what actually
  // reconnects those for whatever restores here open - persisting this Set
  // alone would just show an open-but-frozen panel until you manually
  // toggled it, same class of bug the Control tab's target-logs restore
  // had to handle.
  const [expandedTopics, setExpandedTopics] = usePersistentSet('dashboard.graph.expandedTopics')
  const [searchQuery, setSearchQuery] = useState('')
  // NOT persisted directly - these track which topics currently have a
  // live hz/echo subscription, which is redundant with (and must stay in
  // sync with) expandedTopics above. The mount effect derives these from
  // the restored expandedTopics instead of loading a second, potentially
  // out-of-sync copy from its own localStorage key.
  const [watchedTopics, setWatchedTopics] = useState<Set<string>>(new Set())
  const [hzByTopic, setHzByTopic] = useState<Record<string, HzResult>>({})
  const watchedTopicsRef = useRef<Set<string>>(new Set())
  const [echoingTopics, setEchoingTopics] = useState<Set<string>>(new Set())
  const [echoMessagesByTopic, setEchoMessagesByTopic] = useState<Record<string, unknown[]>>({})
  const echoDisconnectRef = useRef<Record<string, () => void>>({})

  // Global, not per-action: gates the "send a goal" panel everywhere (and
  // the "call a service" panel) - the all-goals status view below is the
  // default, always-on view; composing/sending is the advanced operation
  // that's opt-in for the whole tab at once. Persisted - this is a stable
  // preference ("I'm actively testing things right now"), not session
  // browsing state like a search query or which row is expanded.
  const [sendingEnabled, setSendingEnabled] = usePersistentState('dashboard.graph.sendingEnabled', false)

  // Persisted - same reasoning as expandedTopics: opening an action row
  // starts a real status-stream subscription (toggleExpandAction below),
  // reconnected for whatever restores here open by the mount effect
  // further down.
  const [expandedActions, setExpandedActions] = usePersistentSet('dashboard.graph.expandedActions')
  // All goals on an action, any client, status-only (accepted/executing/
  // succeeded/...) - auto-watched for as long as the row is expanded, same
  // lifecycle as topics' hz/echo. This is the left/default panel.
  const [allGoalsStatusByAction, setAllGoalsStatusByAction] = useState<Record<string, ActionStreamEntry[]>>({})
  const statusStreamDisconnectRef = useRef<Record<string, () => void>>({})
  const lastStatusSeenByAction = useRef<Record<string, Record<string, number>>>({})
  // Real ROS goal UUID (short hex) for whichever goal you most recently
  // sent per action - lets the all-goals panel recognize "that's actually
  // your own goal" and label it. State, not a ref: the raw status topic
  // and your own goal's "accepted" push arrive independently, so an
  // earlier-arriving status entry may predate knowing it's yours -
  // ActionsTreeView derives "(you)" at format time against this, so it
  // must trigger a re-render when it changes to retroactively relabel.
  const [myGoalIdByAction, setMyGoalIdByAction] = useState<Record<string, string>>({})

  // Goal you composed and sent yourself - detailed feed (accepted/feedback/
  // result), only relevant while sendingEnabled. The right/advanced panel.
  // Persisted the same way as requestInputByService above - current draft
  // per action name, capped at 100 recently-touched namespaces.
  const [goalInputByAction, setGoalInputByAction] = useDraftStore('dashboard.actions.drafts')
  const [goalErrorByAction, setGoalErrorByAction] = useState<Record<string, string>>({})
  const [activeGoalByAction, setActiveGoalByAction] = useState<Record<string, string | undefined>>({})
  const [statusByAction, setStatusByAction] = useState<Record<string, string>>({})
  const [ownStreamByAction, setOwnStreamByAction] = useState<Record<string, ActionStreamEntry[]>>({})
  const actionStreamDisconnectRef = useRef<Record<string, () => void>>({})

  // Nodes/Topics/Services/Actions/TF are each collapsible now - this tab
  // outgrew "everything always visible" once Actions/Services/Publish grew
  // real per-item panels. Persisted (an array, not a Set - directly
  // JSON-safe for usePersistentState); collapsed-by-default would hide an
  // empty-looking tab on first load, so this only ever remembers what YOU
  // chose to collapse, nothing starts collapsed.
  const [collapsedSections, setCollapsedSections] = usePersistentState<string[]>('dashboard.graph.collapsedSections', [])
  const collapsedSectionSet = useMemo(() => new Set(collapsedSections), [collapsedSections])
  function toggleSection(id: string) {
    setCollapsedSections((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))
  }
  // Search must still be able to surface a match inside a collapsed
  // section - same "searching forces open" rule every namespace tree in
  // this tab already applies one level down, just at the section level.
  const searching = searchQuery.trim().length > 0
  function sectionOpen(id: string) {
    return searching || !collapsedSectionSet.has(id)
  }

  // frame_id (child) -> parent frame_id, merged from /tf and /tf_static -
  // ordinary topics, no backend support needed: reuses the same echo
  // websocket every other live view in this tab already uses. Watched only
  // while the TF section is actually expanded, same lifecycle as topics'
  // hz/echo and actions' all-goals status.
  const [tfLinks, setTfLinks] = useState<Record<string, string>>({})
  const tfDisconnectRef = useRef<{ tf?: () => void; tfStatic?: () => void }>({})

  // Split out of toggleTfSection so a mount-restore (collapsedSections
  // already persisted 'tf' as open, but that alone never started the
  // subscription itself before) can call just the "start" half without
  // also flipping collapsedSections off like the toggle function would.
  function startTfWatch() {
    const onTfMessage = (data: unknown) => {
      const msg = data as TfMessage
      setTfLinks((prev) => {
        const next = { ...prev }
        for (const t of msg.transforms ?? []) next[t.child_frame_id] = t.header.frame_id
        return next
      })
    }
    tfDisconnectRef.current.tf = connectEcho('tf', onTfMessage)
    tfDisconnectRef.current.tfStatic = connectEcho('tf_static', onTfMessage)
  }

  function toggleTfSection() {
    if (!collapsedSectionSet.has('tf')) {
      tfDisconnectRef.current.tf?.()
      tfDisconnectRef.current.tfStatic?.()
      tfDisconnectRef.current = {}
    } else {
      startTfWatch()
    }
    toggleSection('tf')
  }

  const tfTree = useMemo(() => buildTfTree(tfLinks), [tfLinks])

  // Polled, not fetch-once-on-mount: the ROS graph changes constantly (a
  // node started from the Control tab, something launched by hand in a
  // terminal) and this list is supposed to be "what's actually running
  // right now," not a snapshot from whenever the tab happened to load.
  useEffect(() => {
    function refresh() {
      api.listNodes().then(setNodes).catch((err) => console.error('listNodes failed', err))
      api.listTopics().then(setTopics).catch((err) => console.error('listTopics failed', err))
      api.listServices().then(setServices).catch((err) => console.error('listServices failed', err))
      api.listActions().then(setActions).catch((err) => console.error('listActions failed', err))
    }
    refresh()
    const interval = setInterval(refresh, GRAPH_POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  const nodeTree = useMemo(() => buildNamespaceTree(nodes, (n) => n, '/'), [nodes])
  const topicTree = useMemo(() => buildNamespaceTree(topics, (t) => t.name, '/'), [topics])
  const serviceTree = useMemo(() => buildNamespaceTree(services, (s) => s.name, '/'), [services])
  const actionTree = useMemo(() => buildNamespaceTree(actions, (a) => a.name, '/'), [actions])

  function toggleServiceGroup(prefix: string) {
    setCollapsedServiceGroups((prev) => {
      const next = new Set(prev)
      if (next.has(prefix)) next.delete(prefix)
      else next.add(prefix)
      return next
    })
  }

  function toggleExpandService(serviceName: string) {
    setExpandedServices((prev) => {
      const next = new Set(prev)
      if (next.has(serviceName)) next.delete(serviceName)
      else next.add(serviceName)
      return next
    })
  }

  function onRequestInputChange(serviceName: string, value: string) {
    setRequestInputByService(serviceName, value)
    setRequestErrorByService((prev) => {
      const next = { ...prev }
      delete next[serviceName]
      return next
    })
  }

  async function callService(serviceName: string) {
    let request: Record<string, unknown>
    try {
      request = JSON.parse(requestInputByService[serviceName]?.trim() || '{}')
    } catch (err) {
      setRequestErrorByService((prev) => ({ ...prev, [serviceName]: `invalid JSON: ${String(err)}` }))
      return
    }
    setCallingServices((prev) => new Set(prev).add(serviceName))
    try {
      const { response } = await api.callService(serviceName, request)
      setResponseByService((prev) => ({ ...prev, [serviceName]: formatEcho(response) }))
    } catch (err) {
      setRequestErrorByService((prev) => ({ ...prev, [serviceName]: String(err) }))
    } finally {
      setCallingServices((prev) => {
        const next = new Set(prev)
        next.delete(serviceName)
        return next
      })
    }
  }

  function toggleActionGroup(prefix: string) {
    setCollapsedActionGroups((prev) => {
      const next = new Set(prev)
      if (next.has(prefix)) next.delete(prefix)
      else next.add(prefix)
      return next
    })
  }

  async function fetchInterfaces(fqn: string) {
    if (interfacesByLeaf[fqn] || loadingLeaves.has(fqn)) return
    setLoadingLeaves((prev) => new Set(prev).add(fqn))
    try {
      const result = await api.getNodeInterfaces(fqn)
      setInterfacesByLeaf((prev) => ({ ...prev, [fqn]: result }))
    } catch (err) {
      setErrorByLeaf((prev) => ({ ...prev, [fqn]: String(err) }))
    } finally {
      setLoadingLeaves((prev) => {
        const next = new Set(prev)
        next.delete(fqn)
        return next
      })
    }
  }

  // Eager-fetch every node's interfaces up front - same reasoning as the
  // Params tab fix: lazy-on-expand conflates "not fetched yet" with "not
  // available" and search can't see unopened nodes anyway.
  useEffect(() => {
    for (const fqn of nodes) fetchInterfaces(fqn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes])

  function toggleNodeGroup(prefix: string) {
    setCollapsedNodeGroups((prev) => {
      const next = new Set(prev)
      if (next.has(prefix)) next.delete(prefix)
      else next.add(prefix)
      return next
    })
  }

  function toggleNodeLeaf(fqn: string) {
    setExpandedNodeLeaves((prev) => {
      const next = new Set(prev)
      if (next.has(fqn)) next.delete(fqn)
      else next.add(fqn)
      return next
    })
  }

  function toggleTopicGroup(prefix: string) {
    setCollapsedTopicGroups((prev) => {
      const next = new Set(prev)
      if (next.has(prefix)) next.delete(prefix)
      else next.add(prefix)
      return next
    })
  }

  async function toggleWatch(topicName: string) {
    if (watchedTopics.has(topicName)) {
      setWatchedTopics((prev) => {
        const next = new Set(prev)
        next.delete(topicName)
        return next
      })
      setHzByTopic((prev) => {
        const next = { ...prev }
        delete next[topicName]
        return next
      })
      await api.stopHz(topicName)
    } else {
      setWatchedTopics((prev) => new Set(prev).add(topicName))
      const { error } = await api.startHz(topicName)
      if (error) setHzByTopic((prev) => ({ ...prev, [topicName]: { rate_hz: null, sample_count: 0, error } }))
    }
  }

  function toggleEcho(topicName: string) {
    if (echoingTopics.has(topicName)) {
      echoDisconnectRef.current[topicName]?.()
      delete echoDisconnectRef.current[topicName]
      setEchoingTopics((prev) => {
        const next = new Set(prev)
        next.delete(topicName)
        return next
      })
      setEchoMessagesByTopic((prev) => {
        const next = { ...prev }
        delete next[topicName]
        return next
      })
    } else {
      setEchoingTopics((prev) => new Set(prev).add(topicName))
      echoDisconnectRef.current[topicName] = connectEcho(topicName, (data) => {
        setEchoMessagesByTopic((prev) => {
          const existing = prev[topicName] ?? []
          return { ...prev, [topicName]: [...existing, data].slice(-MAX_ECHO_MESSAGES) }
        })
      })
    }
  }

  // Expanding a row IS starting the all-goals status watch, collapsing IS
  // stopping it - same symmetric pattern as topics' hz/echo (toggleExpand
  // below). This is the always-on default view; sendingEnabled only adds
  // the compose/send panel alongside it, it doesn't gate this one.
  // Split out of toggleExpandAction for the same reason as startTfWatch
  // above - a mount-restore needs just the "start" half, not the toggle
  // that would flip expandedActions back off.
  function startActionStatusWatch(actionName: string) {
    lastStatusSeenByAction.current[actionName] = {}
    statusStreamDisconnectRef.current[actionName] = connectEcho(`${actionName}/_action/status`, (data) => {
      const seen = lastStatusSeenByAction.current[actionName] ?? {}
      for (const entry of (data as GoalStatusArray).status_list ?? []) {
        const goalIdHex = shortGoalId(entry.goal_info.goal_id.uuid)
        // Every message carries the FULL list of currently-tracked
        // goals, not a diff - only push when a goal's status actually
        // changed, or the same "succeeded" goal reprints on every
        // unrelated goal's status change.
        if (seen[goalIdHex] === entry.status) continue
        seen[goalIdHex] = entry.status
        pushEntry(setAllGoalsStatusByAction, actionName, { type: 'status', goalIdHex, status: entry.status })
      }
      lastStatusSeenByAction.current[actionName] = seen
    })
  }

  function toggleExpandAction(actionName: string) {
    const isOpen = expandedActions.has(actionName)
    if (isOpen) {
      statusStreamDisconnectRef.current[actionName]?.()
      delete statusStreamDisconnectRef.current[actionName]
      delete lastStatusSeenByAction.current[actionName]
    } else {
      startActionStatusWatch(actionName)
    }
    setExpandedActions((prev) => {
      const next = new Set(prev)
      if (next.has(actionName)) next.delete(actionName)
      else next.add(actionName)
      return next
    })
  }

  function onGoalInputChange(actionName: string, value: string) {
    setGoalInputByAction(actionName, value)
    setGoalErrorByAction((prev) => {
      const next = { ...prev }
      delete next[actionName]
      return next
    })
  }

  function pushEntry(
    setter: Dispatch<SetStateAction<Record<string, ActionStreamEntry[]>>>,
    actionName: string,
    entry: ActionStreamEntry,
  ) {
    setter((prev) => {
      const existing = prev[actionName] ?? []
      return { ...prev, [actionName]: [...existing, entry].slice(-MAX_ACTION_STREAM_ENTRIES) }
    })
  }

  function onActionStreamItem(actionName: string, item: ActionStreamItem) {
    if ('error' in item) {
      setStatusByAction((prev) => ({ ...prev, [actionName]: item.error }))
      return
    }
    if (item.type === 'accepted') {
      const goalIdHex = shortGoalId(item.ros_goal_id)
      setMyGoalIdByAction((prev) => ({ ...prev, [actionName]: goalIdHex }))
      pushEntry(setOwnStreamByAction, actionName, { type: 'accepted', goalIdHex })
      return
    }
    pushEntry(setOwnStreamByAction, actionName, item)
    if (item.type === 'result') {
      setStatusByAction((prev) => ({ ...prev, [actionName]: goalStatusLabel(item.status) }))
      setActiveGoalByAction((prev) => ({ ...prev, [actionName]: undefined }))
      actionStreamDisconnectRef.current[actionName]?.()
      delete actionStreamDisconnectRef.current[actionName]
    } else if (item.type === 'rejected') {
      setStatusByAction((prev) => ({ ...prev, [actionName]: 'rejected' }))
      setActiveGoalByAction((prev) => ({ ...prev, [actionName]: undefined }))
      actionStreamDisconnectRef.current[actionName]?.()
      delete actionStreamDisconnectRef.current[actionName]
    }
  }

  async function sendGoal(actionName: string) {
    let goal: Record<string, unknown>
    try {
      goal = JSON.parse(goalInputByAction[actionName]?.trim() || '{}')
    } catch (err) {
      setGoalErrorByAction((prev) => ({ ...prev, [actionName]: `invalid JSON: ${String(err)}` }))
      return
    }
    setOwnStreamByAction((prev) => ({ ...prev, [actionName]: [] }))
    setStatusByAction((prev) => ({ ...prev, [actionName]: 'sending…' }))
    try {
      const { goal_id } = await api.sendActionGoal(actionName, goal)
      setActiveGoalByAction((prev) => ({ ...prev, [actionName]: goal_id }))
      setStatusByAction((prev) => ({ ...prev, [actionName]: 'goal sent, waiting for feedback…' }))
      actionStreamDisconnectRef.current[actionName] = connectActionStream(actionName, goal_id, (item) =>
        onActionStreamItem(actionName, item),
      )
    } catch (err) {
      setGoalErrorByAction((prev) => ({ ...prev, [actionName]: String(err) }))
      setStatusByAction((prev) => ({ ...prev, [actionName]: 'send failed' }))
    }
  }

  async function cancelGoal(actionName: string) {
    const goalId = activeGoalByAction[actionName]
    if (!goalId) return
    setStatusByAction((prev) => ({ ...prev, [actionName]: 'cancel requested…' }))
    await api.cancelActionGoal(actionName, goalId).catch((err) => {
      setStatusByAction((prev) => ({ ...prev, [actionName]: `cancel failed: ${String(err)}` }))
    })
  }

  // The dropdown IS the start/stop control, symmetric both ways: opening a
  // topic's details starts Hz + Echo, closing it stops them - no separate
  // buttons. A subscription that keeps running behind a collapsed row,
  // invisible, is exactly the kind of silent leak this feature has been
  // careful to avoid everywhere else (tab-unmount cleanup, ref-counted
  // teardown on the backend). "Closed" means actually stopped, not hidden.
  function toggleExpand(topicName: string) {
    const isOpen = expandedTopics.has(topicName)
    if (isOpen) {
      if (watchedTopics.has(topicName)) toggleWatch(topicName)
      if (echoingTopics.has(topicName)) toggleEcho(topicName)
    } else {
      if (!watchedTopics.has(topicName)) toggleWatch(topicName)
      if (!echoingTopics.has(topicName)) toggleEcho(topicName)
    }
    setExpandedTopics((prev) => {
      const next = new Set(prev)
      if (next.has(topicName)) next.delete(topicName)
      else next.add(topicName)
      return next
    })
  }

  // Reconnects whatever was left expanded from a previous session -
  // expandedTopics/expandedActions/the TF section's own open-state are all
  // persisted now, but none of the actual live subscriptions (hz, echo,
  // action status stream, tf/tf_static) survive a reload on their own.
  // Mount-only: toggleExpand/toggleExpandAction/toggleTfSection already
  // handle connecting for anything opened during THIS session.
  useEffect(() => {
    if (!collapsedSectionSet.has('tf') && !tfDisconnectRef.current.tf) startTfWatch()
    for (const topicName of expandedTopics) {
      if (!watchedTopics.has(topicName)) toggleWatch(topicName)
      if (!echoingTopics.has(topicName)) toggleEcho(topicName)
    }
    for (const actionName of expandedActions) {
      if (!statusStreamDisconnectRef.current[actionName]) startActionStatusWatch(actionName)
    }
    // Intentionally mount-only - see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep a ref in sync so the unmount-cleanup effect below can see the
  // latest watched set without re-subscribing to it as a dependency.
  useEffect(() => {
    watchedTopicsRef.current = watchedTopics
  }, [watchedTopics])

  // Poll each watched topic's rate while any are being watched.
  useEffect(() => {
    if (watchedTopics.size === 0) return
    const interval = setInterval(() => {
      for (const topic of watchedTopics) {
        api.getHz(topic).then((result) => setHzByTopic((prev) => ({ ...prev, [topic]: result })))
      }
    }, HZ_POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [watchedTopics])

  // Switching tabs unmounts GraphTab entirely (App.tsx only renders the
  // active tab) - without this, any topic left "watching" when you
  // navigate away leaks its backend subscription forever, since nothing
  // else would ever call stop_hz for it. Echo websockets close themselves
  // on unmount as a side effect of the component tree disappearing, but
  // that's not something to depend on - closing them explicitly here too.
  useEffect(() => {
    return () => {
      for (const topic of watchedTopicsRef.current) {
        api.stopHz(topic).catch(() => {})
      }
      for (const disconnect of Object.values(echoDisconnectRef.current)) {
        disconnect()
      }
      for (const disconnect of Object.values(actionStreamDisconnectRef.current)) {
        disconnect()
      }
      for (const disconnect of Object.values(statusStreamDisconnectRef.current)) {
        disconnect()
      }
      tfDisconnectRef.current.tf?.()
      tfDisconnectRef.current.tfStatic?.()
    }
  }, [])

  // Tears down every live subscription this tab can have open (hz/echo via
  // toggleExpand, action status streams, tf/tf_static) through the same
  // toggle functions a manual collapse would use - not just clearing the
  // expand-state Sets directly - then collapses every group/section on
  // top of that.
  function collapseAll() {
    for (const topicName of [...expandedTopics]) toggleExpand(topicName)
    for (const actionName of [...expandedActions]) toggleExpandAction(actionName)
    if (!collapsedSectionSet.has('tf')) toggleTfSection()
    setCollapsedSections(['nodes', 'topics', 'services', 'actions', 'tf'])
    setCollapsedNodeGroups(new Set(collectGroupPrefixes(nodeTree)))
    setExpandedNodeLeaves(new Set())
    setCollapsedTopicGroups(new Set(collectGroupPrefixes(topicTree)))
    setCollapsedServiceGroups(new Set(collectGroupPrefixes(serviceTree)))
    setExpandedServices(new Set())
    setCollapsedActionGroups(new Set(collectGroupPrefixes(actionTree)))
  }

  return (
    <div>
      <div className="params-toolbar">
        <input
          type="text"
          placeholder="Search nodes and topics…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button className="flag-toggle" onClick={collapseAll}>
          Collapse all
        </button>
        <button className="flag-toggle" onClick={resetAllConsoleHeights} title="Reset every drag-resized console back to its default height">
          Reset console height
        </button>
        <button
          className={`flag-toggle${sendingEnabled ? ' active' : ''}`}
          onClick={() => setSendingEnabled((v) => !v)}
        >
          advanced: send goals/calls
        </button>
      </div>

      <h3 className="tree-row group" style={{ cursor: 'pointer' }} onClick={() => toggleSection('nodes')}>
        <span className="tree-caret">{sectionOpen('nodes') ? '▾' : '▸'}</span> Nodes
      </h3>
      {sectionOpen('nodes') && (
        <>
          {nodes.length === 0 && <p className="hint">No nodes on the graph yet.</p>}
          <NodeInterfacesTreeView
            nodes={nodeTree}
            depth={0}
            collapsedGroups={collapsedNodeGroups}
            onToggleGroup={toggleNodeGroup}
            expandedLeaves={expandedNodeLeaves}
            onToggleLeaf={toggleNodeLeaf}
            interfacesByLeaf={interfacesByLeaf}
            loadingLeaves={loadingLeaves}
            errorByLeaf={errorByLeaf}
            searchQuery={searchQuery}
          />
        </>
      )}

      <h3 className="tree-row group" style={{ marginTop: '2rem', cursor: 'pointer' }} onClick={() => toggleSection('topics')}>
        <span className="tree-caret">{sectionOpen('topics') ? '▾' : '▸'}</span> Topics
      </h3>
      {sectionOpen('topics') && (
        <>
          {sendingEnabled && <PublishPanel />}
          {topics.length === 0 && <p className="hint">No topics on the graph yet.</p>}
          <TopicsTreeView
            nodes={topicTree}
            depth={0}
            collapsedGroups={collapsedTopicGroups}
            onToggleGroup={toggleTopicGroup}
            searchQuery={searchQuery}
            expandedTopics={expandedTopics}
            onToggleExpand={toggleExpand}
            hzByTopic={hzByTopic}
            echoMessagesByTopic={echoMessagesByTopic}
          />
        </>
      )}

      <h3 className="tree-row group" style={{ marginTop: '2rem', cursor: 'pointer' }} onClick={() => toggleSection('services')}>
        <span className="tree-caret">{sectionOpen('services') ? '▾' : '▸'}</span> Services
      </h3>
      {sectionOpen('services') && (
        <>
          {services.length === 0 && <p className="hint">No services on the graph yet.</p>}
          <ServicesTreeView
            nodes={serviceTree}
            depth={0}
            collapsedGroups={collapsedServiceGroups}
            onToggleGroup={toggleServiceGroup}
            searchQuery={searchQuery}
            sendingEnabled={sendingEnabled}
            expandedServices={expandedServices}
            onToggleExpand={toggleExpandService}
            requestInputByService={requestInputByService}
            onRequestInputChange={onRequestInputChange}
            requestErrorByService={requestErrorByService}
            callingServices={callingServices}
            responseByService={responseByService}
            onCallService={callService}
          />
        </>
      )}

      <h3 className="tree-row group" style={{ marginTop: '2rem', cursor: 'pointer' }} onClick={() => toggleSection('actions')}>
        <span className="tree-caret">{sectionOpen('actions') ? '▾' : '▸'}</span> Actions
      </h3>
      {sectionOpen('actions') && (
        <>
          {actions.length === 0 && <p className="hint">No actions on the graph yet.</p>}
          <ActionsTreeView
            nodes={actionTree}
            depth={0}
            collapsedGroups={collapsedActionGroups}
            onToggleGroup={toggleActionGroup}
            searchQuery={searchQuery}
            expandedActions={expandedActions}
            onToggleExpand={toggleExpandAction}
            allGoalsStatusByAction={allGoalsStatusByAction}
            myGoalIdByAction={myGoalIdByAction}
            sendingEnabled={sendingEnabled}
            goalInputByAction={goalInputByAction}
            onGoalInputChange={onGoalInputChange}
            goalErrorByAction={goalErrorByAction}
            activeGoalByAction={activeGoalByAction}
            statusByAction={statusByAction}
            ownStreamByAction={ownStreamByAction}
            onSendGoal={sendGoal}
            onCancelGoal={cancelGoal}
          />
        </>
      )}

      <h3 className="tree-row group" style={{ marginTop: '2rem', cursor: 'pointer' }} onClick={toggleTfSection}>
        <span className="tree-caret">{sectionOpen('tf') ? '▾' : '▸'}</span> TF
      </h3>
      {sectionOpen('tf') && (
        <>
          {tfTree.length === 0 && <p className="hint">No transforms seen yet (watching /tf and /tf_static).</p>}
          <TfTreeView nodes={tfTree} prefix="" />
        </>
      )}
    </div>
  )
}
