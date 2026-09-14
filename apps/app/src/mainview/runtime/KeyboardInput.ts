import { createVimBuffer, nextVimCharacter, vimKey, type VimBuffer, type VimMode } from './VimBuffer'
import { adjacentPane, controlsIn, EDITABLE, focusControl, focusPane, keyboardScope, paneAt, panesIn, visible } from './KeyboardPanes'

export type KeyboardHint = {
  prefix: 'off' | 'command' | 'numbers' | 'help'
  mode?: VimMode
  pending?: string
  panes: { label: string; index: number; x: number; y: number }[]
  portal: HTMLElement
}
type Field = HTMLInputElement | HTMLTextAreaElement
const textField = (target: Element | null): Field | undefined => {
  if (!target?.matches('textarea,input')) return
  const field = target as Field
  if (field.closest('.xterm,[data-vim-native]') || field.disabled || field.readOnly || field.selectionStart === null) return
  return field
}
const consume = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation() }

/** One capture boundary precedes shell shortcuts and React input handlers. */
export function bindKeyboardInput(root: HTMLElement, onHint: (hint: KeyboardHint) => void) {
  const doc = root.ownerDocument, win = doc.defaultView!
  const buffers = new WeakMap<Field, VimBuffer>()
  const remembered = new WeakMap<HTMLElement, HTMLElement>()
  let current: HTMLElement | undefined, previous: HTMLElement | undefined
  let prefix: KeyboardHint['prefix'] = 'off'
  let numbered: HTMLElement[] = []
  let markedField: Field | undefined
  const held = new Set<string>()
  let applying = false
  let register = '', linewise = false
  const bufferFor = (field: Field) => {
    let buffer = buffers.get(field)
    if (!buffer) { buffer = createVimBuffer(field.value, field.selectionStart ?? 0); buffers.set(field, buffer) }
    return buffer
  }
  const hint = () => {
    const active = doc.activeElement as HTMLElement | null
    const field = textField(active)
    const buffer = field ? bufferFor(field) : undefined
    if (markedField !== field) markedField?.removeAttribute('data-vim-mode')
    markedField = field
    field?.setAttribute('data-vim-mode', buffer!.mode)
    const next = paneAt(root, active)
    if (next !== current) {
      current?.removeAttribute('data-keyboard-active')
      if (current?.isConnected) previous = current
      current = next
    }
    current?.setAttribute('data-keyboard-active', '')
    if (current && active && current !== active) remembered.set(current, active)
    const scope = keyboardScope(root)
    onHint({ prefix, mode: buffer?.mode, pending: buffer ? buffer.count + buffer.pending : undefined,
      panes: prefix === 'off' ? [] : (prefix === 'numbers' ? numbered.filter(visible) : panesIn(root)).map(pane => {
        const rect = pane.getBoundingClientRect()
        return { label: pane.dataset.keyboardPane ?? pane.getAttribute('aria-label') ?? 'Dialog', index: prefix === 'numbers' ? numbered.indexOf(pane) : panesIn(root).indexOf(pane),
          x: Math.max(8, Math.min(win.innerWidth - 100, rect.left + 8)), y: Math.max(8, Math.min(win.innerHeight - 32, rect.top + 8)) }
      }), portal: scope })
  }
  const cancel = () => { prefix = 'off'; numbered = []; hint() }
  const rovingFocus = (target: HTMLElement) => {
    const field = textField(target)
    // Arriving by navigation never starts typing, including a remembered buffer.
    if (field) vimKey(bufferFor(field), 'Escape')
    focusControl(target)
  }
  const focus = (pane: HTMLElement | undefined) => {
    if (pane && panesIn(root).includes(pane)) focusPane(pane, remembered.get(pane), rovingFocus)
    hint()
  }
  const rove = (event: KeyboardEvent) => {
    const pane = paneAt(root, doc.activeElement)
    if (!pane || !['h', 'j', 'k', 'l'].includes(event.key) || doc.activeElement?.closest('[role="menu"],[role="listbox"],[role="tree"],[role="grid"]')) return false
    consume(event); held.add(event.code || event.key)
    const controls = controlsIn(pane), index = controls.indexOf(doc.activeElement as HTMLElement)
    const delta = event.key === 'h' || event.key === 'k' ? -1 : 1
    const next = controls[Math.max(0, Math.min(controls.length - 1, index + delta))]
    if (next) rovingFocus(next)
    hint()
    return true
  }
  const down = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (event.isComposing || event.key === 'Process' || event.keyCode === 229) return cancel()
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return
    const key = event.key, id = event.code || key
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && key.toLowerCase() === 'b') {
      if (event.repeat) { consume(event); return }
      if (prefix !== 'off') { cancel(); return } // Ctrl+B Ctrl+B sends a literal prefix to a terminal/editor.
      consume(event); held.add(id)
      if (!event.repeat) { prefix = 'command'; hint() }
      return
    }
    if (prefix !== 'off') {
      if (event.metaKey || event.altKey) { cancel(); return }
      consume(event); held.add(id)
      if (event.repeat) return
      if (key === 'Escape') return cancel()
      const panes = panesIn(root), active = paneAt(root, doc.activeElement)
      if (key === 'q' || key === '?') { prefix = key === '?' ? 'help' : 'numbers'; numbered = panes; hint(); return }
      let next: HTMLElement | undefined
      if (prefix === 'numbers' && /^\d$/.test(key)) next = numbered[Number(key)]
      else if (['h', 'j', 'k', 'l', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) next = adjacentPane(panes, active, key)
      else if (key === 'o') next = panes[(panes.indexOf(active!) + 1) % panes.length]
      else if (key === ';') next = previous
      cancel(); focus(next)
      return
    }
    const field = textField(doc.activeElement)
    if (field) {
      if (event.metaKey || event.altKey || (event.ctrlKey && key !== 'r')) return
      const buffer = bufferFor(field)
      buffer.register = register; buffer.linewise = linewise
      if (buffer.value !== field.value) {
        if (buffer.mode !== 'insert') { buffer.undo = []; buffer.redo = [] }
        buffer.value = field.value
      }
      if (buffer.mode !== 'visual') buffer.cursor = field.selectionStart ?? 0
      if (buffer.mode === 'normal' && !buffer.pending && !buffer.count && !event.ctrlKey && !event.shiftKey) {
        if (key === 'Escape') {
          consume(event); held.add(id)
          focusControl(paneAt(root, field) ?? root)
          hint()
          return
        }
        if (rove(event)) return
      }
      const bufferKey = buffer.mode === 'normal' && !buffer.pending && key === 'Enter' ? 'i'
        : field.tagName === 'INPUT' && buffer.mode === 'normal' ? key === 'o' ? 'A' : key === 'O' ? 'I' : key : key
      if (!vimKey(buffer, bufferKey, event.ctrlKey)) return
      register = buffer.register; linewise = buffer.linewise
      consume(event); held.add(id)
      // Native setters bypass React's value tracker; input still runs the field's own flow/onChange.
      if (buffer.value !== field.value) {
        const prototype = field.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, buffer.value)
        applying = true
        try { field.dispatchEvent(new win.Event('input', { bubbles: true })) } finally { applying = false }
      }
      const from = buffer.mode === 'visual' ? Math.min(buffer.anchor, buffer.cursor) : buffer.cursor
      const to = buffer.mode === 'visual' ? nextVimCharacter(buffer.value, Math.max(buffer.anchor, buffer.cursor)) : from
      field.setSelectionRange(from, to, buffer.cursor < buffer.anchor ? 'backward' : 'forward')
      hint()
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    if (doc.activeElement?.closest(EDITABLE) && !doc.activeElement.matches('input[type="checkbox"],input[type="radio"]')) return
    rove(event)
  }
  const up = (event: KeyboardEvent) => {
    if (held.delete(event.code || event.key)) consume(event)
  }
  const input = (event: Event) => {
    if (applying) return
    const field = textField(event.target as Element)
    if (!field) return
    const buffer = bufferFor(field)
    buffer.value = field.value; buffer.cursor = field.selectionStart ?? 0
  }
  const focusIn = () => { if (prefix !== 'off') { prefix = 'off'; numbered = [] } hint() }
  const blur = () => { held.clear(); cancel() }
  const visibility = () => { if (doc.visibilityState === 'hidden') blur() }
  win.addEventListener('keydown', down, true)
  win.addEventListener('keyup', up, true)
  doc.addEventListener('input', input)
  doc.addEventListener('focusin', focusIn)
  doc.addEventListener('pointerdown', cancel, true)
  doc.addEventListener('compositionstart', cancel, true)
  doc.addEventListener('visibilitychange', visibility)
  win.addEventListener('blur', blur)
  win.addEventListener('resize', hint)
  doc.addEventListener('scroll', hint, true)
  hint()
  return () => {
    current?.removeAttribute('data-keyboard-active'); markedField?.removeAttribute('data-vim-mode')
    win.removeEventListener('keydown', down, true)
    win.removeEventListener('keyup', up, true)
    doc.removeEventListener('input', input)
    doc.removeEventListener('focusin', focusIn)
    doc.removeEventListener('pointerdown', cancel, true)
    doc.removeEventListener('compositionstart', cancel, true)
    doc.removeEventListener('visibilitychange', visibility)
    win.removeEventListener('blur', blur)
    win.removeEventListener('resize', hint)
    doc.removeEventListener('scroll', hint, true)
  }
}
