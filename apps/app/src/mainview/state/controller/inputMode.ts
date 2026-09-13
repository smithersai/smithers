import type { Actor } from '../AppState'
import type { AppStore } from '../AppStore'
import type { InputMode } from '../InputMode'

/** A preference never starts capture; the human's later Chat gesture opts in. */
export function createInputModeController(store: AppStore, effects: {
  actor: () => Actor
  cancelDictation: () => void
  startDictation: () => string | void
  openChat: () => Promise<void>
}) {
  return {
    async setInputMode(mode: InputMode) {
      if (mode !== 'dictation') effects.cancelDictation()
      await store.dispatch({ type: 'input.mode.changed', actor: effects.actor(), mode }).isPersisted.promise
    },
    async openChat() {
      await effects.openChat()
      if (store.session().inputMode === 'dictation' && !store.session().dictating) return effects.startDictation()
    },
  }
}
