import type * as Artifacts from "../branch/Artifacts.vibe"

/** Standard SHA-256 lowercase hex digest over raw bytes via WebCrypto. */
export const sha256BytesAsync = async (bytes: Uint8Array): Promise<string> => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer)
  const arr = new Uint8Array(digest)
  let out = ""
  for (let i = 0; i < arr.length; i++) {
    out += arr[i]!.toString(16).padStart(2, "0")
  }
  return out
}

const SAFE_INLINE_TYPES: ReadonlyMap<string, string> = new Map([
  ["application/json", "application/json; charset=utf-8"],
  ["text/plain", "text/plain; charset=utf-8"],
  ["text/markdown", "text/plain; charset=utf-8"],
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/webp", "image/webp"],
])

/**
 * Prevents same-origin stored XSS when serving user-uploaded objects:
 * only a strict allowlist of non-scriptable MIME types may be served inline,
 * and every other type (including text/html, image/svg+xml, application/javascript)
 * is downgraded to application/octet-stream with attachment disposition.
 * @throws {never}
 */
export const sanitizeServeContentType = (
  raw: string,
): { readonly contentType: string; readonly disposition: "inline" | "attachment" } => {
  const base = raw.split(";")[0]!.trim().toLowerCase()
  const safe = SAFE_INLINE_TYPES.get(base)
  if (safe !== undefined) {
    return { contentType: safe, disposition: "inline" }
  }
  return { contentType: "application/octet-stream", disposition: "attachment" }
}

/** Strips NUL bytes that PostgreSQL jsonb rejects (SQLSTATE 22P05).
 * @throws {never}
 */
export const safeJsonStringify = (value: unknown): string =>
  JSON.stringify(value ?? {}).replace(/\\u0000/g, "")

/** Write bytes to an R2 bucket binding using Web Streams. */
export const putR2Bytes = async (bucket: Artifacts.Bucket, key: string, bytes: Uint8Array): Promise<void> => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  await bucket.put(key, stream)
}

/** Read bytes from an R2 bucket binding, or null when absent. */
export const getR2Bytes = async (bucket: Artifacts.Bucket, key: string): Promise<Uint8Array | null> => {
  const obj = await bucket.get(key)
  if (obj === null) return null
  return new Uint8Array(await new Response(obj.body).arrayBuffer())
}
