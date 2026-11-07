/**
 * The rolldown options Alchemy bundles the API Worker with (apps/mvp/infra/WorkerBuild.ts is the same). Its import
 * graph reaches `.vibe` modules, this app's and the workspace packages' own, which vibelang-unplugin compiles.
 *
 * The Worker's props sit in its own module, so the Worker evaluates this object too. `deferred` keeps the compiler out
 * of the bundle: it imports nothing, and loads the plugin only when rolldown awaits its plugin list at deploy or
 * `alchemy dev`. Alchemy's dev sidecar receives props over RPC, which drops functions; the root's Alchemy patch
 * rehydrates this module reference before its local provider hands the options to rolldown.
 */
import { deferred } from "vibelang-unplugin/deferred"

export const workerBuild = {
  input: {
    plugins: [Object.assign(deferred("rolldown"), {
      "~alchemy/DeferredPlugin": "vibelang-unplugin/rolldown",
    })],
  },
}
