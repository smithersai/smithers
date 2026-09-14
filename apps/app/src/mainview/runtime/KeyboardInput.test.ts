import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { bindKeyboardInput, type KeyboardHint } from './KeyboardInput'
import { focusPane } from './KeyboardPanes'

GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()) })
function fixture() {
  const win = window
  const doc = win.document
  doc.body.innerHTML = '<main><nav data-keyboard-pane="Sidebar"><button>One</button><button>Two</button></nav><section data-keyboard-pane="Conversation"><button>Read</button><input value="title"></section><section data-keyboard-pane="Chat"><textarea>hello world</textarea></section><section data-keyboard-pane="Hidden" hidden><button>Hidden</button></section></main>'
  const root = doc.querySelector('main')! as unknown as HTMLElement
  const panes = [...root.querySelectorAll<HTMLElement>('[data-keyboard-pane]')]
  const place = (node: HTMLElement, x: number, y: number, width = 200, height = 180) => {
    node.getBoundingClientRect = () => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }) as DOMRect
  }
  panes.forEach((pane, n) => { place(pane, n === 0 ? 0 : 220, n === 2 ? 200 : 0); [...pane.children].forEach((child, index) => place(child as HTMLElement, n === 0 ? 0 : 220, n === 2 ? 200 : index * 40, 180, 30)) })
  let hint: KeyboardHint
  const stop = bindKeyboardInput(root, state => { hint = state })
  cleanups.push(() => { stop(); root.remove() })
  const key = (key: string, options: Record<string, unknown> = {}) => {
    const target = doc.activeElement ?? doc.body
    const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
    target.dispatchEvent(event)
    target.dispatchEvent(new win.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...options }))
    return event
  }
  const prefix = (next: string) => { key('b', { ctrlKey: true }); key(next) }
  return { win, doc, root, panes, place, key, prefix, hint: () => hint!, stop }
}

test('pane prefix leaves text intact, remembers focus, shows numbers, and skips hidden panes', () => {
  const f = fixture(), input = f.root.querySelector('textarea')!
  input.focus(); input.setSelectionRange(5, 5)
  f.key('b', { ctrlKey: true })
  expect(f.hint().prefix).toBe('command')
  f.key('ArrowUp')
  expect(f.doc.activeElement).toBe(f.panes[1]!.querySelector('input') as any)
  f.prefix(';')
  expect(f.doc.activeElement).toBe(input as any)
  expect(input.selectionStart).toBe(5)
  expect(input.value).toBe('hello world')
  f.prefix('q')
  expect(f.hint().panes.map(pane => pane.label)).toEqual(['Sidebar', 'Conversation', 'Chat'])
  f.key('0')
  expect(f.doc.activeElement?.textContent).toBe('One')
  f.key('j')
  expect(f.doc.activeElement?.textContent).toBe('Two')
  f.prefix('o'); f.prefix(';')
  expect(f.doc.activeElement?.textContent).toBe('Two')
})

test('Vim editing dispatches native input updates, keeps selection and never calls shell shortcuts', () => {
  const f = fixture(), input = f.root.querySelector('textarea')!
  let shells = 0, saved = ''
  f.doc.addEventListener('keydown', () => shells++)
  input.addEventListener('input', () => { saved = input.value })
  input.focus(); input.setSelectionRange(0, 0)
  f.key('Escape'); f.key('w'); f.key('d'); f.key('w')
  expect(saved).toBe('hello ')
  expect(f.hint().mode).toBe('normal')
  expect(f.doc.activeElement).toBe(input as any)
  expect(shells).toBe(0)
  f.key('u')
  expect(input.value).toBe('hello world')
  f.key('0'); f.key('v'); f.key('l')
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 2])
  f.key('Escape'); f.key('i')
  expect(f.key('x').defaultPrevented).toBe(false)
  expect(shells).toBe(1)
})

test('prefix cancellation, repeat, composition and cleanup do not leave stuck shortcuts', () => {
  const f = fixture(), input = f.root.querySelector('textarea')!
  input.focus()
  f.key('b', { ctrlKey: true }); f.key('b', { ctrlKey: true, repeat: true })
  expect(f.hint().prefix).toBe('command')
  f.key('Escape'); expect(f.hint().prefix).toBe('off')
  f.key('b', { ctrlKey: true }); f.key('Process', { isComposing: true })
  expect(f.hint().prefix).toBe('off')
  f.key('b', { ctrlKey: true })
  expect(f.key('b', { ctrlKey: true }).defaultPrevented).toBe(false)
  f.key('b', { ctrlKey: true }); f.win.dispatchEvent(new f.win.Event('blur'))
  expect(f.hint().prefix).toBe('off')
  f.stop()
  expect(f.key('b', { ctrlKey: true }).defaultPrevented).toBe(false)
  expect(input.hasAttribute('data-vim-mode')).toBe(false)
})

test('a modal dialog contains pane navigation and a terminal retains unprefixed keys', () => {
  const f = fixture()
  const dialog = f.doc.createElement('dialog')
  dialog.setAttribute('open', ''); dialog.innerHTML = '<section data-keyboard-pane="Confirm"><button>Cancel</button></section>'
  f.root.append(dialog as unknown as HTMLElement)
  f.place(dialog as unknown as HTMLElement, 20, 20)
  for (const node of dialog.querySelectorAll('*')) f.place(node as unknown as HTMLElement, 20, 20)
  dialog.querySelector('button')!.focus()
  f.prefix('q'); expect(f.hint().panes.map(pane => pane.label)).toEqual(['Confirm'])
  f.key('0'); f.prefix('h')
  expect(f.doc.activeElement?.textContent).toBe('Cancel')
  dialog.remove()
  const input = f.root.querySelector('textarea')!
  input.parentElement!.className = 'xterm'; input.focus()
  expect(f.key('Escape').defaultPrevented).toBe(false)
  expect(f.key('h').defaultPrevented).toBe(false)
  f.prefix('o')
  expect(f.doc.activeElement?.textContent).toBe('One')
})

test('returning to a list restores an option instead of an implicitly focused scroller', () => {
  const f = fixture(), pane = f.panes[1]!
  pane.innerHTML = '<div tabindex="-1"><button role="option" tabindex="-1" aria-selected="true">First</button><button role="option" tabindex="-1">Second</button></div>'
  const wrapper = pane.firstElementChild as HTMLElement
  for (const node of pane.querySelectorAll<HTMLElement>('*')) f.place(node, 220, 0)
  focusPane(pane, wrapper)
  expect(f.doc.activeElement?.textContent).toBe('First')
})

test('the unnamed copy register works between independent text buffers', () => {
  const f = fixture(), first = f.root.querySelector('textarea')!, second = f.root.querySelector('input')!
  first.focus(); first.setSelectionRange(0, 0)
  f.key('Escape'); f.key('y'); f.key('w')
  second.focus(); second.setSelectionRange(0, 0)
  f.key('Escape'); f.key('P')
  expect(second.value).toBe('hello title')
  expect(first.value).toBe('hello world')
})
