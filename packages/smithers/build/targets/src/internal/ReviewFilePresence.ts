/**
 * Review policy for files that disappear after discovery.
 * @since 1.0.0
 */

/**
 * Required context cannot silently disappear; changed paths may be deletions.
 * @since 1.0.0
 * @private
 */
export const contents = (path: string, value: string | undefined, missing: "skip" | "fail"): string | undefined => {
  if (value === undefined && missing === "fail") {
    throw new Error(`LLM review file disappeared after discovery: ${path}`)
  }
  return value
}
