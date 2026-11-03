/**
 * The browser contract, declared.
 *
 * Two lists and nothing else: the entry points the repository promises bundle
 * for a browser, and the ones it documents as Node-only with the `node:`
 * built-in that keeps them there. `browser-check.mjs` beside it executes the
 * promise with esbuild; `scripts/check-docs.mjs` reads the same declaration and
 * fails when a page states a different set or a different count. They share
 * this module so the prose and the gate cannot drift apart.
 */

/**
 * Entry points that are part of the browser promise. Each is bundled for the
 * browser; any resolution or syntax error fails the gate.
 */
export const BROWSER_SAFE = [
  { name: "@smthrs/artifacts", entry: "packages/smithers/flows/artifacts/src/index.vibe" },
  { name: "@smthrs/canonical", entry: "packages/smithers/flows/canonical/src/index.vibe" },
  { name: "@smthrs/capability", entry: "packages/smithers/flows/capability/src/index.ts" },
  { name: "@smthrs/chain", entry: "packages/smithers/agent/chain/src/index.ts" },
  { name: "@smthrs/crypto", entry: "packages/smithers/flows/crypto/src/index.ts" },
  { name: "@smthrs/jj", entry: "packages/smithers/flows/jj/src/index.ts" },
  { name: "@smthrs/jj/browser/BrowserJj", entry: "packages/smithers/flows/jj/src/browser/BrowserJj.ts" },
  { name: "@smthrs/platform-browser", entry: "packages/smithers/flows/platform-browser/src/index.ts" },
  {
    name: "@smthrs/platform-browser/BrowserHost",
    entry: "packages/smithers/flows/platform-browser/src/BrowserHost.ts"
  },
  { name: "@smthrs/platform-cloudflare", entry: "packages/smithers/flows/platform-cloudflare/src/index.ts" },
  { name: "@smthrs/sandbox", entry: "packages/smithers/flows/sandbox/src/index.ts" },
  { name: "@smthrs/kernel", entry: "packages/smithers/flows/kernel/src/index.ts" },
  { name: "@smthrs/keys", entry: "packages/smithers/flows/keys/src/index.ts" },
  { name: "@smthrs/plan", entry: "packages/smithers/flows/plan/src/index.ts" },
  { name: "@smthrs/plan-store", entry: "packages/smithers/flows/plan-store/src/index.ts" },
  { name: "@smthrs/database", entry: "packages/smithers/flows/database/src/index.ts" },
  { name: "@smthrs/journal", entry: "packages/smithers/flows/journal/src/index.ts" },
  { name: "@smthrs/run-store", entry: "packages/smithers/flows/run-store/src/index.ts" },
  { name: "@smthrs/step-cache", entry: "packages/smithers/flows/step-cache/src/index.ts" },
  { name: "@smthrs/flow", entry: "packages/smithers/flows/flow/src/index.ts" },
  { name: "@smthrs/engine", entry: "packages/smithers/flows/engine/src/index.ts" },
  { name: "@smthrs/engine-store", entry: "packages/smithers/flows/engine-store/src/index.ts" },
  { name: "@smthrs/flows", entry: "packages/smithers/flows/src/index.ts" },
  { name: "@smthrs/observability", entry: "packages/smithers/flows/observability/src/index.ts" },
  { name: "@smthrs/sync", entry: "packages/smithers/flows/sync/src/index.ts" },
  { name: "@smthrs/time-travel", entry: "packages/smithers/flows/time-travel/src/index.vibe" },
  // The agent the app runs in its engine leader's dedicated worker (apps/mvp decision 0011), and the standard
  // tools its root reaches. A tool that needs a filesystem, a process or DNS gets it from a host layer.
  { name: "@smthrs/agent", entry: "packages/smithers/agent/src/index.ts" },
  { name: "@smthrs/std", entry: "packages/smithers/agent/std/src/index.ts" },
  // The model call path a Cloudflare Worker imports (apps/mvp/worker): a model,
  // its configured route and the contracts around it. The Node pieces are the
  // host's to inject (`FetchTransport` in @smthrs/platform-node), never these
  // roots' to import.
  { name: "@smthrs/model", entry: "packages/smithers/agent/model/src/index.ts" },
  { name: "@smthrs/model-host", entry: "packages/smithers/agent/model-host/src/index.ts" },
  { name: "@smthrs/rpc", entry: "packages/rpc/src/index.ts" },
  // The app's state and sync libraries (apps/mvp's browser and Worker): TanStack DB and Electric through Effect.
  { name: "@smthrs/effect-tanstack-db", entry: "packages/effect-tanstack-db/src/index.ts" },
  { name: "@smthrs/effect-electric", entry: "packages/effect-electric/src/index.ts" },
  // Pierre's git hosting for repository import and reads (apps/mvp's Worker and the agent's repo flows).
  { name: "@smthrs/effect-code-storage", entry: "packages/effect-code-storage/src/index.ts" },
  // The secrets egress (apps/mvp's Worker, decision 0005 §4): placeholders, bindings, substitution and scrubbing.
  { name: "@smthrs/secrets", entry: "packages/smithers/flows/secrets/src/index.ts" },
  // The GitHub client, webhook verification and OAuth PKCE the repository-clone flow runs on the Cloudflare host.
  { name: "@smthrs/integrations", entry: "packages/smithers/agent/integrations/src/index.ts" },
  // Generated views (decision 0004): the checker, the QuickJS presentation realm and the frame bridge, which the
  // browser agent runs in the tab.
  { name: "@smthrs/views", entry: "packages/smithers/ui/views/src/index.ts" }
]

