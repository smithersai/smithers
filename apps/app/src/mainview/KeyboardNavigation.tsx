import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { bindKeyboardInput, type KeyboardHint } from './runtime/KeyboardInput'
import './KeyboardNavigation.css'

/** Transient focus and prefix hints; the input-mode preference stays in the session collection. */
export function KeyboardNavigation() {
  const [hint, setHint] = useState<KeyboardHint>()
  const mount = useCallback((node: HTMLSpanElement | null) => {
    if (!node) return
    return bindKeyboardInput(node.closest<HTMLElement>('.session-shell') ?? node.ownerDocument.body, setHint)
  }, [])
  return <><span ref={mount} hidden />{hint && createPortal(<>
    <div className="keyboard-hints" data-prefix={hint.prefix} role="status" aria-live="polite" aria-atomic="true">
      {hint.prefix !== 'off' ? <>
        <strong>{hint.prefix === 'numbers' ? 'Choose a pane' : hint.prefix === 'help' ? 'Vim and pane shortcuts' : 'Ctrl B — next key'}</strong>
        <span><kbd>← ↓ ↑ →</kbd> / <kbd>h j k l</kbd> move</span>
        <span><kbd>o</kbd> next pane · <kbd>;</kbd> previous pane</span>
        <span><kbd>q</kbd> pane numbers · <kbd>?</kbd> help · <kbd>Esc</kbd> cancel</span>
        {hint.prefix === 'help' && <>
          <span><kbd>Esc</kbd> normal · <kbd>i a I A</kbd> insert · <kbd>v</kbd> select</span>
          <span><kbd>h j k l</kbd> / arrows · <kbd>w b e</kbd> words · <kbd>0 ^ $</kbd> line</span>
          <span><kbd>gg G</kbd> first / last line · <kbd>o O</kbd> open line</span>
          <span><kbd>d c y</kbd> + motion: delete / change / copy · <kbd>dd cc yy</kbd> line</span>
          <span><kbd>x</kbd> delete · <kbd>r</kbd> replace · <kbd>p P</kbd> paste · <kbd>u</kbd> undo · <kbd>Ctrl R</kbd> redo</span>
          <span><kbd>Tab</kbd> next control · <kbd>Shift Tab</kbd> previous · <kbd>Enter</kbd> activate</span>
        </>}
        {hint.prefix === 'numbers' && <span>{hint.panes.slice(0, 10).map(pane => <span className="keyboard-pane-choice" key={pane.index}><kbd>{pane.index}</kbd> {pane.label}</span>)}</span>}
      </> : <>
        <strong>VIM {hint.mode?.toUpperCase() ?? 'NAVIGATION'}{hint.pending ? ` · ${hint.pending}` : ''}</strong>
        <span>{hint.mode === 'insert' ? <><kbd>Esc</kbd> normal</> : hint.mode === 'visual' ? <><kbd>h j k l</kbd> select · <kbd>y</kbd> copy · <kbd>d</kbd> delete · <kbd>Esc</kbd> normal</>
          : hint.mode === 'normal' ? <><kbd>i</kbd> insert · <kbd>v</kbd> select · <kbd>u</kbd> undo</>
          : <><kbd>h j k l</kbd> controls · <kbd>Tab</kbd> next · <kbd>Enter</kbd> select</>}</span>
        <span><kbd>Ctrl B</kbd> panes</span>
      </>}
    </div>
    {hint.prefix === 'numbers' && hint.panes.slice(0, 10).map(pane => <div className="keyboard-pane-number" aria-hidden="true" key={pane.index}
      style={{ left: pane.x, top: pane.y }}><kbd>{pane.index}</kbd> {pane.label}</div>)}
  </>, hint.portal)}</>
}
