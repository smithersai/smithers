import { describe, test } from "vitest"
import { catalogDescriptors } from "../src/Catalog.ts"
import { catalogRequest } from "../src/CatalogRequest.ts"
import { normalizeArguments } from "../src/cli/Arguments.ts"
import * as Output from "../src/Output.ts"
import * as Verb from "../src/Verb.ts"

const opts = { time: 120, warmupTime: 30 }

const argVectors: ReadonlyArray<ReadonlyArray<string>> = [
  ["--root", "/repo", "test", "//packages/smithers/..."],
  ["--root=/repo", "--ui=plain", "bench", "//packages/...:bench"],
  ["--workspace", "/repo", "//packages/smithers:check"],
  ["--no-color", "runs", "list", "--status", "running", "--", "--raw-flag"],
  ["--workspace=/repo", "cache", "steps", "prune", "--dry-run"],
  ["."]
]

const getDescriptor = {
  http: {
    method: "GET" as const,
    path: "/api/v1/repos/{owner}/{repo}/runs",
    query: { status: "status", limit: "limit" }
  }
}

const postDescriptor = {
  http: {
    method: "POST" as const,
    path: "/api/v1/repos/{owner}/{repo}/flows/{flow}/start",
    body: { branch: "branch", ref: "ref" },
    defaults: { source: "cli" },
    objects: {
      options: {
        when: "dryRun",
        body: { dryRun: "dryRun", budget: "budget" },
        defaults: { strict: true }
      }
    }
  }
}

const samplePayload = {
  status: "completed",
  runId: "run_01JABC1234567890",
  steps: Array.from({ length: 24 }, (_, index) => ({
    id: `step-${index}`,
    status: index % 4 === 0 ? "cached" : "succeeded",
    durationMs: 12 + index * 3,
    tags: ["bench", "cli", `phase-${index % 3}`]
  }))
}

describe("@smthrs/cli", () => {
  test("normalizeArguments across 6 CLI invocations", async ({ bench }) => {
    await bench("normalizeArguments (6 argvs)", () => {
      for (const argv of argVectors) normalizeArguments(argv)
    }).run(opts)
  })

  test("catalogRequest GET and POST encoding", async ({ bench }) => {
    await bench("catalogRequest (GET + POST)", () => {
      catalogRequest(getDescriptor, {
        owner: "smithersai",
        repo: "smithers",
        status: "running",
        limit: 50
      })
      catalogRequest(postDescriptor, {
        owner: "smithersai",
        repo: "smithers",
        flow: "ci/review",
        branch: "main",
        ref: "abcdef1234567890",
        dryRun: true,
        budget: 100
      })
      catalogDescriptors.length
    }).run(opts)
  })

  test("Verb.select and Verb.find lookup", async ({ bench }) => {
    const invocations = [
      ["flow", "start", "review"],
      ["runs", "watch", "run-1"],
      ["bench", "//..."],
      ["unknown", "command"]
    ]
    await bench("Verb.select + find", () => {
      for (const words of invocations) {
        Verb.select(words)
        Verb.find(words[0]!)
      }
    }).run(opts)
  })

  test("Output.renderValue on structured payload", async ({ bench }) => {
    await bench("Output.renderValue (24 steps)", () => {
      Output.renderValue(samplePayload)
    }).run(opts)
  })
})
