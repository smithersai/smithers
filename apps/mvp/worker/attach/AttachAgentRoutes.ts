import { Result, Schema } from "effect"
import type { Attach } from "./Attach.ts"
import { attachMcpPath, readBody } from "./McpRoute.ts"

const claim = Schema.decodeUnknownOption(Schema.Struct({
  reference: Schema.String,
  client: Schema.String,
  challenge: Schema.String
}))
const redeem = Schema.decodeUnknownOption(Schema.Struct({
  claim: Schema.String,
  code: Schema.String,
  verifier: Schema.String
}))

/** Agent-facing steps. The person approves through the host's existing session. */
export const handleAttachAgent = async (attach: Attach, request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname
  if (request.method !== "POST" || (path !== "/api/attach/claim" && path !== "/api/attach/redeem")) {
    return new Response(null, { status: 404 })
  }
  const headers = { "cache-control": "no-store" }
  const invalid = () => Response.json({ error: "invalid_request" }, { status: 400, headers })
  const text = await readBody(request, 4096)
  if (Result.isFailure(text)) {
    return text.failure === "too_large"
      ? Response.json({ error: "too_large" }, { status: 413, headers })
      : invalid()
  }
  let body: unknown
  try {
    body = JSON.parse(text.success)
  } catch {
    return invalid()
  }
  if (path === "/api/attach/claim") {
    const input = claim(body)
    if (input._tag === "None") return invalid()
    const result = attach.claimIntent(input.value)
    return Result.isSuccess(result)
      ? Response.json(result.success, { headers })
      : Response.json({ error: result.failure }, { status: 400, headers })
  }
  const input = redeem(body)
  if (input._tag === "None") return invalid()
  const result = await attach.redeemCode(input.value)
  if (Result.isFailure(result)) return Response.json({ error: result.failure }, { status: 400, headers })
  const { token, grant } = result.success
  return Response.json({
    token, mcpPath: attachMcpPath(grant), grant: { act: grant.act, expiresAt: grant.expiresAt }
  }, { headers })
}
