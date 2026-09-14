import { flowAction } from "../flows/FlowAction"
import { REEL_BUTTON } from "./reel.ts"
import { scrollToGuideRead } from "./transcriptScroll"
import { TranscriptMessage } from "../TranscriptMessage"
import { Button, ChatMessage } from "@smthrs/ui"
import {
  GUIDE_BRIDGE, GUIDE_LAST_STEP, GUIDE_STAGES,
  lessonMessage, lessonText, lessonVisible, type GoalCheckpoint, type GuideAction,
} from "./lessons"
import { guideClock, readPause, scheduleGuideAdvance, type GuideClock } from "./advance"
import { ReelShell } from "./Reel.tsx"
import { IntroSlidesShell } from "./IntroSlides"
import { guideForwardAction } from "./navigation"
import { useLiveQuery } from "@tanstack/react-db"
import { Fragment, useCallback, useRef, useState, type ReactNode, type CSSProperties } from "react"
import { flushSync } from "react-dom"
import { Check, Mic, X } from "lucide-react"
import { useController } from "../ControllerContext"
import { initialGuide, conversationTabIdOf, inConversation, type Card, type Message } from "../state/AppState"
import { useCardRows } from "../state/useCardRows"
import { CardView } from "../ChatCards"
import { cardActions } from "../cards/CardActions"
import { PRACTICE_CARD, PRACTICE_REPO, PRACTICE_RUN_ID } from "../state/practice/PracticeRepository"
import "./guide.css"

import { bindPressActions, type PressAction } from "../runtime/PressActions"
import { InputModeMenu } from "../InputModeMenu"
import { GuideButton, GUIDE_KEYS } from "./GuideButton"
import { GuideComposerHost } from "./GuideComposerHost"
import { guideTranscriptEntries, InTutorial, tutorialTranscript } from "./transcriptScope"
import { HelpBubble } from "../HelpBubble"
import { GuidanceText } from "../GuidanceText"
import { useCoarsePointer } from "../runtime/PointerMode"
import { legacyLibrarianFailure, librarianFailureMessage } from "../state/LibrarianLaunch"
import { LibrarianRunChips } from "./LibrarianRunChips"
import { guideActionState } from "./actionState"

/** An original, short opt-in interval; no autoplay or copyrighted game audio. */
function chime() {
  if (typeof AudioContext === "undefined") return
  const audio = new AudioContext()
  void audio
    .resume()
    .then(() => {
      for (const [i, frequency] of [261.63, 392, 523.25].entries()) {
        const tone = audio.createOscillator(),
          gain = audio.createGain(),
          at = audio.currentTime + i * 0.13
        tone.type = "sine"
        tone.frequency.value = frequency
        gain.gain.setValueAtTime(0, at)
        gain.gain.linearRampToValueAtTime(0.035, at + 0.04)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.8)
        tone.connect(gain).connect(audio.destination)
        tone.start(at)
        tone.stop(at + 0.85)
      }
      setTimeout(() => {
        void audio.close()
      }, 1400)
    })
    .catch(() => {
      void audio.close()
    })
}

const GOAL: ReadonlyArray<readonly [GoalCheckpoint, string]> = [["issue", "Issue"], ["plan", "Plan"], ["commits", "Commits"], ["change", "Change"]]
const cardRepo = (card: Card): string | undefined => {
  const repo = (card.payload as { repo?: unknown }).repo
  return typeof repo === "string" ? repo : undefined
}
/** The trace's turn ids in order (`frame-1`…), as the fold names them (cards/RunTrace.ts). */
const frameIds = (card: Card | undefined): ReadonlyArray<string> => {
  if (card?.kind !== "run-trace") return []
  const opened = (card.payload.events ?? []).filter((record) => record.kind === "control.agent.turn-opened").length
  return Array.from({ length: opened }, (_, index) => `frame-${index + 1}`)
}

