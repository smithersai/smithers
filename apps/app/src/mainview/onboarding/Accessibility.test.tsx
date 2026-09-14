import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, expect, test, spyOn } from 'bun:test'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import App from '../App'
import { ControllerTestProvider } from '../ControllerContext'
import { SessionNavigation } from '../SessionNavigation'
import { createAppController } from '../state/AppController'
import { createAppStore } from '../state/AppStore'
import { initialGuide } from '../state/AppState'
import { memoryStorage, nativeRepositories, silentAgent } from '../state/TestFixtures'
import { GuideShell } from './GuideShell'
import { PRACTICE_REPO } from '../state/practice/PracticeRepository'

GlobalRegistrator.register()
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
afterAll(async () => { await settle(); await GlobalRegistrator.unregister() })
const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}) } }
const press = async (key: string, target: EventTarget = document) => {
  for (const type of ['keydown', 'keyup']) flushSync(() => (type === 'keyup' && target !== document ? document.activeElement ?? target : target).dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true })))
  await settle()
}
async function mount(step = 1) {
  const store = await createAppStore({ kind: 'localStorage', storage: memoryStorage() })
  const controller = createAppController(store, nativeRepositories, silentAgent)
  await store.dispatch({ type: 'guide.changed', actor: 'user', guide: { ...initialGuide(), step } }).isPersisted.promise
  const host = document.createElement('div')
  host.className = 'session-shell'
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ControllerTestProvider controller={controller}><SessionNavigation /><GuideShell clock={{ setTimeout: () => 1, clearTimeout: () => {} }}><App /></GuideShell></ControllerTestProvider>))
  cleanups.push(async () => { flushSync(() => root.unmount()); host.remove(); await settle(); await controller.dispose() })
  await settle()
  return { host, store, controller }
}

function speech() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'SpeechRecognition')
  let aborted = 0
  class Recognition {
    onend?: () => void
    start() {}
    abort() { aborted++ }
    stop() { this.onend?.() }
  }
  Object.defineProperty(globalThis, 'SpeechRecognition', { configurable: true, value: Recognition })
  cleanups.push(() => { if (previous) Object.defineProperty(globalThis, 'SpeechRecognition', previous); else Reflect.deleteProperty(globalThis, 'SpeechRecognition') })
  return () => aborted
}

test('unsupported Dictation is explained and cannot be selected; Chat opens normally', async () => {
  const { host, store } = await mount()
  await press('m')
  const option = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(node => node.textContent?.includes('Dictation'))!
  expect(option.getAttribute('aria-disabled')).toBe('true')
  expect(document.getElementById(option.getAttribute('aria-describedby')!)?.textContent).toBe('Dictation needs a browser with speech recognition')
  flushSync(() => option.click())
  await settle()
  expect(store.session().inputMode).toBe('normal')
  await press('Escape')
  await press('c')
  expect(store.session().paletteOpen).toBe(true)
  expect([...store.collections.toasts.values()].some(toast => toast.title.includes("didn't run"))).toBe(false)
})

test('dictation Tab reaches Stop, Shift+Tab returns to the composer, and Escape releases capture before closing Chat', async () => {
  const aborted = speech()
  const { host, store, controller } = await mount()
  controller.runCommand('input.mode', 'dictation')
  await settle()
  await press('c')
  const input = host.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!
  const stop = host.querySelector<HTMLButtonElement>('.guide-dictation-stop')!
  expect(stop.getAttribute('aria-keyshortcuts')).toBe('Escape')
  input.focus()
  await press('Tab', input)
  expect(document.activeElement?.className).toContain('guide-dictation-stop')
  flushSync(() => stop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })))
  expect(document.activeElement?.getAttribute('data-testid')).toBe('composer-input')
  await press('Escape', input)
  expect(aborted()).toBe(1)
  expect(store.session().dictating).toBe(false)
  expect(host.querySelector('[role="listbox"]')).toBeNull()
  expect(store.session().guide?.conversationOpen).toBe(false)
})

test('Escape dismisses Chat together with its root palette and preserves the draft', async () => {
  const { host, store, controller } = await mount()
  await press('c')
  controller.changeDraft('hello from a phone')
  await settle()
  const input = host.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!
  input.focus()
  await press('Escape', input)
  expect(store.session().guide?.conversationOpen).toBe(false)
  expect(host.querySelector('dialog')!.open).toBe(false)
  expect(store.session().draft).toBe('hello from a phone')
})

test('Chat has a modal boundary and makes the tutorial and footer inert; Mode remains inside', async () => {
  const { host } = await mount()
  await press('c')
  const dialog = host.querySelector('[role="dialog"][aria-label="Chat"]')!
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(dialog.closest('dialog')!.open).toBe(true)
  expect(host.querySelector('.guide-content')?.hasAttribute('inert')).toBe(true)
  expect(host.querySelector('.guide-footer')?.hasAttribute('inert')).toBe(true)
  expect(dialog.querySelector('[aria-haspopup="menu"]')).not.toBeNull()
  await press('Escape')
  expect(host.querySelector('.guide-content')?.hasAttribute('inert')).toBe(false)
})

test('Enter on dictation Stop ends capture and returns focus to the open Chat composer', async () => {
  speech()
  const { host, store, controller } = await mount()
  controller.runCommand('input.mode', 'dictation')
  await settle()
  await press('c')
  const input = host.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!
  expect(store.session().dictating).toBe(true)
  await press('Tab', input)
  const stop = host.querySelector<HTMLButtonElement>('.guide-dictation-stop')!
  expect(document.activeElement).toBe(stop)
  await press('Enter', stop)
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  expect(store.session().dictating).toBe(false)
  expect(host.querySelector('.guide-dictation-stop')).toBeNull()
  expect(store.session().guide?.conversationOpen).toBe(true)
  expect(document.activeElement).toBe(input)
})

