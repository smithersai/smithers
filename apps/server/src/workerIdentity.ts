/*
 * The frozen identity of the deployed Worker, as plain data.
 *
 * src/Worker.ts builds its Alchemy props from this object and
 * src/workerIdentity.test.ts pins every field, so a change to the Worker's
 * name, its domain or route, its Durable Object bindings and classes, or its
 * assets configuration is a deliberate edit here (recorded in DEPLOY.md's
 * cutover log) and never a diff that slips through with a deploy.
 *
 * wrangler.jsonc stays checked in as the adoption bridge: it describes the
 * Worker exactly as Wrangler last deployed it, and the same test holds it to
 * this object so scripts/adopt-durable-objects.ts can compare both against
 * the live script. Nothing in the Worker imports wrangler.jsonc.
 *
 * This module has no imports on purpose: scripts and tests read it without
 * pulling the Worker's runtime graph.
 */

/** One Durable Object namespace: the binding name the Worker reads and the class name the bundle exports. */
export interface DurableObjectIdentity {
  readonly binding: string
  readonly className: string
}

/** One Durable Object migration as Wrangler recorded it (the adoption bridge). */
export interface MigrationIdentity {
  readonly tag: string
  readonly newSqliteClasses: ReadonlyArray<string>
}

export const WORKER_IDENTITY = {
  /** The physical script name. Durable Object storage is keyed to it. */
  name: "smithers-mvp-web",
  /** The Alchemy stack and stage the state is filed under; the physical name above is what Cloudflare sees. */
  stack: "smithers-mvp-web",
  stage: "prod",
  accountId: "dd3525a4132493566aeb38de533c8827",
  /** The Effect-native entry Alchemy bundles (wrangler.jsonc's `main` was src/index.ts). */
  entry: "src/Worker.ts",
  compatibility: { date: "2026-08-01", flags: ["nodejs_compat"] as ReadonlyArray<string> },
  /** The canary custom domain (wrangler: `routes[0]`, `custom_domain: true`). */
  domain: { name: "canary.smithers.sh", zoneId: "8ebd98d2f0dc7d8db2e61f31ebc19c14" },
  /** The apex zone route: one Worker serves every apex path (DEPLOY.md cutover log). */
  routes: [{ pattern: "smithers.sh/*", zoneId: "8ebd98d2f0dc7d8db2e61f31ebc19c14" }] as ReadonlyArray<{
    readonly pattern: string
    readonly zoneId: string
  }>,
  /** No workers.dev surface: the live script serves only its domain and route. */
  workersDev: false,
  assets: {
    /** Relative to apps/server: the smithers.sh Astro build. */
    directory: "../site/dist",
    /**
     * Alchemy hard-codes the assets binding name (`metadata.bindings` gets
     * `{ type: "assets", name: "ASSETS" }`, WorkerProvider.ts:2901), so
     * src/Worker.ts does not pass this; it is here because wrangler.jsonc
     * declares it and src/workerIdentity.test.ts holds the two together.
     */
    binding: "ASSETS",
    notFoundHandling: "404-page" as const,
    /**
     * The paths the Worker sees before the assets layer answers them.
     * src/workerIdentity.test.ts holds this list to the prefixes the code routes.
     */
    runWorkerFirst: [
      "/api/*", "/v1/*", "/workflows/*", "/smithersai/*", "/w/*",
      "/Effect-TS/*", "/effect-ts/*",
      "/wevm/*",
      "/bombshell-dev/*",
      "/jj-vcs/*",
      "/modelcontextprotocol/*",
      "/GitoxideLabs/*", "/gitoxidelabs/*",
      "/TanStack/*", "/tanstack/*",
      "/xyflow/*",
      "/blackboardsh/*",
      "/withastro/*"
    ] as ReadonlyArray<string>
  },
  /**
   * The five Durable Objects, binding name and class name both frozen. Alchemy
   * adopts a foreign Worker by matching each declared binding to the live one
   * BY BINDING NAME and reusing its class (WorkerProvider.ts:3445-3474); a
   * binding it cannot match is a class to create (:3514), and a live binding
   * it does not find in this list is a class to DELETE (:3310-3331, applied
   * at :3377-3392). Either mismatch
   * is data loss, so scripts/adopt-durable-objects.ts refuses to proceed
   * unless the live script agrees with this list exactly.
   */
  durableObjects: [
    { binding: "TURN_CANCELS", className: "TurnCancelRegistry" },
    { binding: "GATEWAY_SESSIONS", className: "GatewaySessionRegistry" },
    { binding: "TURN_LIMITS", className: "TurnRateLimiter" },
    { binding: "CLIENT_ERRORS", className: "ClientErrorLog" },
    { binding: "RECOMMEND_LOG", className: "RecommendLog" }
  ] as ReadonlyArray<DurableObjectIdentity>,
  /**
   * The Wrangler migration history. Alchemy does not replay it: it reads the
   * live tag (`v4`) back from Cloudflare's precondition error and re-uploads
   * with `old_tag: "v4"`, `new_tag: "alchemy:v5"`
   * (WorkerProvider.ts:3707-3747, :5404-5410). The retry carries the SAME
   * class lists as the first attempt, so it is safe exactly when the
   * reconciliation found nothing to create, rename or delete — which is what
   * scripts/adopt-durable-objects.ts proves before a deploy.
   */
  migrations: [
    { tag: "v1", newSqliteClasses: ["TurnCancelRegistry"] },
    { tag: "v2", newSqliteClasses: ["GatewaySessionRegistry"] },
    { tag: "v3", newSqliteClasses: ["TurnRateLimiter", "ClientErrorLog"] },
    { tag: "v4", newSqliteClasses: ["RecommendLog"] }
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
   * Every secret the Worker reads, declared through `Config` in src/Worker.ts
   * and supplied from the operator's environment at deploy time. An Alchemy
   * upload replaces the script's bindings wholesale (`keepBindings:
   * undefined`, WorkerProvider.ts:3584), so a secret set with `wrangler secret
   * put` but absent from the deploying shell is DROPPED by the deploy. All are
   * optional to the code (an unset one makes its route answer an honest 501 or
   * 503); none is optional to the deploy of a working canary.
   *
   * `optionalVars` below deploy through the same channel: Alchemy records
   * EVERY Config the init phase reads as a Redacted output
   * (Platform.ts:572-577), so a knob read with `Config.string` lands on the
   * live script as `secret_text`, not `plain_text`, and is dropped by a
   * deploy that does not export it. Only `vars` above — literal strings in
   * the Worker's `env` props — are plain text.
   */
  secrets: [
    "SMITHERS_CHAT_AUTH_TOKEN",
    "CHAT_PRODUCT_SERVICE_TOKEN",
    "IDENTITY_SERVICE_TOKEN",
    "IDENTITY_ADMIN_TOKEN",
    "BILLING_AUTH_TOKEN",
    "BILLING_PRODUCT_SERVICE_TOKEN",
    "BILLING_ADMIN_TOKEN",
    "ANONYMOUS_TURN_SALT",
    "CEREBRAS_API_KEY",
    "SMITHERS_GITHUB_APP_ID",
    "SMITHERS_GITHUB_APP_PRIVATE_KEY",
    "GITHUB_TOKEN"
  ] as ReadonlyArray<string>,
  /** Optional plain knobs, read from the deploying environment when set. */
  optionalVars: [
    "SMITHERS_BUILD_SHA",
    "UPSTREAM_TIMEOUT_MS",
    "BILLING_CHECKOUT_ENABLED",
    "CEREBRAS_MODEL",
    "CEREBRAS_MODEL_LIBRARIAN",
    "CEREBRAS_MODEL_FLOWS"
  ] as ReadonlyArray<string>
} as const

export type WorkerIdentity = typeof WORKER_IDENTITY
