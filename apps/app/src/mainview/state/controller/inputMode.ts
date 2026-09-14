import { dictationAvailable } from './dictation'
import type { Actor } from '../AppState'
import type { AppStore } from '../AppStore'
import type { InputMode } from '../InputMode'

/** A preference never starts capture; the human's later Chat gesture opts in. */
export function createInputModeController(store: AppStore, effects: {
  dictationAvailable?: () => boolean
  actor: () => Actor
  cancelDictation: () => void
  startDictation: () => string | void
  openChat: () => Promise<void>
}) {
  const available = effects.dictationAvailable ?? dictationAvailable
  return {
    async setInputMode(mode: InputMode) {
      if (mode === 'dictation' && !available()) mode = 'normal'
      if (mode !== 'dictation') effects.cancelDictation()
      await store.dispatch({ type: 'input.mode.changed', actor: effects.actor(), mode }).isPersisted.promise
    },
    async openChat() {
      if (store.session().inputMode === 'dictation' && !available()) {
        effects.cancelDictation()
        await store.dispatch({ type: 'input.mode.changed', actor: effects.actor(), mode: 'normal' }).isPersisted.promise
      }
      await effects.openChat()
      if (store.session().paletteOpen === true && store.session().inputMode === 'dictation' && !store.session().dictating) return effects.startDictation()
    },
  }
}
