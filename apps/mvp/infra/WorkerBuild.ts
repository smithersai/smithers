/**
 * The rolldown options Alchemy bundles each Worker with. A workspace package exports its source, so a Worker's import
 * graph reaches `.vibe` modules, which vibelang-unplugin compiles, each with its own package's tsconfig.
 *
 * A Worker's props sit in the Worker's own module, so the Worker evaluates this object too. `deferred` keeps the
 * compiler out of the bundle: it imports nothing, and loads the plugin only when rolldown awaits its plugin list at
 * deploy or `alchemy dev`.
 */
import { deferred } from "vibelang-unplugin/deferred"

// Alchemy's dev sidecar receives props over RPC. Functions are dropped there, so
// the patched codec rehydrates this module reference before the local provider
// hands the options to Rolldown. Production still awaits the original deferred plugin.
export const workerBuild = {
  input: {
    plugins: [Object.assign(deferred("rolldown"), {
      "~alchemy/DeferredPlugin": "vibelang-unplugin/rolldown",
    })],
  },
}
