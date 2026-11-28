import { Card, CardContent, EmptyState, PageBody, PageHeader } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import { HostedModelSettings } from "../../features/auth/components/HostedModelSettings"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { useAuth } from "../../features/auth/components/AuthContext"
import { PersonalModelSettings } from "../../features/personal-model/components/PersonalModelSettings"
import { ConnectedAgentsSettings } from "../../features/mcp/components/ConnectedAgentsSettings"
import { BillingSettings } from "../../features/billing/components/BillingSettings"
import { canSave } from "../../features/personal-model/view"
import { AlertSettings } from "../../features/spend/components/AlertSettings"
import { SandboxLimitsSettings } from "../../features/spend/components/SandboxLimitsSettings"
import "./settings-screen.css"

// Each signed-in person manages their own connections here (AUTH-8). Admins also manage
// spend alert channels and sandbox limits.
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
            <>
              <Card>
                <CardContent className="settings-screen-section">
                  <BillingSettings admin={admin} />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="settings-screen-section">
                  <ConnectedAgentsSettings />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="settings-screen-section">
                  <PersonalModelSettings canSave={canSave(session)} />
                  <a href="/api/auth/connections">GitHub connections</a>
                </CardContent>
              </Card>
            </>
          )
          : null}
        {admin
          ? (
            <Card>
              <CardContent className="settings-screen-section">
                <HostedModelSettings />
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
