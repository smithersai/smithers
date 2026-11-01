import { Button, Card, CardContent, EmptyState, PageBody, PageHeader } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { Link } from "@tanstack/react-router"
import { NEW_FLOW, NEW_FLOW_PATH } from "../../features/flows-ui/contract"
import { NotificationsBell } from "../../features/attention/components/NotificationsBell"
import { FlowsPage } from "../../features/flows-ui/components/FlowsPage"
import "./flows-screen.css"

// /app/flows: your own flows and drafts (decision 0014 §5).
export function FlowsScreen() {
  const { data: session } = useLiveQuery(useAuth().queries.session)
  const signedIn = session?.status === "signed_in"
  return (
    <main className="flows-screen" aria-label="Flows">
      <PageHeader
        back={<Link to="/app">Back to chat</Link>}
        title="Flows"
        actions={
          <>
            {signedIn
              ? (
                <Button asChild variant="solid">
                  <Link to={NEW_FLOW_PATH}>{NEW_FLOW}</Link>
                </Button>
              )
              : null}
            <NotificationsBell />
          </>
        }
      />
      <PageBody width="default">
        {session?.status === "signed_out"
          ? (
            <Card>
              <CardContent>
                <EmptyState action={<SignInButton />} />
              </CardContent>
            </Card>
          )
          : <FlowsPage />}
      </PageBody>
    </main>
  )
}
