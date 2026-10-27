import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { useAuth } from "../../features/auth/components/AuthContext"
import { PersonalModelSettings } from "../../features/personal-model/components/PersonalModelSettings"
import { canSave } from "../../features/personal-model/view"
import { AlertSettings } from "../../features/spend/components/AlertSettings"
import { SandboxLimitsSettings } from "../../features/spend/components/SandboxLimitsSettings"
import "./settings-screen.css"

// /app/settings: a signed-in Member's or above's own model, or Remove alone for anyone else who still has one saved
// (docs/features/personal-model.md#the-settings-section), and
// for an Admin, where spend alerts go outside the app (docs/features/spend-alerts.md#channels) and the sandbox limits
// (docs/features/sandbox-budgets.md#the-limits). Anyone else sees the page's header alone.
export function SettingsScreen() {
  const { queries } = useAuth()
  const { data: session } = useLiveQuery(queries.session)
  const admin = session?.status === "signed_in" && session.role === "admin"
  return (
    <main className="settings-screen" aria-label="Settings">
      <header className="settings-screen-header">
        <Link to="/app">Back to chat</Link>
        <h1>Settings</h1>
      </header>
      {session?.status === "signed_out" ? <SignInButton /> : null}
      {session?.status === "signed_in" ? <PersonalModelSettings canSave={canSave(session)} /> : null}
      {admin ? <AlertSettings /> : null}
      {admin ? <SandboxLimitsSettings /> : null}
    </main>
  )
}
