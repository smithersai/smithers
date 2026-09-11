import { Spinner } from "@smthrs/ui"
import { GUIDE_LESSONS, GUIDE_STAGES, GUIDE_LAST_STEP, type GuideAction } from "./lessons"
import { guideClock, readPause, scheduleGuideAdvance, type GuideClock } from "./advance"
import { GuideSteps } from "./GuideSteps"
import { ReelShell } from "./Reel.tsx"
import { guideForwardAction } from "./navigation"
import { LESSON_PLUGIN } from "./pluginLesson"
import { loadedApp } from "../plugins/appSurface"
import { PluginGallery } from "../plugins/PluginGallery"
import { PluginRail } from "../plugins/PluginRail"
import { useLiveQuery } from "@tanstack/react-db"
import { useRef, useState, type ReactNode, type CSSProperties } from "react"
import {
  Check,
  Command,
  Volume2,
  VolumeX,
  X,
} from "lucide-react"
import { useController } from "../ControllerContext"
import { initialGuide, conversationTabIdOf, inConversation } from "../state/AppState"
import { useCardRows } from "../state/useCardRows"
import { CardView } from "../ChatCards"
import { cardActions } from "../cards/CardActions"
import "./guide.css"

import { GuideComposerHost } from "./GuideComposerHost"

const lessons = GUIDE_LESSONS

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

