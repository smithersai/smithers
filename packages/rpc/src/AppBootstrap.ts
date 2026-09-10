/**
 * Bootstrap responses for native and web application sessions.
 *
 * @since 1.0.0
 */
import { z } from "zod"

/**
 * Shared app api version used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const APP_API_VERSION = 1 as const
/**
 * The app bootstrap route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const APP_BOOTSTRAP_PATH = "/api/bootstrap"

/**
 * Validates runtime capability values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RuntimeCapabilitySchema = z.enum([
  "agent",
  "browser.read", // guarded, pinned HTTPS page reads on this host
  "identity",
  "cloud",
  "billing.checkout",
  "keys.byok",
  // Cloud doors a host serves itself, declared by the host that opens them
  // (packages/rpc/src/HostCapabilities.ts holds the per-host tables).
  "cloud.terminal", // this origin tunnels workspace terminals (/api/cloud-ws/*)
  "cloud.pat", // a host-held Smithers Cloud PAT session (/api/cloud-auth/*, the Linear loopback)
  "local.repositories",
  "local.repository-path-entry",
  "local.targets",
  "local.terminal",
  "local.harnesses",
  // The code-intelligence routes (/api/lsp/*, apps/ui/docs/code-intel/PLAN.md §3): a
  // local.* door, so `code.*` flows hide on the web and the refusal names the native app.
  "local.lsp"
])
/**
 * The decoded value accepted by {@link RuntimeCapabilitySchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RuntimeCapability = z.infer<typeof RuntimeCapabilitySchema>

/**
 * Validates app bootstrap values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AppBootstrapSchema = z.object({
  apiVersion: z.literal(APP_API_VERSION),
  host: z.enum(["cloud", "local"]),
  version: z.string(),
  buildSha: z.string(),
  capabilities: z.array(RuntimeCapabilitySchema),
  authFlow: z.enum(["redirect", "native-handoff", "both", "none"]),
  sandbox: z.object({
    platform: z.string(),
    mode: z.enum(["enforced", "trusted-only", "unavailable"])
  }).nullable()
})
/**
 * The decoded value accepted by {@link AppBootstrapSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AppBootstrap = z.infer<typeof AppBootstrapSchema>

/**
 * True when the bootstrap lists the capability.
 *
 * @since 1.0.0
 * @category conversions
 */
export const hasCapability = (bootstrap: AppBootstrap, capability: RuntimeCapability): boolean =>
  bootstrap.capabilities.includes(capability)
