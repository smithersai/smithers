/*
 * Refusal decoding samples, read through a Response and `refusalOf`.
 * Worker samples use the production envelope builder; native samples are
 * hand-built legacy envelopes that exercise compatibility decoding.
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

/** A Worker-vocabulary refusal built with the production envelope helper. */
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

/** A representative legacy native-host envelope; checks the decoder, not a current host writer. */
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