export function GuideShell({ children, clock = guideClock }: { children: ReactNode; clock?: GuideClock }) {
  const controller = useController()
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const { data: toasts } = useLiveQuery(controller.store.collections.toasts)
  const cards = useCardRows(controller.store.collections.cards)
  const { data: worldDocuments } = useLiveQuery(controller.store.collections.worldDocuments)
  const session = sessions[0] ?? controller.store.session()
  const conversation = conversationTabIdOf(session)
  const lessonCards = cards.filter(card => inConversation(card, conversation)).sort((a, b) => a.ordinal - b.ordinal)
  const guide = session.guide ?? initialGuide()
  const stage = guide.step
  /*
   * Progression is data (GUIDE_STAGES): an informational lesson keeps talking
   * on its own after a read pause, and an actionable one waits for its real
   * outcome, then shows the instruction as done and moves on.
   */
  const lesson = GUIDE_STAGES[stage]
  const done = (step: number): boolean => {
    const asked = GUIDE_STAGES[step]
    return asked?.kind === "do" && (guide.completed ?? []).includes(asked.completion)
  }
  const paused = guide.autoPaused === true
  const showNext = lesson === undefined
    || (lesson.kind === "say" ? paused : lesson.skippable)
  const lastScrolledStep = useRef(-1)
  const transcriptRef = useRef<HTMLDivElement>(null)
  /* Keep the portal mounted so closing can animate without losing the draft. */
  const [composerHost, setComposerHost] = useState<HTMLDivElement | null>(null)
  /*
   * Only a message that mounts AT the current stage enters with the open
   * animation — Back rewinds the history and an earlier message becoming
   * current again must not re-enter.
   */
  const enteredStep = useRef(-1)
  if (stage > enteredStep.current) enteredStep.current = stage
  const opener = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  /*
   * The lessons install REAL plugins: the shelf below is the session's own,
   * and the sidebar shows what the plugin loader made of it — the same
   * computation the Library pane runs.
   */
  const installedPlugins = sessions[0]?.plugins ?? []
  const pluginRail = loadedApp(installedPlugins, (name) => controller.commands.find(name) !== undefined).surface.rail
  const runCommandGuide = (action: string, value?: string) => {
    controller.runCommand("onboarding.act", `${action}${value === undefined ? "" : ` ${JSON.stringify(value)}`}`)
    if (guide.sound && !["close", "sound"].includes(action)) chime()
  }
  const runCommandOpen = () => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    runCommandGuide("open")
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>(".guide-composer-layer textarea")?.focus(),
    )
  }
  const runCommandClose = () => {
    runCommandGuide("close")
    if (previousFocus.current?.isConnected) previousFocus.current.focus()
    else (opener.current ?? document.querySelector<HTMLElement>(".guide-shell"))?.focus()
  }
  const runCommandLive = (name: string) => {
    runCommandOpen()
    if (!controller.runCommand(name)) controller.send(`/${name}`)
  }
  const runLessonAction = (action: GuideAction) => {
    const args = action.flow === "plugins.install" ? LESSON_PLUGIN : action.args
    if (args === undefined) controller.runCommand(action.flow)
    else controller.runCommand(action.flow, args)
  }
  const runCommandSound = () => {
    runCommandGuide("sound")
    if (!guide.sound) chime()
  }
  const keyHint = (keys = "→") => (
    <kbd className="guide-button-key" aria-hidden="true" title={keys === "Tab ↵" ? "Tab to this button, then press Enter" : undefined}>{keys}</kbd>
  )
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
      // Terminal keeps the existing workspace CSS selector; data-stage is the durable lesson index.
      data-step={stage === GUIDE_LAST_STEP ? 14 : stage}
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
            if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
            const action = lesson?.kind === "do"
              ? lesson.actions?.find(action => action.key.toLowerCase() === event.key.toLowerCase())
              : undefined
            if (action) {
              event.preventDefault()
              if (!event.repeat) runLessonAction(action)
              return
            }
            if (event.key.toLowerCase() === "s") {
              event.preventDefault()
              if (!event.repeat) runCommandSound()
              return
            }
            if (event.key.toLowerCase() === "c") {
              event.preventDefault()
              if (!event.repeat) runCommandGuide("dark")
            } else if (stage === 6 && event.key.toLowerCase() === "r") {
              event.preventDefault()
              if (!event.repeat) controller.runCommand("wiki.create")
            } else if (event.key.toLowerCase() === "n") {
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
         * The tutorial presses Next for the reader. An informational lesson
         * advances after a read pause and ANY input cancels it (the reader is
         * doing something); a finished action holds long enough for its green
         * check to be seen and is never cancelled by the input that finished
         * it — so its timer listens on a target no gesture reaches.
         */
        const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
        const ready = lesson !== undefined && (lesson.kind === "say" ? lesson.terminal !== true : done(stage))
        const token = `${guide.playthrough ?? 0}:${stage}`
        const stopAdvance = !ready ? () => {} : scheduleGuideAdvance({
          target: lesson.kind === "say" ? document : new EventTarget(),
          clock,
          paused,
          delay: lesson.kind === "say" ? readPause(lessons[stage] ?? "", reduced) : 700 + (reduced ? 0 : 200),
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
      {
        /*
         * The app IS the default view: full-screen, without a composer. The
         * guide chrome covers it during the lessons; at the workspace step the
         * chrome steps aside (guide.css) and the app takes the window. The
         * composer itself is summoned into the top Command-K palette.
         */
      }
      {/*
        * The workspace is behind the tutorial chrome (guide.css): while a lesson
        * is running it is not reachable, so it leaves the a11y tree and the tab
        * order too. The lesson's own cards are projected into the transcript
        * below; without this the same card would answer a query twice.
        */}
      <div className="guide-app" inert={stage < GUIDE_LAST_STEP ? true : undefined} aria-hidden={stage < GUIDE_LAST_STEP}>
        {children}
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
          {stage === GUIDE_LAST_STEP ? "Your workspace" : ""}
        </span>

      </header>
      {guide.library && (
      <aside className="guide-sidebar" aria-label="Workspace sidebar">
        <div className="guide-plugin-rail">
          <span className="guide-section-label">YOUR PLUGINS</span>
          {/* Not a written list: what the installed plugins actually added. */}
          <PluginRail entries={pluginRail} onOpen={runCommandLive} />
        </div>
      </aside>
      )}
      <main className="guide-main">
        <section className="guide-lesson" aria-label={`Lesson ${stage + 1}`}>
          {stage < GUIDE_LAST_STEP && (
            <nav className="guide-navigation" aria-label="Lesson navigation">
              <button className="guide-back" disabled={stage === 0} aria-keyshortcuts="ArrowLeft" data-flow="onboarding.act" onClick={() => runCommandGuide("back")}>
                <span aria-hidden="true">←</span> Back {keyHint("←")}
              </button>
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
            {lessons.slice(0, stage + 1).map((message, messageStep) => (
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
                  <p>
                    {message.split(" ").map((word, index, words) => {
                      const pauses = words.slice(0, index).filter(part => /[.!?]$/.test(part)).length
                      return <span
                        key={index}
                        className="guide-word"
                        style={{ "--word-delay": `${index * .015 + pauses * .06}s` } as CSSProperties}
                      >{word}{" "}</span>
                    })}
                  </p>
                  {(() => {
                    const asked = GUIDE_STAGES[messageStep]
                    if (asked?.kind !== "do") return null
                    return <GuideSteps steps={asked.instructions ?? [asked.instruction]} done={done(messageStep)} />
                  })()}
                  {messageStep === 5 && stage === 5 && guide.library && (
                    <div className="guide-library" aria-label="Library">
                      <PluginGallery asked={LESSON_PLUGIN} installed={installedPlugins} onInstall={(id) => controller.runCommand("plugins.install", id)} />
                    </div>
                  )}
                </article>
              </div>
            ))}
            {/* The same persisted cards as the slash transcript: forms and repository
                choices must be usable while the tutorial covers the workspace. */}
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
            {lesson?.kind === "do" && lesson.actions?.map(action => (
              <button key={action.flow} type="button" className="guide-primary"
                data-flow={action.flow} aria-keyshortcuts={action.key.toLowerCase()}
                onClick={() => runLessonAction(action)}>
                {action.label} {keyHint(action.key)}
              </button>
            ))}
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
            aria-label="Talk to Smithers"
          >
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
        <div className="guide-progress" aria-label={`Lesson ${stage + 1} of ${GUIDE_STAGES.length}`}>
          {Array.from({ length: GUIDE_STAGES.length }, (_, i) => (
            <span key={i} data-passed={i <= stage} />
          ))}
        </div>
        {stage >= 1 && (
          <button ref={opener} data-flow="onboarding.act" onClick={runCommandOpen}>
            <Command size={14} />
            <span>Talk to Smithers</span>
            {keyHint("⌘ K")}
          </button>
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
