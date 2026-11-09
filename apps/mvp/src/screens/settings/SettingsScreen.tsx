import { Card, CardContent, EmptyState, PageBody, PageHeader } from "@smthrs/ui"
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
      <PageHeader width="narrow" back={<Link to="/app">Back to chat</Link>} title="Settings" />
      <PageBody width="narrow">
        {session?.status === "signed_out"
          ? (
            <Card>
              <CardContent>
                <EmptyState action={<SignInButton />} />
              </CardContent>
            </Card>
          )
          : null}
        {session?.status === "signed_in"
          ? (
            <Card>
              <CardContent className="settings-screen-section">
                <PersonalModelSettings canSave={canSave(session)} />
                <a href="/api/auth/connections">GitHub connections</a>
              </CardContent>
            </Card>
          )
          : null}
        {admin
          ? (
            <Card>
              <CardContent className="settings-screen-section">
                <AlertSettings />
              </CardContent>
            </Card>
          )
          : null}
        {admin
          ? (
            <Card>
              <CardContent className="settings-screen-section">
                <SandboxLimitsSettings />
              </CardContent>
            </Card>
          )
          : null}
      </PageBody>
    </main>
  )
}
