import type { ControllerContext } from "../state/controller/context"
import { initialGuide, type GuideState } from "../state/AppState"
import { GUIDE_LAST_STEP } from "./lessons"
import { REEL_STAGES, type ReelState } from "./reel.ts"
import { guideClock, type GuideClock } from "./advance"

/** Called by onboarding.act, never by a React state setter. Practice stays in guide. */
export function createReelController(ctx: ControllerContext, clock: GuideClock = guideClock) {
  let waitTimer: unknown
  const stopWait = () => { if (waitTimer !== undefined) clock.clearTimeout(waitTimer); waitTimer = undefined }
  ctx.onDispose?.(stopWait)
  const armWait = (guide: GuideState & ReelState) => {
    const run = guide.demoRun, epoch = guide.reelEpoch
    if (guide.reelIndex === undefined || !run || run.status !== "running" || waitTimer !== undefined) return
    waitTimer = clock.setTimeout(() => {
      waitTimer = undefined
      const current: GuideState & ReelState = { ...(ctx.store.session().guide ?? initialGuide()) }
      if (current.reelEpoch !== epoch || current.demoRun?.id !== run.id || current.demoRun.status !== "running") return
      current.demoRun = { ...current.demoRun, status: "succeeded", finishedAt: Date.now() }
      ctx.store.dispatch({ type: "guide.changed", actor: "smithers", guide: current })
      ctx.store.dispatch({ type: "toast.resolved", actor: "system", key: run.id, status: "ok", title: "Done", detail: "The example flow finished. Your repository was not touched." })
    }, Math.max(0, 5000 - (Date.now() - run.startedAt)))
  }
  armWait(ctx.store.session().guide ?? initialGuide())
  const act = async (action: string, value: string): Promise<boolean> => {
    if (!action.startsWith("reel-")) return false
    const guide: GuideState & ReelState = { ...(ctx.store.session().guide ?? initialGuide()) }
    const persist = () => ctx.store.dispatch({ type: "guide.changed", actor: "smithers", guide }).isPersisted.promise
    const restore = async () => {
      if (guide.reelTheme) {
        await ctx.store.dispatch({ type: "theme.changed", actor: "system", theme: guide.reelTheme }).isPersisted.promise
        delete guide.reelTheme
      }
      guide.conversationOpen = false
      delete guide.reelDemo
    }
    const finish = async () => {
      await restore(); stopWait()
      if (guide.demoRun?.status === "running") {
        const key = guide.demoRun.id
        guide.demoRun = { ...guide.demoRun, status: "interrupted", finishedAt: Date.now() }
        ctx.store.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", title: "Example wait interrupted", detail: "You left the reel before the example flow finished." })
      }
      delete guide.reelIndex
      guide.step = GUIDE_LAST_STEP
    }
    if (action === "reel-start") {
      if (guide.step !== GUIDE_LAST_STEP || guide.reelIndex !== undefined) return true
      guide.reelSeen = true; guide.reelIndex = 0; guide.reelEpoch = (guide.reelEpoch ?? 0) + 1
      guide.conversationOpen = false
    } else if (action === "reel-exit") {
      if (guide.reelIndex === undefined) return true
      await finish()
    } else if (action === "reel-next") {
      if (guide.reelIndex === undefined || value !== `${guide.reelEpoch ?? 0}:${guide.reelIndex}`) return true
      await restore()
      if (guide.reelIndex + 1 >= REEL_STAGES.length) { await finish(); guide.finished = true }
      else guide.reelIndex++
    } else if (action === "reel-demo") {
      if (guide.reelIndex === undefined || REEL_STAGES[guide.reelIndex]?.demo !== value || guide.reelDemo === value) return true
      guide.reelDemo = value
      if (value === "theme") {
        guide.reelTheme = ctx.store.session().theme
        await ctx.store.dispatch({ type: "theme.changed", actor: "system", theme: guide.reelTheme === "dark" ? "light" : "dark" }).isPersisted.promise
      } else if (value === "notify") {
        const key = `reel-notify-${crypto.randomUUID()}`
        ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title: "I can send notifications" })
        ctx.store.dispatch({ type: "toast.resolved", actor: "system", key, status: "ok", title: "You can keep working", detail: "This is a tutorial notification." })
      } else if (value === "composer") guide.conversationOpen = true
      else if (value === "wait") {
        stopWait()
        const key = `reel-wait-${crypto.randomUUID()}`
        guide.demoRun = { id: key, status: "running", startedAt: Date.now() }
        ctx.store.dispatch({ type: "toast.shown", actor: "system", key, title: "Waiting 5 seconds…" })
        armWait(guide)
      }
    } else return false
    await persist()
    return true
  }
  // Mount, instant-motion advance and user exit can arrive before persistence settles.
  let queue: Promise<unknown> = Promise.resolve()
  return (action: string, value: string) => {
    const next = queue.then(() => act(action, value))
    queue = next.catch(() => {})
    return next
  }
}
