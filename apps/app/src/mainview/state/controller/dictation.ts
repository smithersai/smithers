import type { AppStore } from "../AppStore"
import { conversationTabIdOf } from "../AppState"

/** The small browser speech boundary; injected in tests without a microphone. */
export interface DictationRecognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
const recognitionConstructor = () => {
  const host = globalThis as typeof globalThis & {
    SpeechRecognition?: new () => DictationRecognition
    webkitSpeechRecognition?: new () => DictationRecognition
  }
  return host.SpeechRecognition ?? host.webkitSpeechRecognition
}
export const DICTATION_UNAVAILABLE = "Dictation needs a browser with speech recognition"
export const dictationAvailable = (): boolean => recognitionConstructor() !== undefined
export const browserRecognition = (): DictationRecognition | undefined => {
  const Recognition = recognitionConstructor()
  return Recognition ? new Recognition() : undefined
}

export function createDictation(store: AppStore, create = browserRecognition) {
  let active: DictationRecognition | undefined
  const status = (listening: boolean) => {
    store.dispatch({ type: "dictation.changed", actor: "user", listening })
  }
  // A microphone session never survives a reload.
  if (store.session().dictating) status(false)
  const cancel = () => {
    const recognition = active
    active = undefined
    if (!recognition) return
    recognition.onresult = recognition.onerror = recognition.onend = null
    try { recognition.abort() } catch { /* An ended recognizer may already be closed. */ }
    status(false)
  }
  const toggle = (): string | void => {
    if (active) {
      try { active.stop() } catch { cancel() }
      return
    }
    let recognition: DictationRecognition | undefined
    try { recognition = create() } catch { return "Dictation could not start. Check your microphone settings." }
    if (!recognition) return "Dictation is unavailable in this browser. Use your device’s dictation in the Chat text field."
    const current = recognition
    const conversation = conversationTabIdOf(store.session())
    active = current
    current.continuous = false
    current.interimResults = false
    current.lang = typeof navigator === "undefined" ? "en-US" : navigator.language
    current.onresult = (event) => {
      if (active !== current) return
      if (conversationTabIdOf(store.session()) !== conversation) { cancel(); return }
      const words: string[] = []
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result?.isFinal) words.push(result[0].transcript)
      }
      const text = words.join(" ").trim()
      if (!text) return
      const draft = store.session().draft
      store.dispatch({ type: "composer.changed", actor: "user", draft: `${draft}${draft && !/\s$/.test(draft) ? " " : ""}${text}` })
    }
    current.onend = () => {
      if (active !== current) return
      active = undefined
      status(false)
    }
    current.onerror = ({ error }) => {
      if (active !== current) return
      cancel()
      if (error === "aborted") return
      const title = error === "not-allowed" || error === "service-not-allowed"
        ? "Microphone access was denied. Allow microphone access to use dictation."
        : error === "no-speech" ? "No speech was heard. Try dictation again."
        : "Dictation stopped. Check your microphone and connection, then try again."
      store.dispatch({ type: "toast.shown", actor: "system", key: "dictation-error", title })
      store.dispatch({ type: "toast.resolved", actor: "system", key: "dictation-error", status: "failed", detail: title })
    }
    try { status(true); current.start() }
    catch { cancel(); return "Dictation could not start. Check your microphone settings." }
  }
  return { toggle, cancel }
}
