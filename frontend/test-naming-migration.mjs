import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

const source = fs.readFileSync(new URL('./src/namingMigration.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { migrateNamingPreferences } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const values = new Map([
  ['dashboard.control.selectedFlags', JSON.stringify({ face_recognition_node: { gpu: true }, person_face: { gpu: false }, hri_bt_main: { real_face_recognition: true } })],
  ['dashboard.control.expandedTargets', JSON.stringify(['audio_vad', 'identity_fusion'])],
  ['dashboard.bt.stubDraft.hri_challenge', JSON.stringify({ 'root/EnrollFace_1': 'succeed' })],
  ['dashboard.authToken', 'keep-token'],
])
const storage = {
  get length() { return values.size }, key: i => [...values.keys()][i] ?? null,
  getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
}
migrateNamingPreferences(storage)
const flags = JSON.parse(values.get('dashboard.control.selectedFlags'))
assert.equal(flags.person_face.gpu, false)
assert.equal(flags.hri_bt_main.real_person_face, true)
assert.ok(!('face_recognition_node' in flags))
assert.deepEqual(JSON.parse(values.get('dashboard.control.expandedTargets')), ['speech_vad', 'person_identity'])
assert.equal(JSON.parse(values.get('dashboard.bt.stubDraft.hri_challenge'))['root/EnrollPerson_1'], 'succeed')
assert.equal(values.get('dashboard.authToken'), 'keep-token')
assert.ok(values.has('dashboard.control.selectedFlags.beforeNamingV1'))
const once = JSON.stringify([...values])
migrateNamingPreferences(storage)
assert.equal(JSON.stringify([...values]), once)
console.log('Naming preference migration: canonical conflicts, flags, stubs, backups, auth and idempotence passed')
