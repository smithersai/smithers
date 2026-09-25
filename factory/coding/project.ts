/** This repository's opinionated configuration of existing coding primitives. */
import { Console, Effect } from "effect"
import { fileURLToPath } from "node:url"
import { pages } from "../wiki/catalog.ts"
import type { ProjectConfig } from "../../flows/coding/project-config.ts"

export const smithersProject = (wikiOutput = "../smithers-wiki", wiki = false): ProjectConfig => ({
  wiki, ...(wiki ? { wikiOutput, pages, reviewer: "smithers-public-engineering-v1" } : {}), implementation: "coding/implementation",
  // Cheap lanes write code on Luna; planning and review run on Sol.
  seats: { "coding/implement": "luna", "coding/dispatch": "luna", "repository/author": "luna", "flow/author": "luna",
    "coding/plan": "sol", "coding/poc": "sol", "repository/research": "sol", "repository/evaluator": "sol", "wiki/reviewer": "sol" },
  checks: [
    { id: "policy", target: "//flows:codingPolicy", flow: "checks/policy", tier: "fast", required: true },
    { id: "lint", target: ".", flow: "checks/lint", tier: "fast", required: false },
    ...([ ["runtime", "codingRuntime"], ["native", "codingNative"], ["native-bun", "codingNativeBun"],
      ["bundle", "codingBundle"], ["bundle-bun", "codingBundleBun"] ] as const).map(([id, target]) => ({
      id, target: `//flows:${target}`, flow: `checks/${id}`, tier: "slow" as const, required: true
    })),
    ...(wiki ? [{ id: "wiki", target: "public engineering wiki", flow: "checks/wiki", tier: "slow" as const, required: true }] : [])
  ], historyLimit: 100, maxMemoryBytes: 48 * 1024
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await Effect.runPromise(Console.log(JSON.stringify(smithersProject(process.argv[2]), null, 2)))
}
