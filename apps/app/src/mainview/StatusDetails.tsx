import { StatusPill, formatStatus } from "@smthrs/ui"
import type { StatusRollup } from "@smthrs/rpc/Health"
import { expireStatus, terminalStatus } from "./state/HealthStatus"

/** One projection on cards and tabs; the dispatcher clock makes expiry live even while offline. */
export const statusPresentation = (input: StatusRollup | undefined, fallback: string, now = Date.now()) => {
  if (input === undefined) return { status: fallback, label: formatStatus(fallback) }
  // A cancellation/exit receipt can reach the card before the next health frame.
  if (["completed", "failed", "cancelled", "done", "stopped"].includes(fallback) && !terminalStatus(input)) {
    return { status: fallback, label: formatStatus(fallback) }
  }
  const status = expireStatus(input, now)
  if (status.state === "cancelled") return { status: "stopped", label: formatStatus("stopped") }
  const lifecycle = formatStatus(status.state)
  if (terminalStatus(status)) return { status: status.health === "failing" ? "failed" : status.state === "exited" ?
    status.health === "healthy" ? "completed" : "unknown" : status.state,
    label: status.state === "exited" ? status.health === "healthy" ? "Exited" : status.health === "failing" ? "Exited · Failed" : "Exited · Outcome unknown" : lifecycle }
  if (status.attention === "awaiting-approval") return { status: "waiting-approval", label: "Waiting for approval" }
  if (status.reason === "quota-wait") return { status: "waiting", label: "Waiting for quota" }
  if (status.reason === "timer-wait") return { status: "waiting", label: "Waiting for timer" }
  if (status.reason === "event-wait") return { status: "waiting", label: "Waiting for event" }
  if (status.state === "parked" && status.health === "awaiting-human") return { status: "awaiting-human", label: "Parked · Needs attention" }
  if (status.freshness === "stale") return { status: "unknown", label: `${lifecycle} · Stale` }
  if (status.attention === "needs-input") return { status: "waiting", label: `${lifecycle} · Needs input` }
  if (status.attention === "unhealthy") return { status: status.health, label: `${lifecycle} · ${formatStatus(status.health)}` }
  if (status.freshness === "unobserved") return { status: status.state, label: lifecycle }
  if (status.activity === "working") return { status: "running", label: `${lifecycle} · Working` }
  if (status.activity === "idle") return { status: "muted", label: `${lifecycle} · Idle` }
  return { status: status.health === "awaiting-human" ? "awaiting-human" : "unknown", label: `${lifecycle} · ${status.health === "awaiting-human" ? "Needs attention" : "Activity unknown"}` }
}

export const StatusDetails = ({ status, fallback, id }: { readonly status?: StatusRollup; readonly fallback: string; readonly id?: string }) => {
  const current = status === undefined ? undefined : expireStatus(status, Date.now())
  const presentation = statusPresentation(current, fallback)
  return <StatusPill {...presentation} id={id} data-testid="status-details" data-health={current?.health ?? "unknown"}
    data-freshness={current?.freshness ?? "unobserved"} aria-label={presentation.label} />
}
