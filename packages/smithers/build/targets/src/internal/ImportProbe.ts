/**
 * Decodes the bounded Node import-resolution probe protocol.
 * @since 1.0.0
 */

/**
 * One successful resolution, absent optional preload, or failed probe.
 * @since 1.0.0
 * @private
 */
export type Answer =
  | { readonly kind: "resolved"; readonly url: string }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly detail: string }

/**
 * Validates the probe status/output pair without silently dropping an unresolved failure.
 * @since 1.0.0
 * @private
 */
export const parse = (error: Error | null, stdout: string, stderr: string): Answer => {
  if (error === null && stdout.startsWith("resolved ")) {
    return { kind: "resolved", url: stdout.slice("resolved ".length) }
  }
  if (error === null && stdout === "missing") return { kind: "missing" }
  const reason = error?.message ?? `unexpected probe output ${JSON.stringify(stdout)}`
  return { kind: "failed", detail: reason + (stderr === "" ? "" : `\n${stderr}`) }
}