test('composer exposes the palette and its moving selection to assistive technology', async () => {
  const { host } = await mount()
  await press('c')
  const input = host.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!
  const list = host.querySelector('[role="listbox"]')!
  expect(input.getAttribute('role')).toBe('combobox')
  expect(input.getAttribute('aria-controls')).toBe(list.id)
  expect(input.getAttribute('aria-expanded')).toBe('true')
  expect(input.getAttribute('aria-activedescendant')).toBe(list.querySelector('[aria-selected="true"]')!.id)
  const before = input.getAttribute('aria-activedescendant')
  await press('ArrowDown', input)
  expect(input.getAttribute('aria-activedescendant')).not.toBe(before)
  expect(input.getAttribute('aria-activedescendant')).toBe(list.querySelector('[aria-selected="true"]')!.id)
  expect([...list.querySelectorAll<HTMLElement>('[role="option"]')].every(option => option.tabIndex === -1)).toBe(true)
})

test('practice issue has one projection and wordmark references only an existing sidebar', async () => {
  const { host, controller } = await mount(3)
  controller.runCommand('issues.list', `open ${PRACTICE_REPO}`)
  await settle()
  controller.runCommand('issues.view', `3 ${PRACTICE_REPO}`)
  await settle()
  const fields = host.querySelectorAll('textarea[id^="ghc-comment-"]')
  expect(fields.length).toBe(1)
  const ids = [...host.querySelectorAll('[id]')].map(node => node.id)
  expect(ids.length).toBe(new Set(ids).size)
  expect(host.querySelectorAll('nav[aria-label="Frame history"]').length).toBe(1)
  expect(host.querySelectorAll('aside[aria-label="Issue #3 details"]').length).toBe(1)
  for (const node of host.querySelectorAll('[aria-controls]')) expect(document.getElementById(node.getAttribute('aria-controls')!)).not.toBeNull()
  await press('w')
  expect(host.querySelector('[aria-controls="session-sidebar"]')).not.toBeNull()
  expect(host.querySelector('#session-sidebar')).not.toBeNull()
  controller.runCommand('input.mode', 'vim')
  await settle()
  const comment = fields[0] as HTMLTextAreaElement
  comment.focus()
  await press('Escape', comment)
  expect(document.activeElement?.className).toBe('guide-shell')
  await press('m')
  expect(host.querySelector('[role="menu"]')).not.toBeNull()
})

test('tutorial sounds report new completions once, including goal ticks, and stay quiet on navigation and toggles', async () => {
  let chimes = 0
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext')
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class { constructor() { chimes++ } resume() { return new Promise(() => {}) } } })
  cleanups.push(() => { if (previous) Object.defineProperty(globalThis, 'AudioContext', previous); else Reflect.deleteProperty(globalThis, 'AudioContext') })
  const { controller } = await mount()
  await press('s')
  expect(chimes).toBe(0)
  await controller.guideAct('signal', 'issues.opened'); await settle()
  expect(chimes).toBe(1)
  await controller.guideAct('signal', 'issues.opened'); await settle()
  expect(chimes).toBe(1)
  await press('ArrowRight')
  expect(chimes).toBe(1)
  await controller.guideAct('signal', 'issue.opened'); await settle()
  expect(chimes).toBe(2)
  await press('b'); await press('s')
  expect(chimes).toBe(2)
})

for (const [label, action] of [['Finish tutorial', 'finish'], ['Replay introduction', 'restart']]) {
  test(`${label} advertises a distinct shortcut that runs its action`, async () => {
    const { host, controller } = await mount(14)
    const calls: unknown[] = []
    const spy = spyOn(controller, 'runCommand').mockImplementation((...args) => { calls.push(args); return true })
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')]
    const finish = buttons.find(node => node.textContent?.includes('Finish tutorial'))!
    const replay = buttons.find(node => node.textContent?.includes('Replay introduction'))!
    const button = label === 'Finish tutorial' ? finish : replay
    expect(finish.getAttribute('aria-keyshortcuts')).toBeTruthy()
    expect(replay.getAttribute('aria-keyshortcuts')).toBeTruthy()
    expect(finish.getAttribute('aria-keyshortcuts')).not.toBe(replay.getAttribute('aria-keyshortcuts'))
    await press(button.getAttribute('aria-keyshortcuts')!)
    expect(calls).toContainEqual(['onboarding.act', action])
    spy.mockRestore()
  })
}

test('touch tutorial copy names the controls instead of physical keys', async () => {
  const media = spyOn(globalThis, 'matchMedia').mockImplementation(query => ({ matches: query.includes('pointer: coarse'), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList)
  cleanups.push(() => media.mockRestore())
  const { host } = await mount(13)
  const message = host.querySelector('[data-message-step="13"]')?.textContent ?? ''
  expect(message).toContain('tap Chat')
  expect(message).toContain('Tap Mode')
  expect(message).not.toMatch(/press|H\/J\/K\/L/i)
})

test('the keyboard-scrollable transcript has an explicit visible focus outline', async () => {
  const style = document.createElement('style')
  style.textContent = await Bun.file(new URL('./guide.css', import.meta.url)).text()
  document.head.append(style)
  cleanups.push(() => style.remove())
  const { host } = await mount()
  const log = host.querySelector<HTMLElement>('.guide-transcript')!
  log.focus()
  // Happy DOM does not evaluate :focus-visible, so apply that selector to the focused log.
  style.textContent = style.textContent.replaceAll('.guide-transcript:focus-visible', '.guide-transcript:focus')
  expect(getComputedStyle(log).outlineStyle).toBe('solid')
  expect(getComputedStyle(log).outlineWidth).toBe('2px')
})
