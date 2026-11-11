/**
 * `rollout`: capture what production serves, publish, check, and restore the captured release on a failed check.
 * A host supplies deployment ports; rollout policy never calls a model or approval. The run's output is the receipt,
 * so the run is the deploy record.
 *
 * Without a host, the flow deploys `apps/mvp` (stack `smithers-mvp`, stage `prod`) with `pnpm run deploy --yes` and checks
 * it with its deploy smoke (apps/mvp/docs/infrastructure.md#deploy). Run it with production's credentials in the environment:
 *
 * ```sh
 * mvp-prod-env smthrs flow start rollout --wait
 * ```
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Config, Effect, Redacted, Schema } from "effect"
import { join } from "node:path"
import { repositoryRoot } from "../automation/run-module.ts"
import { alchemyHost } from "./alchemy.ts"
import { rollout, type RolloutHost } from "./runtime.ts"

const Release = Schema.Struct({ version: Schema.String, revision: Schema.String })
const Check = Schema.Struct({ name: Schema.String, status: Schema.Literals(["passed", "failed"]) })
export const Receipt = Schema.Struct({
  startedAt: Schema.String,
  updatedAt: Schema.String,
  status: Schema.Literals([
    "captured",
    "prepared",
    "publishing",
    "checking",
    "restoring",
    "passed",
    "failed",
    "refused",
    "rolled-back",
    "rollback-failed"
  ]),
  previous: Schema.NullOr(Release),
  candidate: Schema.NullOr(Release),
  baseline: Schema.Array(Check),
  checks: Schema.Array(Check),
  failedChecks: Schema.Array(Schema.String),
  skippedChecks: Schema.Array(Schema.String),
  rollback: Schema.Literals(["not-needed", "succeeded", "failed"]),
  reverification: Schema.Array(Check)
})
export const Execute = Action.make("rollout/execute", {
  implementationVersion: "rollout/v2",
  payload: {},
  success: Receipt,
  error: Schema.Union([Receipt, Schema.String]),
  nondeterministic: true
})

/** One rollout on `host`: a passed receipt succeeds, any other fails with the receipt. */
export const execute = (host: RolloutHost) =>
  Effect.tryPromise({ try: () => rollout(host), catch: () => "Rollout receipt unavailable" }).pipe(
    Effect.flatMap((receipt) => receipt.status === "passed" ? Effect.succeed(receipt) : Effect.fail(receipt))
  )

/** `apps/mvp`'s production stack, read from the environment `mvp-prod-env` sets. */
export const mvp = Effect.gen(function*() {
  const root = repositoryRoot(new URL(import.meta.url))
  const domain = yield* Config.String("APP_DOMAIN")
  return alchemyHost({
    stack: "smithers-mvp",
    stage: "prod",
    directory: join(root, "apps/mvp"),
    deploy: ["pnpm", "run", "deploy", "--yes"],
    checks: { "deploy-smoke": ["node", "ops/deploy-smoke/run.ts"] },
    site: `https://${domain}`,
    cloudflare: {
      api: "https://api.cloudflare.com/client/v4",
      account: yield* Config.String("CLOUDFLARE_ACCOUNT_ID"),
      token: Redacted.value(yield* Config.Redacted("CLOUDFLARE_API_TOKEN"))
    },
    receipts: join(root, ".flows/rollout/smithers-mvp-prod.json"),
    env: process.env
  })
}).pipe(Effect.mapError(() => "Rollout needs APP_DOMAIN, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN"))

/** The default host: `apps/mvp` in production. Nothing is read until a run starts. */
export const layer = Execute.toLayer(() => Effect.flatMap(mvp, execute), { implementationVersion: "rollout/v2" })

export default Flow.make("rollout", {
  description: "Deploy, verify, automatically restore the baseline release on failure, and re-verify.",
  capabilities: [
    "deploy:rollout",
    "proc:spawn:pnpm run deploy --yes",
    "proc:spawn:node ops/deploy-smoke/run.ts",
    "net:get:api.cloudflare.com/**",
    "net:post:api.cloudflare.com/**"
  ],
  effects: {
    reads: ["deployment/**"],
    writes: ["deployment/**"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  },
  modelInvocable: false,
  payload: {},
  success: Receipt,
  error: Schema.Union([Receipt, Schema.String]),
  body: Node.capture({ implementationVersion: "rollout/v2" }, () => Execute.call({}))
})
