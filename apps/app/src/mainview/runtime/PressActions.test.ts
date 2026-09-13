import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { bindPressActions, createPressActions } from './PressActions'

GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const setup = () => {
  const win = window
  win.document.body.innerHTML = '<main><button aria-keyshortcuts="t">Tutorial</button><button aria-keyshortcuts="h">Help</button><input /></main>'
  const root = win.document.querySelector('main')!
  const buttons = [...root.querySelectorAll('button')]
  const calls: string[] = []
  for (const button of buttons) button.addEventListener('click', () => calls.push(button.textContent!))
  cleanup.push(() => root.remove())
  const stop = bindPressActions({ root: root as unknown as HTMLElement, resolveShortcut: event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const button = buttons.find(button => button.getAttribute('aria-keyshortcuts') === event.key)
    return button ? { element: button as unknown as HTMLElement, activate: () => button.click() } : undefined
  } })
  cleanup.push(stop)
  const key = (type: string, key: string, init = {}, target = win.document as any) => target.dispatchEvent(new win.KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init }))
  const pointer = (type: string, target: any, id = 1) => target.dispatchEvent(new win.PointerEvent(type, { button: 0, pointerId: id, bubbles: true, cancelable: true }))
  return { win, root, buttons, calls, stop, key, pointer }
}

test('only the final release wins, independent of press order; repeat downs cannot replace it', () => {
  const held = createPressActions(), calls: string[] = []
  held.down('t', { activate: () => calls.push('t') })
  held.down('h', { activate: () => calls.push('h') })
  held.down('h', { activate: () => calls.push('repeat') })
  held.up('h')
  expect(calls).toEqual([])
  held.up('t')
  held.up('t')
  expect(calls).toEqual(['t'])
})

test('held keys highlight their own controls and intermediate release cannot activate', () => {
  const { key, buttons, calls } = setup()
  key('keydown', 't'); key('keydown', 'h'); key('keydown', 'h', { repeat: true })
  expect(buttons.map(b => b.hasAttribute('data-pressed'))).toEqual([true, true])
  expect(calls).toEqual([])
  key('keyup', 't')
  expect(buttons.map(b => b.hasAttribute('data-pressed'))).toEqual([false, true])
  expect(calls).toEqual([])
  key('keyup', 'h')
  expect(calls).toEqual(['Help'])
  expect(buttons.every(b => !b.hasAttribute('data-pressed'))).toBe(true)
})

test('pointer and key holds share arbitration; synthesized mouse click cannot activate twice', () => {
  const { win, key, pointer, buttons, calls } = setup()
  pointer('pointerdown', buttons[0]); key('keydown', 'h')
  pointer('pointerup', buttons[0])
  buttons[0]!.dispatchEvent(new win.MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }))
  expect(calls).toEqual([])
  key('keyup', 'h')
  expect(calls).toEqual(['Help'])
  pointer('pointerdown', buttons[0]); pointer('pointerup', buttons[0])
  buttons[0]!.dispatchEvent(new win.MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }))
  expect(calls).toEqual(['Help', 'Tutorial'])
})

test('release outside the original button cancels even over another held control', () => {
  const { key, pointer, buttons, calls } = setup()
  pointer('pointerdown', buttons[0]); key('keydown', 'h')
  key('keyup', 'h'); pointer('pointerup', buttons[1])
  expect(calls).toEqual([])
  expect(buttons.every(b => !b.hasAttribute('data-pressed'))).toBe(true)
})

for (const reason of ['blur', 'pointercancel', 'unmount', 'Tab', 'Escape', 'compositionstart', 'focus']) test(`${reason} cancels all held inputs`, () => {
  const { win, key, pointer, buttons, calls, stop } = setup()
  key('keydown', 't'); pointer('pointerdown', buttons[1])
  if (reason === 'blur') win.dispatchEvent(new win.Event('blur'))
  else if (reason === 'pointercancel') pointer('pointercancel', buttons[1])
  else if (reason === 'Tab' || reason === 'Escape') key('keydown', reason)
  else if (reason === 'compositionstart') win.document.dispatchEvent(new win.Event('compositionstart'))
  else if (reason === 'focus') win.document.querySelector('input')!.focus()
  else stop()
  key('keyup', 't'); pointer('pointerup', buttons[1])
  expect(calls).toEqual([])
  expect(buttons.every(b => !b.hasAttribute('data-pressed'))).toBe(true)
})

test('native Enter and Space wait for release; text editing and modified shortcuts stay native', () => {
  const { root, buttons, key, calls } = setup()
  for (const value of ['Enter', ' ']) {
    key('keydown', value, {}, buttons[0])
    expect(buttons[0]!.hasAttribute('data-pressed')).toBe(true)
    key('keyup', value, {}, buttons[0])
  }
  expect(calls).toEqual(['Tutorial', 'Tutorial'])
  key('keydown', 't', {}, root.querySelector('input')); key('keyup', 't')
  key('keydown', 't', { ctrlKey: true }); key('keyup', 't')
  key('keydown', 't', { repeat: true }); key('keyup', 't')
  expect(calls).toEqual(['Tutorial', 'Tutorial'])
})


test('two inputs on the same button keep it highlighted until both are released', () => {
  const { key, pointer, buttons, calls } = setup()
  key('keydown', 't'); pointer('pointerdown', buttons[0])
  key('keyup', 't')
  expect(buttons[0]!.hasAttribute('data-pressed')).toBe(true)
  expect(calls).toEqual([])
  pointer('pointerup', buttons[0])
  expect(buttons[0]!.hasAttribute('data-pressed')).toBe(false)
  expect(calls).toEqual(['Tutorial'])
})

test('a landing link used as the binding root supports shortcut, Enter, and pointer release', () => {
  const link = document.createElement('a')
  link.href = '/app'
  document.body.append(link)
  let calls = 0
  link.addEventListener('click', event => { event.preventDefault(); calls++ })
  const stop = bindPressActions({ root: link, resolveShortcut: event => event.key === 's' ? { element: link, activate: () => link.click() } : undefined })
  cleanup.push(() => { stop(); link.remove() })
  for (const key of ['s', 'Enter']) {
    link.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    expect(link.hasAttribute('data-pressed')).toBe(true)
    link.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
    expect(link.hasAttribute('data-pressed')).toBe(false)
  }
  expect(calls).toBe(2)
  link.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true }))
  expect(calls).toBe(2)
  link.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, bubbles: true }))
  link.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }))
  expect(calls).toBe(3)
})
