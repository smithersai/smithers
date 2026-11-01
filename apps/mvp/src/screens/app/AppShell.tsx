import { PageHeader, TIMELINE_ROOM, Wordmark } from "@smthrs/ui"
import type { CSSProperties } from "react"
import { NotificationsBell } from "../../features/attention/components/NotificationsBell"
import { SettingsLink } from "../../features/auth/components/SettingsLink"
import { ComposerGate } from "../../features/auth/components/ComposerGate"
import { ConnectionPill } from "../../features/chat/components/ConnectionPill"
import { Composer } from "../../features/chat/components/Composer"
import { FirstRunAccount } from "../../features/first-run/components/FirstRunAccount"
import { FirstRunGate } from "../../features/first-run/components/FirstRunGate"
import { FirstRunSteps } from "../../features/first-run/components/FirstRunSteps"
import { Conversation } from "../../features/chat/components/Conversation"
import { HeaderStatus } from "../../features/status/components/HeaderStatus"
import { ThemeButton } from "../../features/theme/components/ThemeButton"
import { Link } from "@tanstack/react-router"
import { Notices } from "../../features/attention/components/Notices"
import { Slot } from "../../plugins/components/Slot"
import "./app-shell.css"

export function AppShell() {
  return (
    <main className="app-shell" aria-label="App">
      <h1 className="app-shell-title">Chat</h1>
      {/* The one top bar: the wordmark and the agent's status at the left, the pages in the middle, the bell, theme
          and account at the right. The pages' row scrolls sideways on a phone instead of breaking. */}
      <PageHeader
        className="app-shell-header"
        back={
          <>
            <Link to="/app" className="app-shell-brand" aria-label="Smithers">
              <Wordmark />
            </Link>
            {/* What the agent is doing, and whether it needs you (decision 0015): its own live region. */}
            <span className="app-shell-agent" role="status" aria-label="Smithers" aria-live="polite">
              <HeaderStatus />
            </span>
            {/* The connection pill's live region holds only the pill, so screen readers hear each change of it alone. */}
            <span className="app-shell-connection" role="status" aria-label="Connection" aria-live="polite">
              <ConnectionPill />
            </span>
          </>
        }
        nav={
          <>
            {/* Your conversations (decision 0013), your own flows and this device's runs (decision 0014 §5), an
                Admin's settings, and the plugins' entries. */}
            <Link to="/app/conversations">Conversations</Link>
            <Link to="/app/flows">Flows</Link>
            <Link to="/app/runs">Runs</Link>
            <SettingsLink />
            <Slot name="shell.nav" />
          </>
        }
        navLabel="Pages"
        actions={
          <>
            {/* Your notifications (decision 0009): the unread count, and the panel it opens. */}
            <NotificationsBell />
            <ThemeButton />
            <FirstRunAccount />
          </>
        }
      />
      {/* The room the timeline rail wants beside the chat; app-shell.css shifts the column to leave it. */}
      <div className="app-shell-center" style={{ "--sui-timeline-want": `${TIMELINE_ROOM}px` } as CSSProperties}>
        {/* Until the person has a conversation of their own, the steps to their first one, above the composer's place,
            which they take while a step before Ask shows (decision 0121). */}
        <div className="app-shell-start">
          <FirstRunSteps />
        </div>
        <div className="app-shell-composer">
          <FirstRunGate>
            <ComposerGate>
              <Composer />
            </ComposerGate>
          </FirstRunGate>
        </div>
        <section className="app-shell-conversation" aria-label="Conversation">
          {/* Anchor after the pin so its controls stay clear; the stack still takes no space (0137). */}
          <Conversation notices={<Notices surface="conversation" />} />
        </section>
      </div>
    </main>
  )
}
