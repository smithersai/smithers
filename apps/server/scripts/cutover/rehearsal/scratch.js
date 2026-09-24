// Isolated scratch Worker for the binding round-trip rehearsal. Never a product authority.
// Its Durable Object reads every binding type the 14 production authorities use.
import { DurableObject } from "cloudflare:workers"
const hex = async text => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, "0")).join("")
export class TurnCancelRegistry extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname !== "/selftest") return new Response("scratch object")
    const env = this.env
    const facts = {
      d1: (await env.DB.prepare("SELECT v FROM rehearsal WHERE k = 'probe'").first())?.v ?? null,
      r2: (await (await env.BUCKET.get("probe.txt"))?.text())?.trim() ?? null,
      kv: await env.KV.get("probe"),
      queue: await env.QUEUE.send({ probe: crypto.randomUUID() }).then(() => "sent", () => "refused"),
      ratelimit: typeof (await env.LIMITER.limit({ key: "rehearsal" })).success,
      assets: (await (await env.ASSETS.fetch("https://assets.local/probe.txt")).text()).trim(),
      plainText: env.MODE,
      secretSHA256: await hex(env.REHEARSAL_SECRET ?? "")
    }
    await this.ctx.storage.put("selftest", facts)
    return Response.json(facts)
  }
}
export default {
  fetch() { return new Response("scratch") },
  async queue(batch) { for (const message of batch.messages) message.ack() }
}
