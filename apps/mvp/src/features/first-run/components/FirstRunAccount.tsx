import { useLiveQuery } from "@tanstack/react-db"
import { Account } from "../../auth/components/Account"
import { offersSignIn } from "../view"
import { useFirstRun } from "./FirstRunContext"

// The header's account on `/app` (decision 0121): while the first run's Sign in step offers sign-in, the header
// doesn't, so the page has one sign-in action.
export function FirstRunAccount() {
  const { queries } = useFirstRun()
  const { data: firstRun } = useLiveQuery(queries.state)
  return <Account signIn={!offersSignIn(firstRun)} />
}
