import { Button } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useLocation } from "@tanstack/react-router"
import { SIGN_IN, SIGN_IN_TO_SEND, signInHref } from "../contract"
import { useAuth } from "./AuthContext"

// "Sign in with GitHub": a link the person presses, never a redirect the app makes (decision 0008 §3). It returns to
// this page. Hidden where this deployment can't sign anyone in.
export function SignInButton() {
  const { queries, actions } = useAuth()
  const { data: session } = useLiveQuery(queries.session)
  const location = useLocation()
  if (session?.available !== true) return null
  return (
    <Button asChild variant="solid">
      <a href={signInHref(`${location.pathname}${location.searchStr}`)} onClick={actions.pressSignIn}>
        {SIGN_IN}
      </a>
    </Button>
  )
}

// "Sign in to send your changes": the same link, offered beside the connection pill while the outbox holds a write
// ChatApi refused because it couldn't tell who asked (src/outbox.ts `held`). Nothing blocks: the person keeps working,
// and the held writes go once they are back.
export function SignInToSend() {
  const { queries, actions } = useAuth()
  const { data: session } = useLiveQuery(queries.session)
  const location = useLocation()
  if (session?.available !== true) return null
  return (
    <Button asChild variant="outline" size="sm">
      <a href={signInHref(`${location.pathname}${location.searchStr}`)} onClick={actions.pressSignIn}>
        {SIGN_IN_TO_SEND}
      </a>
    </Button>
  )
}