export function GuideShell({ children, clock = guideClock }: { children: ReactNode; clock?: GuideClock }) {
  const controller = useController()
  const touch = useCoarsePointer()
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const { data: messageRows } = useLiveQuery(controller.store.collections.messages)
  const cards = useCardRows(controller.store.collections.cards)
  const { data: worldDocuments } = useLiveQuery(controller.store.collections.worldDocuments)
  const session = sessions[0] ?? controller.store.session()
  const conversation = conversationTabIdOf(session)
  const isIdentityPrompt = (message: Message) =>
    (message.action ?? message.answeredAction)?.flow === "auth.sign-in"
  const signInPrompts = messageRows.filter(message => inConversation(message, conversation) && isIdentityPrompt(message) && session.guide?.transcript?.[message.id]?.owned === true)
    .sort((a, b) => a.ordinal - b.ordinal)
  const guide = session.guide ?? initialGuide()
  // The palette transition is synchronous; guide progression may await a reel act.
  const conversationOpen = session.paletteOpen === true || guide.conversationOpen
  const stage = guide.step
  const legacyFailure = legacyLibrarianFailure(guide)
  const notice = legacyFailure ? librarianFailureMessage(legacyFailure.kind, legacyFailure.error) : guide.notice
  const noticeDetail = legacyFailure?.error ?? guide.noticeDetail
  const noticeContent = notice === undefined ? null : <div className="guide-notice" role="alert" data-notice="">
    <p>{notice}</p>
    {noticeDetail && <details><summary>Technical details</summary><pre>{noticeDetail}</pre></details>}
  </div>
  const showPractice = stage <= GUIDE_BRIDGE
  const skipped = guide.declined?.includes("practice") === true
  /* Keep the payoff visible until the user acts on the bridge. Skipped practice stays hidden. */
  const lessonCards = tutorialTranscript(cards.filter(card => inConversation(card, conversation)),
    guide.transcript)
    .filter(card => guide.transcript?.[card.id]?.source === "chat" || (showPractice && !skipped) || !cardRepo(card)?.startsWith("practice:"))
    .sort((a, b) => a.ordinal - b.ordinal)
  const messages = messageRows.filter(message => inConversation(message, conversation) && guide.transcript?.[message.id]?.owned === true && !isIdentityPrompt(message))
  const entries = guideTranscriptEntries(lessonCards.filter(card => stage < GUIDE_LAST_STEP || guide.transcript?.[card.id]?.source === "chat"), messages, guide)
  const typing = session.phase === "responding"
  const streamingMessageId = typing ? messages.at(-1)?.id : undefined
  // Closing the composer keeps the chat read; the terminal beat retains the last question.
  const chatAnchorId = messages.filter(message => message.role === "user" && (guide.transcript?.[message.id]?.step === stage || stage === GUIDE_LAST_STEP)).at(-1)?.id
  const promptId = signInPrompts.at(-1)?.id
  const scrollToken = `${promptId ?? ""}:${stage}:${entries.map(entry => `${entry.kind === "card" ? entry.card.id + ':' + entry.card.kind : entry.message.id}`).join(",")}`
  /*
   * Progression is data (GUIDE_STAGES): a say-beat keeps talking on its own
   * after a read pause, and a do-beat waits for its real outcome, shows its
   * check and the follow-up line, then moves on.
   */
  const lesson = GUIDE_STAGES[stage]
  const done = (step: number): boolean => {
    const asked = GUIDE_STAGES[step]
    return asked?.kind === "do" && (guide.completed ?? []).includes(asked.completion)
  }
  const goalDone = (goal: GoalCheckpoint): boolean => {
    const step = GUIDE_STAGES.findIndex(asked => asked.kind === "do" && asked.goal === goal)
    return step >= 0 && done(step)
  }
  const goalComplete = GOAL.every(([goal]) => goalDone(goal))
  // Dismissal is transient guidance chrome; lesson completion remains in the store.
  const [dismissedHelp, setDismissedHelp] = useState<string | null>(null)
  const helpKey = `${guide.playthrough ?? 0}:${stage}`
  const [guidance, setGuidance] = useState({ key: "", index: 0 })
  const guidanceIndex = guidance.key === helpKey ? guidance.index : 0
  const introduction = lesson?.kind === "do" ? lesson.help?.introduction?.[guidanceIndex] : undefined
  const advanceGuidance = useCallback(() => setGuidance(previous => ({
    key: helpKey, index: (previous.key === helpKey ? previous.index : 0) + 1,
  })), [helpKey])
  const showTutorialHelp = lesson?.kind === "do" && lesson.help !== undefined && !done(stage)
    && dismissedHelp !== helpKey && !conversationOpen
  const chatHelpOpen = showTutorialHelp && introduction?.target === "chat"
  /* An introduction stays until the reader presses Next or Enter; only the final instruction waits on the action. */
  const guidanceContent = lesson?.kind === "do" && lesson.help ? <>
    <GuidanceText
      key={`${helpKey}:${guidanceIndex}`}
      text={touch ? introduction?.touchContent ?? introduction?.content ?? lesson.help.touchContent ?? lesson.help.content : introduction?.content ?? lesson.help.content}
    />
    {introduction && <GuideButton className="help-bubble-next" data-guidance-next="" shortcut="Enter" onClick={advanceGuidance}>Next</GuideButton>}
  </> : null
  const paused = guide.autoPaused === true
  const showNext = lesson === undefined || (lesson.kind === "say" ? paused : lesson.skippable)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const readRef = useRef<{ stage: number; promptId?: string; targetId?: string; chatAnchorId?: string; top: number; following: boolean } | null>(null)
  const userReadPending = useRef(false)
  const bindTranscript = useCallback((node: HTMLDivElement | null) => {
    transcriptRef.current = node
    if (!node) return
    const previous = readRef.current
    const targetId = previous?.stage === stage && promptId !== previous.promptId ? promptId : chatAnchorId
    const following = !previous || previous.following || previous.stage !== stage
      || previous.chatAnchorId !== chatAnchorId || previous.promptId !== promptId || userReadPending.current
    userReadPending.current = false
    const read = { stage, promptId, targetId, chatAnchorId, top: node.scrollTop, following }
    readRef.current = read
    const align = () => {
      if (!read.following) return
      scrollToGuideRead(node, stage, read.targetId)
      read.top = node.scrollTop
    }
    const onScroll = () => {
      if (node.scrollTop < read.top) read.following = false
      read.top = node.scrollTop
    }
    const frame = requestAnimationFrame(align)
    const observer = new ResizeObserver(align)
    observer.observe(node)
    for (const child of node.children) observer.observe(child)
    node.addEventListener("scroll", onScroll)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      node.removeEventListener("scroll", onScroll)
    }
  }, [scrollToken, stage, chatAnchorId])
  /* Keep the portal mounted so closing can animate without losing the draft. */
  const [composerHost, setComposerHost] = useState<HTMLDivElement | null>(null)
  /* Only a message that mounts AT the current stage enters with the open animation. */
  const enteredStep = useRef(-1)
  if (stage > enteredStep.current) enteredStep.current = stage
  const sounded = useRef({ playthrough: guide.playthrough, completed: guide.completed ?? [] })
  const opener = useRef<HTMLButtonElement>(null)
  const dockWasOpen = useRef(false)
  const picker = cards.find(card => card.id === PRACTICE_CARD.commits)
  const runCard = cards.find(card => card.id === PRACTICE_CARD.run)
  const runCommandGuide = (action: string, value?: string) => {
    controller.runCommand("onboarding.act", `${action}${value === undefined ? "" : ` ${JSON.stringify(value)}`}`)
  }
  /*
   * C opens Chat (Cmd/Ctrl-K remains an alias) (SCRIPT v4 "Open decision"): the composer rises
   * into the bottom dock with "Ask Smithers" as its first row.
   */
  const runCommandOpen = () => {
    flushSync(() => controller.runCommand("chat.open"))
    document.querySelector<HTMLTextAreaElement>(".guide-composer-layer textarea")?.focus()
  }
  const runCommandClose = () => {
    controller.cancelDictation()
    flushSync(() => {
      controller.closePalette()
      runCommandGuide("close")
    })
    const target = opener.current ?? document.querySelector<HTMLElement>(".guide-shell")
    target?.focus()
  }
  /** `{repo}` is the user's repository; `{picked}` is the picker's checked commits. Unresolved args render the flow's form. */
  const argsOf = (action: GuideAction): string | undefined => {
    if (action.args === undefined) return undefined
    if (action.args === "{picked}") {
      if (picker?.kind !== "commit-pick") return undefined
      const ids = picker.payload.rows.filter(row => picker.payload.picked.includes(row.index)).map(row => row.commitId)
      return `${PRACTICE_REPO} ${ids.join(" ")}`
    }
    if (action.args.includes("{repo}")) return guide.repo === undefined ? undefined : action.args.replaceAll("{repo}", guide.repo)
    return action.args
  }
  const runLessonAction = (suggestion: GuideAction) => {
    // Read the store again at release so a run started while held cannot launch twice.
    const action = guideActionState(suggestion, [...controller.store.collections.cards.values()], controller.store.session().guide ?? guide)
    if (action.disabled) return
    if (action.flow === "chat.open" || action.flow === "palette.open") {
      runCommandOpen()
      return
    }
    if (action.args === "{picked}" && picker?.kind !== "commit-pick") return
    const args = argsOf(action)
    if (args === undefined) controller.runCommand(action.flow)
    else controller.runCommand(action.flow, args)
    /* Beat 12's launches open their illustrated introduction while the run builds. */
    if (stage === 12 && (action.flow === "wiki.create" || action.flow === "history.bootstrap")) {
      runCommandGuide("intro-open", action.flow === "wiki.create" ? "wiki" : "history")
    }
  }
  const runCommandSound = () => {
    runCommandGuide("sound")
  }
  /** ↑/↓ walk the practice run's turns once the trace is open. */
  const moveTrace = (delta: number): boolean => {
    if (runCard?.kind !== "run-trace" || runCard.payload.selection === undefined) return false
    const frames = frameIds(runCard)
    const at = frames.findIndex(id => id === runCard.payload.selection)
    const next = frames[Math.max(0, Math.min(frames.length - 1, (at < 0 ? 0 : at) + delta))]
    if (next === undefined || next === runCard.payload.selection) return true
    controller.runCommand("runs.trace.select", `${PRACTICE_RUN_ID} ${next}`)
    return true
  }
  const lineOf = (step: number): string | undefined => {
    const asked = GUIDE_STAGES[step]
    if (asked?.kind !== "do" || !done(step)) return undefined
    return guide.said?.[asked.completion] ?? asked.success
  }
  const inputHandlers = useRef<{ resolve: (event: KeyboardEvent) => PressAction | undefined; enabled: () => boolean }>(null!)
  inputHandlers.current = {
    enabled: () => !guide.finished && guide.reelIndex === undefined && guide.introSlides === undefined && !document.querySelector(".input-mode-menu"),
    resolve: (event) => {
      const key = event.key.toLowerCase()
      const action = (activate: () => void, shortcut = key): PressAction => ({
        element: Array.from(document.querySelectorAll<HTMLElement>('.session-shell [aria-keyshortcuts], .guide-shell [aria-keyshortcuts]'))
          .find(button => !button.closest('[inert], [aria-hidden="true"]') && button.getAttribute('aria-keyshortcuts')?.toLowerCase().split(' ').includes(shortcut)),
        activate,
      })
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key === 'k') {
        return action(() => conversationOpen ? runCommandClose() : runCommandOpen(), event.metaKey ? 'meta+k' : 'control+k')
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (key === 'escape' && conversationOpen) return action(controller.store.session().dictating ? () => {
        controller.cancelDictation()
        document.querySelector<HTMLTextAreaElement>('.guide-composer-layer textarea')?.focus()
      } : runCommandClose)
      if (key === GUIDE_KEYS.mode) return action(() => document.querySelector<HTMLButtonElement>('.guide-shell [aria-haspopup="menu"][aria-keyshortcuts="m"]')?.click())
      if (key === GUIDE_KEYS.chat) return action(() => conversationOpen ? runCommandClose() : runCommandOpen())
      if (key === 'w') return action(() => controller.runCommand('sidebar.toggle'))
      if (conversationOpen) return
      if (key === 'enter' && introduction !== undefined && showTutorialHelp) return action(advanceGuidance)
      const lessonAction = lesson?.kind === 'do'
        ? [...lesson.actions, ...(lesson.secondary === undefined ? [] : [lesson.secondary])].find(candidate => candidate.key.toLowerCase() === key)
        : undefined
      if (lessonAction) return action(() => runLessonAction(lessonAction))
      if (lesson?.kind === 'do' && lesson.practice === true && key === 'q') return action(() => runCommandGuide('skip-practice'))
      if (/^[1-9]$/.test(key) && lesson?.kind === 'do' && lesson.completion === 'change.opened' && picker?.kind === 'commit-pick') {
        return action(() => controller.runCommand('change.pick', key))
      }
      if ((key === 'arrowdown' || key === 'arrowup') && runCard?.kind === 'run-trace' && runCard.payload.selection !== undefined) {
        return action(() => { moveTrace(key === 'arrowdown' ? 1 : -1) })
      }
      if (key === GUIDE_KEYS.sound) return action(runCommandSound)
      if (key === 'n') return action(() => runCommandGuide('notify'))
      if (key === 'arrowright') return action(() => runCommandGuide(guideForwardAction(stage)))
      if (key === GUIDE_KEYS.back && stage > 1) return action(() => runCommandGuide('back'))
      if (stage === GUIDE_LAST_STEP) {
        if (key === REEL_BUTTON.key) return action(() => controller.runCommand(REEL_BUTTON.command))
        if (key === GUIDE_KEYS.finish) return action(() => runCommandGuide('finish'))
        if (key === GUIDE_KEYS.replay) return action(() => runCommandGuide('restart'))
      }
    },
  }
  // Ref ownership survives incidental renders (for example the auto-advance pause on keydown).
  const bindInputs = useCallback((node: HTMLDivElement | null) => {
    if (!node?.parentElement) return
    controller.store.dispatch({ type: "guide.visibility.changed", actor: "system", visible: true })
    const unbind = bindPressActions({ root: node.closest<HTMLElement>(".session-shell") ?? node.parentElement,
      resolveShortcut: event => inputHandlers.current.resolve(event),
      enabled: () => inputHandlers.current.enabled(),
    })
    return () => {
      unbind()
      controller.store.dispatch({ type: "guide.visibility.changed", actor: "system", visible: false })
    }
  }, [controller, stage, guide.playthrough, guide.reelIndex])
  if (guide.finished) return <>{children}</>
  return (
    <GuideComposerHost.Provider value={composerHost}>
    <InTutorial value={true}>
    <div
      key={guide.playthrough ?? 0}
      className="guide-shell"
      data-flows={controller.commands
        .all()
        .map((command) => command.name)
        .join(" ")}
      data-conversation-open={conversationOpen}
      data-input-mode={session.inputMode}
      data-step={stage}
      data-stage={stage}
      data-theme={sessions[0]?.theme ?? "light"}
      tabIndex={-1}
      ref={(node) => {
        if (!node) return
        // Sound follows new completion receipts, never toggles, replay, or Back/Next.
        const completed = guide.completed ?? []
        const progress = sounded.current.playthrough === guide.playthrough && completed.some(signal => !sounded.current.completed.includes(signal))
        sounded.current = { playthrough: guide.playthrough, completed }
        if (progress && guide.sound) chime()
        if (document.activeElement === document.body) node.focus()
        /*
         * The tutorial presses Next for the reader. A say-beat advances after
         * a read pause and ANY input cancels it (the reader is doing
         * something); a finished do-beat holds 0.9 s so its check can be
         * seen, and the input that finished it never cancels it — its timer
         * listens on a target no gesture reaches.
         */
        const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
        const ready = lesson !== undefined && (lesson.kind === "say" ? lesson.terminal !== true : done(stage))
        const token = `${guide.playthrough ?? 0}:${stage}`
        const spoken = lesson?.kind === "say" ? `${lessonMessage(stage, guide, touch)} ${lesson.more ?? ""}` : ""
        const stopAdvance = !ready ? () => {} : scheduleGuideAdvance({
          target: lesson.kind === "say" ? document : new EventTarget(),
          clock,
          paused,
          delay: lesson.kind === "say" ? readPause(spoken, reduced) : 900,
          advance: () => controller.runCommand("onboarding.act", `advance ${JSON.stringify(token)}`),
          cancel: () => controller.runCommand("onboarding.act", "pause"),
        })
        return () => {
          stopAdvance()
        }
      }}
    >
      <div className="guide-content" ref={bindInputs}>
      {/*
        * The workspace is behind the tutorial chrome (guide.css): while a lesson
        * is running it is not reachable, so it leaves the a11y tree and the tab
        * order too. The lesson's own cards are projected into the transcript
        * below; without this the same card would answer a query twice.
        */}
      <div className="guide-app" data-repo={session.activeRepoKey ?? undefined} inert={stage < GUIDE_LAST_STEP ? true : undefined} aria-hidden={stage < GUIDE_LAST_STEP}>
        <InTutorial value={stage < GUIDE_LAST_STEP}>{children}</InTutorial>
      </div>
      <div className="guide-atmosphere" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="guide-header">
        <span className="guide-location">
          {stage === GUIDE_LAST_STEP ? "Your workspace" : null}
        </span>
      </div>
      <main className="guide-main">
        <section className="guide-lesson" aria-label={`Lesson ${stage}`}>
          {stage > 0 && stage < GUIDE_LAST_STEP && (
            <nav data-keyboard-pane="Lesson navigation" className="guide-navigation" aria-label="Lesson navigation">
              {stage > 1 && <GuideButton shortcut={GUIDE_KEYS.back} data-flow="onboarding.act" onClick={() => runCommandGuide("back")}>
                Back
              </GuideButton>}
              {lesson?.kind === "do" && lesson.practice === true && (
                <GuideButton className="guide-skip" shortcut="q" data-flow="onboarding.act"
                  onClick={() => runCommandGuide("skip-practice")}>
                  Skip tutorial
                </GuideButton>
              )}
              {showNext && (
                <GuideButton
                  className="guide-next"
                  shortcut="ArrowRight"
                  data-flow="onboarding.act"
                  onClick={() => runCommandGuide("next")}
                >
                  Next
                </GuideButton>
              )}
            </nav>
          )}
          {/* Tutorial progress, pinned above the transcript. */}
          {stage > 0 && showPractice && (
            <section className="guide-goal" aria-label="Goal" data-goal-state={skipped ? "skipped" : goalComplete ? "complete" : "open"}>
              <ol className="guide-goal-checkpoints">
                {GOAL.map(([goal, label]) => (
                  <li key={goal} data-checkpoint={goal} data-done={goalDone(goal)}>
                    <span className="guide-goal-mark" aria-hidden="true">{goalDone(goal) ? <Check size={13} /> : null}</span>
                    {label}
                  </li>
                ))}
              </ol>
            </section>
          )}
          <div
            className="guide-transcript"
            data-keyboard-pane="Tutorial"
            role="log"
            aria-label="Onboarding chat history"
            aria-live="polite"
            aria-relevant="additions"
            tabIndex={0}
            ref={bindTranscript}
            onClickCapture={event => {
              if (event.target instanceof Element && event.target.closest("button[data-flow]")) userReadPending.current = true
            }}
          >
            {GUIDE_STAGES.slice(0, stage + 1).map((asked, messageStep) => {
              const message = lessonMessage(messageStep, guide, touch)
              const line = lineOf(messageStep)
              const words = (text: string, from = 0) => text.split(" ").map((word, index, all) => {
                const pauses = all.slice(0, index).filter(part => /[.!?]$/.test(part)).length
                return <span
                  key={index}
                  className="guide-word"
                  style={{ "--word-delay": `${(from + index) * .015 + pauses * .06}s` } as CSSProperties}
                >{word}{" "}</span>
              })
              return (
                <Fragment key={messageStep}>
                {asked.message !== "" && lessonVisible(messageStep, guide) && <div
                  className="guide-message"
                  data-enter={messageStep === stage && messageStep === enteredStep.current}
                  onAnimationEnd={(event) => {
                    if (event.target !== event.currentTarget || messageStep !== stage) return
                    if (transcriptRef.current && readRef.current?.following) {
                      scrollToGuideRead(transcriptRef.current, stage, readRef.current.targetId)
                      readRef.current.top = transcriptRef.current.scrollTop
                    }
                  }}
                >
                  <article
                    className="guide-dialogue smithers-control"
                    data-message-step={messageStep}
                    data-current={messageStep === stage}
                    data-controlled={messageStep === stage}
                  >
                    <div className="guide-speaker"><span />SMITHERS</div>
                    <p data-line="1">{words(message)}</p>
                    {asked.kind === "say" && asked.more !== undefined && <p data-line="2">{words(asked.more, message.split(" ").length)}</p>}
                    {messageStep > 0 && asked.kind === "do" && done(messageStep) && (
                      <p className="guide-followup" data-followup="">
                        <Check className="guide-step-done" size={16} aria-label="Done" role="img" />
                        {line !== undefined ? <span>{line}</span> : null}
                      </p>
                    )}
                    {messageStep === stage && stage !== 12 && noticeContent}
                  </article>
                </div>}
                {entries.filter(entry => entry.step === messageStep).map(entry => <div
                  key={entry.kind === "card" ? entry.card.id : entry.message.id}
                  data-entry-step={messageStep}
                  // Only the active lesson's picker needs fields in the transcript's roving order.
                  data-keyboard-skip-fields={stage < GUIDE_LAST_STEP && !(lesson?.kind === "do" && lesson.completion === "change.opened" && entry.kind === "card" && entry.card.id === picker?.id) ? "" : undefined}
                  data-chat-message-id={entry.kind === "message" ? entry.message.id : undefined}
                  data-tutorial-cards={entry.kind === "card" ? "" : undefined}
                  data-tutorial-files={entry.kind === "card" ? "" : undefined}
                  data-tutorial-trace={entry.kind === "card" ? "" : undefined}
                >
                  {entry.kind === "card" ? <CardView card={entry.card} maximized={session.maximizedCardId === entry.card.id}
                    worldDocuments={worldDocuments} debugVerbose={session.verbose === true}
                    {...cardActions(controller)} /> : <TranscriptMessage entry={entry} streamingMessageId={streamingMessageId} />}
                </div>)}
                </Fragment>
              )
            })}
            {typing && <ChatMessage role="assistant" pending pendingLabel="Smithers is responding" />}
            <ReelShell clock={clock} />
            {signInPrompts.map(message => (
              <article key={message.id} className="message" data-testid="auth-prompt" data-chat-message-id={message.id}>
                <p>{message.text}</p>
                {message.answeredAction ? <p role="status">{message.answeredAction.answer}</p> :
                <Button className="message-cta"  {...flowAction(controller.runCommand, "auth.sign-in", message.action?.args)}>
                  {message.action?.label}
                </Button>}
              </article>
            ))}
          </div>
          {/* The reserved tip space holds for the whole help sequence, so the pills stay put while a tip moves to Chat. */}
          <div className="guide-actions" data-keyboard-pane="Lesson actions" data-help-sequence={showTutorialHelp && lesson?.kind === "do" && lesson.help?.introduction !== undefined || undefined}>
            {lesson?.kind === "do" && lesson.actions.map(suggestion => {
              const action = guideActionState(suggestion, lessonCards, guide)
              const guidedAction = lesson.help?.actionKey === action.key
              const helpOpen = guidedAction && showTutorialHelp && !chatHelpOpen
              const button = (
                <GuideButton key={suggestion.flow} className="guide-primary"
                  data-flow={action.flow} shortcut={action.key}
                  aria-describedby={`guide-instruction-${stage}${helpOpen ? ` guide-help-${stage}` : ""}`}
                  data-guided={helpOpen || undefined}
                  data-done={done(stage)}
                  disabled={action.disabled} aria-busy={action.busy || undefined}
                  onClick={() => runLessonAction(suggestion)}>
                  <span className="guide-primary-label">
                    {lessonText(action.label, guide)}
                    {action.subtitle !== undefined ? <small className="guide-primary-subtitle">{action.subtitle}</small> : null}
                  </span>
                </GuideButton>
              )
              return guidedAction ? (
                <HelpBubble key={suggestion.flow} id={`guide-help-${stage}`} open={helpOpen}
                  pulse={introduction === undefined}
                  placement={lesson.help?.introduction ? "above" : "flow"}
                  below=".guide-goal"
                  content={guidanceContent} onDismiss={() => setDismissedHelp(helpKey)}>
                  {button}
                </HelpBubble>
              ) : button
            })}
            {lesson?.kind === "do" && lesson.secondary !== undefined && (
              <GuideButton className="guide-secondary" data-flow={lesson.secondary.flow}
                data-secondary="" shortcut={lesson.secondary.key}
                onClick={() => runLessonAction(lesson.secondary!)}>
                {lesson.secondary.label}
              </GuideButton>
            )}
            {lesson?.kind === "do" && <span id={`guide-instruction-${stage}`} hidden>{lesson.instruction}</span>}
            {stage === 12 && noticeContent}
            <ReelShell clock={clock} actions />
          </div>
        </section>
      </main>
      </div>
        <section
          className="guide-composer-dock"
          role="dialog"
          aria-label="Chat"
          aria-modal={false}
          ref={node => {
            if (!node) return
            if (conversationOpen && !dockWasOpen.current) {
              node.querySelector<HTMLTextAreaElement>('textarea')?.focus()
            } else if (!conversationOpen && dockWasOpen.current) {
              opener.current?.focus()
            }
            dockWasOpen.current = conversationOpen
          }}
          inert={!conversationOpen ? true : undefined}
          aria-hidden={!conversationOpen}
        >
        <div className="guide-composer-clip">
          <section
            className="guide-composer-layer"
          >
            {session.dictating && (
              <GuideButton className="guide-dictation-stop" data-flow="chat.dictate" shortcut="Escape"
                onClick={() => {
                  controller.runCommand("chat.dictate")
                  document.querySelector<HTMLTextAreaElement>(".guide-composer-layer textarea")?.focus()
                }}>
                <Mic size={16} /> Stop dictation
              </GuideButton>
            )}
            <div className="guide-composer-host" ref={setComposerHost} />
            {conversationOpen && <div className="guide-composer-controls">
              <InputModeMenu mode={session.inputMode ?? "normal"} placement="below" onChange={mode => controller.runCommand("input.mode", mode)} />
              <GuideButton className="guide-composer-close" aria-label="Close Chat" onClick={runCommandClose}>{touch ? "Close" : <X size={16} />}</GuideButton>
            </div>}
          </section>
        </div>
        </section>
      {/* Beat 12's illustrated introductions overlay the shell while a background run builds. */}
      <IntroSlidesShell />
      {/* The footer shares the shell's column with the dock. */}
      <footer data-keyboard-pane="Tutorial controls" className="guide-footer">
        {stage >= GUIDE_BRIDGE && <LibrarianRunChips key={`${guide.playthrough ?? 0}:${stage}`} cards={cards} clock={clock} />}
        <div className="guide-progress" aria-label={`Lesson ${stage} of ${GUIDE_LAST_STEP}`}>
          {Array.from({ length: GUIDE_LAST_STEP }, (_, i) => (
            <span key={i} data-passed={i + 1 <= stage} />
          ))}
        </div>
        {stage >= 1 && (
          <div className="guide-chat-controls">
            <HelpBubble id={`guide-chat-help-${stage}`} placement="above" avoid=".guide-actions .guide-primary, .guide-actions .guide-secondary" below=".guide-goal" open={chatHelpOpen}
              content={guidanceContent} onDismiss={() => setDismissedHelp(helpKey)}>
            <GuideButton ref={opener} shortcut={GUIDE_KEYS.chat} data-flow="chat.open" data-pulse={lesson?.kind === "do" && lesson.completion === "palette.opened" && !done(stage)}
              aria-describedby={chatHelpOpen ? `guide-chat-help-${stage}` : undefined}
              onPointerDown={event => { if (event.pointerType === "touch") event.preventDefault() }}
              onMouseDown={event => event.preventDefault()}
              onClick={() => conversationOpen ? runCommandClose() : runCommandOpen()}>
              <span>Chat</span>
            </GuideButton>
            </HelpBubble>
            {!conversationOpen && <InputModeMenu mode={session.inputMode ?? "normal"} onChange={mode => controller.runCommand("input.mode", mode)} />}
          </div>
        )}
        {stage === GUIDE_LAST_STEP && (
          <GuideButton tabIndex={0} data-flow="onboarding.act" shortcut={GUIDE_KEYS.replay} onClick={() => runCommandGuide("restart")}>
            Replay introduction
          </GuideButton>
        )}
      </footer>
    </div>
    </InTutorial>
    </GuideComposerHost.Provider>
  )
}
