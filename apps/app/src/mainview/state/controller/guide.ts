import { activeRepositoryId } from "../RepoContext"
import { REEL_STAGES } from "../../onboarding/reel.ts"
import { INTRO_SLIDES } from "../../onboarding/introScript.ts"
import { GUIDE_BRIDGE, GUIDE_LAST_STEP, GUIDE_STAGES } from "../../onboarding/lessons"
import { createReelController } from "../../onboarding/reelController"
import { guideBackwardStep, guideForwardStep } from "../../onboarding/navigation"
import { LIBRARIAN_SIGNAL } from "./librarianRuns"
import { conversationTabIdOf, inConversation, initialGuide } from "../AppState"
import type { GuideState } from "../AppState"
import { PRACTICE_BRANCH, PRACTICE_CARD, PRACTICE_REPO, practicePicker } from "../practice/PracticeRepository"
import { PRACTICE_DIFF_CARD } from "../seams/DiffFilesSeam"
import type { ControllerContext } from "./context"

/** Where the escape hatches land: the ⌘K lesson, which every path still runs. */
const PALETTE_STEP = GUIDE_STAGES.findIndex((stage) => stage.kind === "do" && stage.completion === "palette.opened")

/*
 * The beat just landed on already holds its receipt, so this is a revisit
 * (Back, then the act again; or Next over ground already walked). The shell
 * schedules the next step for any finished beat that is not paused, so
 * without this the ONE press that moved here would immediately buy a second
 * step and the card the press reopened would scroll away unread.
 */
const revisitingCompletedBeat = (guide: GuideState): boolean => {
  const stage = GUIDE_STAGES[guide.step]
  return stage?.kind === "do" && guide.completed?.includes(stage.completion) === true
}

