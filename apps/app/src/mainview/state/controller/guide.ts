import { GUIDE_STAGES, GUIDE_LAST_STEP, GUIDE_SIGNAL_ALIASES } from "../../onboarding/lessons"
import { completeGuide } from "../../onboarding/completion"
import { LESSON_PLUGIN, libraryOpened, pluginInstalled } from "../../onboarding/pluginLesson"
import { createReelController } from "../../onboarding/reelController"
import { initialGuide } from "../AppState"
import type { GuideState } from "../AppState"
import type { ControllerContext } from "./context"

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
    const complete = (signal: string) => Object.assign(guide, completeGuide(guide, signal))
    switch (action) {
      case "pause":
        guide.autoPaused = true
        break
      case "advance": {
        // Timer tokens cannot advance a different stage or a restarted playthrough.
        if (value !== `${guide.playthrough ?? 0}:${guide.step}` || guide.autoPaused) return
        const lesson = GUIDE_STAGES[guide.step]
        if (!lesson || (lesson.kind === "say" ? lesson.terminal : !guide.completed?.includes(lesson.completion))) return
        guide.step = Math.min(GUIDE_LAST_STEP, guide.step + 1)
        break
      }
      case "signal": {
        // Stub integration door: never called by a timer or by lesson navigation.
        // Producers must validate repo/run/playthrough scope before emitting.
        const signal = GUIDE_SIGNAL_ALIASES[value] ?? value
        const stage = GUIDE_STAGES[guide.step]
        if (stage?.kind !== "do" || stage.completion !== signal) return "This signal does not complete the current lesson."
        complete(signal)
        break
      }
      case "next": {
        const stage = GUIDE_STAGES[guide.step]
        if (stage?.kind === "do" && !guide.completed?.includes(stage.completion)) return "Complete this lesson's action first."
        guide.autoPaused = false
        guide.step = Math.min(GUIDE_LAST_STEP, guide.step + 1)
        break
      }
      case "back":
        guide.autoPaused = true
        guide.step = Math.max(0, guide.step - 1)
        break
      case "restart": {
        const playthrough = (guide.playthrough ?? 0) + 1
        delete guide.acceptedPracticeTitle
        delete guide.responseId
        delete guide.demoRun
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
      /*
       * The two plugin lessons are finished by the REAL flows — `/plugins`
       * opens the Library and `/plugins.install librarian` installs from it,
       * and the plugins controller advances the lesson through the same two
       * helpers used here. These actions stay as the older door onto the same
       * transition; both read one definition so they cannot drift.
       */
      case "library": {
        const opened = libraryOpened(guide)
        if (opened === undefined) return "Meet the Library in the plugin lesson."
        Object.assign(guide, opened)
        break
      }
      case "librarian": {
        const added = pluginInstalled(guide, LESSON_PLUGIN)
        if (added === undefined) return "Open the Library first."
        /* The lesson installs for real; the shelf is the workspace's, not the tutorial's. */
        ctx.store.dispatch({ type: "plugin.installed", actor: ctx.commandActor, plugin: LESSON_PLUGIN })
        Object.assign(guide, added)
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

/** Old tutorials have no repository context: unfinished readers restart at login.
 * Finished readers stay in the workspace. Preserve drafts and installed plugins.
 * sequence distinguishes the interrupted v3 Library reorder from this v3 brief.
 */
export function migrateGuideV3(guide: GuideState): GuideState {
  if (guide.version === 3 && guide.sequence === "repository-v3") return { ...guide }
  const finished = guide.step >= (guide.version === 1 ? 15 : 14)
  return { ...guide, version: 3, sequence: "repository-v3",
    step: finished ? GUIDE_LAST_STEP : guide.step === 0 ? 0 : 1,
    completed: [], autoPaused: false, conversationOpen: false }
}
