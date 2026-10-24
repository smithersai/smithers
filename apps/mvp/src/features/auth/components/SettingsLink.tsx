import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import { mayAsk } from "../contract"
import { useAuth } from "./AuthContext"

// The header's link to Settings, for a signed-in Member or above: their own model (docs/features/personal-model.md), and
// for an Admin the deployment's spend alerts too (docs/features/spend-alerts.md#channels).
export function SettingsLink() {
  const { queries } = useAuth()
  const { data: session } = useLiveQuery(queries.session)
  if (session?.status !== "signed_in" || !mayAsk(session.role)) return null
  return <Link to="/app/settings">Settings</Link>
}
