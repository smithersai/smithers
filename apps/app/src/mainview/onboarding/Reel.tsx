import { useCallback } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { guideClock, type GuideClock } from "./advance"
import { GUIDE_LAST_STEP } from "./lessons"
import { REEL_BUTTON, REEL_STAGES, dispatchReelDemo, playReelChime, scheduleReel, type ReelDispatch, type ReelState } from "./reel.ts"

/** Standalone projection: the parent supplies durable state and the shared dispatcher. */
export function Reel({ index, epoch = 0, demo, dispatch, playSound = playReelChime }: {
  index: number; epoch?: number; demo?: string; dispatch: ReelDispatch; clock?: GuideClock
  reducedMotion?: boolean; playSound?: () => void
}) {
  const stage = REEL_STAGES[index]
  const mount = useCallback((node: HTMLElement | null) => {
    if (!node || !stage) return
    node.focus()
    dispatchReelDemo(stage.demo, dispatch, playSound)
    return scheduleReel({ target: node.ownerDocument, root: node,
      advance: () => dispatch("reel-next", `${epoch}:${index}`), exit: () => dispatch("reel-exit") })
  }, [stage, index, epoch, dispatch, playSound])
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
    <button className="guide-primary" data-flow="onboarding.act" aria-keyshortcuts="ArrowRight" onClick={() => dispatch("reel-next", `${epoch}:${index}`)}>{index === REEL_STAGES.length - 1 ? "Finish" : "Next"} <kbd className="guide-button-key">→</kbd></button>
    <button className="guide-primary" data-flow="onboarding.act" aria-keyshortcuts="Escape ArrowLeft" onClick={() => dispatch("reel-exit")}>Back <kbd className="guide-button-key">Esc</kbd></button>
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

  }, [controller, guide?.reelSeen])
  if (guide?.step !== GUIDE_LAST_STEP) return null
  if (guide.reelIndex !== undefined) return <Reel index={guide.reelIndex} epoch={guide.reelEpoch} demo={guide.reelDemo} dispatch={dispatch} clock={clock} />
  return <><button className="guide-primary" data-flow="onboarding.act" onClick={() => dispatch("finish")}>Finish tutorial</button>
  <button ref={launchRef} className="guide-primary" style={{ border: "1px solid currentColor", borderRadius: 999 }} data-flow="tut.more" aria-keyshortcuts={REEL_BUTTON.key.toLowerCase()} onClick={() => controller.runCommand(REEL_BUTTON.command)}>
    {REEL_BUTTON.label} <kbd className="guide-button-key" aria-hidden="true">{REEL_BUTTON.key}</kbd>
  </button></>
}
