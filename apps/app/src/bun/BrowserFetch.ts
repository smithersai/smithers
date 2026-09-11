import { lookup } from "node:dns/promises"
import { request } from "node:https"
import { isIP } from "node:net"
import { Readable } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import { browserFetch, browserFetchResponseBody } from "@smthrs/rpc/BrowserFetch"
import type { BrowserFetchDeps } from "@smthrs/rpc/BrowserFetch"
import { json } from "./routes"

/** Pin the socket to the address checked by the shared guard, keeping Host, SNI and certificate verification on the original hostname. */
export const createPinnedHttpsFetch = (options: { readonly ca?: string } = {}): NonNullable<BrowserFetchDeps["fetchImpl"]> =>
  (input, init, address) => new Promise((resolve, reject) => {
    const family = isIP(address)
    if (family === 0) return reject(new Error("The checked destination is not an IP address."))
    const outgoing = request(input, {
      method: "GET",
      agent: false,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
      headers: { ...Object.fromEntries(new Headers(init.headers).entries()), "accept-encoding": "identity" },
      signal: init.signal ?? undefined,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [{ address, family }])
        else callback(null, address, family)
      }
    }, (incoming) => {
      const headers = new Headers()
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!)
      }
      const coding = headers.get("content-encoding")?.toLowerCase()
      const decoder = coding === "gzip" ? createGunzip() : coding === "br" ? createBrotliDecompress() : coding === "deflate" ? createInflate() : undefined
      const stream = decoder === undefined ? incoming : incoming.pipe(decoder)
      if (decoder !== undefined) {
        incoming.on("error", (error) => decoder.destroy(error))
        decoder.on("close", () => incoming.destroy())
        headers.delete("content-encoding")
        headers.delete("content-length")
      }
      const status = incoming.statusCode ?? 502
      if ([204, 205, 304].includes(status)) {
        incoming.resume()
        resolve(new Response(null, { status, headers }))
      } else {
        // node:stream and the WebView DOM libs declare different BYOB overloads for the same Web stream.
        resolve(new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers }))
      }
    })
    outgoing.on("error", reject)
    outgoing.end()
  })

const defaultDeps: BrowserFetchDeps = {
  resolveHost: async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((row) => row.address),
  fetchImpl: createPinnedHttpsFetch()
}

export const handleBrowserFetch = async (request: Request, deps: BrowserFetchDeps = defaultDeps): Promise<Response> => {
  if (Number(request.headers.get("content-length") ?? 0) > 8192) return json({ status: "error", message: "Request body is too large." }, 413)
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > 8192) return json({ status: "error", message: "Request body is too large." }, 413)
  let body: unknown
  try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch { return json({ status: "error", message: "Body must be { url }." }, 400) }
  const url = typeof body === "object" && body !== null && "url" in body && typeof body.url === "string" ? body.url.trim() : ""
  if (url === "") return json({ status: "error", message: "Body must be { url }." }, 400)
  const outcome = await browserFetch(url, deps)
  return json(browserFetchResponseBody(outcome), outcome.ok ? 200 : 422)
}
