/** A gesture highlights on down; only the last outstanding input may activate on up. */
export type PressAction = { element?: HTMLElement; activate: () => void }

export function createPressActions() {
  const held = new Map<string, PressAction>()
  const paint = (element?: HTMLElement) => {
    if (element) element.toggleAttribute("data-pressed", [...held.values()].some(action => action.element === element))
  }
  return {
    down(id: string, action: PressAction) {
      if (held.has(id)) return
      held.set(id, action)
      paint(action.element)
    },
    up(id: string, valid = true) {
      const action = held.get(id)
      if (!action) return false
      held.delete(id)
      paint(action.element)
      if (valid && held.size === 0) action.activate()
      return true
    },
    cancel() {
      const elements = [...held.values()].map(action => action.element)
      held.clear()
      elements.forEach(paint)
    },
  }
}

const editing = 'input:not([type="checkbox"]), textarea, select, [contenteditable]:not([contenteditable="false"])'
const control = 'button, a[href]'
const available = (element: HTMLElement) => !element.closest('[inert], [aria-hidden="true"]') && !element.matches(':disabled, [aria-disabled="true"]')

/** Delegate native button clicks and shortcuts through one release arbiter. */
export function bindPressActions({ root, resolveShortcut, enabled = () => true }: {
  root: HTMLElement
  resolveShortcut: (event: KeyboardEvent) => PressAction | undefined
  enabled?: () => boolean
}) {
  const doc = root.ownerDocument
  const held = createPressActions()
  let activating = false
  const pointers = new Map<number, HTMLElement>()
  const buttonAction = (element: HTMLElement): PressAction => ({ element, activate: () => {
    if (!element.isConnected || !available(element)) return
    activating = true
    try { element.click() } finally { activating = false }
  } })
  const buttonAt = (target: EventTarget | null) => {
    const element = (target as Element | null)?.closest?.<HTMLElement>(control)
    return element && root.contains(element) && available(element) ? element : undefined
  }
  const keyId = (event: KeyboardEvent) => `key:${event.code || event.key.toLowerCase()}`
  const down = (event: KeyboardEvent) => {
    if (!enabled() || event.defaultPrevented || event.isComposing) return
    if (event.key === 'Tab') return held.cancel()
    const button = buttonAt(event.target)
    const native = button && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'Enter' || (event.key === ' ' && button.tagName === 'BUTTON'))
    const action = native ? buttonAction(button) : (event.target as Element | null)?.closest?.(editing) && !event.metaKey && !event.ctrlKey && event.key !== 'Escape' ? undefined : resolveShortcut(event)
    if (!action) {
      if (event.key === 'Escape') held.cancel()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) held.down(keyId(event), action)
  }
  const up = (event: KeyboardEvent) => {
    if (held.up(keyId(event), enabled() && !event.isComposing)) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  const pointerDown = (event: PointerEvent) => {
    if (!enabled() || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const button = buttonAt(event.target)
    if (button) {
      pointers.set(event.pointerId, button)
      held.down(`pointer:${event.pointerId}`, buttonAction(button))
    }
  }
  const pointerUp = (event: PointerEvent) => {
    if (event.button !== 0) return
    // A release outside the original control cancels it, even if it is the last input.
    const button = buttonAt(event.target)
    const actionId = `pointer:${event.pointerId}`
    const original = pointers.get(event.pointerId)
    pointers.delete(event.pointerId)
    held.up(actionId, enabled() && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && original !== undefined && original === button)
  }
  const pointerCancel = () => { pointers.clear(); held.cancel() }
  const click = (event: MouseEvent) => {
    if (!activating && enabled() && event.detail > 0 && buttonAt(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  const cancel = pointerCancel
  const focus = (event: FocusEvent) => {
    if ((event.target as Element | null)?.closest?.(editing)) cancel()
  }
  const visibility = () => { if (doc.visibilityState === 'hidden') cancel() }
  doc.addEventListener('keydown', down, true)
  doc.addEventListener('keyup', up, true)
  doc.addEventListener('pointerdown', pointerDown, true)
  doc.addEventListener('pointerup', pointerUp, true)
  doc.addEventListener('pointercancel', pointerCancel, true)
  doc.addEventListener('click', click, true)
  doc.addEventListener('visibilitychange', visibility)
  doc.addEventListener('compositionstart', cancel)
  doc.addEventListener('focusin', focus)
  doc.defaultView?.addEventListener('blur', cancel)
  doc.defaultView?.addEventListener('pagehide', cancel)
  return () => {
    cancel()
    doc.removeEventListener('keydown', down, true)
    doc.removeEventListener('keyup', up, true)
    doc.removeEventListener('pointerdown', pointerDown, true)
    doc.removeEventListener('pointerup', pointerUp, true)
    doc.removeEventListener('pointercancel', pointerCancel, true)
    doc.removeEventListener('click', click, true)
    doc.removeEventListener('visibilitychange', visibility)
    doc.removeEventListener('compositionstart', cancel)
    doc.removeEventListener('focusin', focus)
    doc.defaultView?.removeEventListener('blur', cancel)
    doc.defaultView?.removeEventListener('pagehide', cancel)
  }
}
