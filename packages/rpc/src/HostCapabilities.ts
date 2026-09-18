/**
 * Capabilities advertised by the current application host.
 *
 * @since 1.0.0
 */
import type { RuntimeCapability } from "./AppBootstrap.ts"

/**
 * The one place each host's bootstrap capability list is spelled out.
 *
 * The Worker (`apps/server/src/index.ts`, host `cloud`) and the Bun server
 * (`apps/app/src/bun/server.ts`, host `local`) call these with what they have
 * configured, and the parity test builds its registries from the same two
 * functions, so the matrix cannot drift from production. Each table is the
 * emission order; a row is kept only when its flag is on.
 */

/** What the Worker has configured. `terminal` names the same-origin workspace terminal relay.
 * @since 1.0.0
 * @category models
 */
export interface CloudCapabilityEnv {
  readonly browser?: boolean
  readonly identity: boolean
  readonly cloud: boolean
  readonly agent: boolean
  readonly checkout: boolean
  readonly terminal: boolean
}

/** What a Bun launch has configured. `cloud` is the cloud upstream; offline launches have none.
 * @since 1.0.0
 * @category models
 */
export interface LocalCapabilityOptions {
  readonly browser?: boolean
  readonly agent: boolean
  readonly identity: boolean
  readonly cloud: boolean
}

const present = (rows: ReadonlyArray<readonly [RuntimeCapability, boolean]>): Array<RuntimeCapability> =>
  rows.filter(([, on]) => on).map(([capability]) => capability)

/** The Worker never emits `cloud.pat`: it holds no PAT session; the GitHub cookie is its only identity.
 * @since 1.0.0
 * @category conversions
 */
export const cloudCapabilities = (env: CloudCapabilityEnv): Array<RuntimeCapability> =>
  present([
    ["agent", env.agent],
    ["browser.read", env.browser === true],
    ["identity", env.identity],
    ["cloud", env.cloud],
    ["billing.checkout", env.checkout],
    ["cloud.terminal", env.terminal]
  ])

/**
 * Both cloud doors ride the Smithers Cloud upstream: without one, the Bun server
 * answers 501 on `/api/cloud-auth/*` and on the `/api/cloud-ws/` tunnel, so
 * claiming either would name a door the host has closed.
 * @since 1.0.0
 * @category conversions
 */
export const localCapabilities = (opts: LocalCapabilityOptions): Array<RuntimeCapability> =>
  present([
    ["agent", opts.agent],
    ["browser.read", opts.browser === true],
    ["identity", opts.identity],
    ["cloud", opts.cloud],
    ["cloud.terminal", opts.cloud],
    ["cloud.pat", opts.cloud]
  ])
