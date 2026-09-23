/*
 * Refusals as the app receives them: each one is the host's real envelope,
 * turned into a Response and read back through `refusalOf`, so a test guards
 * the wire and not a second copy of it.
 */
import { NATIVE_FAILURES, nativeWireCode } from "../src/NativeFailureCodes.ts"
import type { NativeRouteCode } from "../src/NativeFailureCodes.ts"
import { refusalOf, retryAfterHeader, workerRefusalEnvelope } from "../src/Refusal.ts"
import type { Refusal } from "../src/Refusal.ts"
import type { WorkerFailureCode } from "../src/WorkerFailureCodes.ts"

const received = async (response: Response, message: string): Promise<Refusal> =>
  refusalOf({
    body: await response.json(),
    status: response.status,
    message,
    retryAfterSeconds: retryAfterHeader(response.headers)
  })

/** A Worker-vocabulary refusal, from the envelope the Worker (or, with origin local, the desktop host) writes. */
export const workerRefusal = (
  code: WorkerFailureCode,
  message: string,
  options?: { readonly origin?: "worker" | "local" }
): Promise<Refusal> => {
  const envelope = workerRefusalEnvelope(code, message, options?.origin === undefined ? {} : { origin: options.origin })
  return received(
    new Response(JSON.stringify(envelope.body), { status: envelope.status, headers: envelope.headers }),
    message
  )
}

/** A refusal on one of the desktop host's private routes, in the envelope its `jsonError` writes. */
export const nativeRefusal = (code: NativeRouteCode, message: string): Promise<Refusal> =>
  received(
    new Response(
      JSON.stringify({
        error: { code, message },
        status: "error",
        code: nativeWireCode(code),
        message,
        origin: "local"
      }),
      { status: NATIVE_FAILURES[code].status }
    ),
    message
  )
