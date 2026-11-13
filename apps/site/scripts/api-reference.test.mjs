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

test("engine refusals identify flow-owned identity conflicts re-exported by the engine", () => {
  for (const path of ["docs/api.md", "docs/reference/engine.md"]) {
    const docs = read(`${flows}engine/${path}`)
    assert.ok(docs.includes("FlowRuntime.ExecutionIdentityConflict"), `${path}: owner must be @smthrs/flow`)
    assert.ok(docs.includes("FlowEngine.ExecutionIdentityConflict"), `${path}: re-export must be documented`)
    assert.ok(docs.includes("capabilityConflict"), `${path}: capability refusal constructor must be documented`)
    assert.doesNotMatch(docs, /not an engine export|not by\s+`@smthrs\/engine`|engine raises them as defects/)
    assert.match(docs, /typed/)
  }
})

test("engine references cover the root namespaces and resolvable module entry points", () => {
  const root = read(`${flows}engine/src/index.ts`)
  const namespaces = [...root.matchAll(/export \* as (\w+) from/g)].map((match) => match[1])
  const manifest = JSON.parse(read(`${flows}engine/package.json`))
  for (const path of ["docs/api.md", "docs/reference/engine.md", "docs/installation.md"]) {
    const docs = read(`${flows}engine/${path}`)
    for (const namespace of namespaces) {
      assert.ok(docs.includes(`\`${namespace}\``), `${path}: missing namespace ${namespace}`)
    }
    for (const [entry, target] of Object.entries(manifest.exports)) {
      if (target === null || entry === "./package.json") continue
      const specifier = entry === "." ? manifest.name : `${manifest.name}/${entry.slice(2)}`
      assert.ok(docs.includes(`\`${specifier}\``), `${path}: missing entry point ${specifier}`)
    }
    assert.doesNotMatch(docs, /three namespaces|four subpaths/)
  }
})

