// The platform code of deps.vibe: hashing and the bounded HTTP fetch, which a .vibe file does not reach directly.
import { createHash } from "node:crypto"

/** The largest document one source may import. */
export const maxDocBytes = 256 * 1024

/** How long one URL may take to answer in full. */
export const fetchTimeoutMs = 30_000

/** A response larger than {@link maxDocBytes}, refused before or while it streamed. */
export class TooLarge extends Error {}

/**
 * The hex SHA-256 of `bytes`.
 * @throws {never}
 */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Fetches one document: no redirect, at most `timeoutMs` in full, and never
 * more than {@link maxDocBytes} + 1 bytes read. A declared or streamed body
 * over the limit rejects with {@link TooLarge}.
 */
export const fetchBounded = async (url: string, timeoutMs = fetchTimeoutMs): Promise<Uint8Array> => {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`${url} answered ${response.status}`)
  }
  if (Number(response.headers.get("content-length") ?? 0) > maxDocBytes) {
    await response.body?.cancel()
    throw new TooLarge(`${url} declares more than ${maxDocBytes} bytes`)
  }
  const chunks: Array<Uint8Array> = []
  let total = 0
  if (response.body !== null) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
      if (total > maxDocBytes) {
        await reader.cancel()
        throw new TooLarge(`${url} streamed more than ${maxDocBytes} bytes`)
      }
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
