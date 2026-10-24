import { Toast } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useNavigate } from "@tanstack/react-router"
import type { ReactElement } from "react"
import { useAuth } from "../../auth/components/AuthContext"
import { YOUR_MODEL } from "../copy"
import { toastOf } from "../view"
import { usePersonalModel } from "./PersonalModelContext"

// The failure toast of a person's own model (docs/features/personal-model.md#when-the-key-fails), in the shell's one
// toast stack after the spend alerts' (src/screens/app/Toasts.tsx): while the person's row records that their key was
// refused or ran out on a real call, and this device hasn't hidden that failure. It is how they see at once why an
// answer failed. Open goes to Settings; Hide marks that failure hidden on this device, so a later one shows again.
export function usePersonalModelToasts(): ReadonlyArray<ReactElement> {
  const { queries, actions } = usePersonalModel()
  const auth = useAuth()
  const navigate = useNavigate()
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: row } = useLiveQuery(queries.row)
  const { data: hidden } = useLiveQuery(queries.hidden)
  const toast = toastOf(session, row, hidden)
  if (toast === undefined) return []
  return [
    <Toast
      key={`personal-model:${toast.failedAt}`}
      tone="needs_you"
      word={YOUR_MODEL}
      detail={toast.detail}
      onOpen={() => void navigate({ to: "/app/settings" })}
      onHide={() => actions.hide(toast.failedAt)}
      data-personal-model=""
    />,
  ]
}
