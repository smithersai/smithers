import { GUIDE_BRIDGE, GUIDE_LAST_STEP, GUIDE_STAGES } from "../../onboarding/lessons"
import { createReelController } from "../../onboarding/reelController"
import { initialGuide } from "../AppState"
import type { GuideState } from "../AppState"
import { PRACTICE_BRANCH, PRACTICE_CARD, practicePicker } from "../practice/PracticeRepository"
import type { ControllerContext } from "./context"

/** Where the escape hatches land: the ⌘K lesson, which every path still runs. */
const PALETTE_STEP = GUIDE_STAGES.findIndex((stage) => stage.kind === "do" && stage.completion === "palette.opened")

/** Whether an escape hatch took away what a beat needs (login declined, install declined). */
const unreachable = (guide: GuideState, step: number): boolean => {
  const stage = GUIDE_STAGES[step]
  if (stage?.kind !== "do" || stage.requires === undefined) return false
  const declined = guide.declined ?? []
  return stage.requires === "signed-in" ? declined.includes("login") : declined.includes("login") || declined.includes("install")
}
/** The next beat from `step`, stepping over beats an escape hatch made unreachable. */
const forward = (guide: GuideState, step: number): number => {
  let next = Math.min(GUIDE_LAST_STEP, step)
  while (next < GUIDE_LAST_STEP && unreachable(guide, next)) next += 1
  return next
}
const backward = (guide: GuideState, step: number): number => {
  let previous = Math.max(0, step)
  while (previous > 0 && unreachable(guide, previous)) previous -= 1
  return previous
}

