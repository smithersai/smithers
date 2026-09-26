/** Dotted version comparison for the setup commands. */

const versionParts = (version: string) => version.trim().replace(/^v/, "").split(".").map((part) => Number(part))

/** `true` when `actual` is at least `wanted`, compared as dotted numbers. */
export const atLeast = (actual: string, wanted: string): boolean => {
  const a = versionParts(actual), w = versionParts(wanted)
  for (let index = 0; index < Math.max(a.length, w.length); index++) {
    const left = a[index] ?? 0, right = w[index] ?? 0
    if (left !== right) return left > right
  }
  return true
}
