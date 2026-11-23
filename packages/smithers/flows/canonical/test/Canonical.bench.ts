import { describe, test } from "vitest"
import { BoundedJson, canonicalize, sortCollections } from "../src/index.ts"

const nestedPayload = {
  z: 1,
  version: 2,
  meta: {
    updatedAt: "2026-11-22T00:00:00Z",
    author: "alice",
    tags: ["durable", "flows", "cache", "canonical"]
  },
  inputs: {
    repo: "smithersai/smithers",
    branch: "main",
    commit: "a".repeat(40),
    flags: { strict: true, retries: 3, timeoutMs: 30_000 }
  },
  steps: Array.from({ length: 16 }, (_, index) => ({
    id: `step-${index}`,
    kind: "action",
    order: 16 - index,
    dependsOn: index === 0 ? [] : [`step-${index - 1}`],
    params: { path: `packages/smithers/flows/step-${index}.ts`, dryRun: false }
  }))
}

const largeRecords = Array.from({ length: 200 }, (_, index) => ({
  id: index,
  key: `key1_${String(index).padStart(64, "0")}`,
  status: index % 3 === 0 ? "done" : "running",
  metrics: { durationMs: 12 + (index % 50), attempts: 1, bytes: 2048 + index * 7 },
  labels: [`lane-${index % 8}`, "core", "bench"]
}))

const admitLimits: BoundedJson.Limits = {
  maxBytes: 128 * 1024,
  maxDepth: 16,
  maxMembers: 512,
  maxTotalMembers: 4096,
  maxNodes: 4096,
  maxStringBytes: 4096,
  maxKeyBytes: 256
}

const strictLimits: BoundedJson.StrictLimits = {
  maxBytes: 128 * 1024,
  maxDepth: 16,
  maxMembers: 4096,
  maxNodes: 4096,
  maxStringBytes: 4096,
  maxKeyBytes: 256
}

const collectionsInput = {
  capabilities: new Set(["fs:write:/tmp/b", "fs:read:/src/a", "net:https:api.github.com", "proc:spawn:node"]),
  env: new Map([
    ["Z_VAR", "last"],
    ["A_VAR", "first"],
    ["M_VAR", "mid"],
    ["B_VAR", "second"]
  ]),
  nested: new Map<string, ReadonlySet<string>>([
    ["beta", new Set(["x", "a", "m"])],
    ["alpha", new Set(["z", "c", "b"])]
  ])
}

const escapedText = Array.from(
  { length: 32 },
  (_, index) => `line ${index}: "quoted" \\path\\to\\file\t日本語\n`
).join("")

const opts = { time: 120, warmupTime: 30 }

const canonicalizeFn = canonicalize
const admitFn = BoundedJson.admit
const admitStrictFn = BoundedJson.admitStrict
const encodedStringBytesFn = BoundedJson.encodedStringBytes
const sortCollectionsFn = sortCollections

describe("@smthrs/canonical", () => {
  test("canonicalize nested flow payload", async ({ bench }) => {
    await bench("canonicalize (16 steps)", () => {
      canonicalizeFn(nestedPayload)
    }).run(opts)
  })

  test("canonicalize 200 structured records", async ({ bench }) => {
    await bench("canonicalize (200 records)", () => {
      canonicalizeFn(largeRecords)
    }).run(opts)
  })

  test("BoundedJson.admit nested flow payload", async ({ bench }) => {
    await bench("BoundedJson.admit", () => {
      admitFn(nestedPayload, admitLimits)
    }).run(opts)
  })

  test("BoundedJson.admitStrict nested flow payload", async ({ bench }) => {
    await bench("BoundedJson.admitStrict", () => {
      admitStrictFn(nestedPayload, strictLimits)
    }).run(opts)
  })

  test("BoundedJson.encodedStringBytes with escapes and UTF-8", async ({ bench }) => {
    await bench("encodedStringBytes (~1.4 KB)", () => {
      encodedStringBytesFn(escapedText)
    }).run(opts)
  })

  test("sortCollections nested Sets and Maps", async ({ bench }) => {
    await bench("sortCollections", () => {
      sortCollectionsFn(collectionsInput)
    }).run(opts)
  })
})
