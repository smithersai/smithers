import { expect, test } from 'bun:test'
import { createAppStore } from '../AppStore'
import { createInputModeController } from './inputMode'

test('mode persists without opening Chat; only the next Chat gesture starts dictation', async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  const store = await createAppStore({ kind: 'localStorage', storage })
  let opens = 0, starts = 0, cancels = 0
  const modes = createInputModeController(store, {
    actor: () => 'user', openChat: async () => { opens++; store.dispatch({ type: 'palette.toggled', actor: 'user', open: true }) },
    startDictation: () => { starts++; store.dispatch({ type: 'dictation.changed', actor: 'user', listening: true }) },
    cancelDictation: () => { cancels++; store.dispatch({ type: 'dictation.changed', actor: 'user', listening: false }) },
  })
  expect(store.session().inputMode).toBe('normal')
  await modes.setInputMode('dictation')
  expect({ opens, starts, cancels }).toEqual({ opens: 0, starts: 0, cancels: 0 })
  await modes.openChat()
  await modes.openChat()
  expect({ opens, starts }).toEqual({ opens: 2, starts: 1 })
  await modes.setInputMode('vim')
  expect(store.session().dictating).toBe(false)
  await modes.openChat()
  expect(starts).toBe(1)
  expect(cancels).toBe(1)
  await store.dispose?.()
  const restored = await createAppStore({ kind: 'localStorage', storage })
  expect(restored.session().inputMode).toBe('vim')
  await restored.dispose?.()
})

test('closing Chat while its open persists cannot start the microphone later', async () => {
  const store = await createAppStore({ kind: 'localStorage', storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  let finish!: () => void, starts = 0
  const pending = new Promise<void>(resolve => { finish = resolve })
  const modes = createInputModeController(store, {
    actor: () => 'user', cancelDictation: () => {}, startDictation: () => { starts++ },
    openChat: async () => { store.dispatch({ type: 'palette.toggled', actor: 'user', open: true }); await pending },
  })
  await modes.setInputMode('dictation')
  const opening = modes.openChat()
  store.dispatch({ type: 'palette.toggled', actor: 'user', open: false })
  finish(); await opening
  expect(starts).toBe(0)
  await store.dispose?.()
})
