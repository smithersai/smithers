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
  private readonly longest: number
  constructor(secret: string | undefined, additional: ReadonlyArray<string> = []) {
    this.parts = [secret ?? "", ...additional].flatMap(ConfiguredModel.modelCredentialParts)
    let longest = 0
    for (const part of this.parts) {
      if (part.length > longest) longest = part.length
    }
    this.longest = longest
  }
  private cut(value: string): string {
    let kept = value
    for (;;) {
      let changed = false
      for (let index = 0; index < this.parts.length; index++) {
        const part = this.parts[index]!
        if (kept.includes(part)) {
          kept = kept.split(part).join("")
          changed = true
        }
      }
      if (!changed) return kept
    }
  }
  push(value: string): string {
    if (this.parts.length === 0) return value
    const pending = this.cut(this.pending + value)
    this.pending = pending
    const pendingLength = pending.length
    let held = 0
    if (pendingLength > 0) {
      const lastCode = pending.charCodeAt(pendingLength - 1)
      for (let p = 0; p < this.parts.length; p++) {
        const part = this.parts[p]!
        const firstCode = part.charCodeAt(0)
        const maxSize = Math.min(pendingLength, part.length - 1)
        for (let size = maxSize; size > held; size -= 1) {
          if (part.charCodeAt(size - 1) !== lastCode) continue
          const offset = pendingLength - size
          if (pending.charCodeAt(offset) !== firstCode) continue
          let match = true
          for (let k = 1; k < size - 1; k++) {
            if (pending.charCodeAt(offset + k) !== part.charCodeAt(k)) {
              match = false
              break
            }
          }
          if (match) {
            held = size
            break
          }
        }
      }
    }
    const emitted = held === 0 ? pending : pending.slice(0, pendingLength - held)
    this.pending = held === 0 ? "" : pending.slice(pendingLength - held)
    return this.release(emitted)
  }
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
      if (seam === 0 || kept.length === 0) break
      const combined = this.returned + kept
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!
        const found = combined.indexOf(part, Math.max(0, seam - part.length + 1))
        if (found !== -1) {
          kept = combined.slice(found + part.length)
          joined = true
          break
        }
      }
    }
    const tail = this.longest - 1
    if (tail <= 0) {
      this.returned = ""
    } else if (kept.length >= tail) {
      this.returned = kept.slice(kept.length - tail)
    } else {
      const combined = this.returned + kept
      this.returned = combined.slice(Math.max(0, combined.length - tail))
    }
    return kept
  }
}
