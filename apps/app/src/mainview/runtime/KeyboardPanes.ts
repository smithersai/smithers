export const PANE = '[data-keyboard-pane]'
export const EDITABLE = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])'
const CONTROLS = 'button,a[href],input,textarea,select,[tabindex],[contenteditable="true"]'

export function visible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"]') || element.matches(':disabled,[aria-disabled="true"]')) return false
  const rect = element.getBoundingClientRect(), style = element.ownerDocument.defaultView!.getComputedStyle(element)
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
}

/** Native modal dialogs retain their focus boundary. The Vim chat dock is nonmodal. */
export function keyboardScope(root: HTMLElement): HTMLElement {
  return [...root.ownerDocument.querySelectorAll<HTMLElement>('dialog[open],[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]')]
    .filter(node => node.getAttribute('aria-modal') !== 'false' && visible(node)).at(-1) ?? root
}

export function panesIn(root: HTMLElement): HTMLElement[] {
  const scope = keyboardScope(root)
  const panes = [...scope.querySelectorAll<HTMLElement>(PANE)].filter(visible)
  return panes.length ? panes : visible(scope) ? [scope] : []
}

export function controlsIn(pane: HTMLElement): HTMLElement[] {
  return [...pane.querySelectorAll<HTMLElement>(CONTROLS)].filter(node => (node.tabIndex >= 0 || node.matches('[role="option"]')) && visible(node)
    && !(node.matches(EDITABLE) && node.closest('[data-keyboard-skip-fields]'))
    && (node.closest(PANE) === pane || !pane.matches(PANE)))
}

export function paneAt(root: HTMLElement, target: Element | null): HTMLElement | undefined {
  const panes = panesIn(root)
  return panes.find(pane => pane === target?.closest(PANE)) ?? panes.find(pane => target && pane.contains(target))
}

/** Prefer panes in the same row/column before reaching diagonally. */
export function adjacentPane(panes: HTMLElement[], current: HTMLElement | undefined, key: string): HTMLElement | undefined {
  if (!current) return panes[0]
  const from = current.getBoundingClientRect()
  const vertical = ['j', 'k', 'ArrowDown', 'ArrowUp'].includes(key)
  const sign = ['h', 'k', 'ArrowLeft', 'ArrowUp'].includes(key) ? -1 : 1
  return panes.filter(pane => pane !== current).map(pane => {
    const to = pane.getBoundingClientRect()
    const dx = to.x + to.width / 2 - from.x - from.width / 2
    const dy = to.y + to.height / 2 - from.y - from.height / 2
    const overlap = vertical ? to.left < from.right && to.right > from.left : to.top < from.bottom && to.bottom > from.top
    return { pane, along: (vertical ? dy : dx) * sign, score: Math.abs(vertical ? dy : dx) + Math.abs(vertical ? dx : dy) * 2 + (overlap ? 0 : 10000) }
  }).filter(item => item.along > 1).sort((a, b) => a.score - b.score)[0]?.pane
}

export function focusPane(pane: HTMLElement, remembered?: HTMLElement, focus = focusControl): void {
  const controls = controlsIn(pane)
  // Browsers can focus overflow containers implicitly. Restore a real control,
  // so returning to a list never strands the keyboard on its scroll wrapper.
  const target = remembered && controls.includes(remembered) ? remembered
    : controls.find(node => node.matches('textarea,input,[contenteditable="true"],[aria-selected="true"]')) ?? controls[0] ?? pane
  focus(target)
}

export function focusControl(target: HTMLElement): void {
  if (!target.matches(CONTROLS)) {
    target.tabIndex = -1
    target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true })
  }
  target.focus({ preventScroll: true })
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
