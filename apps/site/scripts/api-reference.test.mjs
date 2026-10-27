/** Public reference contracts read the real package source and authored docs. */
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { test } from "node:test"

const read = (path) => {
  const url = new URL(`../../../${path}`, import.meta.url)
  const source = path.endsWith(".ts") && !existsSync(url)
    ? new URL(`../../../${path.slice(0, -3)}.vibe`, import.meta.url)
    : url
  return readFileSync(source, "utf8")
}
const flows = "packages/smithers/flows/"
const reference = (pkg) => read(`${pkg}/docs/api.md`)
const members = (pkg, module, names) => {
  const source = read(`${pkg}/src/${module}.ts`)
  const docs = reference(pkg)
  for (const name of names.split(" ")) {
    assert.match(source, new RegExp(`export (?:const|class|interface|type|function) ${name}\\b`), `${module}.${name} remains public`)
    assert.ok(docs.includes(`\`${name}\``) || docs.includes(`\`${module}.${name}\``), `${pkg}: missing reference for ${module}.${name}`)
  }
}

test("engine refusals identify flow-owned typed identity conflicts", () => {
  for (const path of ["docs/api.md", "docs/reference/engine.md"]) {
    const docs = read(`${flows}engine/${path}`)
    assert.ok(docs.includes("FlowRuntime.ExecutionIdentityConflict"), `${path}: owner must be @smthrs/flow`)
    assert.doesNotMatch(docs, /### `FlowEngine\.ExecutionIdentityConflict`|engine raises them as defects/)
    assert.match(docs, /typed/)
  }
})

test("journal facts and deferred clock reconstruction expose their public namespaces", () => {
  for (const [pkg, module] of [["engine-store", "DeferredClockFold"], ["journal", "CallFact"], ["journal", "StepFact"]]) {
    const dir = `${flows}${pkg}`
    assert.match(read(`${dir}/src/index.ts`), new RegExp(String.raw`export \* as ${module} `))
    const source = read(`${dir}/src/${module}.ts`)
    const names = [...source.matchAll(/^export (?:const|class|interface|type|function) (\w+)/gm)].map((m) => m[1])
    members(dir, module, [...new Set(names)].join(" "))
    assert.ok(reference(dir).includes(`## \`${module}\``))
  }
})

test("verified flow API members have reference entries", () => {
  const required = {
    flow: {
      ExternalJob: "StatusOptions Operations stepWaits", Graph: "Inspection",
      Interpreter: "ExecutionOptions maximumDispatchDigests", Stall: "Signal Observation"
    },
    "engine-store": {
      ArtifactGc: "ArtifactGcErrorCode", DisasterRecovery: "DisasterRecoveryErrorCode",
      SelectionStore: "SelectionStoreErrorCode", WorkspaceSandbox: "WorkspaceErrorCode",
      "EngineStore": "RequestedResumeReason", EngineStoreMetrics: "heartbeatReceipts",
      DurableEngineState: "DeferredDigest waitingTreeMaxDepth"
    },
    journal: {
      JournalEvent: "decodeLineageId decodeWaitId decodeCommandId decodePlanId decodeDispatchId decodeArtifactId decodeTimestampMs decodeNonNegativeQuantity decodePositiveQuantity contentDigest",
      EngineEvent: "stateEventType attemptEventType stateEvent"
    },
    canonical: { BoundedJson: "Limits Json IssueCode StrictOptions" },
    crypto: { Sha256: "makeDigestPartsSync" },
    secrets: { Binding: "ValueProblem", Scrub: "Target" },
    sandbox: {
      "SandboxTools/index": "ExecuteOptions CommandOptions ReadResult WriteResult ListResult StatusEntry StatusResult DiffResult ToolFailure Checkpoint RebaseOptions Rebased",
      "CiJob/index": "RunStep", "TerminalProtocol/index": "EndReason ServerControl encodeServerControl decodeClientControl"
    }
  }
  for (const [pkg, modules] of Object.entries(required)) {
    for (const [module, names] of Object.entries(modules)) members(`${flows}${pkg}`, module, names)
  }
  const metrics = read(`${flows}flow/src/RunMetrics.ts`)
  members(`${flows}flow`, "RunMetrics", [...new Set([...metrics.matchAll(/^export (?:const|interface|type) (\w+)/gm)].map((m) => m[1]))].join(" "))
  const published = read(`${flows}flow/docs/reference/flow.md`)
  for (const name of ["RunMetrics", "StatusOptions", "Inspection", "ExecutionOptions", "maximumDispatchDigests", "Observation"]) assert.ok(published.includes(name), `published flow reference: ${name}`)
})

test("agent capacity documents the actual one-hour default park ceiling", () => {
  const docs = reference("packages/smithers/agent")
  const row = docs.split("\n").find((line) => line.startsWith("| `capacity`"))
  assert.ok(row)
  assert.doesNotMatch(row, /no wait ceiling/)
  assert.match(row, /maxParkMillis/)
  assert.match(row, /3,600,000|3_600_000/)
  assert.match(read("packages/smithers/agent/src/QuotaPolicy.ts"), /maxWaitMillis = 3_600_000/)
})

test("harness API index matches every public root namespace", () => {
  const dir = "packages/smithers/agent/harness"
  const names = [...read(`${dir}/src/index.ts`).matchAll(/export \* as (\w+) from/g)].map((m) => m[1])
  const docs = reference(dir)
  assert.match(docs, new RegExp(`${names.length} public root modules`))
  for (const name of names) assert.ok(docs.includes(`\`${name}\``), `harness index: ${name}`)
  assert.ok(read(`${dir}/docs/reference.md`).includes("RealmFlow"))
})

test("build API tables cover public install, manager, and runtime helpers", () => {
  const dir = "packages/smithers/build"
  members(dir, "Install", "Requires InstallFlow")
  members(dir, "PackageManager", "Diagnostic Digest StoreManifest storeManifest storeManifestText pnpmfileNames pnpmfileOf defaultCredentialHosts npmrcDigest lockfileDigest packageJsonDigest linkedTreeManifest")
  members(dir, "Runtime", "lookupEnvironmentNames")
  for (const name of ["linkedTreeManifest", "storeManifest", "Requires", "InstallFlow"]) {
    assert.ok(reference(dir).split("\n").some((line) => line.startsWith("|") && line.includes(`\`${name}\``)), `build table: ${name}`)
  }
})

test("API roster includes the published build, targets, and views references", () => {
  const index = read("apps/site/docs/reference/api/index.mdx")
  for (const name of ["build", "targets", "views"]) {
    assert.ok(index.includes(`[\`@smthrs/${name}\`](/docs/reference/api/${name}/)`), name)
  }
})

test("API roster explains UI's contributor-only reference without promising an absent route", () => {
  const index = read("apps/site/docs/reference/api/index.mdx")
  const row = index.split("\n").find((line) => line.startsWith("|") && line.includes("@smthrs/ui"))
  assert.ok(row)
  assert.match(row, /workspace-private/)
  assert.match(row, /packages\/smithers\/ui\/docs\/api\.md/)
  assert.doesNotMatch(row, /\/docs\/reference\/api\/ui\//)
  assert.equal(JSON.parse(read("packages/smithers/ui/package.json")).private, true)
})
