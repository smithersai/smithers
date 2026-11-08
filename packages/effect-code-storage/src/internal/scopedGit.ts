/**
 * Bounded protocol-v0 framing for the branch-scoped read-only proxy.
 *
 * @since 0.2.0
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** Frames a UTF-8 payload as one git pkt-line.
 * @private
 * @throws {never}
 * @since 0.2.0
 */
export const packet = (line: string): string => (encoder.encode(line).length + 4).toString(16).padStart(4, "0") + line

/** Ref names cannot inject advertisement framing or capabilities.
 * @private
 * @throws {never}
 * @since 0.2.0
 */
export const validBranch = (branch: string): boolean =>
  branch.length > 0 && branch.length <= 255 &&
  // eslint-disable-next-line no-control-regex -- Git ref syntax explicitly excludes ASCII controls.
  !/[\x00-\x20\x7f~^:?*[\\]/.test(branch) &&
  !branch.includes("..") && !branch.includes("@{") && !branch.includes("//") &&
  !branch.startsWith("-") && !branch.startsWith("/") && !branch.endsWith("/") && !branch.endsWith(".") &&
  branch.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))

/** Validates every byte; strips haves so arbitrary private object IDs cannot become an ACK oracle.
 * @private
 * @throws {never}
 * @since 0.2.0
 */
export const negotiation = (bytes: Uint8Array, tip: string): string | undefined => {
  let offset = 0
  let phase: "want" | "have" | "end" = "want"
  let wants = 0
  let result = ""
  while (offset < bytes.length) {
    const header = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    if (!/^[0-9a-f]{4}$/.test(header)) return undefined
    const size = Number.parseInt(header, 16)
    if (phase === "end" || (size > 0 && size < 5) || offset + size > bytes.length) return undefined
    offset += 4
    if (size === 0) {
      if (wants === 0) return undefined
      phase = phase === "want" ? "have" : "end"
      result += "0000"
      continue
    }
    let line: string
    try {
      line = decoder.decode(bytes.subarray(offset, offset + size - 4))
    } catch {
      return undefined
    }
    offset += size - 4
    if (phase === "want") {
      const match = /^want ([0-9a-f]{40}|[0-9a-f]{64})((?: (?:side-band-64k|ofs-delta))*)\n$/.exec(line)
      if (match === null || match[1] !== tip || (wants > 0 && match[2] !== "")) return undefined
      wants++
      result += packet(line)
    } else if (line === "done\n") {
      phase = "end"
      result += packet(line)
    } else if (!/^have ([0-9a-f]{40}|[0-9a-f]{64})\n$/.test(line)) {
      return undefined
    }
  }
  return phase === "end" ? result : undefined
}
