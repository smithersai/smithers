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
import { Slot } from "../../plugins/components/Slot"
import { Toasts } from "./Toasts"
import "./app-shell.css"

export function AppShell() {
  return (
    <main className="app-shell" aria-label="App">
      <h1 className="app-shell-title">Chat</h1>
      <header className="app-shell-header">
        {/* What the agent is doing, and whether it needs you (decision 0015): its own live region, first in the row. */}
        <div className="app-shell-agent" role="status" aria-label="Smithers" aria-live="polite">
          <HeaderStatus />
        </div>
        {/* The connection pill's live region holds only the pill, so screen readers hear each change of it alone. */}
        <div className="app-shell-connection" role="status" aria-label="Connection" aria-live="polite">
          <ConnectionPill />
        </div>
        {/* Your conversations (decision 0013), your own flows and this device's runs (decision 0014 §5), an Admin's
            settings, and the plugins' entries. */}
        <nav className="app-shell-nav" aria-label="Pages">
          <Link to="/app/conversations">Conversations</Link>
          <Link to="/app/flows">Flows</Link>
          <Link to="/app/runs">Runs</Link>
          <SettingsLink />
          <Slot name="shell.nav" />
        </nav>
        {/* Your notifications (decision 0009): the unread count, and the panel it opens. */}
        <NotificationsBell />
        <ThemeButton />
        <FirstRunAccount />
      </header>
      {/* The toasts, under the header and its pill: the open composer docks over the column's foot, so a toast there
          would hide behind it (decision 0015). */}
      <Toasts />
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
        <Conversation />
      </section>
    </main>
  )
}
