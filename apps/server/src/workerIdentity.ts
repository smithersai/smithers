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

/** One Worker secret as the deploy preflight grades it. */
export interface SecretIdentity {
  /** Unset, a core route refuses every user, so the preflight FAILs. */
  readonly required: boolean
  /** What the Worker does while the secret is unset, as the preflight prints it. */
  readonly absent: string
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
  /** Workers Logs (wrangler.jsonc `observability`): every console line the Worker writes is kept. */
  observability: { enabled: true },
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
   * deploying shell never needs a value. The preflight reports each name as
   * live or not: a missing `required` secret is a FAIL, any other an INFO,
   * and both print `absent`. MODEL_VAULT_KEY is an optional knob, not listed
   * here: absent disables account enrollment alone.
   */
  secrets: {
    SMITHERS_CHAT_AUTH_TOKEN: { required: true, absent: "the chat forward carries no bearer, so every turn comes back chat's 401" },
    CHAT_PRODUCT_SERVICE_TOKEN: { required: false, absent: "signed-in turns meter onto the deployment account, not the user's" },
    IDENTITY_SERVICE_TOKEN: { required: true, absent: "the Cloud token door answers not_configured and identity rate-limits every sign-in as one address" },
    PLUE_WORKER_EXCHANGE_TOKEN: { required: false, absent: "client-error export skipped; /api/client-errors still answers 202 and logs `skipped: unconfigured`" },
    IDENTITY_ADMIN_TOKEN: { required: false, absent: "POST /api/admin/allowlist and GET /api/admin/requests answer 501" },
    BILLING_AUTH_TOKEN: { required: false, absent: "the admin charge summary reads no charges" },
    BILLING_PRODUCT_SERVICE_TOKEN: { required: false, absent: "signed-in balance reads and POST /api/admin/grant answer 501" },
    BILLING_ADMIN_TOKEN: { required: false, absent: "POST /api/admin/grant answers 501" },
    ANONYMOUS_TURN_SALT: { required: false, absent: "anonymous turn buckets hash addresses unsalted" },
    CEREBRAS_API_KEY: { required: true, absent: "Librarian and Flows agent turns answer 503" },
    AI_GATEWAY_API_KEY: { required: true, absent: "Jev refuses, so POST /api/recommend, POST /api/jev and every turn's front door answer 503" },
    SMITHERS_GITHUB_APP_ID: { required: false, absent: "catalog stats read GitHub without the App (GITHUB_TOKEN, else anonymous at 60 requests an hour)" },
    SMITHERS_GITHUB_APP_PRIVATE_KEY: { required: false, absent: "the GitHub App cannot sign, so catalog stats read with GITHUB_TOKEN, else anonymously" },
    GITHUB_TOKEN: { required: false, absent: "catalog stats read as the GitHub App, else anonymously" }
  } as Readonly<Record<string, SecretIdentity>>,
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
    "UPSTREAM_TIMEOUT_MS",
    "BILLING_CHECKOUT_ENABLED",
    "CEREBRAS_MODEL_LIBRARIAN",
    "CEREBRAS_MODEL_FLOWS"
  ] as ReadonlyArray<string>
} as const

export type WorkerIdentity = typeof WORKER_IDENTITY
