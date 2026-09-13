import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, expect, test } from 'bun:test'
import { vimFocusAction } from './VimNavigation'
GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())

test('Vim moves spatial focus only on activation and leaves editable text alone', () => {
  const root = document.createElement('div')
  document.body.append(root)
  const buttons = [[0, 0], [100, 0], [0, 100], [100, 100]].map(([x, y]) => {
    const button = document.createElement('button')
    button.getBoundingClientRect = () => ({ x, y, left: x, top: y, width: 40, height: 30, right: x! + 40, bottom: y! + 30, toJSON: () => ({}) }) as DOMRect
    root.append(button)
    return button
  })
  buttons[0]!.focus()
  const right = vimFocusAction(root, 'l')!
  expect(right.element).toBe(buttons[1])
  expect(document.activeElement).toBe(buttons[0])
  right.activate()
  expect(document.activeElement).toBe(buttons[1])
  vimFocusAction(root, 'j')!.activate()
  expect(document.activeElement).toBe(buttons[3])
  vimFocusAction(root, 'h')!.activate()
  expect(document.activeElement).toBe(buttons[2])
  vimFocusAction(root, 'k')!.activate()
  expect(document.activeElement).toBe(buttons[0])
  expect(vimFocusAction(root, 'h')).toBeUndefined()
  const input = document.createElement('textarea')
  root.append(input); input.focus()
  expect(vimFocusAction(root, 'j')).toBeUndefined()
  root.remove()
})
