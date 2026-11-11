/**
 * The platform code of ShapeSource.vibe, which a .vibe file does not import as a value (EK4402): the host
 * `Response` and `ReadableStream` constructors the faulty source answers with.
 *
 * @since 0.1.0
 */

/**
 * How a faulty source cuts a response's body short: ending early (`Cut`) or failing mid-body (`Drop`).
 *
 * @category platform
 * @since 0.1.0
 */
export type Shortening = "Cut" | "Drop"

// A body that gives `bytes`, then fails as a dropped connection does.
const breaksOff = (bytes: Uint8Array): ReadableStream<Uint8Array> => {
  let given = false
  return new ReadableStream({
    pull: (controller) => {
      if (given) return controller.error(new TypeError("terminated"))
      given = true
      controller.enqueue(bytes)
    }
  })
}

/**
 * A gateway's refusal: a JSON body with `status`, never from Electric.
 *
 * @category platform
 * @since 0.1.0
 * @throws {never}
 */
export const refusal = (status: number): Response => Response.json({ message: "Refused" }, { status })

/**
 * `response`'s status and headers over a body cut mid-JSON.
 *
 * @category platform
 * @since 0.1.0
 * @throws {never}
 */
export const corrupted = (response: Response): Response =>
  new Response("[{", { status: response.status, headers: response.headers })

/**
 * `response`'s status and headers over its first `bytes` bytes, ending early or failing after them.
 *
 * @category platform
 * @since 0.1.0
 * @throws {never}
 */
export const shortened = (response: Response, body: ArrayBuffer, bytes: number, how: Shortening): Response => {
  const kept = new Uint8Array(body).slice(0, bytes)
  return new Response(how === "Cut" ? kept : breaksOff(kept), { status: response.status, headers: response.headers })
}
