import { Button } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useSearch } from "@tanstack/react-router"
import { SIGN_IN_FAILED, SIGN_IN_FAILED_PARAM, SIGN_OUT } from "../contract"
import { useAuth } from "./AuthContext"
import { SignInButton } from "./SignInButton"

// Who is signed in, for the header: their GitHub login and Sign out; or, signed out, the sign-in button, with
// "Couldn't sign in." after GitHub's callback failed. A page whose own content offers sign-in, `/app`'s first run, passes
// `signIn={false}`, so the page has one sign-in action.
export function Account({ signIn = true }: { readonly signIn?: boolean } = {}) {
  const { queries, actions } = useAuth()
  const { data: session } = useLiveQuery(queries.session)
  const search: Record<string, unknown> = useSearch({ strict: false })
  if (session === undefined || session.status === "loading") return null
  if (session.status === "signed_in") {
    return (
      <span aria-label="Account">
        <span>{session.login}</span>
        <Button variant="ghost" size="sm" disabled={session.signingOut} onClick={actions.signOut}>
          {SIGN_OUT}
        </Button>
      </span>
    )
  }
  return (
    <span aria-label="Account">
      {search[SIGN_IN_FAILED_PARAM] === "failed" ? <span role="alert">{SIGN_IN_FAILED}</span> : null}
      {signIn ? <SignInButton /> : null}
    </span>
  )
}
