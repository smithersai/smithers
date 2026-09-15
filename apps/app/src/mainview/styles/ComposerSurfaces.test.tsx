import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { SmithersUiStyles } from '@smthrs/ui'
import { ControllerTestProvider } from '../ControllerContext'
import type { AppController } from '../state/AppController'
import { TranscriptMessage } from '../TranscriptMessage'

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const chat = read('./chat.css'), cards = read('./cards.css'), guide = read('../onboarding/guide.css'), mode = read('../InputModeMenu.css')

for (const theme of ['light', 'dark']) test(`user Markdown is readable in the guide transcript (${theme})`, () => {
  const host = document.createElement('div')
  host.className = 'guide-transcript'
  const foreground = theme === 'light' ? '#403f53' : '#eeeeee'
  const background = theme === 'light' ? '#ffffff' : '#101e24'
  host.style.cssText = `--text:${foreground};--inverse-bg:${foreground};--inverse-text:${background};--bubble-outgoing:${foreground};--bubble-outgoing-text:${background}`
  const style = document.createElement('style')
  style.textContent = chat
  document.head.append(style)
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<ControllerTestProvider controller={{} as AppController}>
      <SmithersUiStyles />
      <TranscriptMessage entry={{ kind: 'message', message: { id: 'user', role: 'user', text: 'Hello **Smithers**', status: 'complete', createdAt: 0, ordinal: 1 } }} />
    </ControllerTestProvider>))
    const bubble = getComputedStyle(host.querySelector('.sui-chat-bubble')!)
    // happy-dom resolves explicit `color: inherit` against a lower-priority
    // .sui-md rule instead of the parent. Check the matching cascade contract
    // here; Playwright checks the actual paragraph's computed colour.
    expect(bubble.color).not.toBe(bubble.backgroundColor)
    const markdown = host.querySelector('.message-markdown')!
    const rule = [...style.sheet!.cssRules].find(rule =>
      'selectorText' in rule && (rule as CSSStyleRule).selectorText.includes('.guide-transcript .smithers-chat-message .message-markdown')
      && markdown.matches((rule as CSSStyleRule).selectorText)) as CSSStyleRule
    expect(rule.style.color).toBe('inherit')
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    style.remove()
  }
})

test('palette and Mode use the opaque house surface, independent of blur', () => {
  expect(cards).toMatch(/\.slash-menu\s*\{[^}]*background:\s*var\(--surface\);/)
  expect(mode).toMatch(/\.input-mode-menu\s*\{[^}]*background:\s*var\(--surface\);/)
})

test('coarse pointers give the hint bar space back while the palette preserves transcript space', () => {
  expect(cards).toMatch(/@media\s*\(pointer: coarse\)\s*\{\s*\.palette-foot\s*\{\s*display:\s*none;/)
  const layer = /\.guide-composer-layer\s*\{([^}]*)\}/.exec(guide)![1]!
  expect(layer).not.toContain('40dvh')
  expect(layer).toContain('max-height: min(70dvh, calc(100dvh - var(--g-strip) - 100px));')
  expect(cards).toMatch(/\.slash-menu-item\s*\{[^}]*flex-shrink:\s*0;/)
})

test('Mode has its own nonshrinking row below the palette without negative overlap', () => {
  const palette = /\.guide-composer-layer \.composer-wrap > \.slash-menu\s*\{([^}]*)\}/.exec(guide)![1]!
  expect(palette).not.toMatch(/margin:[^;]*-8px/)
  expect(mode).toMatch(/\.guide-composer-layer > \.input-mode-control\s*\{[^}]*flex-shrink:\s*0;/)
})

test('every repository bubble and Markdown rule also scopes to the guide transcript', () => {
  const selectors = chat.match(/\.smithers-transcript [^{,\n]+/g) ?? []
  const bubbleRules = selectors.filter(selector => /smithers-chat-message|sui-chat-bubble/.test(selector))
  expect(bubbleRules.length).toBeGreaterThan(10)
  for (const selector of bubbleRules) expect(chat.includes(selector.replace('.smithers-transcript', '.guide-transcript'))).toBe(true)
})
