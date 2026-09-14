import { Spinner } from "@smthrs/ui"
import {
  GUIDE_BRIDGE, GUIDE_LAST_STEP, GUIDE_STAGES,
  lessonMessage, lessonText, lessonVisible, type GoalCheckpoint, type GuideAction,
} from "./lessons"
import { guideClock, readPause, scheduleGuideAdvance, type GuideClock } from "./advance"
import { ReelShell } from "./Reel.tsx"
import { guideForwardAction } from "./navigation"
import { useLiveQuery } from "@tanstack/react-db"
import { useCallback, useRef, useState, type ReactNode, type CSSProperties } from "react"
import { Check, Mic, Volume2, VolumeX, X } from "lucide-react"
import { useController } from "../ControllerContext"
import { initialGuide, conversationTabIdOf, inConversation, type Card } from "../state/AppState"
import { useCardRows } from "../state/useCardRows"
import { CardView } from "../ChatCards"
import { cardActions } from "../cards/CardActions"
import { PRACTICE_CARD, PRACTICE_REPO, PRACTICE_RUN_ID } from "../state/practice/PracticeRepository"
import "./guide.css"

import { bindPressActions, type PressAction } from "../runtime/PressActions"
import { InputModeMenu } from "../InputModeMenu"
import { vimFocusAction } from "../runtime/VimNavigation"
import { GuideButton, GUIDE_KEYS } from "./GuideButton"
import { GuideComposerHost } from "./GuideComposerHost"
import { InTutorial, tutorialTranscript } from "./transcriptScope"
import { HelpBubble } from "../HelpBubble"
import { GuidanceText } from "../GuidanceText"
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
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const { data: storedToasts } = useLiveQuery(controller.store.collections.toasts)
  // Old persisted tutorial tips are superseded by the action-anchored guidance.
  const toasts = storedToasts.filter(toast => !toast.key.startsWith("guide-tip-"))
  const cards = useCardRows(controller.store.collections.cards)
  const { data: worldDocuments } = useLiveQuery(controller.store.collections.worldDocuments)
  const session = sessions[0] ?? controller.store.session()
  const conversation = conversationTabIdOf(session)
  const guide = session.guide ?? initialGuide()
  const stage = guide.step
  const showPractice = stage <= GUIDE_BRIDGE
  const skipped = guide.declined?.includes("practice") === true
  /* Keep the payoff visible until the user acts on the bridge. Skipped practice stays hidden. */
  const lessonCards = tutorialTranscript(cards.filter(card => inConversation(card, conversation)))
    .filter(card => (showPractice && !skipped) || !cardRepo(card)?.startsWith("practice:"))
    .sort((a, b) => a.ordinal - b.ordinal)
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
    && dismissedHelp !== helpKey && !guide.conversationOpen && !session.paletteOpen
  const chatHelpOpen = showTutorialHelp && introduction?.target === "chat"
  const guidanceContent = lesson?.kind === "do" && lesson.help ? <GuidanceText
    key={`${helpKey}:${guidanceIndex}`}
    text={introduction?.content ?? lesson.help.content}
    onRead={introduction ? advanceGuidance : undefined}
  /> : null
  const paused = guide.autoPaused === true
  const showNext = lesson === undefined || (lesson.kind === "say" ? paused : lesson.skippable)
  const lastScrolledStep = useRef(-1)
  const transcriptRef = useRef<HTMLDivElement>(null)
  /* Keep the portal mounted so closing can animate without losing the draft. */
  const [composerHost, setComposerHost] = useState<HTMLDivElement | null>(null)
  /* Only a message that mounts AT the current stage enters with the open animation. */
  const enteredStep = useRef(-1)
  if (stage > enteredStep.current) enteredStep.current = stage
  /* The goal fills with a chime when the Change lands (sound is opt-in). */
  const changeLanded = useRef(goalDone("change"))
  if (goalDone("change") !== changeLanded.current) {
    changeLanded.current = goalDone("change")
    if (changeLanded.current && guide.sound) queueMicrotask(chime)
  }
  const opener = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const picker = cards.find(card => card.id === PRACTICE_CARD.commits)
  const runCard = cards.find(card => card.id === PRACTICE_CARD.run)
  const librarianRuns = cards.flatMap(card => card.kind === "run-trace" && typeof card.payload.input?._librarian === "object" ? [card] : [])
  const runCommandGuide = (action: string, value?: string) => {
    controller.runCommand("onboarding.act", `${action}${value === undefined ? "" : ` ${JSON.stringify(value)}`}`)
    if (guide.sound && !["close", "sound"].includes(action)) chime()
  }
  /*
   * C opens Chat (Cmd/Ctrl-K remains an alias) (SCRIPT v4 "Open decision"): the composer rises
   * into the palette layer with "Ask Smithers" as its first row.
   */
  const runCommandOpen = () => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    controller.runCommand("chat.open")
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>(".guide-composer-layer textarea")?.focus(),
    )
  }
  const runCommandClose = () => {
    controller.cancelDictation()
    controller.closePalette()
    runCommandGuide("close")
    if (previousFocus.current?.isConnected) previousFocus.current.focus()
    else (opener.current ?? document.querySelector<HTMLElement>(".guide-shell"))?.focus()
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
  }
  const runCommandSound = () => {
    runCommandGuide("sound")
    if (!guide.sound) chime()
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
    enabled: () => !guide.finished && guide.reelIndex === undefined && !document.querySelector(".input-mode-menu"),
    resolve: (event) => {
      const key = event.key.toLowerCase()
      const action = (activate: () => void, shortcut = key): PressAction => ({
        element: Array.from(document.querySelectorAll<HTMLElement>('.session-shell [aria-keyshortcuts], .guide-shell [aria-keyshortcuts]'))
          .find(button => !button.closest('[inert], [aria-hidden="true"]') && button.getAttribute('aria-keyshortcuts')?.toLowerCase().split(' ').includes(shortcut)),
        activate,
      })
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key === 'k') {
        return action(() => guide.conversationOpen ? runCommandClose() : runCommandOpen(), event.metaKey ? 'meta+k' : 'control+k')
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (key === 'escape' && guide.conversationOpen) return action(runCommandClose)
      if (key === GUIDE_KEYS.mode) return action(() => document.querySelector<HTMLButtonElement>('.guide-shell [aria-haspopup="menu"][aria-keyshortcuts="m"]')?.click())
      if (key === GUIDE_KEYS.chat) return action(() => guide.conversationOpen ? runCommandClose() : runCommandOpen())
      if (session.inputMode === 'vim' && ['h', 'j', 'k', 'l'].includes(key)) {
        const root = document.querySelector<HTMLElement>(guide.conversationOpen ? '.guide-composer-layer' : '.guide-shell')
        return root ? vimFocusAction(root, key) : undefined
      }
      if (key === 'w') return action(() => controller.runCommand('sidebar.toggle'))
      if (guide.conversationOpen || session.paletteOpen) return
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
      if (key === 'e' && stage === GUIDE_LAST_STEP) return action(() => controller.runCommand('tut.more'))
    },
  }
  // Ref ownership survives incidental renders (for example the auto-advance pause on keydown).
  const bindInputs = useCallback((node: HTMLDivElement | null) => {
    if (!node?.parentElement) return
    return bindPressActions({ root: node.closest<HTMLElement>(".session-shell") ?? node.parentElement,
      resolveShortcut: event => inputHandlers.current.resolve(event),
      enabled: () => inputHandlers.current.enabled(),
    })
  }, [stage, guide.playthrough, guide.reelIndex])
  if (guide.finished) return <>{children}</>
  return (
    <GuideComposerHost.Provider value={composerHost}>
    <div
      key={guide.playthrough ?? 0}
      className="guide-shell"
      data-flows={controller.commands
        .all()
        .map((command) => command.name)
        .join(" ")}
      data-conversation-open={guide.conversationOpen}
      data-step={stage}
      data-stage={stage}
      data-theme={sessions[0]?.theme ?? "light"}
      tabIndex={-1}
      ref={(node) => {
        if (!node) return
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
        const spoken = lesson?.kind === "say" ? `${lessonMessage(stage, guide)} ${lesson.more ?? ""}` : ""
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
      <div className="guide-app" inert={stage < GUIDE_LAST_STEP ? true : undefined} aria-hidden={stage < GUIDE_LAST_STEP}>
        <InTutorial value={true}>{children}</InTutorial>
        {/* The optional capability reel: inline at workspace width, after the last lesson. */}
        <ReelShell clock={clock} />
      </div>
      <div className="guide-atmosphere" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <header className="guide-header">
        <span className="guide-location">
          {stage === GUIDE_LAST_STEP ? "Your workspace" : null}
        </span>
      </header>
      <main className="guide-main">
        <section className="guide-lesson" aria-label={`Lesson ${stage}`}>
          {stage > 0 && stage < GUIDE_LAST_STEP && (
            <nav className="guide-navigation" aria-label="Lesson navigation">
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
            role="log"
            aria-label="Onboarding chat history"
            aria-live="polite"
            aria-relevant="additions"
            tabIndex={0}
            ref={(node) => {
              transcriptRef.current = node
              if (node && lastScrolledStep.current !== stage) {
                lastScrolledStep.current = stage
                requestAnimationFrame(() => {
                  const latest = node.querySelector("[data-tutorial-cards]")?.lastElementChild
                  if (latest) latest.scrollIntoView({ block: "nearest", behavior: "instant" })
                  else node.scrollTo({ top: node.scrollHeight })
                })
              }
            }}
          >
            {GUIDE_STAGES.slice(0, stage + 1).map((asked, messageStep) => {
              if (asked.message === "" || !lessonVisible(messageStep, guide)) return null
              const message = lessonMessage(messageStep, guide)
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
                <div
                  key={messageStep}
                  className="guide-message"
                  data-enter={messageStep === stage && messageStep === enteredStep.current}
                  onAnimationEnd={(event) => {
                    /* The open grows the history: settle the scroll at the bottom. */
                    if (event.target !== event.currentTarget) return
                    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight })
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
                    {messageStep === stage && guide.notice !== undefined && (
                      <p className="guide-notice" role="status" data-notice="">{guide.notice}</p>
                    )}
                  </article>
                </div>
              )
            })}
            {/* The same persisted cards as the slash transcript: forms and pickers
                must be usable while the tutorial covers the workspace. */}
            {stage < GUIDE_LAST_STEP && (
              <div data-tutorial-cards="" data-tutorial-files="" data-tutorial-trace="">
                {lessonCards.map(card => (
                  <CardView key={card.id} card={card} maximized={session.maximizedCardId === card.id}
                    worldDocuments={worldDocuments} debugVerbose={session.verbose === true}
                    {...cardActions(controller)} />
                ))}
              </div>
            )}
          </div>
          <div className="guide-actions" data-help-sequence={lesson?.kind === "do" && lesson.help?.introduction !== undefined || undefined}>
            {lesson?.kind === "do" && lesson.actions.map(suggestion => {
              const action = guideActionState(suggestion, lessonCards, guide)
              const guidedAction = lesson.help?.actionKey === action.key
              const helpOpen = guidedAction && showTutorialHelp && !chatHelpOpen
              const button = (
                <GuideButton key={action.flow} className="guide-primary"
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
                <HelpBubble key={action.flow} id={`guide-help-${stage}`} open={helpOpen}
                  pulse={introduction === undefined}
                  placement={lesson.help?.introduction ? "above" : "flow"}
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
          </div>
        </section>
      </main>
      </div>
        <div
          className="guide-composer-dock"
          inert={!guide.conversationOpen ? true : undefined}
          aria-hidden={!guide.conversationOpen}
          /* Clicking the scrim (not the palette) dismisses, like a command palette. */
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              event.preventDefault()
              runCommandClose()
            }
          }}
        >
        <div className="guide-composer-clip">
          <section
            className="guide-composer-layer"
            role="dialog"
            aria-label="Chat"
          >
            {session.dictating && (
              <GuideButton className="guide-dictation-stop" data-flow="chat.dictate" shortcut="Tab ↵" onClick={() => controller.runCommand("chat.dictate")}>
                <Mic size={16} /> Stop dictation
              </GuideButton>
            )}
            <div className="guide-composer-host" ref={setComposerHost} />
          </section>
        </div>
        </div>
      {/* The footer is the shell's last row; the palette overlay floats above it. */}
      <footer className="guide-footer">
        <GuideButton
          data-flow="onboarding.act"
          onClick={runCommandSound}
          shortcut={GUIDE_KEYS.sound}
          aria-label={guide.sound ? "Mute tutorial sounds" : "Enable tutorial sounds"}
        >
          {guide.sound ? <Volume2 size={15} /> : <VolumeX size={15} />}
          <span>Sound {guide.sound ? "on" : "off"}</span>
        </GuideButton>
        {/* Background runs stay in the chrome after the tutorial ends (SCRIPT v4 beat 12): the footer is the chrome the terminal keeps. */}
        {librarianRuns.length > 0 && stage >= GUIDE_BRIDGE && (
          <span className="guide-run-chips" aria-label="Background runs">
            {librarianRuns.map(run => {
              const kind = (run.payload.input?._librarian as { kind?: string }).kind
              return <span key={run.id} className="guide-run-chip" data-run-chip={kind} data-phase={run.payload.phase}>
                {kind === "wiki" ? "Wiki" : "History"} · {run.payload.steps[run.payload.steps.length - 1] ?? run.payload.phase}
              </span>
            })}
          </span>
        )}
        <div className="guide-progress" aria-label={`Lesson ${stage} of ${GUIDE_LAST_STEP}`}>
          {Array.from({ length: GUIDE_LAST_STEP }, (_, i) => (
            <span key={i} data-passed={i + 1 <= stage} />
          ))}
        </div>
        {stage >= 1 && (
          <div className="guide-chat-controls">
            <HelpBubble id={`guide-chat-help-${stage}`} placement="above" open={chatHelpOpen}
              content={guidanceContent} onDismiss={() => setDismissedHelp(helpKey)}>
            <GuideButton ref={opener} shortcut={GUIDE_KEYS.chat} data-flow="chat.open" data-pulse={lesson?.kind === "do" && lesson.completion === "palette.opened" && !done(stage)}
              aria-describedby={chatHelpOpen ? `guide-chat-help-${stage}` : undefined}
              onClick={runCommandOpen}>
              <span>Chat</span>
            </GuideButton>
            </HelpBubble>
            <InputModeMenu mode={session.inputMode ?? "normal"} onChange={mode => controller.runCommand("input.mode", mode)} />
          </div>
        )}
        {stage === GUIDE_LAST_STEP && (
          <GuideButton data-flow="onboarding.act" shortcut="Tab ↵" onClick={() => runCommandGuide("restart")}>
            Replay introduction
          </GuideButton>
        )}
      </footer>
      {toasts.length > 0 && (
        <aside className="guide-toasts" aria-label="Notifications">
          {[...toasts].sort((a, b) => b.createdAt - a.createdAt).map((toast) => (
            <div className="guide-toast" key={toast.id} data-toast-status={toast.status} role={toast.status === "failed" ? "alert" : "status"}>
              {toast.status === "running" ? <Spinner size="sm" aria-label="Working" /> : toast.status === "ok" ? <Check size={17} aria-hidden="true" /> : <X size={17} aria-hidden="true" />}
              <div>
                <strong>{toast.title}</strong>
                {toast.detail && <p>{toast.detail}</p>}
              </div>
              <button
                aria-label={`Dismiss ${toast.title}`}
                data-flow="toast.dismiss"
                onClick={() => controller.runCommand("toast.dismiss", toast.id)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </aside>
      )}
    </div>
    </GuideComposerHost.Provider>
  )
}
