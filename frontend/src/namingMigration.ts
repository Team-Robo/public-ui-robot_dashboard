// Preserve target flags and unsaved BT stub choices across the naming change.
// This only migrates browser preferences; it never starts a target or saves a BT.
const TARGETS: Record<string, string> = {
  pose_estimation: 'person_pose', person_pose_python: 'person_pose',
  face_recognition_node: 'person_face', person_reid_tracker: 'person_body',
  identity_fusion: 'person_identity', audio_frontend: 'audio_capture',
  audio_vad: 'speech_vad', asr_node: 'speech_asr', intent_node: 'speech_intent',
  llm_bridge: 'llm_api_bridge', llm_node: 'conversation_llm',
  speak_action_server: 'speech_output', bt_hri_mission: 'hri_bt_main',
}

export function migrateNamingPreferences(storage: Storage): void {
  const marker = 'dashboard.namingMigration.v1'
  if (storage.getItem(marker)) return
  const keys = ['dashboard.control.selectedFlags', 'dashboard.viz.selectedFlags',
    'dashboard.control.expandedTargets']
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key?.startsWith('dashboard.bt.stubDraft.') && !key.endsWith('.beforeNamingV1')) keys.push(key)
  }
  for (const key of keys) {
    const raw = storage.getItem(key)
    if (raw === null) continue
    let value: unknown
    try { value = JSON.parse(raw) } catch { continue }
    let changed: unknown = value
    if (key === 'dashboard.control.expandedTargets' && Array.isArray(value)) {
      changed = [...new Set(value.map(id => typeof id === 'string' ? TARGETS[id] ?? id : id))]
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const result: Record<string, unknown> = {}
      const entries = Object.entries(value)
      const rename = (id: string) => key.startsWith('dashboard.bt.stubDraft.')
        ? id.replace(/EnrollFace/g, 'EnrollPerson') : TARGETS[id] ?? id
      // Existing canonical entries win over stale aliases if both are present.
      for (const [id, flags] of entries.sort(([a], [b]) => Number(rename(a) === a) - Number(rename(b) === b))) {
        let migrated = flags
        if (key === 'dashboard.control.selectedFlags' && flags && typeof flags === 'object' && !Array.isArray(flags)) {
          const fields = { ...flags } as Record<string, unknown>
          if ('real_face_recognition' in fields) {
            if (!('real_person_face' in fields)) fields.real_person_face = fields.real_face_recognition
            delete fields.real_face_recognition
          }
          migrated = fields
        }
        result[rename(id)] = migrated
      }
      changed = result
    }
    const serialized = JSON.stringify(changed)
    if (serialized !== raw) {
      if (storage.getItem(key + '.beforeNamingV1') === null) storage.setItem(key + '.beforeNamingV1', raw)
      storage.setItem(key, serialized)
    }
  }
  storage.setItem(marker, 'done')
}