/**
 * Entry points documented as Node-only. The `expect` module is the `node:`
 * built-in the documentation names as the reason; if an entry stops failing —
 * or starts failing for some other reason — the docs and this list are wrong.
 */
export const NODE_ONLY = [
  {
    name: "@smthrs/platform-node",
    entry: "packages/smithers/flows/platform-node/src/index.ts",
    expect: "node:child_process",
    reason: "the Node host bundle spawns child processes"
  },
  {
    name: "@smthrs/platform-bun",
    entry: "packages/smithers/flows/platform-bun/src/index.ts",
    expect: "node:fs",
    reason: "the Bun bundle falls back to the @effect/platform-node adapters off Bun"
  },
  {
    name: "@smthrs/testing/TestHost",
    entry: "packages/testing/src/TestHost.ts",
    expect: "node:assert",
    reason: "effect/testing's TestClock pulls node:assert"
  },
  {
    name: "@smthrs/jj/node/NodeJj",
    entry: "packages/smithers/flows/jj/src/node/NodeJj.ts",
    expect: "node:child_process",
    reason: "the Node jj adapter spawns the jj CLI"
  },
  {
    name: "@smthrs/jj/bun/BunJj",
    entry: "packages/smithers/flows/jj/src/bun/BunJj.ts",
    expect: "node:child_process",
    reason: "the Bun jj adapter reuses the Node child-process implementation"
  },
  {
    name: "@smthrs/database/node/NodeDatabase",
    entry: "packages/smithers/flows/database/src/node/NodeDatabase.ts",
    expect: "node:sqlite",
    reason: "the Node database layer is node:sqlite through @effect/sql-sqlite-node"
  }
]

/**
 * The host packages. The platform rule puts all platform code in them
 * (`docs/libraries.md`, "Platform rule"), so their modules may reach the host
 * however they need to.
 */
export const HOST_PACKAGES = [
  "packages/smithers/flows/platform-node",
  "packages/smithers/flows/platform-bun",
  "packages/smithers/flows/platform-browser",
  "packages/smithers/flows/platform-cloudflare"
]

/**
 * Whether the platform rule governs a bundled module, by the path esbuild's
 * `// <path>` marker gives it: a workspace package's module outside the host
 * packages. A dependency's module is not governed.
 */
export const governed = (module) =>
  module.startsWith("packages/") && !HOST_PACKAGES.some((root) => module.startsWith(`${root}/`))

/**
 * Governed modules that still reach the host out of the bundler's sight, each
 * with the kinds of access (`../src/HiddenHostAccess.ts`) it holds today. The
 * gate passes these and fails on any other governed module, on a kind a listed
 * module does not name, and on a listed kind no bundle reports any more, so the
 * list only shrinks. `docs/libraries.md` lists the same modules.
 */
export const KNOWN_HOST_ACCESS = [
  {
    module: "packages/smithers/agent/integrations/src/Environment.ts",
    kinds: ["ambient-global"],
    reason: "reads its configuration from process.env"
  },
  {
    module: "packages/smithers/flows/engine-store/src/OwnerIdentity.ts",
    kinds: ["ambient-global"],
    reason: "reads process.pid into the run owner's identity"
  },
  {
    module: "packages/smithers/flows/engine-store/src/internal/HostReflection.ts",
    kinds: ["ambient-global", "builtin", "host-module"],
    reason: "detects proxies through node:util/types"
  },
  {
    module: "packages/smithers/flows/engine/src/internal/Diagnostic.ts",
    kinds: ["ambient-global", "builtin", "host-module"],
    reason: "detects proxies through node:util"
  },
  {
    module: "packages/smithers/flows/kernel/src/ChildProcessSpawner.ts",
    kinds: ["ambient-global"],
    reason: "reads process.platform and process.env for a child's environment"
  },
  {
    module: "packages/smithers/flows/run-store/src/Ownership.ts",
    kinds: ["ambient-global"],
    reason: "sameHostPidProbe calls process.kill(pid, 0)"
  },
  {
    module: "packages/smithers/flows/sandbox/src/ContainerSandbox/existing.ts",
    kinds: ["ambient-global"],
    reason: "reads process.env for the transport's environment"
  },
  {
    module: "packages/smithers/flows/sandbox/src/DirectorySandbox/make.ts",
    kinds: ["ambient-global"],
    reason: "reads process.env for a command's environment"
  },
  {
    module: "packages/smithers/flows/sandbox/src/RemoteChildProcessSpawner/layer.ts",
    kinds: ["ambient-global"],
    reason: "reads process.env to keep host-only values out of a guest"
  }
]

/** The names in the browser half of the contract. */
export const browserEntryNames = () => BROWSER_SAFE.map((entry) => entry.name)

/** The names in the Node-only half of the contract. */
export const nodeEntryNames = () => NODE_ONLY.map((entry) => entry.name)

/**
 * Every place a document states how many entry points bundle for the browser.
 *
 * The count moves whenever an entry point joins or leaves `BROWSER_SAFE`, and a
 * number written by hand goes stale silently: the gate keeps passing while the
 * page lies. Both spellings this tree uses are read.
 *
 * @example
 * ```js
 * citedBrowserCounts("28 entry points bundle for the browser.") // [28]
 * ```
 */
export const citedBrowserCounts = (body) =>
  [
    ...body.matchAll(/(\d+) entry points bundle for the browser/g),
    ...body.matchAll(/(\d+) browser entry points/g)
  ].map((match) => Number(match[1]))
