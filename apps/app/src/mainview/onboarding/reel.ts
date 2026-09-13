import { GUIDE_KEYS } from "./GuideButton"
import { bindPressActions, createPressActions, type PressAction } from "../runtime/PressActions"

/* Bare e opens the optional reel after the tutorial. */
export const REEL_BUTTON = { label: "What else can you do?", command: "tut.more", key: "e" } as const

export const REEL_STAGES = [
  { id: "theme", kind: "say", message: "I can change the theme, and put it back when I'm done.", demo: "theme" },
  { id: "notifications", kind: "say", message: "I can send notifications while you keep working.", demo: "notify" },
  { id: "sound", kind: "say", message: "I can play a little sound when something needs your attention.", demo: "sound" },
  { id: "profile", kind: "say", message: "I can show forms, like these optional questions about what you want to build.", demo: "profile" },
  { id: "wait", kind: "say", message: "I can run a flow and wait for it. This example simply waits; your repository stays untouched.", demo: "wait" },
  { id: "create-flow", kind: "say", message: "I can turn reusable instructions into a flow. Here's the wait example's instruction.", demo: "create-flow" },
  { id: "composer", kind: "say", message: "You can talk directly to me with Command K. I'll open the composer, then close it.", demo: "composer" },
  { id: "prototype", kind: "say", message: "I can show a disposable prototype before implementation. Here's our local practice idea board.", demo: "prototype" },
  { id: "revision", kind: "say", message: "I can revise that prototype from feedback. Watch the practice heading change.", demo: "revision" },
  { id: "plan", kind: "say", message: "I can turn feedback into a plan: change the heading, check it, then review the result.", demo: "plan" },
  { id: "review", kind: "say", message: "I can show changes for review before delivery. This practice review publishes nothing.", demo: "review" },
] as const
export type ReelDemo = typeof REEL_STAGES[number]["demo"]
export type ReelState = { reelSeen?: boolean; reelIndex?: number; reelEpoch?: number; reelDemo?: string; reelTheme?: "light" | "dark" }
export type ReelDispatch = (action: string, value?: string) => void

/** The mounted card invokes the same controller door as slash/agent callers. */
export function dispatchReelDemo(demo: ReelDemo, dispatch: ReelDispatch, playSound: () => void = () => {}) {
  dispatch("reel-demo", demo)
  if (demo === "sound") playSound()
}

/** Each example waits for Next. Escape exits; arrows never interfere with text input. */
export function scheduleReel({ target, root, advance, exit }: {
  target: EventTarget; root?: HTMLElement; advance: () => void; exit: () => void
}) {
  let pending = true
  const resolve = (event: KeyboardEvent): PressAction | undefined => {
    if (!pending || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    if (!["Escape", GUIDE_KEYS.back, "ArrowRight"].includes(event.key)) return
    if (event.key !== "Escape" && (event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable="true"]')) return
    const forward = event.key === 'ArrowRight'
    return { element: root?.querySelector<HTMLElement>(`[aria-keyshortcuts="${forward ? 'ArrowRight' : GUIDE_KEYS.back}"]`) ?? undefined,
      activate: () => { if (!pending) return; pending = false; forward ? advance() : exit() } }
  }
  if (root) {
    const stop = bindPressActions({ root, resolveShortcut: resolve })
    return () => { pending = false; stop() }
  }
  const held = createPressActions()
  const keydown = (raw: Event) => {
    const event = raw as KeyboardEvent, action = resolve(event)
    if (!action) return
    event.preventDefault(); event.stopImmediatePropagation()
    if (!event.repeat) held.down(event.code || event.key, action)
  }
  const keyup = (raw: Event) => {
    const event = raw as KeyboardEvent
    if (held.up(event.code || event.key)) { event.preventDefault(); event.stopImmediatePropagation() }
  }
  const cancel = () => held.cancel()
  target.addEventListener("keydown", keydown, true)
  target.addEventListener("keyup", keyup, true)
  target.addEventListener("blur", cancel)
  return () => { pending = false; held.cancel(); target.removeEventListener("keydown", keydown, true); target.removeEventListener("keyup", keyup, true); target.removeEventListener("blur", cancel) }
}

/** Original three-note interval; the optional reel click is the audio opt-in. */
export function playReelChime() {
  if (typeof AudioContext === "undefined") return
  const audio = new AudioContext()
  void audio.resume().then(() => {
    for (const [i, frequency] of [261.63, 392, 523.25].entries()) {
      const tone = audio.createOscillator(), gain = audio.createGain(), at = audio.currentTime + i * .09
      tone.frequency.value = frequency
      gain.gain.setValueAtTime(.025, at)
      gain.gain.exponentialRampToValueAtTime(.0001, at + .25)
      tone.connect(gain).connect(audio.destination); tone.start(at); tone.stop(at + .3)
      if (i === 2) tone.onended = () => { void audio.close() }
    }
  }).catch(() => { void audio.close() })
}
