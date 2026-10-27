import { NotFound } from "@smthrs/ui"
import { Link } from "@tanstack/react-router"
import { RecoveryShell } from "./RecoveryShell"

export function RouteNotFound() {
  return <RecoveryShell><NotFound back={<Link to="/app">Back to chat</Link>} /></RecoveryShell>
}
