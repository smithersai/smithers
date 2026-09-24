import { Effect } from "effect"
import type { ServerResponse } from "node:http"
import { fetchWithDeadline, transportLayer } from "smithers-server/Http"
import { readBody, upstreamUnreachable } from "smithers-server/Responses"
import { relayCall, relayGatewayResponse } from "smithers-server/workflows"

/** Only authentication and gateway discovery differ from the deployed Worker. */
export const relayRpc = (request: Request, gatewayUrl: string, credential: string, forwarded?: (procedure: string) => void): Promise<Response> =>
  Effect.runPromise(Effect.gen(function* () {
    const body = yield* readBody(request)
    if (body instanceof Response) return body
    const call = relayCall(body)
    if (call instanceof Response) return call
    forwarded?.(call.procedure)
    const response = yield* fetchWithDeadline("workspace", `${gatewayUrl}${call.mount}`, {
      method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: call.text
    }, 30_000)
    return yield* relayGatewayResponse(response)
  }).pipe(Effect.catch(failure => Effect.succeed(upstreamUnreachable("The workspace", failure))), Effect.provide(transportLayer(fetch))))

export const writeResponse = async (response: Response, target: ServerResponse): Promise<void> => {
  target.writeHead(response.status, Object.fromEntries(response.headers))
  target.end(Buffer.from(await response.arrayBuffer()))
}
