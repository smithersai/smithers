/**
 * Credential redaction across provider chunks, before durable recording.
 *
 * @since 1.0.0
 */

import { ConfiguredModel } from "@smthrs/rpc"

/**
 * Removes a configured credential even when provider chunks split it. The
 * concatenation of everything `push` and `finish` return never contains the
 * credential: when cutting one echo joins text already returned with text
 * still to come, the joining text is dropped too.
 *
 * @category utilities
 * @since 1.0.0-rc.0
 */
export class StreamingCredentialCutter {
  private pending = ""
  /** The end of the returned text, one character shorter than the longest secret part. */
  private returned = ""
  private readonly parts: ReadonlyArray<string>
  constructor(secret: string | undefined, additional: ReadonlyArray<string> = []) {
    this.parts = [secret ?? "", ...additional].flatMap(ConfiguredModel.modelCredentialParts)
  }
  private cut(value: string): string {
    let kept = value
    let previous: string
    do {
      previous = kept
      for (const part of this.parts) kept = kept.split(part).join("")
    } while (previous !== kept)
    return kept
  }
  /**
   * Returns the part of `value` that can be released without exposing a
   * credential, holding back a possible credential prefix for the next chunk.
   *
   * @throws {never}
   */
  push(value: string): string {
    if (this.parts.length === 0) return value
    this.pending = this.cut(this.pending + value)
    let held = 0
    for (const part of this.parts) {
      for (let size = Math.min(this.pending.length, part.length - 1); size > held; size -= 1) {
        if (this.pending.endsWith(part.slice(0, size))) {
          held = size
          break
        }
      }
    }
    const emitted = this.pending.slice(0, this.pending.length - held)
    this.pending = this.pending.slice(this.pending.length - held)
    return this.release(emitted)
  }
  /** @throws {never} */
  finish(): string {
    const emitted = this.cut(this.pending)
    this.pending = ""
    return this.release(emitted)
  }
  /**
   * Drops the start of `text` while it completes a secret part begun in the
   * returned text. Both sides are already free of whole parts, so any part
   * found from one part-length before the seam straddles it.
   */
  private release(text: string): string {
    const parts = this.parts
    let kept = text
    for (let joined = true; joined;) {
      joined = false
      const seam = this.returned.length
      const combined = this.returned + kept
      for (const part of parts) {
        const index = combined.indexOf(part, Math.max(0, seam - part.length + 1))
        if (index !== -1) {
          kept = combined.slice(index + part.length)
          joined = true
          break
        }
      }
    }
    const longest = Math.max(0, ...parts.map((part) => part.length))
    const combined = this.returned + kept
    this.returned = combined.slice(Math.max(0, combined.length - (longest - 1)))
    return kept
  }
}
