/** Recovery for a failed engine, without assuming its storage is the cause. */
export const ENGINE_RECOVERY = "Open a regular window or reload."
export const TERMINAL_UNAVAILABLE = `Terminal unavailable here. ${ENGINE_RECOVERY}`
export const BRANCH_UNAVAILABLE = `Branch workspace unavailable here. ${ENGINE_RECOVERY}`
export const FILE_UNAVAILABLE = `File editor unavailable here. ${ENGINE_RECOVERY}`
export const COMPARE_UNAVAILABLE = `Branch comparison unavailable here. ${ENGINE_RECOVERY}`
export const FLOW_UNAVAILABLE = `Flow code unavailable here. ${ENGINE_RECOVERY}`
export const COMMIT_UNAVAILABLE = `Commit unavailable here. ${ENGINE_RECOVERY}`
/** Conservative even when a failed engine leaves some storage usable. */
export const COPY_DRAFT = "Draft may be lost on reload. Copy it first."

export const engineStopped = (connection: { readonly status: string } | undefined): boolean => connection?.status === "stopped"

/** A confirmed offline session keeps the branch's recovery guidance after the engine stops. */
export const branchUnavailable = (stopped: boolean, session: { readonly status: string } | undefined, confirmed: unknown): boolean =>
  stopped && session !== undefined && session.status !== "signed_out" && (session.status === "signed_in" || confirmed !== undefined)
