import { useCallback } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { guideClock, type GuideClock } from "./advance"
import { GUIDE_LAST_STEP } from "./lessons"
import { REEL_BUTTON, REEL_STAGES, dispatchReelDemo, playReelChime, scheduleReel, type ReelDispatch, type ReelState } from "./reel.ts"

/** Standalone projection: the parent supplies durable state and the shared dispatcher. */
export function Reel({ index, epoch = 0, demo, dispatch, clock = guideClock, reducedMotion, playSound = playReelChime }: {
  index: number; epoch?: number; demo?: string; dispatch: ReelDispatch; clock?: GuideClock
  reducedMotion?: boolean; playSound?: () => void
}) {
  const stage = REEL_STAGES[index]
  const mount = useCallback((node: HTMLElement | null) => {
    if (!node || !stage) return
    node.focus()
    dispatchReelDemo(stage.demo, dispatch, playSound)
    return scheduleReel({ target: node.ownerDocument, copy: stage.message, clock,
      reduced: reducedMotion ?? globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
      advance: () => dispatch("reel-next", `${epoch}:${index}`), exit: () => dispatch("reel-exit") })
  }, [stage, index, epoch, dispatch, clock, reducedMotion, playSound])
  if (!stage) return null
  return <section aria-label="What else Smithers can do" data-reel-stage={index} tabIndex={-1} ref={mount}>
    <article className="guide-message" aria-live="polite"><p>{stage.message}</p>
      {/* A read-only example of a form: nothing is submitted, so it is not a <form>. */}
      {demo === "profile" && <div role="group" aria-label="Optional profile example">
        <label>How did you find Smithers?<input readOnly value="" /></label>
        <label>What do you want to build?<textarea readOnly value="" /></label>
      </div>}
      {demo === "create-flow" && <pre>Wait 5 seconds.</pre>}
      {["prototype", "revision", "plan", "review"].includes(demo ?? "") && <div aria-label="Local practice example">
        {demo === "prototype" ? "A little room for big ideas" : demo === "revision" ? "Our next big idea" : demo === "plan" ? "Change the heading → check → review" : <><del>A little room for big ideas</del> → <ins>Our next big idea</ins></>}
      </div>}
    </article>
    <button className="guide-primary" data-flow="onboarding.act" onClick={() => dispatch("reel-exit")}>Back <kbd className="guide-button-key">Esc</kbd></button>
  </section>
}

/** Mount beside GuideShell's transcript; composer and toast hosts remain mounted. */
export function ReelShell({ clock = guideClock }: { clock?: GuideClock }) {
  const controller = useController()
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const guide = sessions[0]?.guide as (ReelState & { step: number }) | undefined
  const dispatch = useCallback<ReelDispatch>((action, value) => {
    controller.runCommand("onboarding.act", `${action}${value === undefined ? "" : ` ${JSON.stringify(value)}`}`)
  }, [controller])
  const launchRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return
    if (guide?.reelSeen) node.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== REEL_BUTTON.key.toLowerCase()) return
      if ((event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable="true"]')) return
      event.preventDefault(); controller.runCommand(REEL_BUTTON.command)
    }
    node.ownerDocument.addEventListener("keydown", keydown)
    return () => node.ownerDocument.removeEventListener("keydown", keydown)
  }, [controller, guide?.reelSeen])
  if (guide?.step !== GUIDE_LAST_STEP) return null
  if (guide.reelIndex !== undefined) return <Reel index={guide.reelIndex} epoch={guide.reelEpoch} demo={guide.reelDemo} dispatch={dispatch} clock={clock} />
  return <button ref={launchRef} className="guide-primary" style={{ border: "1px solid currentColor", borderRadius: 999 }} data-flow="tut.more" aria-keyshortcuts={REEL_BUTTON.key.toLowerCase()} onClick={() => controller.runCommand(REEL_BUTTON.command)}>
    {REEL_BUTTON.label} <kbd className="guide-button-key" aria-hidden="true">{REEL_BUTTON.key}</kbd>
  </button>
}
