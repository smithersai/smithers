import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Action, HumanTask, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import { Ownership } from "@smthrs/run-store"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { atomDelegate } from "../coding/atoms.ts"
import { checkDelegate } from "../coding/checks.ts"
import { nativeLayer } from "../coding/native.ts"
import { memoryLayer } from "../coding/planning-memory.ts"
import { planningWikiLayers, PrepareWithWiki } from "../coding/planning-wiki.ts"
import { DraftPlan, planningPolicy, PreparePlan, ReviewRequest } from "../coding/planning.ts"
import { layerAt } from "../coding/snapshots.ts"
import { policySources } from "../wiki/reuse.ts"
import type { PageSpec } from "../wiki/schema.ts"
import { ReviewPage } from "../wiki/workflow.ts"

const source = process.env.PLUE_CODING_ADAPTER_SOURCE
const input = { prompt: "Add the next feature from verified current documentation.", feedback: "" }
test("wiki generation precedes planning, reuses exact reviews, rechecks changed pages and refuses unsupported prose", {
  skip: source === undefined ? "Set PLUE_CODING_ADAPTER_SOURCE to the existing native Plue adapter" : false,
  timeout: 600_000
}, async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "coding-planning-wiki-")))
  let close = async () => {}
  t.after(async () => { await close(); await rm(temporary, { force: true, recursive: true }) })
  const root = join(temporary, "repo"), output = join(temporary, "wiki")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Wiki Planning Acceptance")
  jj("config", "set", "--repo", "user.email", "wiki-planning@example.com")
  await mkdir(join(root, "src"))
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  for (const [id, value] of [["answer", 42], ["stable", 7]] as const) {
    await writeFile(join(root, `${id}.md`), `# ${id}\n\nThe ${id} is ${value}.\n`)
    await writeFile(join(root, `src/${id}.ts`), `export const ${id} = ${value}\n`)
  }
  for (const [name, delegate, body] of [["coding/atoms", "coding/Implement", "Implement the supplied atom."],
    ["checks/fast", "coding/CommandCheck", JSON.stringify({ argv: ["true"], cwd: ".", timeoutMs: 1000 })],
    ["checks/slow", "coding/CommandCheck", JSON.stringify({ argv: ["true"], cwd: ".", timeoutMs: 1000 })]]) {
    const directory = join(root, "flows", name!)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "flow.mdx"), `---\ndescription: Planning wiki fixture.\nflows: [${delegate}]\n---\n${body}\n`)
  }
  jj("describe", "-m", "🏗️ chore: stable foundation")
  jj("new", "-m", "✨ feat: current native tip")
  const config = join(temporary, "coding.json"), reporter = join(temporary, "reporter"), adapterPath = join(temporary, "coding.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "planning-wiki-acceptance", actorId: 42, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(adapterPath, (await readFile(source!, "utf8")).replaceAll("/etc/smithers/workspace-coding.json", config)
    .replaceAll("/usr/local/bin/smithers-workspace-head", reporter))
  const platform = "Bun" in globalThis
    ? (await import("../../packages/smithers/flows/platform-bun/node_modules/@effect/platform-bun/dist/BunServices.js")).layer
    : NodeServices.layer
  const runtime = "Bun" in globalThis ? await import("@smthrs/flows/BunRuntime") : NodeRuntime
  const executables = await Effect.runPromise(Effect.gen(function*() {
    const catalog = yield* (yield* Discovery.Discovery).scan({ source: "project", root: join(root, "flows"), naming: "path" })
    return yield* Effect.forEach(catalog.entries, descriptor => Executable.fromDescriptor(descriptor, { delegates: [atomDelegate, checkDelegate] }))
  }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provideMerge(platform)))))
  const pages: PageSpec[] = ["answer", "stable"].map(id => ({ id, title: id, purpose: `Understand ${id}.`, kind: "current", document: `${id}.md`,
    inputs: [`src/${id}.ts`], related: [] }))
  const options = { repositoryPath: root, wikiOutput: output, pages, reviewer: "scripted-wiki-planning-acceptance", hostPolicy: "artifact:planning-fixture-v1", implementation: "coding/atoms",
    checks: ["fast", "slow"].map(tier => ({ id: tier, target: tier, flow: `checks/${tier}`, tier: tier as "fast" | "slow", required: true })) }
  const reviews: string[] = []
  let requests = 0, drafts = 0
  const registration = Layer.mergeAll(planningWikiLayers(options), memoryLayer(options), planningPolicy, HumanTask.layer, Interpreter.layer(PreparePlan),
    ReviewPage.toLayer(({ evidence }) => Effect.sync(() => {
      reviews.push(evidence.spec.id)
      const path = `src/${evidence.spec.id}.ts`, source = evidence.sources.find(source => source.path === path)!
      const value = source.text.match(/= (\d+)/)![1]!
      const supported = evidence.markdown.includes(`is ${value}.`)
      return { sections: evidence.sections.map(section => ({ id: section.id, verdict: supported ? "supported" as const : "unsupported" as const,
        explanation: supported ? "The source declaration matches the owning prose." : "The prose claims a different numeric value.",
        citations: supported ? [{ path, line: 1, quote: source.text.trim() }] : [] })) }
    })),
    ReviewRequest.toLayer(({ context }) => Effect.sync(() => {
      requests++
      assert.equal(context.memory.length, 2)
      assert.ok(context.memory.every(page => page.markdown.includes("verification_status: verified")))
      return { explanation: "Current verified memory is available.", clarification: "" }
    })),
    DraftPlan.toLayer(({ context }) => Effect.sync(() => {
      drafts++
      return { rationale: "Append from the captured head.", baseChangeId: context.head.changeId,
        changes: [{ id: "feature", title: "Feature", intent: "Add feature", checks: ["fast", "slow"],
          atoms: [{ changeId: null, message: "✨ feat: add feature", intent: "Add the next feature", reads: ["src/answer.ts"], writes: ["src/next.ts"] }] }] }
    }))
  ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(Layer.succeed(Executable.Catalog, { executables, refused: [] })),
    Layer.provideMerge(nativeLayer({ sourcePublication: "local-only", repositoryPath: root, adapterPath })))
  const make = () => ManagedRuntime.make(runtime.layer({ filename: join(root, ".flows", "engine.db"), workspaceRoot: root,
    owner: { hostId: "planning-wiki-acceptance" }, isAlive: Ownership.sameHostPidProbe }, StepBoundary.layer, WorkspaceSandbox.layerFileSystem(), registration).pipe(
      Layer.provideMerge(layerAt({ repositoryPath: root, adapterPath })), Layer.provideMerge(platform),
      Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000))))
  let host = make(); close = () => host.dispose()
  const run = (executionId: string) => host.runPromise(PrepareWithWiki.execute(input, { executionId }), { signal: t.signal })
  const children = (executionId: string) => host.runPromise(Effect.flatMap(RunCatalogRead.RunCatalogRead,
    catalog => catalog.listRuns({ filters: { parentRunId: executionId }, limit: 20 })))
  const first = await run("wiki-planning-first")
  assert.deepEqual(reviews.toSorted(), ["answer", "stable"])
  assert.deepEqual({ requests, drafts }, { requests: 1, drafts: 1 })
  assert.match(first.memoryRevision, /^sha256:/)
  const graph = await children("wiki-planning-first")
  const wikiChild = graph.runs.find(run => run.flowName === "coding/RefreshWiki")!
  const planChild = graph.runs.find(run => run.flowName === "coding/PreparePlan")!
  assert.equal(wikiChild.status, "completed")
  assert.equal(planChild.status, "completed")
  assert.ok(wikiChild.finishedAtMs! <= planChild.startedAtMs!, "wiki verification is a real upstream child dependency")
  await host.dispose(); host = make()
  assert.deepEqual(await run("wiki-planning-first"), first)
  assert.equal(reviews.length, 2); assert.equal(drafts, 1)
  await run("wiki-planning-unchanged")
  assert.equal(reviews.length, 2, "unchanged source reuses actual previous model receipts")
  assert.equal(drafts, 2)
  await writeFile(join(root, "answer.md"), "# answer\n\nThe answer is 43.\n")
  await writeFile(join(root, "src/answer.ts"), "export const answer = 43\n")
  await run("wiki-planning-changed")
  assert.deepEqual(reviews.toSorted(), ["answer", "answer", "stable"], "only changed page is semantically reviewed again")
  assert.equal(drafts, 3)
  await run("wiki-planning-changed-unchanged")
  assert.equal(reviews.length, 3, "the latest reviewed source is reused instead of repeatedly consulting the oldest refresh")
  assert.equal(drafts, 4)
  await writeFile(join(root, "src/answer.ts"), "export const answer = 44\n")
  await assert.rejects(run("wiki-planning-unsupported"), /Semantic review did not pass/)
  assert.equal(reviews.length, 4)
  assert.deepEqual({ requests, drafts }, { requests: 4, drafts: 4 }, "unsupported documentation stops before request review or drafting")
  assert.equal((await children("wiki-planning-unsupported")).runs.some(run => run.flowName === "coding/PreparePlan"), false)
  const pointer = JSON.parse(await readFile(join(output, "current.json"), "utf8"))
  assert.equal(pointer.verification, "needs-changes", "failed source-pinned draft remains inspectable")
  await writeFile(join(root, "answer.md"), "# answer\n\nThe answer is 44.\n")
  options.reviewer = "scripted-wiki-planning-acceptance-v2"
  await host.dispose(); host = make()
  await run("wiki-planning-reviewer-changed")
  assert.equal(reviews.length, 6, "different reviewer configuration cannot reuse earlier receipts")
  assert.equal(drafts, 5)
  t.diagnostic("Real JJ + SQLite child graph on the current platform; semantic/planning model outputs were scripted.")
})
