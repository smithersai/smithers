import type { ReactNode } from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { PageNotices } from "../../features/attention/components/PageNotices"
import { floatsBell } from "../../features/attention/contract"
import { Account } from "../../features/auth/components/Account"
import { ThemeButton } from "../../features/theme/components/ThemeButton"

/** Navigation remains available when the requested page cannot render. Supply the failed header’s controls if Root normally leaves them to the page. */
export function RecoveryShell({ children }: { readonly children: ReactNode }) {
  const routeId = useRouterState({ select: (state) => state.matches.at(-1)?.routeId })
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
      {floatsBell(routeId) ? null : <PageNotices />}
      {children}
    </main>
  )
}
