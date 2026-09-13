import type { StatusRollup } from "@smthrs/rpc/Health"

export const terminalStatus = (status: StatusRollup): boolean =>
  ["completed", "failed", "cancelled", "exited"].includes(status.state)
const knownWait = (status: StatusRollup): boolean => status.state === "waiting-approval" ||
  status.state === "parked" && ["awaiting-reply", "quota-wait", "timer-wait", "event-wait"].includes(status.reason ?? "")

/** Presentation expiry cannot change execution, release a wait, or turn an exit into success. */
export const expireStatus = (status: StatusRollup, now: number): StatusRollup => {
  if (status.freshness !== "fresh" || status.provenance !== undefined &&
    now >= status.provenance.observedAt && now < status.provenance.expiresAt) return status
  if (terminalStatus(status) || knownWait(status)) return { ...status, activity: "unknown", freshness: "stale" }
  return { ...status, activity: "unknown", health: "unknown", attention: "none", freshness: "stale" }
}

/** Only compare versions inside one opaque incarnation; wall clocks do not order owners. */
export const acceptStatus = (current: StatusRollup | undefined, next: StatusRollup): boolean => {
  const a = current?.provenance, b = next.provenance
  if (a === undefined || b === undefined || a.incarnation !== b.incarnation) return true
  if (b.evidenceSeq !== a.evidenceSeq) return b.evidenceSeq > a.evidenceSeq
  if (b.version !== a.version) return b.version > a.version
  return !(current?.freshness === "stale" && next.freshness === "fresh")
}

export const exitedStatus = (sessionId: string, code: number | null, previous: StatusRollup | undefined, now: number): StatusRollup => ({
  subjectId: `session:${sessionId}`, state: "exited", activity: "unknown", health: code === 0 ? "healthy" : code === null ? "unknown" : "failing",
  attention: code !== 0 && code !== null ? "unhealthy" : "none", freshness: previous?.provenance === undefined ? "unobserved" : "stale",
  ...(previous?.provenance === undefined ? {} : { provenance: previous.provenance }), updatedAt: now
})
