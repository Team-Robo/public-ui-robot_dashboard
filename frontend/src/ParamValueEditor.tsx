interface Props {
  type: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  valid: boolean
  message?: string
}

export default function ParamValueEditor({ type, value, onChange, disabled, valid, message }: Props) {
  if (type === 'bool') {
    return (
      <div className="bool-toggle">
        <button
          type="button"
          className={`bool-btn${value === 'true' ? ' active' : ''}`}
          disabled={disabled}
          onClick={() => onChange('true')}
        >
          true
        </button>
        <button
          type="button"
          className={`bool-btn${value === 'false' ? ' active' : ''}`}
          disabled={disabled}
          onClick={() => onChange('false')}
        >
          false
        </button>
      </div>
    )
  }

  const inputMode: 'numeric' | 'decimal' | 'text' = type === 'integer' ? 'numeric' : type === 'double' ? 'decimal' : 'text'
  const showError = !valid && value.trim() !== ''

  return (
    <div>
      <input
        type="text"
        inputMode={inputMode}
        className={showError ? 'invalid' : ''}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {showError && <div className="input-error">{message}</div>}
    </div>
  )
}
