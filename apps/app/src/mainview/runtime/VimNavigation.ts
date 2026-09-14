import type { PressAction } from './PressActions'

/** Spatial focus navigation; text fields keep ordinary h/j/k/l editing. */
export function vimFocusAction(root: HTMLElement, key: string): PressAction | undefined {
  if (!['h', 'j', 'k', 'l'].includes(key)) return
  const doc = root.ownerDocument
  if ((doc.activeElement as Element | null)?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return
  const candidates = [...root.querySelectorAll<HTMLElement>('button,a[href],[role="button"],[role="link"]')]
    .filter(node => node.tabIndex >= 0 && !node.closest('[inert],[hidden],[aria-hidden="true"]') && !node.matches(':disabled,[aria-disabled="true"]'))
    .filter(node => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden' })
  const current = candidates.find(node => node === doc.activeElement)
  let next: HTMLElement | undefined
  if (!current) next = key === 'h' || key === 'k' ? candidates.at(-1) : candidates[0]
  else {
    const from = current.getBoundingClientRect(), vertical = key === 'j' || key === 'k', sign = key === 'h' || key === 'k' ? -1 : 1
    const ranked = candidates.filter(node => node !== current).map(node => {
      const to = node.getBoundingClientRect()
      const dx = to.x + to.width / 2 - from.x - from.width / 2, dy = to.y + to.height / 2 - from.y - from.height / 2
      const along = (vertical ? dy : dx) * sign, across = Math.abs(vertical ? dx : dy)
      return { node, along, score: along + across * 2 }
    }).filter(item => item.along > 1).sort((a, b) => a.score - b.score)
    next = ranked[0]?.node
  }
  return next ? { element: next, activate: () => { next?.focus(); next?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } } : undefined
}
