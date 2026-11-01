/**
 * The gate proof's stage (decision 0145 "Proof"): production's dependencies without the site, its domain or the docs,
 * with ChatApi deployed as `GateHarness` (Harness.ts). Deploy it only to a `smithers-gates-*` stage, from apps/mvp:
 *
 *   alchemy deploy --stage smithers-gates-<name> worker/test/gates/alchemy.run.ts
 *
 * with the deploy's Cloudflare and Neon credentials, GATE_IMAGE, GATE_HARNESS_TOKEN_SHA256, APP_DOMAIN=workers.dev, and
 * no GitHub App, Code Storage organization or GITHUB_REPOSITORY. Its state stays on the deploying machine
 * (worker/test/gates/.alchemy). `alchemy destroy` keeps the Neon project, as production's does: delete it in Neon.
 */
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Neon from "alchemy/Neon"
import { Effect, Layer } from "effect"
import { ChatDatabase } from "../../../infra/ChatDatabase.ts"
import * as Electric from "../../../infra/Electric.ts"
import ElectricGateway from "../../../infra/ElectricGateway.ts"
import { DatabaseUrl as ElectricDatabaseUrl } from "../../../infra/ElectricRuntime.ts"
import { directUrl, Postgres } from "../../../infra/Postgres.ts"
import * as Secrets from "../../../infra/Secrets.ts"
import * as SignIn from "../../../infra/SignIn.ts"
import GateHarness from "./Harness.ts"

export default Alchemy.Stack(
  "smithers-gates",
  { providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers()), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = (yield* Alchemy.Stage).toString()
    if (!stage.startsWith("smithers-gates-")) return yield* Effect.die(new Error(`the gate harness deploys only to smithers-gates-*, not ${stage}`))
    yield* ChatDatabase
    const databaseUrl = ElectricDatabaseUrl.of({ value: directUrl(yield* Postgres) })
    const gateway = yield* ElectricGateway.pipe(Effect.provideService(ElectricDatabaseUrl, databaseUrl))
    const sessionSecret = SignIn.Secret.of({ value: (yield* SignIn.SessionSecret).text })
    const secretsKey = Secrets.Secret.of({ value: (yield* Secrets.SecretsKey).text })
    const harness = yield* GateHarness.pipe(
      Effect.provideService(Electric.Endpoint, Electric.Endpoint.of({ service: gateway.workerName })),
      Effect.provideService(SignIn.Secret, sessionSecret),
      Effect.provideService(Secrets.Secret, secretsKey),
    )
    return { url: harness.url }
  }),
)
