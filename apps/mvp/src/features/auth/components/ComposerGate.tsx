import { Button, EmptyState } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useNavigate } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { usePersonalModel } from "../../personal-model/components/PersonalModelContext"
import { ADD_YOUR_MODEL, composerAccess, MEMBERS_ASK, OPEN_SETTINGS, type OwnModel, SIGN_IN_TO_ASK } from "../contract"
import { useAuth } from "./AuthContext"

// Asking Smithers is for Members and above (decision 0007 §2, `repo:ask`; decision 0008 §11): the composer for them,
// even offline after a reload; a short line for a signed-in Guest or a person with no role; and the sign-in prompt for
// anyone signed out, so nothing they type leaves the browser. While the deployment's own model is off (decision 0099),
// a person without a model of their own sees the way to add one instead of a composer whose answers would all fail.
// `composerAccess` decides.
export function ComposerGate({ children }: { readonly children: ReactNode }) {
  const { queries } = useAuth()
  const model = usePersonalModel()
  const navigate = useNavigate()
  const { data: session } = useLiveQuery(queries.session)
  const { data: confirmed } = useLiveQuery(queries.confirmed)
  const { data: rows, isReady } = useLiveQuery(model.queries.saved)
  if (session === undefined) return null
  const own: OwnModel = rows.length > 0 ? "saved" : isReady ? "none" : "loading"
  switch (composerAccess(session, confirmed, own)) {
    case "ask":
      return children
    case "members_only":
      return <EmptyState title={MEMBERS_ASK} />
    case "sign_in":
      return <EmptyState title={SIGN_IN_TO_ASK} />
    case "add_model":
      return (
        <EmptyState
          title={ADD_YOUR_MODEL}
          action={<Button onClick={() => void navigate({ to: "/app/settings" })}>{OPEN_SETTINGS}</Button>}
          data-add-model=""
        />
      )
    case "wait":
      return null
  }
}
