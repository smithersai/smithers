import { Spinner } from "@smthrs/ui"
import { SidebarRepositoryPicker } from "../Composer"
import { GUIDE_LESSONS } from "./lessons"
import { GuideSteps } from "./GuideSteps"
import { guideForwardAction } from "./navigation"
import { LESSON_PLUGIN } from "./pluginLesson"
import { loadedApp } from "../plugins/appSurface"
import { PluginGallery } from "../plugins/PluginGallery"
import { PluginRail } from "../plugins/PluginRail"
import { useLiveQuery } from "@tanstack/react-db"
import { createContext, Fragment, useRef, useState, type ReactNode, type CSSProperties } from "react"
import {
  BookOpen,
  Check,
  ChevronLeft,
  Command,
  GitPullRequest,
  History,
  Volume2,
  VolumeX,
  X,
} from "lucide-react"
import { useController } from "../ControllerContext"
import { conversationTabIdOf, initialGuide, inConversation } from "../state/AppState"
import "./guide.css"

/*
 * Where the summoned composer goes. The guide renders the app full-screen
 * with the composer hidden; Command-K summons ONLY the composer into the
 * bottom dock — the chat history stays in the workspace above.
 * `undefined` outside the guide (the bare app keeps its docked composer),
 * null until the persistent portal host mounts.
 */
export const GuideComposerHost = createContext<HTMLDivElement | null | undefined>(undefined)

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

const scrollProfileIntoView = (node: HTMLFormElement | null) => {
  if (node) requestAnimationFrame(() => {
    if (node.isConnected) node.scrollIntoView({ block: "nearest" })
  })
}

