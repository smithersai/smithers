import * as Effect from "effect/Effect"
import { Cloudflare, Stack } from "../infra/Alchemy.ts"
import { deployment } from "./src/deploymentConfig.ts"

export { deployment }
export default Stack(
  "smithers-docs-redirect",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function*() {
    return yield* Cloudflare.Worker("smithers-docs-redirect", yield* deployment.pipe(Effect.orDie))
  })
)