test("engine transport reference includes interrupt in each operation surface", () => {
  const docs = read(`${flows}engine/docs/reference/engine.md`)
  for (const member of [
    "FlowProxy.OperationAddresses", "FlowProxy.operationAddresses", "FlowProxy.toRpcGroup",
    "FlowProxy.ConvertRpcs", "FlowProxy.toHttpApiGroup", "FlowProxy.ConvertHttpApi",
    "FlowProxyServer.ExecutionIdScope", "FlowProxyServer.RpcHandlers"
  ]) {
    const section = docs.split(`### \`${member}\``)[1]?.split(/\n## /)[0]?.split(/\n### /)[0]
    assert.match(section ?? "", /interrupt/i, `${member}: missing interrupt`)
  }
  for (const [module, name] of [
    ["FlowProxy", "ConvertRpcs"], ["FlowProxy", "ConvertHttpApi"], ["FlowProxyServer", "RpcHandlers"]
  ]) {
    const source = read(`${flows}engine/src/${module}.ts`)
    const declaration = source.match(new RegExp(`export type ${name}\\b[\\s\\S]*?:\\s*never`))?.[0]
    assert.ok(declaration, `${module}.${name}: source declaration exists`)
    const section = docs.split(`### \`${module}.${name}\``)[1]?.split(/\n###? /)[0]
    const documented = section?.match(/- \*\*Type:\*\* `+(.*?)`+\n/)?.[1]
    assert.equal(
      documented?.replace(/\s/g, ""),
      declaration.replace(/^export /, "").replace(/\s/g, ""),
      `${module}.${name}: reference type matches the exported union`
    )
  }
  const scope = read(`${flows}engine/docs/guides/namespace-execution-ids.md`)
  assert.ok(scope.includes('`"interrupt"`'))
  assert.match(scope, /resume and interrupt/)
})

test("engine guides describe surviving admission and missing retry origins", () => {
  const admission = read(`${flows}engine/docs/guides/test-in-memory.md`)
  assert.match(admission, /joiners retry admission/)
  assert.doesNotMatch(admission, /joiners receive the interrupted dispatch's exit/)
  for (const path of [
    "docs/concepts/retries.md", "docs/guides/implement-the-encoded-seam.md",
    "docs/reference/engine.md", "src/FlowEngine/Encoded.ts"
  ]) {
    assert.match(read(`${flows}engine/${path}`), /Debug/, `${path}: missing retry origins log at Debug`)
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

test("flows authoring lists cover every flat namespace", () => {
  const names = [...read(`${flows}flow/src/index.ts`).matchAll(/^export \* as (\w+) from/gm)].map((match) => match[1])
  assert.ok(names.includes("JournalDecode"))
  assert.ok(names.includes("RunMetrics"))
  for (const path of ["src/index.ts", "README.md", "docs/api.md", "docs/concepts/aggregate-surface.md"]) {
    const docs = read(`${flows}${path}`)
    for (const name of names) assert.ok(docs.includes(`\`${name}\``), `${path}: missing flat namespace ${name}`)
  }
})

test("flows setup docs use the current release and public platform imports", () => {
  const manifest = JSON.parse(read(`${flows}package.json`))
  const platform = JSON.parse(read(`${flows}platform-node/package.json`))
  for (const path of ["docs/installation.md", "docs/quickstart.md"]) {
    const docs = read(`${flows}${path}`)
    for (const name of [manifest.name, platform.name]) {
      const pins = [...docs.matchAll(new RegExp(`${name}@([0-9][^\\s\`]*|next)`, "g"))].map((match) => match[1])
      assert.ok(pins.includes(manifest.version), `${path}: pins the current release of ${name}`)
      for (const version of pins) assert.ok(version === "next" || version === manifest.version, `${path}: stale ${name}@${version}`)
    }
    const effectPins = [...docs.matchAll(/\beffect@([0-9][^\s`]*|next)/g)]
    assert.ok(effectPins.length > 0, `${path}: pins the Effect peer version`)
    for (const pin of effectPins) {
      assert.equal(pin[1], manifest.peerDependencies.effect, `${path}: Effect peer version`)
    }
    assert.ok(/import \{[^}]*NodeRuntime[^}]*\} from "@smthrs\/platform-node"/.test(docs), `${path}: imports the public Node runtime`)
    assert.ok(!/@smthrs\/flows\/(?:NodeRuntime|SandboxedFlow)/.test(docs), `${path}: avoids blocked platform subpaths`)
  }
})

test("journal root namespaces and root-only imports match the published export maps", () => {
  const dir = `${flows}journal`
  const manifest = JSON.parse(read(`${dir}/package.json`))
  const names = [...read(`${dir}/src/index.ts`).matchAll(/^export \* as (\w+) from/gm)].map((match) => match[1])
  const readme = read(`${dir}/README.md`)
  const table = readme.split("## Public API\n")[1].split("Two test entry points")[0]
  const documented = [...table.matchAll(/^\| `(\w+)`\s*\|/gm)].map((match) => match[1])
  assert.deepEqual(documented.sort(), names.sort())
  const rootOnly = names.filter((name) => !Object.hasOwn(manifest.exports, `./${name}`))
  for (const name of names) {
    assert.equal(Object.hasOwn(manifest.exports, `./${name}`), Object.hasOwn(manifest.publishConfig.exports, `./${name}`))
  }
  for (const path of ["README.md", "docs/api.md", "docs/installation.md"]) {
    const text = read(`${dir}/${path}`)
    assert.doesNotMatch(text, /each is also importable|Every module in the root is also importable|Each module is also importable/)
    for (const name of rootOnly) {
      assert.match(text, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "@smthrs/journal"`), path)
      assert.ok(!text.includes(`"@smthrs/journal/${name}"`), `${path}: root-only ${name}`)
    }
  }
})

test("journal setup and API reference cover the installed schema", () => {
  const dir = `${flows}journal`
  const migrations = [...read(`${dir}/src/Migrations.ts`).matchAll(/"(\d{4}_\w+)":/g)].map((match) => match[1])
  const api = reference(dir)
  for (const migration of migrations) assert.ok(api.includes(`\`${migration}\``), migration)
  const install = read(`${dir}/docs/installation.md`)
  for (const migration of migrations) {
    const source = read(`${dir}/src/migrations/${migration}.ts`)
    for (const [, table] of source.matchAll(/CREATE TABLE (\w+)/g)) {
      assert.ok(install.includes(`\`${table}\``), table)
    }
  }
  for (const text of [install, api]) {
    assert.ok(text.includes("`flows_journal_generations`"))
    assert.ok(text.includes("`JournalGeneration.initialize`"))
  }
  assert.doesNotMatch(install, /two tables and nothing else/)
})

test("journal guides describe the consensus lease rather than run status as the fence", () => {
  const dir = `${flows}journal/docs`
  const trouble = read(`${dir}/troubleshooting.md`).split("## fence_lost\n")[1].split("\n## ")[0]
  assert.match(trouble, /Consensus/)
  assert.match(trouble, /flows_consensus_leases/)
  assert.doesNotMatch(trouble, /status|running/)
  const testing = read(`${dir}/guides/testing.md`)
  assert.match(testing, /journal.*migrations.*flows_consensus_leases/s)
  assert.doesNotMatch(testing, /run-store migrations, so the fence/)
})

test("journal docs agree on SQL backends and retained history", () => {
  const dir = `${flows}journal`
  const install = read(`${dir}/docs/installation.md`).replace(/\s+/g, " ")
  assert.match(install, /SQLite and PostgreSQL/)
  assert.match(install, /PGlite is not supported/)
  const reader = read(`${dir}/docs/guides/read-a-run.md`).replace(/\s+/g, " ")
  assert.doesNotMatch(reader, /SQLite-specific adapter/)
  assert.match(reader, /On SQLite/)
  for (const path of ["README.md", "docs/README.md"]) {
    const text = read(`${dir}/${path}`)
    assert.doesNotMatch(text, /Rows are appended and never updated/)
    const introduction = text.split("It is a set of")[0]
    assert.match(introduction, /checkpoint.*replac/s)
    assert.match(introduction, /compact.*delet/s)
  }
})

test("sync docs distinguish the authenticated presence mount from unserved commands", () => {
  const dir = `${flows}sync`
  const pages = ["docs/api.md", "docs/concepts/branches.md", "docs/troubleshooting.md", "docs/protocol.md", "docs/README.md", "docs/guides/test-a-follower.md"].map((path) => `${dir}/${path}`)
  pages.push("apps/site/src/content/docs/docs/reference/http-api.mdx")
  for (const path of pages) {
    const docs = read(path).replace(/\s+/g, " ")
    assert.match(docs, /POST \/branch/, path)
    assert.match(docs, /authenticated runtime bridge/, path)
    assert.match(docs, /commands and share-link bootstrap remain unserved/i, path)
    assert.doesNotMatch(docs, /collaboration ships unserved|branch surface ships unserved|nothing outside this package|nothing mounts the branch|has no production mount|serves `SyncRpcs` alone/i, path)
  }
})

test("sync docs list every branch procedure including presence health", () => {
  const dir = `${flows}sync`
  const names = [...read(`${dir}/src/BranchRpcs.ts`).matchAll(/Rpc\.make\("(Branch\.[^"]+)"/g)].map((match) => match[1])
  assert.equal(names.length, 8)
  for (const path of ["docs/api.md", "docs/concepts/branches.md"]) {
    const docs = read(`${dir}/${path}`)
    assert.match(docs, /eight procedures/, path)
    for (const name of names) assert.ok(docs.includes(`\`${name}\``), `${path}: missing ${name}`)
  }
  const handlers = read(`${dir}/src/BranchServer.ts`).split("*/")[0]
  assert.match(handlers, /Six procedures/)
  assert.ok(handlers.includes("`Branch.PresenceOn`"))
})

test("sync troubleshooting assigns unavailable branch presence to unsupported", () => {
  const docs = read(`${flows}sync/docs/troubleshooting.md`)
  const row = docs.split("\n").find((line) => line.startsWith("| `unsupported`"))
  assert.ok(row)
  assert.ok(row.includes("Branch presence is unavailable"))
  assert.ok(row.includes("`BranchPresence.layerNoop`"))
  const closed = docs.split("## Every operation fails with closed")[1].split("\n## ")[0]
  assert.doesNotMatch(closed, /Branch presence is unavailable/)
  assert.match(read(`${flows}sync/src/BranchPresence.ts`), /code: "unsupported", message: "Branch presence is unavailable"/)
})

test("sync authorization docs check the key name before the signature", () => {
  const docs = read(`${flows}sync/docs/guides/authorize-a-connection.md`).replace(/\s+/g, " ")
  assert.match(docs, /checks that the key name is known, then the signature in constant time, then the expiry/)
  assert.match(docs, /names an unknown signing key/)
  for (const module of ["BranchShare", "WorkspaceShare"]) {
    const source = read(`${flows}sync/src/${module}.ts`)
    const lookup = source.indexOf("ring.verification.get(claims.kid)")
    assert.ok(lookup >= 0 && lookup < source.indexOf("yield* shareSigner.verifyClaims"))
  }
})

test("model executor README lists every shipped member", () => {
  const dir = "packages/smithers/agent/model"
  const source = read(`${dir}/src/RequestExecutor.ts`)
  const names = [...new Set([...source.matchAll(/^export (?:const|class|interface|type|function) (\w+)/gm)].map((match) => match[1]))]
  assert.ok(names.length > 0)
  const block = read(`${dir}/README.md`).split("- **`RequestExecutor`**:")[1]?.split("\n- **")[0]
  assert.ok(block, "RequestExecutor has a README entry")
  const documented = [...block.matchAll(/`(\w+)`/g)].map((match) => match[1])
  assert.deepEqual(documented.sort(), names.sort())
})

test("model executor options document both retry and response-start bounds", () => {
  const dir = "packages/smithers/agent/model"
  const source = read(`${dir}/src/RequestExecutor.ts`)
  const options = source.match(/^export interface MakeOptions \{([\s\S]*?)^\}/m)?.[1]
  assert.ok(options, "MakeOptions remains public")
  const fields = [...options.matchAll(/^  readonly (\w+)\?:/gm)].map((match) => match[1])
  assert.ok(fields.length > 0)
  const chapter = reference(dir).split("## `RequestExecutor`")[1]?.split("\n## ")[0]
  assert.ok(chapter, "RequestExecutor has a reference chapter")
  const row = chapter.split("\n").find((line) => line.startsWith("| `MakeOptions`"))
  assert.ok(row, "MakeOptions has a reference row")
  for (const field of fields) assert.ok(row.includes(`${field}?`), `MakeOptions documents ${field}`)
  const defaultMs = source.match(/^export const defaultResponseStartMs = ([\d_]+)/m)?.[1]
  assert.ok(defaultMs, "the response-start default remains public")
  assert.ok(row.includes("`defaultResponseStartMs`"))
  assert.ok(row.includes(defaultMs), "MakeOptions states the shipped response-start default")
})
