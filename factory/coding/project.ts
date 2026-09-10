/** This repository's opinionated configuration of existing coding primitives. */
import { Console, Effect } from "effect"
import { pages } from "../wiki/catalog.ts"
import type { ProjectConfig } from "../../flows/coding/project-config.ts"

export const smithersProject = (wikiOutput = "../smithers-wiki"): ProjectConfig => ({
  wikiOutput, pages, reviewer: "smithers-public-engineering-v1", implementation: "coding/implementation",
  checks: [
    { id: "policy", target: "//flows:codingPolicy", flow: "checks/policy", tier: "fast", required: true },
    ...([ ["runtime", "codingRuntime"], ["native", "codingNative"], ["native-bun", "codingNativeBun"],
      ["bundle", "codingBundle"], ["bundle-bun", "codingBundleBun"] ] as const).map(([id, target]) => ({
      id, target: `//flows:${target}`, flow: `checks/${id}`, tier: "slow" as const, required: true
    })),
    { id: "wiki", target: "public engineering wiki", flow: "checks/wiki", tier: "slow", required: true }
  ], historyLimit: 100, maxMemoryBytes: 48 * 1024
})

if (import.meta.main) await Effect.runPromise(Console.log(JSON.stringify(smithersProject(process.argv[2]), null, 2)))
