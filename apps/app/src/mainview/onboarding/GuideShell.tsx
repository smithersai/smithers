import { Spinner } from "@smthrs/ui"
import {
  GUIDE_BRIDGE, GUIDE_LAST_STEP, GUIDE_PRACTICE_END, GUIDE_STAGES,
  lessonMessage, lessonText, type GoalCheckpoint, type GuideAction,
} from "./lessons"
import { guideClock, readPause, scheduleGuideAdvance, type GuideClock } from "./advance"
import { ReelShell } from "./Reel.tsx"
import { guideForwardAction } from "./navigation"
import { useLiveQuery } from "@tanstack/react-db"
import { useRef, useState, type ReactNode, type CSSProperties } from "react"
import { Check, Command, Mic, Volume2, VolumeX, X } from "lucide-react"
import { useController } from "../ControllerContext"
import { initialGuide, conversationTabIdOf, inConversation, type Card } from "../state/AppState"
import { useCardRows } from "../state/useCardRows"
import { CardView } from "../ChatCards"
import { cardActions } from "../cards/CardActions"
import { PRACTICE_CARD, PRACTICE_NAME, PRACTICE_REPO, PRACTICE_RUN_ID } from "../state/practice/PracticeRepository"
import "./guide.css"

import { GuideComposerHost } from "./GuideComposerHost"
import { InTutorial, tutorialTranscript } from "./transcriptScope"

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
  const { data: toasts } = useLiveQuery(controller.store.collections.toasts)
  const cards = useCardRows(controller.store.collections.cards)
  const { data: worldDocuments } = useLiveQuery(controller.store.collections.worldDocuments)
  const session = sessions[0] ?? controller.store.session()
  const conversation = conversationTabIdOf(session)
  const guide = session.guide ?? initialGuide()
  const stage = guide.step
  const practice = stage <= GUIDE_PRACTICE_END
  /* Not now at login: the workspace stays on the practice repository, badge and all (SCRIPT v4 "Escape hatches"). */
  const stillPractice = practice || (guide.repo === undefined && guide.declined?.includes("login") === true)
  /* The bridge (SCRIPT v4 principle 9): after practice, the practice cards step aside. */
  const lessonCards = tutorialTranscript(cards.filter(card => inConversation(card, conversation)))
    .filter(card => practice || !cardRepo(card)?.startsWith("practice:"))
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
  const skipped = guide.declined?.includes("practice") === true
  const goalComplete = GOAL.every(([goal]) => goalDone(goal))
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
   * ⌘K opens the palette (SCRIPT v4 "Open decision"): the composer rises
   * into the palette layer with "Ask Smithers" as its first row.
   */
  const runCommandOpen = () => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    runCommandGuide("open")
    controller.runCommand("palette.open")
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>(".guide-composer-layer textarea")?.focus(),
    )
  }
  const runCommandDictation = () => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    controller.runCommand("chat.dictate")
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".guide-composer-layer textarea")?.focus())
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
  const runLessonAction = (action: GuideAction) => {
    if (action.flow === "palette.open") {
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
  const keyHint = (keys = "→") => (
    <kbd className="guide-button-key" aria-hidden="true" title={keys === "Tab ↵" ? "Tab to this button, then press Enter" : undefined}>{keys}</kbd>
  )
  const lineOf = (step: number): string | undefined => {
    const asked = GUIDE_STAGES[step]
    if (asked?.kind !== "do" || !done(step)) return undefined
    return guide.said?.[asked.completion] ?? asked.success
  }
  const repoChip = stillPractice
    ? <span className="guide-repo-chip" data-practice="">{PRACTICE_NAME}</span>
    : <span className="guide-repo-chip" data-your-repo="">{guide.repo ?? "Your repository"}</span>
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
        // The composer is portaled and focus can fall back to the document.
        // Shell dismissal must work even when the key has no React ancestor.
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
          /* A playing reel owns Escape and Back; the tutorial must not navigate underneath it. */
          if (guide.reelIndex !== undefined) return
          if (event.isComposing) return
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
            event.preventDefault()
            event.stopPropagation()
            if (!event.repeat) guide.conversationOpen ? runCommandClose() : runCommandOpen()
          } else if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && guide.conversationOpen) {
            /* Escape closes only the palette or the composer, never a beat. */
            event.preventDefault()
            event.stopPropagation()
            runCommandClose()
            return
          }
          if (
            !guide.conversationOpen &&
            !session.paletteOpen &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey
          ) {
            const target = event.target instanceof Element ? event.target : null
            // Text editing retains arrows; Enter is always native, never guide navigation.
            if (target?.closest('input:not([type="checkbox"]), textarea, select, [contenteditable]:not([contenteditable="false"])')) return
            const key = event.key.toLowerCase()
            const action = lesson?.kind === "do"
              ? [...lesson.actions, ...(lesson.secondary === undefined ? [] : [lesson.secondary])].find(candidate => candidate.key.toLowerCase() === key)
              : undefined
            if (action) {
              event.preventDefault()
              if (!event.repeat) runLessonAction(action)
              return
            }
            if (lesson?.kind === "do" && lesson.practice === true && key === "q") {
              event.preventDefault()
              if (!event.repeat) runCommandGuide("skip-practice")
              return
            }
            /* Digits toggle the picker's rows, and only while the picker is the lesson. */
            if (/^[1-9]$/.test(key) && lesson?.kind === "do" && lesson.completion === "change.opened" && picker?.kind === "commit-pick") {
              event.preventDefault()
              if (!event.repeat) controller.runCommand("change.pick", key)
              return
            }
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && moveTrace(event.key === "ArrowDown" ? 1 : -1)) {
              event.preventDefault()
              return
            }
            if (key === "s") {
              event.preventDefault()
              if (!event.repeat) runCommandSound()
              return
            }
            if (key === "c") {
              event.preventDefault()
              if (!event.repeat) runCommandGuide("dark")
            } else if (key === "n") {
              event.preventDefault()
              if (!event.repeat) runCommandGuide("notify")
            } else if (event.key === "ArrowRight") {
              event.preventDefault()
              if (event.repeat) return
              runCommandGuide(guideForwardAction(stage))
            } else if (event.key === "ArrowLeft" && stage > 0) {
              event.preventDefault()
              if (!event.repeat) runCommandGuide("back")
            }
          }
        }
        document.addEventListener("keydown", onKeyDown, true)
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
          document.removeEventListener("keydown", onKeyDown, true)
        }
      }}
    >
      <div className="guide-content">
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
          {stage === GUIDE_LAST_STEP ? <>Your workspace{guide.repo !== undefined || stillPractice ? <> · {repoChip}</> : null}</> : repoChip}
        </span>
      </header>
      <main className="guide-main">
        <section className="guide-lesson" aria-label={`Lesson ${stage + 1}`}>
          {stage > 0 && stage < GUIDE_LAST_STEP && (
            <nav className="guide-navigation" aria-label="Lesson navigation">
              <button className="guide-back" disabled={stage === 0} aria-keyshortcuts="ArrowLeft" data-flow="onboarding.act" onClick={() => runCommandGuide("back")}>
                <span aria-hidden="true">←</span> Back {keyHint("←")}
              </button>
              {lesson?.kind === "do" && lesson.practice === true && (
                <button className="guide-back guide-skip" type="button" aria-keyshortcuts="q" data-flow="onboarding.act"
                  onClick={() => runCommandGuide("skip-practice")}>
                  Skip tutorial {keyHint("Q")}
                </button>
              )}
              {showNext && (
                <button
                  className="guide-back"
                  type="button"
                  aria-keyshortcuts="ArrowRight"
                  data-flow="onboarding.act"
                  onClick={() => runCommandGuide("next")}
                >
                  Next <span aria-hidden="true">→</span> {keyHint()}
                </button>
              )}
            </nav>
          )}
          {/* The goal and the stakes, pinned above the transcript (SCRIPT v4 principle 4). */}
          {stage > 0 && (practice || (skipped && stage === GUIDE_BRIDGE)) && (
            <section className="guide-goal" aria-label="Goal" data-goal-state={skipped ? "skipped" : goalComplete ? "complete" : "open"}>
              <p className="guide-goal-title">{PRACTICE_NAME} · Practice{skipped ? " · Skipped" : ""}</p>
              <p className="guide-goal-line">Fix a bug and send it for review as a Change.</p>
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
                requestAnimationFrame(() => { node.scrollTo({ top: node.scrollHeight }) })
              }
            }}
          >
            {GUIDE_STAGES.slice(0, stage + 1).map((asked, messageStep) => {
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
          <div className="guide-actions">
            {lesson?.kind === "do" && lesson.actions.map(action => {
              const chord = action.key.length > 1
              return (
                <button key={action.flow} type="button" className="guide-primary"
                  data-flow={action.flow} aria-keyshortcuts={chord ? "Meta+K Control+K" : action.key.toLowerCase()}
                  aria-describedby={`guide-instruction-${stage}`}
                  data-done={done(stage)}
                  onClick={() => runLessonAction(action)}>
                  <span className="guide-primary-label">
                    {lessonText(action.label, guide)}
                    {action.subtitle !== undefined ? <small className="guide-primary-subtitle">{action.subtitle}</small> : null}
                  </span>
                  {keyHint(action.key)}
                </button>
              )
            })}
            {lesson?.kind === "do" && lesson.secondary !== undefined && (
              <button type="button" className="guide-secondary" data-flow={lesson.secondary.flow}
                data-secondary="" aria-keyshortcuts={lesson.secondary.key.toLowerCase()}
                onClick={() => runLessonAction(lesson.secondary!)}>
                {lesson.secondary.label} {keyHint(lesson.secondary.key)}
              </button>
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
              <button type="button" className="guide-dictation-stop" data-flow="chat.dictate" onClick={runCommandDictation}>
                <Mic size={16} /> Stop dictation
              </button>
            )}
            <div className="guide-composer-host" ref={setComposerHost} />
          </section>
        </div>
        </div>
      {/* The footer is the shell's last row; the palette overlay floats above it. */}
      <footer className="guide-footer">
        <button
          data-flow="onboarding.act"
          onClick={runCommandSound}
          aria-keyshortcuts="s"
          aria-label={guide.sound ? "Mute tutorial sounds" : "Enable tutorial sounds"}
        >
          {guide.sound ? <Volume2 size={15} /> : <VolumeX size={15} />}
          <span>Sound {guide.sound ? "on" : "off"}</span>
          {keyHint("S")}
        </button>
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
        <div className="guide-progress" aria-label={`Lesson ${stage + 1} of ${GUIDE_STAGES.length}`}>
          {Array.from({ length: GUIDE_STAGES.length }, (_, i) => (
            <span key={i} data-passed={i <= stage} />
          ))}
        </div>
        {stage >= 1 && (
          <div className="guide-chat-controls">
            <button ref={opener} aria-keyshortcuts="Meta+K Control+K" data-flow="palette.open" data-pulse={lesson?.kind === "do" && lesson.completion === "palette.opened" && !done(stage)}
              onClick={runCommandOpen}>
              <Command size={14} />
              <span>Chat</span>
              {keyHint("⌘ K")}
            </button>
            <button type="button" data-flow="chat.dictate" aria-pressed={session.dictating === true}
              onClick={runCommandDictation}>
              <Mic size={14} />
              <span>{session.dictating ? "Stop dictation" : "Dictation"}</span>
            </button>
          </div>
        )}
        {stage === GUIDE_LAST_STEP && (
          <button data-flow="onboarding.act" onClick={() => runCommandGuide("restart")}>
            Replay introduction {keyHint("Tab ↵")}
          </button>
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