/** Durable, replayable onboarding. Practice artifacts never enter repository/run tables. */
export function createGuideController(ctx: ControllerContext) {
  /* The optional capability reel owns its own reducer cases (onboarding/reelController.ts). */
  const reelAct = createReelController(ctx)
  const guideAct = async (action: string, value = ""): Promise<string | void> => {
    /*
     * Restore the demonstration's borrowed resources (theme, composer, its
     * example wait) before ordinary navigation or replay reads the guide.
     */
    if (["back", "finish", "restart"].includes(action) && ctx.store.session().guide?.reelIndex !== undefined) {
      await reelAct("reel-exit", "")
      if (action !== "restart") return
    }
    /* Reducer cases: reel-start, reel-next <epoch:index>, reel-demo <demo>, reel-exit. */
    if (await reelAct(action, value)) return
    const guide: GuideState = migrateGuideV3(ctx.store.session().guide ?? initialGuide())
    switch (action) {
      case "start":
        if (guide.step !== 0) return
        guide.completed = [...new Set([...(guide.completed ?? []), "tutorial.started"])]
        guide.autoPaused = false
        guide.step = 1
        break
      case "pause":
        guide.autoPaused = true
        break
      case "advance": {
        // Timer tokens cannot advance a different stage or a restarted playthrough.
        if (value !== `${guide.playthrough ?? 0}:${guide.step}` || guide.autoPaused) return
        const lesson = GUIDE_STAGES[guide.step]
        if (!lesson || (lesson.kind === "say" ? lesson.terminal : !guide.completed?.includes(lesson.completion))) return
        guide.step = forward(guide, guide.step + 1)
        break
      }
      case "signal": {
        // Test-only integration door: never called by a timer, a pill or lesson navigation.
        const stage = GUIDE_STAGES[guide.step]
        if (stage?.kind !== "do" || stage.completion !== value) return "This signal does not complete the current lesson."
        guide.completed = [...new Set([...(guide.completed ?? []), value])]
        guide.autoPaused = false
        break
      }
      case "next": {
        const stage = GUIDE_STAGES[guide.step]
        if (stage?.kind === "do" && !guide.completed?.includes(stage.completion)) return "Complete this lesson's action first."
        guide.autoPaused = false
        guide.step = forward(guide, guide.step + 1)
        break
      }
      case "back": {
        guide.autoPaused = true
        guide.notice = undefined
        const stage = GUIDE_STAGES[guide.step]
        /*
         * Back from the stack view reopens the picker with the previous pick (SCRIPT v4 "Back"). The stack view on
         * screen is the test, not the recorded completion: change.open persists the Change before it records the
         * signal, and a Back pressed in between must still reopen the picker rather than rewind a beat.
         */
        const shown = ctx.store.collections.cards.get(PRACTICE_CARD.commits)
        if (stage?.kind === "do" && stage.completion === "change.opened" && (guide.completed?.includes("change.opened") || shown?.kind === "change")) {
          const card = shown
          await ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: {
            id: PRACTICE_CARD.commits, kind: "commit-pick", title: `Commits on ${PRACTICE_BRANCH}`, status: "active",
            createdAt: card?.createdAt ?? Date.now(), ordinal: card?.ordinal ?? 0, payload: practicePicker(guide.pick)
          } }).isPersisted.promise
          guide.completed = (guide.completed ?? []).filter((signal) => signal !== "change.opened")
          break
        }
        guide.step = backward(guide, guide.step - 1)
        break
      }
      case "skip-practice": {
        const stage = GUIDE_STAGES[guide.step]
        if (stage?.kind !== "do" || stage.practice !== true) return "Skip tutorial is offered on the practice lessons."
        guide.declined = [...new Set([...(guide.declined ?? []), "practice" as const])]
        guide.autoPaused = false
        guide.step = GUIDE_BRIDGE
        break
      }
      case "decline": {
        // "Not now" at login, "Later" at install: the ⌘K lesson still runs, and the terminal line says where to pick up.
        const stage = GUIDE_STAGES[guide.step]
        const wants = value === "login" ? "identity.signed-in" : value === "install" ? "github.app.installed" : undefined
        if (wants === undefined) return "Decline takes login or install."
        if (stage?.kind !== "do" || stage.completion !== wants) return `There is no ${value} step to decline here.`
        guide.declined = [...new Set([...(guide.declined ?? []), value as "login" | "install"])]
        guide.autoPaused = false
        guide.notice = undefined
        guide.step = PALETTE_STEP
        break
      }
      case "restart": {
        const playthrough = (guide.playthrough ?? 0) + 1
        for (const field of ["acceptedPracticeTitle", "responseId", "demoRun", "said", "declined", "repo", "pick", "notice"] as const) delete guide[field]
        Object.assign(guide, initialGuide(), { playthrough })
        break
      }
      case "open":
        guide.conversationOpen = true
        break
      case "close":
        guide.conversationOpen = false
        break
      case "toggle":
        guide.conversationOpen = !guide.conversationOpen
        break
      case "heard":
        guide.heard = value.slice(0, 500)
        break
      case "project":
        guide.project = value.slice(0, 500)
        break
      case "title":
        guide.completed = guide.completed?.filter(signal => signal !== "revision" && signal !== "practice")
        delete guide.acceptedPracticeTitle
        guide.prototypeTitle = value.slice(0, 100)
        break
      case "sound":
        guide.sound = !guide.sound
        break
      case "notify": {
        /* Every press sends its own notification — a fresh key per press, not the shared slot. */
        const key = `guide-hello-${crypto.randomUUID()}`
        ctx.store.dispatch({
          type: "toast.shown",
          actor: "system",
          key,
          title: "A little hello from Smithers",
        })
        ctx.store.dispatch({
          type: "toast.resolved",
          actor: "system",
          key,
          status: "ok",
          title: "You can keep working",
          detail: "This is a tutorial notification. I'll bring real flow updates here too.",
        })
        break
      }
      case "dark": {
        const before = ctx.store.session().theme
        const flipped = before === "dark" ? "light" as const : "dark" as const
        await ctx.store.dispatch({ type: "theme.changed", actor: ctx.commandActor === "smithers" ? "system" : ctx.commandActor, theme: flipped }).isPersisted.promise
        break
      }
      case "finish":
        guide.step = GUIDE_LAST_STEP
        guide.conversationOpen = false
        break
      default:
        return `Unknown onboarding action: ${action}`
    }
    await ctx.store.dispatch({ type: "guide.changed", actor: action === "advance" ? "system" : ctx.commandActor, guide }).isPersisted.promise
  }
  return { guideAct }
}

/**
 * Bring any older guide row onto script v4 (sequence `practice-v4`). An
 * unfinished reader restarts at the greeting — the practice repository needs
 * no account, so there is nothing to resume. A finished reader stays in the
 * workspace. Drafts, sound and the reel's state survive. (The name stays for
 * AppStore's seed, which calls it on every hydrated guide.)
 */
export function migrateGuideV3(guide: GuideState): GuideState {
  if (guide.sequence === "practice-v4") return { ...guide }
  const finished = guide.sequence === "repository-v3" ? guide.step >= 9 : guide.step >= (guide.version === 1 ? 15 : 14)
  const { said: _said, declined: _declined, repo: _repo, pick: _pick, notice: _notice, ...kept } = guide
  return { ...kept, version: 3, sequence: "practice-v4",
    step: finished ? GUIDE_LAST_STEP : 0,
    completed: [], autoPaused: false, conversationOpen: false }
}
