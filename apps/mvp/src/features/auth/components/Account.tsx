import { Button } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useSearch } from "@tanstack/react-router"
import { useOptionalChat } from "../../../AppContext"
import { useOptionalTodos } from "../../todos/components/TodosContext"
import { SIGN_IN_FAILED, SIGN_IN_FAILED_PARAM, SIGN_OUT } from "../contract"
import { useAuth } from "./AuthContext"
import { SignInButton } from "./SignInButton"

// Who is signed in, for the header: their GitHub login and Sign out; or, signed out, the sign-in button, with
// "Couldn't sign in." after GitHub's callback failed. Signing out with unsent local writes asks once before wiping the
// device. A page whose own content offers sign-in, `/app`'s first run, passes `signIn={false}`, so the page has one
// sign-in action.
export function Account({ signIn = true }: { readonly signIn?: boolean } = {}) {
  const { queries } = useAuth()
  const { data: session } = useLiveQuery(queries.session)
  const search: Record<string, unknown> = useSearch({ strict: false })
  if (session === undefined || session.status === "loading") return null
  if (session.status === "signed_in") {
    return <SignedInAccount login={session.login} signingOut={session.signingOut} confirming={session.confirmSignOut === true} />
  }
  return (
    <span aria-label="Account">
      {search[SIGN_IN_FAILED_PARAM] === "failed" ? <span role="alert">{SIGN_IN_FAILED}</span> : null}
      {signIn ? <SignInButton /> : null}
    </span>
  )
}

function SignedInAccount({ login, signingOut, confirming }: { readonly login: string | null; readonly signingOut: boolean; readonly confirming: boolean }) {
  const { actions } = useAuth()
  const chat = useOptionalChat()
  const todos = useOptionalTodos()
  return (
    <span aria-label="Account">
      <span>{login}</span>
      {chat !== null && todos !== null
        ? <SignOutWithPending chat={chat} todos={todos} signingOut={signingOut} confirming={confirming} />
        : (
          <Button variant="ghost" size="sm" disabled={signingOut} onClick={actions.signOut}>
            {SIGN_OUT}
          </Button>
        )}
    </span>
  )
}

function SignOutWithPending({
  chat,
  todos,
  signingOut,
  confirming,
}: {
  readonly chat: NonNullable<ReturnType<typeof useOptionalChat>>
  readonly todos: NonNullable<ReturnType<typeof useOptionalTodos>>
  readonly signingOut: boolean
  readonly confirming: boolean
}) {
  const { actions } = useAuth()
  const { data: place } = useLiveQuery(chat.queries.place)
  const { data: queued } = useLiveQuery(chat.queries.of(place?.conversationId).queued)
  const { data: sending } = useLiveQuery(todos.queries.sending)
  const pending = queued.length + sending.length
  if (confirming && pending > 0) {
    return (
      <>
        <span role="alert">{pending} unsent — wiping device</span>
        <Button variant="destructive" size="sm" disabled={signingOut} onClick={actions.signOut}>
          Sign out anyway
        </Button>
        <Button variant="ghost" size="sm" disabled={signingOut} onClick={actions.cancelSignOut}>
          Cancel
        </Button>
      </>
    )
  }
  return (
    <Button variant="ghost" size="sm" disabled={signingOut} onClick={pending > 0 ? actions.promptSignOut : actions.signOut}>
      {SIGN_OUT}
    </Button>
  )
}
