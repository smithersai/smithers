import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Account } from "../../features/auth/components/Account"
import { ThemeButton } from "../../features/theme/components/ThemeButton"

/** Navigation remains available when the requested page cannot render. Root supplies notices and the bell. */
export function RecoveryShell({ children }: { readonly children: ReactNode }) {
  return (
    <main className="recovery-shell" aria-label="Smithers">
      <header className="recovery-shell-header">
        <Link to="/app">Smithers</Link>
        <nav aria-label="Pages">
          <Link to="/app/conversations">Conversations</Link>
          <Link to="/app/flows">Flows</Link>
          <Link to="/app/runs">Runs</Link>
        </nav>
        <ThemeButton />
        <Account />
      </header>
      {children}
    </main>
  )
}
