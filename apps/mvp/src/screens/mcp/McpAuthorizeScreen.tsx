import { Button, Card, CardContent, EmptyState, PageBody, PageHeader } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, useLocation } from "@tanstack/react-router"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { AgentPermissions } from "../../features/mcp/components/AgentPermissions"
import { useMcp } from "../../features/mcp/components/McpContext"
import {
  ACCESS,
  AUTHORIZE,
  AUTHORIZE_AGENT,
  CANCEL,
  CLIENT,
  errorText,
  LOADING,
  REDIRECTING,
  REPOSITORY,
  RETURNS_TO,
  REVIEW_REQUEST,
  ROLE,
  SIGN_IN_TO_AUTHORIZE,
  BACK_TO_CHAT,
} from "../../features/mcp/copy"
import { consentView } from "../../features/mcp/view"
import "./mcp-authorize-screen.css"

// /app/mcp/authorize: the browser half of an MCP client's OAuth 2.1 authorization. A signed-out person sees
// "Sign in with GitHub", which returns to this path with its search, so the request survives sign-in. A signed-in
// person sees who asks, who the agent acts as (`<login> (agent)`), the repository, their live GitHub role there, what
// that role allows and what stays person-only, then Cancel and Authorize. Either decision goes to ChatApi, and the
// browser leaves for the callback only when it is the one the request registered (features/mcp/view.ts
// `verifiedRedirect`). The route's loader reads the request (`mcp.actions.loadConsent(location.searchStr)`); until
// something has, the screen offers to.
export function McpAuthorizeScreen() {
  const auth = useAuth()
  const { queries, actions } = useMcp()
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: consent } = useLiveQuery(queries.consent)
  const location = useLocation()
  const search = location.searchStr
  const status = consent?.status ?? "idle"
  const signedOut = session?.status === "signed_out" || (status === "signed_out" && session?.status !== "signed_in")
  const details = consent?.details ?? null
  const view = details === null ? null : consentView(details)
  const submitting = consent?.submitting ?? null
  const leaving = status === "done"
  // The press's own handler leaves the page, with the URL the action verified: a navigation the person asked for.
  const decide = (decision: "approve" | "deny") =>
    void actions.submitConsent(decision, search).then((redirectTo) => {
      if (redirectTo !== undefined) {
        const link = document.createElement("a")
        link.href = redirectTo
        link.rel = "noreferrer"
        link.click()
      }
    })
  return (
    <main className="mcp-authorize-screen" aria-label={AUTHORIZE_AGENT}>
      <PageHeader width="narrow" back={<Link to="/app">{BACK_TO_CHAT}</Link>} title={AUTHORIZE_AGENT} />
      <PageBody width="narrow">
        {signedOut
          ? (
            <Card>
              <CardContent>
                <EmptyState title={SIGN_IN_TO_AUTHORIZE} action={<SignInButton />} />
              </CardContent>
            </Card>
          )
          : (
            <Card>
              <CardContent className="mcp-authorize">
                {view === null
                  ? (
                    <>
                      <p role="status">{status === "loading" ? LOADING : errorText(consent?.error ?? null)}</p>
                      {status === "loading" ? null : (
                        <div className="mcp-authorize-actions">
                          <Button variant="outline" onClick={() => void actions.loadConsent(search)}>{REVIEW_REQUEST}</Button>
                        </div>
                      )}
                    </>
                  )
                  : (
                    <>
                      <h2>{view.heading}</h2>
                      <dl className="mcp-authorize-facts">
                        <dt>{CLIENT}</dt>
                        <dd>{view.clientName}</dd>
                        <dt>{REPOSITORY}</dt>
                        <dd>{view.repoScope}</dd>
                        <dt>{ROLE}</dt>
                        <dd>{view.roleLabel}</dd>
                        <dt>{ACCESS}</dt>
                        <dd>{view.scopes.join(" + ")}</dd>
                        <dt>{RETURNS_TO}</dt>
                        <dd>{view.returnsTo}</dd>
                      </dl>
                      <AgentPermissions
                        roleLabel={view.roleLabel}
                        allowed={view.allowed}
                        blocked={view.blocked}
                        who={<strong>{view.actor}</strong>}
                      />
                      <p role="status">{leaving ? REDIRECTING : errorText(consent?.error ?? null)}</p>
                      <div className="mcp-authorize-actions">
                        <Button variant="outline" disabled={submitting !== null || leaving} onClick={() => decide("deny")}>{CANCEL}</Button>
                        <Button variant="solid" disabled={submitting !== null || leaving} onClick={() => decide("approve")}>{AUTHORIZE}</Button>
                      </div>
                    </>
                  )}
              </CardContent>
            </Card>
          )}
      </PageBody>
    </main>
  )
}
