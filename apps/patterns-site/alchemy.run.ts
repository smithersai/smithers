import * as Effect from "effect/Effect"
import { Cloudflare, Stack } from "../site/infra/Alchemy.ts"
import { optionalHost, physicalName } from "../site/infra/Deployment.ts"

export const deployment = Effect.gen(function*() {
  return {
    name: yield* physicalName("PATTERNS_SITE_WORKER_NAME", "patterns-site"),
    domain: yield* optionalHost("PATTERNS_SITE_DOMAIN"),
    assets: { directory: "site" },
    compatibility: { date: "2026-07-02" },
    workersDev: true,
    observability: { enabled: true }
  }
})

export default Stack(
  "patterns-site",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function*() {
    return yield* Cloudflare.Worker("patterns-site", yield* deployment.pipe(Effect.orDie))
  })
)