export function GuideShell({ children }: { children: ReactNode }) {
  const controller = useController()
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const { data: toasts } = useLiveQuery(controller.store.collections.toasts)
  const { data: messages } = useLiveQuery(controller.store.collections.messages)
  const { data: cards } = useLiveQuery(controller.store.collections.cards)
  const conversationTabId = conversationTabIdOf(sessions[0] ?? controller.store.session())
  // The outro belongs to an empty conversation. Real output owns this space
  // as soon as it exists, including after reload or a tutorial replay.
  const hasConversation = messages.some((row) => inConversation(row, conversationTabId)) ||
    cards.some((row) => inConversation(row, conversationTabId))
  const guide = sessions[0]?.guide ?? initialGuide()
  const stage = guide.step
  const lastScrolledStep = useRef(-1)
  const transcriptRef = useRef<HTMLDivElement>(null)
  // Animation progress is transient; the form answers remain in the store.
  const [finishedProfileMessage, setFinishedProfileMessage] = useState<number | null>(null)
  const profileMessageFinished = finishedProfileMessage === (guide.playthrough ?? 0)
  const finishProfileMessage = () => setFinishedProfileMessage(guide.playthrough ?? 0)
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
  // Transient save acknowledgement only; field values and progression live in the store.
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  const saveSequence = useRef(0)
  const runCommandGuide = (action: string, value?: string) => {
    const args = `${action}${value === undefined ? "" : ` ${JSON.stringify(value)}`}`
    if (action === "next" && stage === 3) {
      const sequence = ++saveSequence.current
      setSaveStatus("saving")
      void controller.commands.run("onboarding.act", args).then(
        (outcome) => {
          if (saveSequence.current === sequence)
            setSaveStatus(outcome.status === "executed" ? "saved" : "failed")
        },
        () => {
          if (saveSequence.current === sequence) setSaveStatus("failed")
        },
      )
    } else controller.runCommand("onboarding.act", args)
    if (guide.sound && !["title", "heard", "project", "close"].includes(action)) chime()
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
  const runCommandNext = () => runCommandGuide("next")
  const runCommandSound = () => {
    runCommandGuide("sound")
    if (!guide.sound) chime()
  }
  const keyHint = (keys = "↵ Enter") => (
    <kbd className="guide-button-key" aria-hidden="true" title={keys === "Tab ↵" ? "Tab to this button, then press Enter" : undefined}>{keys}</kbd>
  )
  const primary = (label: string, action = "next") => (
    <button
      className="guide-primary"
      data-flow="onboarding.act"
      data-action={action}
      aria-keyshortcuts="Enter ArrowRight"
      onClick={() => runCommandGuide(action)}
    >
      {label}
      {keyHint()}
    </button>
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
      data-step={stage}
      data-theme={sessions[0]?.theme ?? "light"}
      tabIndex={-1}
      ref={(node) => {
        if (!node) return
        if (document.activeElement === document.body) node.focus()
        // The composer is portaled and focus can fall back to the document.
        // Shell dismissal must work even when the key has no React ancestor.
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
          if (event.isComposing) return
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
            event.preventDefault()
            event.stopPropagation()
            guide.conversationOpen ? runCommandClose() : runCommandOpen()
          } else if (event.key === "Escape" && guide.conversationOpen) {
            event.preventDefault()
            event.stopPropagation()
            runCommandClose()
          }
        }
        document.addEventListener("keydown", onKeyDown, true)
        return () => document.removeEventListener("keydown", onKeyDown, true)
      }}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing) return
        if (
          !guide.conversationOpen &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey
        ) {
          const target = event.target instanceof Element ? event.target : null
          // Text editing retains arrows/Enter. Enter on a focused button retains its native action.
          if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
          if (event.key.toLowerCase() === "s") {
            event.preventDefault()
            if (!event.repeat) runCommandSound()
            return
          }
          if (event.key === "Enter" && target?.closest("button, a")) return
          if (stage === 4 && event.key.toLowerCase() === "r") {
            event.preventDefault()
            if (!event.repeat) runCommandGuide("wait-flow")
          } else if (stage === 2 && event.key.toLowerCase() === "n") {
            event.preventDefault()
            if (!event.repeat) runCommandGuide("notify")
          } else if (event.key === "ArrowRight" || event.key === "Enter") {
            event.preventDefault()
            if (event.repeat) return
            if (stage === 6 || stage === 14) runCommandOpen()
            /* The plugin lessons finish with the real flows, not a tutorial action. */
            else if (stage === 7) controller.runCommand("plugins")
            else if (stage === 8) controller.runCommand("plugins.install", LESSON_PLUGIN)
            else runCommandGuide(guideForwardAction(stage))
          } else if (event.key === "ArrowLeft" && stage > 0) {
            event.preventDefault()
            if (!event.repeat) runCommandGuide("back")
          }
        }
      }}
    >
      <div className="guide-content">
      {
        /*
         * The app IS the default view: full-screen, without a composer. The
         * guide chrome covers it during the lessons; at the workspace step the
         * chrome steps aside (guide.css) and the app takes the window. The
         * composer itself is summoned into the bottom Command-K dock.
         */
      }
      <div className="guide-app">
        {children}
      </div>
      <div className="guide-atmosphere" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <header className="guide-header">
        <span className="guide-location">
          {stage < 7 ? "" : stage < 14 ? "Your first adventure" : "Your workspace"}
        </span>

      </header>
      <aside className="guide-sidebar" aria-label="Workspace sidebar">
        <SidebarRepositoryPicker />
      {guide.library && (
        <div className="guide-plugin-rail">
          <span className="guide-section-label">YOUR PLUGINS</span>
          {/* Not a written list: what the installed plugins actually added. */}
          <PluginRail entries={pluginRail} onOpen={runCommandLive} />
        </div>
      )}
      </aside>
      <main className="guide-main">
        <section className="guide-lesson" aria-label={`Lesson ${stage + 1}`}>
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
                  data-controlled={messageStep === stage && (stage < 6 || stage === 9)}
                >
                  <div className="guide-speaker"><span />SMITHERS</div>
                  <p>
                    {message.split(" ").map((word, index, words) => {
                      const pauses = words.slice(0, index).filter(part => /[.!?]$/.test(part)).length
                      const profileLastWord = messageStep === 3 && index === words.length - 1
                      return <span
                        key={index}
                        className="guide-word"
                        style={{ "--word-delay": `${index * .015 + pauses * .06}s` } as CSSProperties}
                        ref={profileLastWord ? (node) => {
                          // Reduced motion (or revisiting an already read message) has no animation event.
                          if (!node) return
                          if (getComputedStyle(node).animationName === "none") finishProfileMessage()
                          node.addEventListener("animationcancel", finishProfileMessage)
                          return () => node.removeEventListener("animationcancel", finishProfileMessage)
                        } : undefined}
                        onAnimationEnd={profileLastWord ? finishProfileMessage : undefined}
                      >{word}{" "}</span>
                    })}
                  </p>
                </article>
              </div>
            ))}
          </div>
          {stage === 6 && (
            <GuideSteps
              steps={[
                <>Press <kbd className="guide-button-key">⌘ K</kbd> (or <kbd className="guide-button-key">Ctrl K</kbd>) and type a message to me</>,
              ]}
            />
          )}
          {stage === 3 && profileMessageFinished && (
            <form
              id="guide-profile"
              className="guide-form"
              ref={scrollProfileIntoView}
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget) event.currentTarget.scrollIntoView({ block: "nearest" })
              }}
              onSubmit={(event) => {
                event.preventDefault()
                runCommandNext()
              }}
            >
              <label>
                How did you hear about Smithers?
                <input
                  data-saved-value={guide.heard}
                  value={guide.heard}
                  onChange={(event) => runCommandGuide("heard", event.target.value)}
                  placeholder="A friend, a post, a happy accident…"
                  maxLength={500}
                />
              </label>
              <label>
                What would you love to build?
                <input
                  value={guide.project}
                  onChange={(event) => runCommandGuide("project", event.target.value)}
                  placeholder="A small idea is a great place to start"
                  maxLength={500}
                />
              </label>
              <p role="status">
                {saveStatus === "saving"
                  ? "Saving…"
                  : saveStatus === "saved"
                    ? "Saved."
                    : saveStatus === "failed"
                      ? "Your answer could not be saved. Please try again."
                      : "Answers are optional and shared with the Smithers team when you continue."}
              </p>
            </form>
          )}
          {stage === 7 && (
            <GuideSteps
              steps={[
                <>Type <kbd className="guide-button-key">/plugins</kbd> in the composer and press <kbd className="guide-button-key">↵ Enter</kbd></>,
              ]}
            />
          )}
          {stage === 8 && (
            <div className="guide-library">
              {/* The real Library, the same one `/plugins` opens on your workspace. */}
              <PluginGallery
                installed={installedPlugins}
                asked={LESSON_PLUGIN}
                onInstall={(id) => controller.runCommand("plugins.install", id)}
              />
            </div>
          )}
          {stage >= 7 && stage <= 13 && (
            <p className="guide-practice-note">
              ONBOARDING PREVIEW · Plugins install on this workspace for real. Repository runs begin only
              when you launch them.
            </p>
          )}
          {stage === 9 && (
            <div className="guide-background-flows">
              {[
                [BookOpen, "Build the wiki", "Read the code → connect concepts → write a living guide"],
                [
                  History,
                  "Tell the mythical history",
                  "Find foundations → order changes → explain the architecture",
                ],
              ].map(([Icon, label, detail]) => {
                const Glyph = Icon as typeof BookOpen
                return (
                  <div key={String(label)} className="smithers-control" data-controlled="true">
                    <Glyph size={20} />
                    <div>
                      <strong>{String(label)}</strong>
                      <p>{String(detail)}</p>
                    </div>
                    <span className="guide-tag">PREVIEW</span>
                  </div>
                )
              })}
              <p>These are the two proposed flows. No codebase is being processed in this rehearsal.</p>
            </div>
          )}
          {(stage === 10 || stage === 11) && (
            <div className="guide-prototype smithers-control" data-controlled={stage === 10}>
              <div className="guide-artifact-bar">
                <span>
                  <span className="guide-status-dot" />
                  POC / idea-board
                </span>
                <span>LIVE LOCAL PREVIEW</span>
              </div>
              <div className="guide-board">
                <span className="guide-board-overline">THE IDEA GARDEN</span>
                <h2>{guide.prototypeTitle || "Your next idea starts here"}</h2>
                <div className="guide-board-cards">
                  {["A spark", "A little experiment", "Something worth keeping"].map((item, i) => (
                    <article key={item} style={{ "--card": i } as CSSProperties}>
                      <span>0{i + 1}</span>
                      <h3>{item}</h3>
                      <p>
                        {
                          [
                            "What if we tried something new?",
                            "Make it small. Make it tangible.",
                            "Keep the lesson. Grow the idea.",
                          ][i]
                        }
                      </p>
                    </article>
                  ))}
                </div>
              </div>
              {stage === 11 && (
                <label className="guide-edit-label">
                  Edit the heading
                  <input
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        runCommandGuide("revise")
                      }
                    }}
                    aria-label="Prototype heading"
                    value={guide.prototypeTitle}
                    maxLength={100}
                    onChange={(event) => runCommandGuide("title", event.target.value)}
                  />
                </label>
              )}
            </div>
          )}
          {stage === 12 && (
            <div className="guide-history">
              <div className="guide-artifact-bar">
                <span>MYTH / practice change</span>
                <span>LOCAL REHEARSAL</span>
              </div>
              {[
                ["01", "Foundation", "Define the board and its idea model"],
                ["02", "Presentation", guide.prototypeTitle],
                ["03", "Verification", "Check the accepted revision, then review"],
              ].map(([n, heading, description]) => (
                <div className="guide-history-row" key={n}>
                  <span>{n}</span>
                  <div>
                    <strong>{heading}</strong>
                    <p>{description}</p>
                  </div>
                  {n === "02" && <span className="guide-tag">AMENDED</span>}
                </div>
              ))}
              <p className="guide-artifact-foot">
                Your feedback is carried into this practice plan. Your repository hasn’t changed.
              </p>
            </div>
          )}
          {stage === 13 && (
            <div className="guide-pr">
              <GitPullRequest size={22} />
              <div>
                <h2>Add the idea garden</h2>
                <p>{guide.prototypeTitle}</p>
                <div className="guide-pr-steps">
                  <span>Implement</span>
                  <span>Review + checks</span>
                  <span>Vibed</span>
                  <span>Cleanup + deliver</span>
                </div>
                <div className="guide-review-diff" aria-label="Practice heading change">
                  <span>Heading before</span>
                  <del>A little room for big ideas</del>
                  <span>Your proposed heading</span>
                  <ins>{guide.prototypeTitle}</ins>
                </div>
                <p className="guide-review-explanation">Review the direction you chose. You can go back and refine it before accepting this practice change.</p>
                <button className="guide-text-button" data-flow="onboarding.act" onClick={() => runCommandGuide("request-changes")}>
                  I’d like to change something {keyHint("Tab ↵")}
                </button>
                <small>Practice PR preview · nothing has been pushed or published.</small>
              </div>
            </div>
          )}
          {
            /*
             * The actions are ONE stable row: a new lesson message appends
             * above it and the row just moves with the layout — the controls
             * never re-animate or trade places with a retiring copy.
             */
          }
          {stage === 14 && !hasConversation && (
            <div className="guide-start-actions">
              {guide.acceptedPracticeTitle && <p className="guide-review-accepted"><Check size={14} /> Practice accepted: “{guide.acceptedPracticeTitle}”</p>}
              <button className="guide-primary" data-flow="connect" onClick={() => runCommandLive("connect")}>
                Choose a repository
                {keyHint("Tab ↵")}
              </button>
              <button
                className="guide-secondary"
                data-flow="feature.prototype"
                onClick={() => runCommandLive("feature.prototype")}
              >
                Start a real prototype
                {keyHint("Tab ↵")}
              </button>
              <p>
                Sign in when requested. Real runs show their actual progress and any missing setup in the
                conversation.
              </p>
            </div>
          )}
          <div className="guide-actions">
            {
              /*
               * The buttons of the next step are DIFFERENT controls, keyed by
               * step so reconciliation swaps the activated node out instead of
               * morphing it in place: a pointer click that advances into the
               * profile lesson must not let the browser's activation behavior
               * submit the freshly-mounted form the same gesture became (one
                * click was advancing 1 → 2 → 3 in a single gesture).
               */
            }
            <Fragment key={stage}>
            {stage === 2 && (
              <button className="guide-text-button" aria-keyshortcuts="N" data-flow="onboarding.act" onClick={() => runCommandGuide("notify")}>
                Send me a notification {keyHint("N")}
              </button>
            )}
            {stage === 4 && (
              <button className="guide-secondary" data-flow="onboarding.act" aria-keyshortcuts="R" disabled={guide.demoRun?.status === "running"} onClick={() => runCommandGuide("wait-flow")}>
                Run a flow {keyHint("R")}
              </button>
            )}
            {stage === 3 ? (profileMessageFinished && (
              <button type="submit" form="guide-profile" aria-keyshortcuts="Enter ArrowRight" className="guide-primary" data-flow="onboarding.act">
                Continue, with or without answers {keyHint()}
              </button>
            )) : stage === 1 ? (
              primary("Change theme", "dark")
            ) : stage === 6 ? (
              <button
                ref={opener}
                className="guide-primary"
                aria-keyshortcuts="Meta+k Control+k Enter ArrowRight"
                data-flow="onboarding.act"
                onClick={runCommandOpen}
              >
                <span>Call Smithers</span>
                {keyHint("⌘ K")}
                {keyHint()}
              </button>
            ) : stage === 7 ? (
              <button
                className="guide-primary"
                data-flow="plugins"
                aria-keyshortcuts="Enter ArrowRight"
                onClick={() => controller.runCommand("plugins")}
              >
                Open the Library
                {keyHint()}
              </button>
            ) : stage === 8 ? (
              <button
                className="guide-primary"
                data-flow="plugins.install"
                aria-keyshortcuts="Enter ArrowRight"
                onClick={() => controller.runCommand("plugins.install", LESSON_PLUGIN)}
              >
                Install the Librarian
                {keyHint()}
              </button>
            ) : stage === 11 ? (
              primary("Keep this direction", "revise")
            ) : stage === 13 ? (
              primary("Accept practice change", "accept-practice")
            ) : stage === 14 ? null : (
              primary(
                stage === 0
                  ? "Let’s begin"
                  : stage === 3
                    ? "Continue, with or without answers"
                    : stage === 9
                      ? "Let’s make something"
                      : stage === 10
                        ? "Try editing it"
                        : stage === 12
                          ? "See the path to a PR"
                          : stage === 13
                            ? "Take me to my workspace"
                            : "Continue",
              )
            )}
            {stage > 0 && stage < 14 && (
              <button
                className="guide-back"
                aria-keyshortcuts="ArrowLeft"
                data-flow="onboarding.act"
                onClick={() => runCommandGuide("back")}
              >
                <ChevronLeft size={13} />
                Back {keyHint("←")}
              </button>
            )}
            </Fragment>
          </div>
        </section>
      </main>
      </div>
        <div
          className="guide-composer-dock"
          inert={!guide.conversationOpen ? true : undefined}
          aria-hidden={!guide.conversationOpen}
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
      {/*
       * The footer is the shell's last row, BELOW the composer dock: the dock
       * grows between the workspace and this chrome, so the summoned composer
       * always appears above the footer.
       */}
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
        <div className="guide-progress" aria-label={`Lesson ${stage + 1} of 15`}>
          {Array.from({ length: 15 }, (_, i) => (
            <span key={i} data-passed={i <= stage} />
          ))}
        </div>
        {stage >= 6 && (
          <button ref={opener} data-flow="onboarding.act" onClick={runCommandOpen}>
            <Command size={14} />
            <span>Talk to Smithers</span>
            {keyHint("⌘ K")}
          </button>
        )}
        {stage === 14 && (
          <button data-flow="onboarding.act" onClick={() => runCommandGuide("restart")}>
            Replay introduction {keyHint("Tab ↵")}
          </button>
        )}
      </footer>
      {toasts.length > 0 && (
        <aside className="guide-toasts" aria-label="Notifications">
          {toasts.map((toast) => (
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
                {keyHint("Tab ↵")}
              </button>
            </div>
          ))}
        </aside>
      )}
    </div>
    </GuideComposerHost.Provider>
  )
}
