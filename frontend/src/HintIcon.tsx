interface Props {
  text: string
}

// A small "?" badge carrying a longer explanation via the native title
// tooltip - for text you only need explained once. Prefer this over an
// always-visible paragraph: the surrounding UI stays terse, and the
// fuller explanation is still one hover away for whoever actually wants it.
export default function HintIcon({ text }: Props) {
  return (
    <span
      title={text}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '1.05rem',
        height: '1.05rem',
        borderRadius: '50%',
        border: '1px solid var(--text-dim)',
        color: 'var(--text-dim)',
        fontSize: '0.7rem',
        lineHeight: 1,
        cursor: 'help',
        flexShrink: 0,
      }}
    >
      ?
    </span>
  )
}
