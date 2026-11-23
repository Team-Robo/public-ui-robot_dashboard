import { CSSProperties } from 'react'
import * as RadixSelect from '@radix-ui/react-select'

// Headless (unstyled by default) Radix primitive, styled entirely below with
// this app's own CSS variables - used instead of a plain <select> wherever a
// dropdown's own popup/arrow-box coloring actually matters. A native <select>
// looked fine everywhere the closed box itself is what's visible (kind,
// etc.), but its dropdown popup AND the little arrow-box next to it are
// rendered by the browser/OS, not this page - color-scheme/option CSS
// couldn't fully reach either one (confirmed live, several attempts, one
// browser/OS combo still showed native chrome regardless). Radix renders
// its whole popup as real DOM instead of native OS chrome, so there's
// nothing left uncontrollable to fight.
export interface DropdownOption {
  value: string
  label: string
}

interface DropdownProps {
  value: string
  onChange: (value: string) => void
  options: DropdownOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
  // Applied to the trigger button - e.g. width, matching how every other
  // form control in this app is sized inline rather than via a dedicated
  // class per width.
  style?: CSSProperties
  // Shown as the first, empty-value choice (e.g. "None" for a flag with an
  // implicit no-selection state) - omit for a dropdown that must always
  // have a real value chosen.
  emptyLabel?: string
}

// Radix forbids an empty-string Item value outright (it reserves ""
// internally for "nothing selected") - this app's own convention for "no
// selection" on a flag IS the empty string throughout (flag_values, the
// plain <select> this replaces, etc.), so that convention is kept at this
// component's own boundary and translated to/from a sentinel only for
// Radix's benefit, invisibly to every caller.
const EMPTY_SENTINEL = '__dropdown_none__'

export default function Dropdown({ value, onChange, options, placeholder, disabled, className, style, emptyLabel }: DropdownProps) {
  // Select.Value's displayed text normally comes from having already
  // rendered the matching Item at least once - Items live inside Content,
  // which (by design, see Radix docs) isn't mounted at all until the popup
  // has been opened, so a freshly-added flag's closed trigger could show
  // blank instead of "None"/its real label until opened once. Resolving
  // the text explicitly here and passing it as children sidesteps that
  // entirely - always correct from the very first render.
  const currentLabel = value === '' ? emptyLabel : options.find((o) => o.value === value)?.label
  return (
    <RadixSelect.Root
      value={value === '' ? EMPTY_SENTINEL : value}
      onValueChange={(v) => onChange(v === EMPTY_SENTINEL ? '' : v)}
      disabled={disabled}
    >
      <RadixSelect.Trigger className={`dropdown-trigger${className ? ` ${className}` : ''}`} style={style}>
        <RadixSelect.Value placeholder={placeholder}>{currentLabel}</RadixSelect.Value>
        <RadixSelect.Icon className="dropdown-arrow">▾</RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="dropdown-content" position="popper" sideOffset={4}>
          <RadixSelect.Viewport>
            {emptyLabel !== undefined && (
              <RadixSelect.Item value={EMPTY_SENTINEL} className="dropdown-item">
                <RadixSelect.ItemText>{emptyLabel}</RadixSelect.ItemText>
              </RadixSelect.Item>
            )}
            {options.map((opt) => (
              <RadixSelect.Item key={opt.value} value={opt.value} className="dropdown-item">
                <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