/** Durable, replayable onboarding. Practice artifacts never enter repository/run tables. */
export function createGuideController(ctx: ControllerContext, onStart?: () => Promise<unknown>, onFinish?: (repo: string) => Promise<string | void>, onFinished?: () => void) {
  /** Revisit the persisted frame result without executing the action that produced it. */
  const restoreLessonCard = async (guide: GuideState, back = false) => {
    if (ctx.disposed) return
    const stage = GUIDE_STAGES[guide.step]
    if (stage?.kind !== "do") return
    const stackBack = back && stage.completion === "change.opened"
      && ctx.store.collections.cards.get(PRACTICE_CARD.commits)?.kind === "change"
    if (!guide.completed?.includes(stage.completion) && !stackBack) return
    const kind = stage.completion === "issues.opened" ? "issue-list"
      : stage.completion === "issue.opened" ? "issue"
      : stage.completion === "diff.opened" ? "diff"
      : stage.completion === "diff.file.opened" ? "file"
      : stage.completion === "change.opened" ? back ? "commit-pick" : "change" : undefined
    if (kind === undefined) return
    const frame = kind === "diff" || kind === "file" ? PRACTICE_DIFF_CARD
      : kind === "commit-pick" || kind === "change" ? PRACTICE_CARD.commits : undefined
    const conversation = conversationTabIdOf(ctx.store.session())
    for (const history of ctx.store.collections.cardHistories.values()) {
      if (frame !== undefined && history.id !== frame) continue
      const current = ctx.store.collections.cards.get(history.id)
      if (!current || !inConversation(current, conversation)) continue
      const index = history.entries.map(card => card.kind === kind && "repo" in card.payload && card.payload.repo === PRACTICE_REPO).lastIndexOf(true)
      if (index < 0) continue
      const delta = index > history.index ? 1 : -1
      for (let count = Math.abs(index - history.index); count > 0; count--) {
        if (ctx.disposed) return
        await ctx.store.dispatch({ type: "card.history.moved", actor: ctx.commandActor, id: history.id, delta }).isPersisted.promise
      }
      return
    }
    // Older bundled Changes predate frame history; keep their stack as a forward location.
    const shown = ctx.store.collections.cards.get(PRACTICE_CARD.commits)
    if (stackBack && shown) await ctx.store.dispatch({ type: "card.navigated", actor: ctx.commandActor, card: {
      ...shown, kind: "commit-pick", title: `Commits on ${PRACTICE_BRANCH}`, status: "active", payload: practicePicker(guide.pick),
    } }).isPersisted.promise
  }
  /* The optional capability reel owns its own reducer cases (onboarding/reelController.ts). */
  const finish = async (): Promise<string | void> => {
    const guide = ctx.store.session().guide ?? initialGuide()
    const active = activeRepositoryId(ctx.store)
    const signedIn = ctx.store.collections.identitySessions.get("identity")?.state === "signed-in"
    const repo = signedIn && !guide.declined?.some(choice => choice === "login" || choice === "install")
      && active && !active.startsWith("practice:") ? active : "smithersai/smithers"
    for (const toast of ctx.store.collections.toasts.values()) {
      if (["reel-notify-", "reel-wait-", "guide-hello-", "guide-tip-"].some(prefix => toast.key.startsWith(prefix))) {
        ctx.store.dispatch({ type: "toast.dismissed", actor: "system", id: toast.id })
      }
    }
    return onFinish?.(repo)
  }
  const reelAct = createReelController(ctx)
  const applyGuideAction = async (action: string, value = ""): Promise<string | void> => {
    if (ctx.disposed) return
    /*
     * Restore the demonstration's borrowed resources (theme, composer, its
     * example wait) before ordinary navigation or replay reads the guide.
     */
    if (["back", "finish", "skip", "restart"].includes(action) && ctx.store.session().guide?.reelIndex !== undefined) {
      await reelAct("reel-exit", "")
      if (ctx.disposed) return
      if (action === "back") return
    }
    /* Reducer cases: reel-start, reel-next <epoch:index>, reel-demo <demo>, reel-exit. */
    const beforeReel = ctx.store.session().guide
    const completingReel = action === "reel-next" && beforeReel?.reelIndex === REEL_STAGES.length - 1
      && value === `${beforeReel.reelEpoch ?? 0}:${beforeReel.reelIndex}`
    const handledByReel = await reelAct(action, value)
    if (ctx.disposed) return
    if (handledByReel) {
      if (completingReel) return applyGuideAction("finish")
      return
    }
    const guide: GuideState = migrateGuideV3(ctx.store.session().guide ?? initialGuide())
    switch (action) {
      case "start":
        if (guide.finished || guide.step > 1 || (guide.step === 1 && (guide.completed?.length ?? 0) > 0)) return
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
        await restoreLessonCard(guide)
        guide.step = guideForwardStep(guide)
        // A repeated act (onboarding/completion.ts lessonResumed) resumes this
        // timer; landing back on walked ground stops it here, not two beats on.
        if (revisitingCompletedBeat(guide)) guide.autoPaused = true
        await restoreLessonCard(guide)
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
        if (stage?.kind === "do" && !guide.completed?.includes(stage.completion)) return "Finish this step first."
        await restoreLessonCard(guide)
        guide.step = guideForwardStep(guide)
        guide.autoPaused = revisitingCompletedBeat(guide)
        await restoreLessonCard(guide)
        break
      }
      case "back": {
        if (guide.step <= 1) return
        guide.autoPaused = true
        guide.notice = undefined
        guide.noticeDetail = undefined
        const stage = GUIDE_STAGES[guide.step]
        /*
         * Back from the stack view reopens the picker with the previous pick (SCRIPT v4 "Back"). The stack view on
         * screen is the test, not the recorded completion: change.open persists the Change before it records the
         * signal, and a Back pressed in between must still reopen the picker rather than rewind a beat.
         */
        const shown = ctx.store.collections.cards.get(PRACTICE_CARD.commits)
        if (!(stage?.kind === "do" && stage.completion === "change.opened" && shown?.kind === "change")) {
          guide.step = guideBackwardStep(guide)
        }
        await restoreLessonCard(guide, true)
        if (guide.step < GUIDE_BRIDGE) {
          guide.declined = guide.declined?.filter(choice => choice !== "practice")
          delete guide.practiceSkippedFrom
        }
        break
      }
      case "decline": {
        // "Not now" at login, "Later" at install: the ⌘K lesson still runs, and the terminal line says where to pick up.
        const stage = GUIDE_STAGES[guide.step]
        const wants = value === "login" ? "identity.signed-in" : value === "install" ? "github.app.installed" : value === "background" ? "librarian.runs.launched" : undefined
        if (wants === undefined) return "Decline takes login, install, or background."
        if (stage?.kind !== "do" || stage.completion !== wants) return `There is no ${value} step to decline here.`
        guide.declined = [...new Set([...(guide.declined ?? []), value as "login" | "install" | "background"])]
        if (value === "background") {
          for (const toast of ctx.store.collections.toasts.values()) {
            if (toast.key === "command.failed.wiki.create" || toast.key === "command.failed.history.bootstrap" || toast.key.startsWith(`flow.provision.${guide.repo}.`)) {
              ctx.store.dispatch({ type: "toast.dismissed", actor: ctx.commandActor === "smithers" ? "system" : "user", id: toast.id })
            }
          }
        }
        guide.autoPaused = false
        guide.notice = undefined
        guide.noticeDetail = undefined
        guide.step = PALETTE_STEP
        break
      }
      case "restart": {
        const playthrough = (guide.playthrough ?? 0) + 1
        for (const field of ["finished", "acceptedPracticeTitle", "responseId", "demoRun", "said", "declined", "practiceSkippedFrom", "repo", "pick", "notice", "noticeDetail", "librarianLaunches", "introSlides", "introSeen"] as const) delete guide[field]
        // Persisted replies stay with the transcript that owned their turn.
        // initialGuide omits this optional map, so Object.assign cannot reset it.
        delete guide.transcript
        Object.assign(guide, initialGuide(), { playthrough, completed: ["tutorial.started"] })
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
      /*
       * Beat 12's illustrated introductions: opening is a consequence of the
       * lesson's launch pills (GuideShell runLessonAction), each kind presents
       * once, and the last slide's Next closes back into the tutorial.
       */
      case "intro-open": {
        if (value !== "wiki" && value !== "history") return "Intro takes wiki or history."
        const stage = GUIDE_STAGES[guide.step]
        if (guide.finished || stage?.kind !== "do" || stage.completion !== LIBRARIAN_SIGNAL) {
          return "There is no background introduction here."
        }
        if (guide.introSlides !== undefined || guide.introSeen?.includes(value)) break
        guide.introSlides = { kind: value, index: 0 }
        guide.introSeen = [...(guide.introSeen ?? []), value]
        break
      }
      case "intro-next": {
        const slides = guide.introSlides
        if (slides === undefined) return
        if (slides.index + 1 >= INTRO_SLIDES[slides.kind].length) delete guide.introSlides
        else guide.introSlides = { kind: slides.kind, index: slides.index + 1 }
        break
      }
      case "intro-back": {
        const slides = guide.introSlides
        if (slides === undefined || slides.index === 0) return
        guide.introSlides = { kind: slides.kind, index: slides.index - 1 }
        break
      }
      case "intro-close": {
        if (guide.introSlides === undefined) return
        delete guide.introSlides
        break
      }
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
      case "skip":
      case "finish": {
        if (action === "skip") {
          const stage = GUIDE_STAGES[guide.step]
          if (stage?.kind !== "do" || stage.practice !== true) return "Skip tutorial is offered on the practice lessons."
          guide.declined = [...new Set([...(guide.declined ?? []), "practice" as const])]
          guide.practiceSkippedFrom = guide.step
          guide.autoPaused = false
        }
        guide.finished = true
        guide.step = GUIDE_LAST_STEP
        guide.conversationOpen = false
        guide.notice = undefined
        guide.noticeDetail = undefined
        break
      }
      default:
        return `Unknown onboarding action: ${action}`
    }
    if (ctx.disposed) return
    await ctx.store.dispatch({ type: "guide.changed", actor: action === "advance" ? "system" : ctx.commandActor, guide }).isPersisted.promise
    // The receipt may settle after shutdown began. It never grants a closed
    // controller permission to launch the next repository read or navigation.
    if (ctx.disposed) return
    if (action === "finish" || action === "skip") {
      onFinished?.()
      return finish()
    }
    if (action === "start" || action === "restart") {
      await onStart?.()
    }
  }
  // Boot and explicit entry share the same pending initialization and hidden read.
  let starting: Promise<string | void> | undefined
  const guideAct = (action: string, value = ""): Promise<string | void> => {
    if (action !== "start") return applyGuideAction(action, value)
    return starting ??= applyGuideAction(action, value).finally(() => { starting = undefined })
  }
  // Mount visibility is a host observation, independent of the command actor.
  // A late React ref cleanup cannot reopen a controller whose lifetime ended.
  const observeGuideVisibility = (visible: boolean): void => {
    if (ctx.disposed) return
    ctx.store.dispatch({ type: "guide.visibility.changed", actor: "system", visible })
  }
  return { guideAct, observeGuideVisibility }
}

/** Map old lessons by their durable completion signals; an update never erases progress. */
export function migrateGuideV3(guide: GuideState): GuideState {
  if (guide.sequence === "practice-v4") return { ...guide }
  const finished = guide.sequence === "repository-v3" ? guide.step >= 9 : guide.step >= (guide.version === 1 ? 15 : 14)
  const completed = [...(guide.completed ?? [])]
  const started = guide.step > 0 || completed.length > 0
  if (started && !completed.includes("tutorial.started")) completed.push("tutorial.started")
  let step = started ? 1 : 0
  GUIDE_STAGES.forEach((stage, index) => {
    if (stage.kind === "do" && completed.includes(stage.completion)) step = Math.max(step, index)
  })
  return { ...guide, version: 3, sequence: "practice-v4", completed,
    step: finished ? GUIDE_LAST_STEP : step, autoPaused: started || guide.autoPaused }
}
