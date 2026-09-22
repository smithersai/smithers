/*
 * The frozen identity of the deployed Worker, as plain data.
 *
 * wrangler.jsonc is what `wrangler deploy` reads, and src/workerIdentity.test.ts
 * holds it to this object field by field, so a change to the Worker's name,
 * its domain or route, its Durable Object bindings and classes, or its assets
 * configuration is a deliberate edit in both places (recorded in DEPLOY.md's
 * cutover log) and never a diff that slips through with a deploy.
 * scripts/adopt-durable-objects.ts compares both against the live script
 * before every deploy. Nothing in the Worker imports wrangler.jsonc.
 *
 * This module has no imports on purpose: scripts and tests read it without
 * pulling the Worker's runtime graph.
 */

/** One Durable Object namespace: the binding name the Worker reads and the class name the bundle exports. */
export interface DurableObjectIdentity {
  readonly binding: string
  readonly className: string
}

/** One Durable Object migration as wrangler.jsonc records it. */
export interface MigrationIdentity {
  readonly tag: string
  readonly newSqliteClasses: ReadonlyArray<string>
}

export const WORKER_IDENTITY = {
  /** The physical script name. Durable Object storage is keyed to it. */
  name: "smithers-mvp-web",
  accountId: "dd3525a4132493566aeb38de533c8827",
  /** The entry wrangler bundles (wrangler.jsonc `main`): the native adapter over the router. */
  entry: "src/index.ts",
  compatibility: { date: "2026-08-01", flags: ["nodejs_compat"] as ReadonlyArray<string> },
  /** The canary custom domain (wrangler: `routes[0]`, `custom_domain: true`). */
  domain: { name: "canary.smithers.sh", zoneId: "8ebd98d2f0dc7d8db2e61f31ebc19c14" },
  /** The apex zone route: one Worker serves every apex path (DEPLOY.md cutover log). */
  routes: [
    { pattern: "smithers.sh/*", zoneId: "8ebd98d2f0dc7d8db2e61f31ebc19c14" },
    { pattern: "www.smithers.sh/*", zoneId: "8ebd98d2f0dc7d8db2e61f31ebc19c14" }
  ] as ReadonlyArray<{
    readonly pattern: string
    readonly zoneId: string
  }>,
  /** No workers.dev surface: the live script serves only its domain and route. */
  workersDev: false,
  assets: {
    /** Relative to apps/server: the smithers.sh Astro build. */
    directory: "../site/dist",
    /** The assets binding the router reads (`serveAsset` in src/index.ts). */
    binding: "ASSETS",
    notFoundHandling: "404-page" as const,
    /**
     * The paths the Worker sees before the assets layer answers them.
     * src/workerIdentity.test.ts holds this list to the prefixes the code routes.
     */
    runWorkerFirst: ["/*"] as ReadonlyArray<string>
  },
  /**
   * The six Durable Objects, binding name and class name both frozen. A
   * declared binding the live script lacks deploys as a fresh, empty class; a
   * live binding this list lacks is deleted with its storage; a class renamed
   * under the same binding is a migration. Every one is data loss, so
   * scripts/adopt-durable-objects.ts refuses a deploy unless the live script
   * agrees with this list exactly.
   */
  durableObjects: [
    { binding: "TURN_CANCELS", className: "TurnCancelRegistry" },
    { binding: "GATEWAY_SESSIONS", className: "GatewaySessionRegistry" },
    { binding: "TURN_LIMITS", className: "TurnRateLimiter" },
    { binding: "CLIENT_ERRORS", className: "ClientErrorLog" },
    { binding: "RECOMMEND_LOG", className: "RecommendLog" },
    { binding: "MODEL_VAULTS", className: "AccountModelVault" }
  ] as ReadonlyArray<DurableObjectIdentity>,
  /**
   * The migration history wrangler.jsonc carries. wrangler sends only the
   * steps after the script's live tag, so a deploy with the same list is a
   * no-op; appending a step is how a class is added, renamed or deleted, and
   * every one of those is a cutover-log entry.
   */
  migrations: [
    { tag: "v1", newSqliteClasses: ["TurnCancelRegistry"] },
    { tag: "v2", newSqliteClasses: ["GatewaySessionRegistry"] },
    { tag: "v3", newSqliteClasses: ["TurnRateLimiter", "ClientErrorLog"] },
    { tag: "v4", newSqliteClasses: ["RecommendLog"] },
    { tag: "v5", newSqliteClasses: ["AccountModelVault"] }
  ] as ReadonlyArray<MigrationIdentity>,
  /** The plain vars, bound as `plain_text` (wrangler.jsonc `vars`). */
  vars: {
    IDENTITY_UPSTREAM_URL: "https://smithers-cloud-identity.willcory10.workers.dev",
    BILLING_UPSTREAM_URL: "https://billing.smithers.sh",
    SMITHERS_CLOUD_API_BASE_URL: "https://api.jjhub.tech",
    SMITHERS_CHAT_URL: "https://smithers-cloud-chat-canary.willcory10.workers.dev/chat",
    SMITHERS_CHAT_ORIGIN: "https://canary.smithers.sh"
  } as Readonly<Record<string, string>>,
  /**
   * Every secret the Worker reads (src/Config.ts). Each is set once on the
   * live script with `wrangler secret put` and kept by every `wrangler deploy`
   * after that: wrangler uploads with `keep_bindings: ["secret_text"]`, so a
   * deploying shell never needs to carry a value, and the preflight only
   * reports each name as live or not. All are optional to the code (an unset
   * one makes its route answer an honest refusal). MODEL_VAULT_KEY is OPTIONAL
   * even on production: absent disables account enrollment alone with
   * vault_unavailable, never deployment or identity. `AI_GATEWAY_API_KEY` joined the list when Jev became the
   * only model behind the composer pills and the turn route's front door
   * (src/recommend.ts, src/frontDoor.ts): without it both refuse, because
   * neither has an LLM to fall back to.
   */
  secrets: [
    "SMITHERS_CHAT_AUTH_TOKEN",
    "CHAT_PRODUCT_SERVICE_TOKEN",
    "IDENTITY_SERVICE_TOKEN",
    "PLUE_WORKER_EXCHANGE_TOKEN",
    "IDENTITY_ADMIN_TOKEN",
    "BILLING_AUTH_TOKEN",
    "BILLING_PRODUCT_SERVICE_TOKEN",
    "BILLING_ADMIN_TOKEN",
    "ANONYMOUS_TURN_SALT",
    "CEREBRAS_API_KEY",
    "AI_GATEWAY_API_KEY",
    "SMITHERS_GITHUB_APP_ID",
    "SMITHERS_GITHUB_APP_PRIVATE_KEY",
    "TUTORIAL_SERVICE_TOKEN",
    "GITHUB_TOKEN"
  ] as ReadonlyArray<string>,
  /**
   * Optional knobs, and the optional secrets a working canary does without.
   * `SMITHERS_BUILD_SHA` is not a binding at all: it is baked into the site
   * build as /__build.json. The rest are set like secrets (`wrangler secret
   * put`) and kept across deploys the same way; a plain var under one of
   * these names would be replaced by the `vars` above.
   */
  optionalVars: [
    // Optional secret, base64 of 32 random bytes; never a required preflight binding.
    "MODEL_VAULT_KEY",
    "SMITHERS_BUILD_SHA",
    "TUTORIAL_SERVICE_URL",
    "UPSTREAM_TIMEOUT_MS",
    "BILLING_CHECKOUT_ENABLED",
    "CEREBRAS_MODEL_LIBRARIAN",
    "CEREBRAS_MODEL_FLOWS"
  ] as ReadonlyArray<string>
} as const

export type WorkerIdentity = typeof WORKER_IDENTITY
