// The private shape gateway owns no container or Durable Object class (decision 0118).
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"
import { logged } from "./ElectricAwake.ts"
import { serve } from "./ElectricCache.ts"
import ElectricRuntime, { ElectricObject, INSTANCE } from "./ElectricRuntime.ts"
import { workerBuild } from "./WorkerBuild.ts"

/** ElectricGateway's Worker settings; infra/WorkerBundles.test.ts bundles the Worker from them. */
export const props = {
  main: "infra/ElectricGateway.ts",
  // Alchemy's Neon module, which the container's declaration names, imports node:crypto.
  compatibility: { date: "2026-10-01", flags: ["nodejs_compat"] },
  // No public URL at all, neither workers.dev nor per-version previews: ChatApi's service binding is the only way in.
  workersDev: { enabled: false, previewsEnabled: false },
  cache: { enabled: true, crossVersionCache: false },
  build: workerBuild,
  observability: {
    enabled: true,
    logs: { enabled: true, invocationLogs: true, persist: true },
    traces: { enabled: true, persist: true },
  },
}

export default class ElectricGateway extends Cloudflare.Worker<ElectricGateway>()(
  "ElectricGateway",
  props,
  Effect.gen(function* () {
    const objects = yield* ElectricObject.from(ElectricRuntime)
    return { fetch: logged(serve((request) => objects.getByName(INSTANCE).fetch(request))) }
  }),
) {}
