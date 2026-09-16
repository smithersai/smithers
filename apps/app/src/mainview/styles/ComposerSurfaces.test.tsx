import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll,expect,test } from 'bun:test'
import { readFileSync } from 'node:fs'

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const cards = read('./cards.css'), mode = read('../InputModeMenu.css')

test('palette and Mode use the opaque house surface, independent of blur', () => {
  expect(cards).toMatch(/\.slash-menu\s*\{[^}]*background:\s*var\(--surface\);/)
  expect(mode).toMatch(/\.input-mode-menu\s*\{[^}]*background:\s*var\(--surface\);/)
})
