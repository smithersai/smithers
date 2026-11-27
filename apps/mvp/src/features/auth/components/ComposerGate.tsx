import { Button, EmptyState } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { composerAccess, MEMBERS_ASK, SIGN_IN_TO_ASK } from "../contract"
import { useAuth } from "./AuthContext"

export function ComposerGate({ children, member }: { readonly children: ReactNode; readonly member?: boolean }) {
  const { queries } = useAuth()
  const { data: session } = useLiveQuery(queries.session)
  const { data: confirmed } = useLiveQuery(queries.confirmed)
  if (session === undefined) return null
  switch (composerAccess(session, confirmed, member)) {
    case "ask":
      return children
    case "members_only":
      return (
        <EmptyState
          title={MEMBERS_ASK}
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/app/settings">Connect agent or add credits</Link>
            </Button>
          }
        />
      )
    case "sign_in":
      return <EmptyState title={SIGN_IN_TO_ASK} />
    case "wait":
      return null
  }
}
