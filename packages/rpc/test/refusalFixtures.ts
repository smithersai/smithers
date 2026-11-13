/*
 * Refusal decoding samples, read through a Response and `refusalOf`.
 * Worker and legacy native samples exercise compatibility decoding.
 */
import { NATIVE_FAILURES, nativeWireCode } from "../src/NativeFailureCodes.ts"
import type { NativeRouteCode } from "../src/NativeFailureCodes.ts"
import { refusalOf, retryAfterHeader } from "../src/Refusal.ts"
import type { Refusal } from "../src/Refusal.ts"
import { WORKER_FAILURES, type WorkerFailureCode } from "../src/WorkerFailureCodes.ts"

const received = async (response: Response, message: string): Promise<Refusal> =>
  refusalOf({
    body: await response.json(),
    status: response.status,
    message,
    retryAfterSeconds: retryAfterHeader(response.headers)
  })

/** A representative Worker-vocabulary HTTP response for the refusal decoder. */
export const workerRefusal = (
  code: WorkerFailureCode,
  message: string,
  options?: { readonly origin?: "worker" | "local" }
): Promise<Refusal> => {
  const { status, retryAfter } = WORKER_FAILURES[code]
  const body = {
    status: "error",
    code,
    message,
    ...(retryAfter > 0 ? { retry_after: retryAfter } : {}),
    ...(options?.origin === "local" ? { origin: "local" } : {})
  }
  return received(
    new Response(JSON.stringify(body), {
      status,
      headers: retryAfter > 0 ? { "retry-after": String(retryAfter) } : {}
    }),
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
