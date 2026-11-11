/**
 * The platform code of ElectricCollection.vibe, which a .vibe file does not import as a value (EK4402): the host
 * `Response` and `fetch` the shape's requests go through.
 *
 * @since 0.1.0
 */

/**
 * `response`'s status and headers over `body`, its bytes already read in full.
 *
 * @category platform
 * @since 0.1.0
 * @throws {never}
 */
export const withBody = (response: Response, body: ArrayBuffer): Response => new Response(body, response)

/**
 * A bodyless answer with `status`: what a request the sync policy gave up on hands Electric.
 *
 * @category platform
 * @since 0.1.0
 * @throws {never}
 */
export const statusOnly = (status: number): Response => new Response(null, { status })

/**
 * `send` with the host fetch's helpers (Bun's `preconnect` included), as Electric's `fetchClient`.
 *
 * @category platform
 * @since 0.1.0
 * @throws {never}
 */
export const fetchClient = (
  send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): typeof fetch => Object.assign(send, fetch)
