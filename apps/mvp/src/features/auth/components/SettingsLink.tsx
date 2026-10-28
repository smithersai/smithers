import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import { useAuth } from "./AuthContext"

// The header's link to Settings, for anyone signed in: their own model (docs/features/personal-model.md, ruling AUTH-8),
// and for an Admin the deployment's spend alerts too (docs/features/spend-alerts.md#channels).
export function SettingsLink() {
  const { queries } = useAuth()
  const { data: session } = useLiveQuery(queries.session)
  if (session?.status !== "signed_in") return null
  return <Link to="/app/settings">Settings</Link>
}
