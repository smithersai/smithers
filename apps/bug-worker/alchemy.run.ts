/**
 * Alchemy 2 stack for the bug Worker. Importing it deploys nothing.
 *
 * One Cloudflare Worker (entry: src/worker.ts), a rate-limit Durable Object
 * (one atomic counter per bucket), and one KV namespace for bug reports and
 * demo requests. Every installation-specific value (the physical names, the
 * custom domain and its zone) is read from the environment by
 * infra/Deployment.ts, so the same source plans an independent installation;
 * see README.md#deployment-configuration.
 *
 * Plan:     pnpm -C apps/bug-worker run plan
 * Deploy:   qualified Cloud rollout only; see docs/deployment.md
 * Destroy:  pnpm -C apps/bug-worker run destroy
 * Provider operations take their stage from `ALCHEMY_STAGE` and refuse to run
 * without it; state lives in the account's shared `alchemy-state-store`
 * Worker, so every machine plans against one record.
 *
 * Required env: CLOUDFLARE_API_TOKEN, ALCHEMY_PASSWORD and BUG_ADMIN_TOKEN.
 * A deploy without one fails instead of removing the live binding.
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { BugWorkerDeployment, bugWorkerDomain, publicBaseUrl } from "./infra/Deployment.ts"

const requireSecret = (name: string) =>
  Config.schema(Schema.Redacted(Schema.Trim.check(Schema.isNonEmpty())), name).pipe(
    Config.map((value) => Redacted.make(Redacted.value(value).trim()))
  )

/** The KV namespace's props for one installation. */
export const bugReportsProps = (deployment: BugWorkerDeployment) => ({ title: deployment.reportsNamespace })

/** The Worker's props for one installation. */
export const workerProps = (deployment: BugWorkerDeployment) => {
  const base = publicBaseUrl(deployment)
  return {
    name: deployment.workerName,
    main: "src/worker.ts",
    compatibility: { date: "2025-05-01" },
    // An installation without a custom domain answers on workers.dev; with
    // one, workers.dev would serve the same routes outside the zone's rules.
    workersDev: deployment.host === undefined,
    // Workers Logs keeps the `logFailure` and `logAccepted` JSON lines queryable by event and route.
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true, persist: true } },
    env: {
      BUGS: Cloudflare.KV.Namespace("bug-reports", bugReportsProps(deployment)),
      RATE_LIMITS: Cloudflare.DurableObject("RateLimiter"),
      BUG_ADMIN_TOKEN: requireSecret("BUG_ADMIN_TOKEN"),
      ...(base === undefined ? {} : { PUBLIC_BASE_URL: base })
    },
    // A declared domain detaches every live hostname it does not list;
    // undefined leaves custom domains unmanaged.
    domain: bugWorkerDomain(deployment)
  } satisfies Cloudflare.WorkerProps
}

export default Alchemy.Stack(
  "smithers-bug-worker",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function*() {
    // Read first: an invalid deployment value stops before anything changes.
    const deployment = yield* BugWorkerDeployment.pipe(Effect.orDie)
    return yield* Cloudflare.Worker("smithers-bug-worker", workerProps(deployment))
  })
)
