// Shared by TargetsConfigEditor/TreesConfigEditor and SettingsModal - lets
// the modal (which owns closing and section-switching) check "does the
// currently active editor have unsaved changes" and trigger its save,
// without needing to lift the editor's own state up into the modal.
export interface ConfigEditorHandle {
  isDirty: () => boolean
  save: () => Promise<boolean>
}
