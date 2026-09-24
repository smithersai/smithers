import * as Cause from "effect/Cause"

/*
 * Work that answers no request (a detached gateway resolution, a background
 * repository-setup write, a Durable Object's own storage failure) has no
 * response to carry its failure, so it writes one structured
 * `worker_seam_failure` line (`logSeamFailure`). Workers Logs (wrangler.jsonc
 * `observability`) keeps it, so an operator can see which Durable Object,
 * store or upstream broke and why.
 */

/** A message longer than this is cut in the log; an upstream's prose can be long. */
export const MAX_LOGGED_MESSAGE = 500

/**
 * A failure as one short line: its tag, the operation, seam or reason it
 * names, then its cause. Only those fields and an Error's own message are
 * read, never a body or any other property, so a failure that must not leak
 * (the model vault) carries nothing but fixed words in those fields.
 */
export const describeCause = (cause: unknown): string =>
  describe(Cause.isCause(cause) ? Cause.squash(cause) : cause, 0).slice(0, MAX_LOGGED_MESSAGE)

const describe = (value: unknown, depth: number): string => {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null) return "unknown"
  const fields = value as { readonly _tag?: unknown; readonly operation?: unknown; readonly seam?: unknown; readonly reason?: unknown; readonly cause?: unknown }
  const tag = typeof fields._tag === "string" ? fields._tag : value instanceof Error ? value.name : "unknown"
  const detail = [fields.operation, fields.seam, fields.reason].find((field): field is string => typeof field === "string")
  const head = detail === undefined ? tag : `${tag}(${detail})`
  if (fields.cause !== undefined && depth < 3) return `${head}: ${describe(fields.cause, depth + 1)}`
  return value instanceof Error && value.message !== "" ? `${head}: ${value.message}` : head
}

export interface SeamFailureLine {
  readonly event: "worker_seam_failure"
  readonly seam: string
  readonly cause: string
}

/** One line for a failure no request answers: a detached resolution, a background write. */
export const logSeamFailure = (seam: string, cause: unknown): void => {
  const line: SeamFailureLine = { event: "worker_seam_failure", seam, cause: describeCause(cause) }
  console.error(JSON.stringify(line))
}
