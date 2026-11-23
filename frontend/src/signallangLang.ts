import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { StreamParser } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

// Kept in sync by hand with signallang's own source, not generated -
// re-check against these if the language grows:
//   parser.py's _KEYWORDS (statement-level keywords)
//   expr.py's _FUNCTIONS (builtins) / _CONSTANTS (pi/e/true/false)
const KEYWORDS = new Set([
  'var', 'if', 'else', 'repeat', 'for', 'in', 'send', 'hz', 'dur', 'inf',
  'default', 'live', 'return', 'timer', 'latching_timer', 'reset', 'msg',
  'static', 'rand_walk', 'brown_motion', 'seed', 'wait', 'func',
])
// Word-form logical operators (expr.py's _and/_or/_not) - not in parser.py's
// _KEYWORDS since they're expr.py's own tokens, not statement-level ones,
// but they read as keywords to anyone writing a script.
const LOGICAL_OPS = new Set(['and', 'or', 'not'])
const CONSTANTS = new Set(['pi', 'e', 'true', 'false'])
// Bare identifiers that are meaningful without being reserved keywords -
// the global tick counter and its live-block-local counterpart.
const SPECIAL_VARS = new Set(['t', '_t'])

interface State {
  afterDot: boolean
}

const signallangParser: StreamParser<State> = {
  startState: () => ({ afterDot: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null

    if (stream.match('//')) {
      stream.skipToEnd()
      state.afterDot = false
      return 'comment'
    }

    // No escape sequences in a signallang string literal - a bare run to
    // the closing quote (or end of line, for an unterminated one).
    if (stream.match(/^"[^"\n]*"?/)) {
      state.afterDot = false
      return 'string'
    }

    // A duration/tick literal (10s, 500ms, 3m, 10t) or a plain number -
    // the unit suffix has to be checked longest-first (ms before s/m)
    // exactly like signallang's own lexer, so ".ms" isn't split wrong.
    if (stream.match(/^\d+(\.\d+)?(ms|s|m|t)?\b/)) {
      state.afterDot = false
      return 'number'
    }

    if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_]*/)) {
      const word = stream.current()
      const wasAfterDot = state.afterDot
      state.afterDot = false
      if (wasAfterDot) return 'propertyName' // .shift/.scale/.s/.reset/... or an object field
      // `live` gets its own tag (controlKeyword), not lumped in with the
      // rest of `keyword` - it's the one construct that makes a field
      // reactive, worth being visually distinct on its own.
      if (word === 'live') return 'controlKeyword'
      if (KEYWORDS.has(word)) return 'keyword'
      if (LOGICAL_OPS.has(word)) return 'keyword'
      if (CONSTANTS.has(word)) return 'atom'
      if (SPECIAL_VARS.has(word)) return 'atom'
      // Only an actual call site (immediately followed by '(' or '!(')
      // gets the function color - matching the identifier's *name*
      // against the builtin list isn't enough, since a builtin name is
      // ordinary field-path text everywhere else (`linear.x = 1;` on a
      // Twist message is a field write, not a call to the `linear()`
      // builtin, even though the name collides). This also naturally
      // covers macro calls (`ramp(...)`), since the same rule - "an
      // identifier directly followed by a call" - is the only way
      // either kind of call is ever written.
      // 'variableName.function' (dotted modifier syntax) resolves to
      // tags.function(tags.variableName) - the bare string 'function'
      // does NOT work here, since tags.function is a modifier *function*,
      // not a plain named tag, so it never auto-resolves by name.
      if (stream.match(/^\s*!?\s*(?=\()/, false)) return 'variableName.function'
      return 'variableName'
    }

    if (stream.match('!')) {
      state.afterDot = false
      return 'operatorKeyword' // bang-call sugar (linear!(...), rand_walk!(...))
    }

    if (stream.match('.')) {
      state.afterDot = true
      return 'derefOperator'
    }

    if (stream.match(/^(==|!=|<=|>=|&&|\|\|)/)) {
      state.afterDot = false
      return 'compareOperator'
    }

    if (stream.match(/^[+\-*/%<>=]/)) {
      state.afterDot = false
      return 'arithmeticOperator'
    }

    if (stream.match(/^[{}()[\],;:]/)) {
      state.afterDot = false
      return 'punctuation'
    }

    stream.next()
    state.afterDot = false
    return null
  },
}

export const signallangLanguage = StreamLanguage.define(signallangParser)

// Matched to the app's own dark palette (styles.css :root), not a canned
// theme - keywords/bang-sugar in --accent (the same blue used for links/
// buttons elsewhere), strings in --ok, numbers/durations in --warn,
// comments dimmed via --text-dim.
export const signallangHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--accent)', fontWeight: 600 },
  // `live` - deliberately its own color, not the shared keyword blue.
  { tag: t.controlKeyword, color: '#c586c0', fontWeight: 600 },
  { tag: t.operatorKeyword, color: 'var(--accent)', fontWeight: 600 },
  // Builtins (sin/linear/terop/...) and macro calls (ramp(...), from a
  // known `func` declaration) - anything callable gets this color,
  // deliberately distinct from plain identifiers (t.variableName below).
  { tag: t.function(t.variableName), color: '#dcdcaa' },
  { tag: t.atom, color: 'var(--warn)' },
  { tag: t.number, color: 'var(--warn)' },
  { tag: t.string, color: 'var(--ok)' },
  { tag: t.comment, color: 'var(--text-dim)', fontStyle: 'italic' },
  { tag: t.propertyName, color: 'var(--text)' },
  { tag: t.derefOperator, color: 'var(--text-dim)' },
  { tag: t.compareOperator, color: 'var(--text-dim)' },
  { tag: t.arithmeticOperator, color: 'var(--text-dim)' },
  { tag: t.punctuation, color: 'var(--text-dim)' },
  { tag: t.variableName, color: 'var(--text)' },
])

// Editor chrome (background/border/caret/selection/gutter) matched to
// .terminal-pane's own colors so the script box reads as part of the same
// family of panels, not a foreign widget dropped into the page.
export const signallangEditorTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: '#0c0d10',
      color: 'var(--text)',
      border: '1px solid var(--border)',
      borderRadius: '6px',
      fontSize: '0.82rem',
    },
    '.cm-content': { fontFamily: 'ui-monospace, monospace', caretColor: 'var(--text)' },
    '.cm-gutters': {
      backgroundColor: '#0c0d10',
      color: 'var(--text-dim)',
      border: 'none',
      borderRight: '1px solid var(--border)',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(76, 141, 255, 0.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(76, 141, 255, 0.1)' },
    '&.cm-focused': { outline: '1px solid var(--accent)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(76, 141, 255, 0.25) !important',
    },
    '.cm-matchingBracket': { backgroundColor: 'rgba(76, 141, 255, 0.25)', outline: 'none' },
  },
  { dark: true },
)

export const signallangSetup = [
  signallangLanguage,
  syntaxHighlighting(signallangHighlightStyle),
  signallangEditorTheme,
]
