import { request as httpsRequest, type RequestOptions } from "node:https"

/** Frame bodies explicitly: Node does not add framing to DELETE requests.
 * Unframed bytes poison the next request on a reused Kubernetes connection. */
export function requestJson(options: RequestOptions, body?: unknown, request = httpsRequest): Promise<{ status: number; body: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((done, reject) => {
    const outgoing = request({ ...options, headers: { ...options.headers,
      "content-type": "application/json",
      ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) })
    } }, incoming => {
      const chunks: Buffer[] = []; let size = 0
      incoming.on("error", reject)
      incoming.on("data", chunk => {
        size += chunk.length
        if (size > 2 * 1024 * 1024) { outgoing.destroy(new Error("Kubernetes reply exceeds limit")); return }
        chunks.push(chunk)
      })
      incoming.on("end", () => {
        const status = incoming.statusCode ?? 500
        try { done({ status, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") }) }
        catch { reject(new Error(`Tutorial workspace service returned an invalid response (HTTP ${status}). Try again shortly.`)) }
      })
    })
    outgoing.on("timeout", () => outgoing.destroy(new Error("Kubernetes request timed out")))
    outgoing.on("error", reject)
    outgoing.end(payload)
  })
}
