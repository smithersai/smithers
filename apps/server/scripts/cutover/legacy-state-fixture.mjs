// Local workerd fixture only. Never uploaded by the maintenance operator.
export class AccountModelVault {
  constructor(ctx) { this.ctx = ctx }
  async fetch(request) {
    const command = await request.json()
    if (command.op === "write") await this.ctx.storage.put("model-vault:v1", { version: 1, login: command.login,
      entries: [{ name: command.name, origin: command.origin, sealed: command.sealed }], receipts: [] })
    return Response.json({ document: await this.ctx.storage.get("model-vault:v1") })
  }
}
export class ClientErrorLog { fetch() { return new Response(null, { status: 404 }) } }
export class GatewaySessionRegistry extends ClientErrorLog {}
export class RecommendLog extends ClientErrorLog {}
export class TurnCancelRegistry extends ClientErrorLog {}
export class TurnRateLimiter extends ClientErrorLog {}
export default { fetch() { return new Response(null, { status: 404 }) } }
