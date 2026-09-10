import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Control } from "@smthrs/control"
import * as Model from "@smthrs/model/Model"
import { ModelEvent } from "@smthrs/model/ModelEvent"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Cause, Context, Deferred, Effect, Layer, Stream } from "effect"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as Registry from "@smthrs/registry/Registry"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import { layer } from "../coding/host.ts"
import { NativeCoding, nativeLayer } from "../coding/native.ts"
import type { Revision } from "../coding/schema.ts"

const source = process.env.PLUE_CODING_ADAPTER_SOURCE
const exporter = process.env.PLUE_JJ_EXPORT_BINARY
const authoring = process.env.SMITHERS_ACCEPTANCE_SOURCE_ROOT ?? new URL("../", import.meta.url).pathname
test("configured coding host runs the real AgentAction, guarded file tool and native JJ atom", {
  skip: source === undefined || exporter === undefined ? "Set PLUE_CODING_ADAPTER_SOURCE and PLUE_JJ_EXPORT_BINARY to Plue's native artifacts" : false,
  timeout: 1_200_000
}, async t => {
  const { platform } = process.versions.bun
    ? await import("../../packages/smithers/src/internal/BunControl.ts")
    : await import("../../packages/smithers/src/internal/NodeControlHost.ts")
  // Keep the OS spelling: macOS /var resolves through /private/var. Existing
  // Write/Edit/ApplyPatch must work across Preserve's canonical sibling paths.
  const temporary = await mkdtemp(join(tmpdir(), "coding-host-native-"))
  let passed = false
  t.diagnostic(`Native host evidence: ${temporary}`)
  t.after(() => passed ? rm(temporary, { recursive: true, force: true }) : Promise.resolve())
  const root = join(temporary, "repo")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Native Coding Host")
  jj("config", "set", "--repo", "user.email", "acceptance@example.com")
  await mkdir(join(root, "flows", "coding", "implementation"), { recursive: true })
  for (const file of ["flow.ts", "schema.ts", "implementation/flow.ts"]) {
    await cp(join(authoring, "coding", file), join(root, "flows", "coding", file))
  }
  for (const tier of ["fast", "slow"]) {
    await mkdir(join(root, "flows", "checks", tier), { recursive: true })
    await writeFile(join(root, "flows", "checks", tier, "flow.mdx"),
      "---\ndescription: Verify the implemented file.\nflows: [coding/CommandCheck]\ncapabilities: ['*']\n---\n" +
      JSON.stringify({ argv: [process.execPath, "verify.mjs"], cwd: ".", timeoutMs: 30_000 }) + "\n")
  }
  await writeFile(join(root, "verify.mjs"), "import {readFileSync} from 'node:fs';\n" +
    "if (readFileSync('hello.txt', 'utf8') !== 'hello from the real agent cell\\n') process.exit(7);\n")
  // Declaration imports use this worktree's exact packages. Immutable checks
  // never borrow these dependencies or execute from the editing checkout.
  await symlink(join(authoring, "node_modules"), join(root, "node_modules"), "dir")
  await writeFile(join(root, ".gitignore"), ".flows/\nnode_modules\n*.tmp\nignored.txt\n")
  jj("status")
  const config = join(temporary, "coding.json"), reporter = join(temporary, "reporter"), wrapper = join(temporary, "adapter.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "host-acceptance", actorId: 42, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  const adapterSource = join(temporary, "native-adapter.py")
  await writeFile(adapterSource, (await readFile(source!, "utf8")).replace('"/usr/local/bin/smithers-jj-export"', JSON.stringify(exporter)))
  await writeFile(wrapper, `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("coding",${JSON.stringify(adapterSource)})\ncoding=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(coding)\ncoding.REPORTER_SCRIPT=${JSON.stringify(reporter)}\ntry:\n print(json.dumps(coding.run_local(${JSON.stringify(config)}, engine="--engine" in sys.argv)))\nexcept coding.CodingError as error:\n print(json.dumps({"error":{"code":error.code,"message":error.message}}))\n sys.exit(1)\n`)
  const options = { sourcePublication: "local-only" as const, repositoryPath: root, adapterPath: wrapper, credential: "fixture-key",
    gatewayId: "11111111-1111-4111-8111-111111111111", implementationModel: "test:scripted", exporterPath: exporter }
  const initial = await Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read()).pipe(
    Effect.provide(nativeLayer(options)), Effect.provide(platform.host), Effect.scoped))
  assert.equal(initial.head.kind, "resolved")
  const calls: string[] = []
  const hello = join(root, "hello.txt")
  const cell = `
    const ignored = await ctx.call("write", ${JSON.stringify({path:join(root,"ignored.txt"),content:"must not persist"})});
    if (ignored.ok !== false) throw new Error("ignored file was accepted");
    const written = await ctx.call("write", ${JSON.stringify({path:hello,content:"hello from the draft agent cell\n"})});
    if (written.ok === false) throw new Error(JSON.stringify(written));
    const edited = await ctx.call("edit", ${JSON.stringify({path:hello,oldString:"draft",newString:"actual"})});
    if (edited.ok === false) throw new Error(JSON.stringify(edited));
    const patched = await ctx.call("apply_patch", ${JSON.stringify({input:"*** Begin Patch\n*** Update File: "+hello+"\n@@\n-hello from the actual agent cell\n+hello from the real agent cell\n*** End Patch"})});
    if (patched.ok === false) throw new Error(JSON.stringify(patched));
    ctx.done(${JSON.stringify(JSON.stringify({summary:"Wrote and edited hello.txt",reads:["hello.txt"],writes:["hello.txt"]}))});`

  const model = Model.make({ stream: request => Stream.suspend(() => {
    calls.push(JSON.stringify(request))
    return Stream.fromIterable([
      ModelEvent.TextStart({ type: "text-start", id: "cell" }),
      ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
      ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
      ModelEvent.Settle({ type: "settle", stopReason: "stop" })
    ])
  }) })
  const seats = { resolve: (id: string) => Effect.succeed({ id, modelId: "scripted", model, contextWindowTokens: 100_000,
    route: { prepare: () => Effect.succeed({ routeId: "fixture", protocolId: "fixture", method: "POST" as const,
      url: "https://fixture.invalid", publicHeaders: {}, body: new TextEncoder().encode("{}"), bodyText: "{}" }) } }) }
  const registry = NativeControl.make(platform).layerRegistry(root)
  const implementation = await Effect.runPromise(Registry.Registry.pipe(
    Effect.flatMap(registry => registry.get("coding/implementation")), Effect.provide(registry), Effect.scoped))
  const checks = await Effect.runPromise(Effect.gen(function*() {
    const registry = yield* Registry.Registry
    return yield* Effect.forEach(["fast", "slow"] as const, tier => registry.get(`checks/${tier}`).pipe(
      Effect.map(descriptor => ({ id: tier, target: "hello.txt", flow: descriptor.name,
        flowDigest: Descriptor.executionDigest(descriptor)!, tier, required: true }))))
  }).pipe(Effect.provide(registry), Effect.scoped))
  const listening = await Effect.runPromise(Deferred.make<number>())
  const observedPlatform: NativeControl.Platform = { ...platform,
    gateway: (health, options) => platform.gateway(health, options).pipe(Layer.tap(context => {
      const server = Context.get(context, HttpServer.HttpServer)
      assert.equal(server.address._tag, "TcpAddress")
      if (server.address._tag !== "TcpAddress") throw new Error("expected TCP gateway")
      return Deferred.succeed(listening, server.address.port)
    })) }
  const result = await Effect.runPromise(Effect.gen(function*() {
    const control = yield* Control.Control
    yield* Effect.forkScoped(Serve.host({ host: "127.0.0.1", port: 0, listen: false, credential: "fixture-key" }, root).pipe(
      Effect.tapCause(cause => Effect.sync(() => t.diagnostic(Cause.pretty(cause))))))
    const port = yield* Deferred.await(listening).pipe(Effect.timeout("30 seconds"))
    const health = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/health`).then(response => response.json()))
    assert.equal(health.protocolVersion, "1")
    assert.equal(health.workspaceHash, Serve.workspaceHash(root))
    assert.equal(health.gatewayId, options.gatewayId)
    assert.deepEqual(health.capabilities, ["coding-plan/v1"])
    assert.equal(Serve.health(root).capabilities, undefined, "ordinary CLI health does not claim native coding")
    const card = yield* control.plan({ flowId: "coding", input: { plan: {
      prompt: "Write hello.txt", memoryRevision: "fixture", base: initial.head as Revision,
      changes: [{ id: "hello", title: "Hello", intent: "Write one file", implementation: "coding/implementation",
        implementationDigest: Descriptor.executionDigest(implementation)!, checks,
        atoms: [{ changeId: null, message: "✨ feat: add hello", intent: "Write hello.txt", reads: [], writes: ["hello.txt"] }] }]
    } } })
    yield* control.approve(card.approval)
    const receipt = yield* control.run({ _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope, idempotencyKey: "native-host" })
    assert.equal(receipt._tag, "Accepted")
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) throw new Error("expected accepted native run")
    return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
      Stream.tap(event => Effect.promise(() => appendFile(join(temporary, "control-events.ndjson"), JSON.stringify(event) + "\n"))),
      Stream.takeUntil(event => event.kind === "control.engine.projection-settled"), Stream.runCollect,
      Effect.timeout("180 seconds"))
  }).pipe(Effect.provide(layer(observedPlatform, options, seats)), Effect.scoped))
  const failed = result.find(event => event.kind === "control.run.failed")
  assert.equal(failed, undefined, JSON.stringify({ failed, contents: await readFile(join(root, "hello.txt"), "utf8").catch(() => null),
    history: jj("log", "--no-graph", "-r", "all()", "-T", "change_id ++ ' ' ++ description"),
    evidence: result.filter(event => event.kind === "control.engine.event").slice(-20) }))
  assert(result.some(event => event.kind === "control.run.completed"))
  assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "hello from the real agent cell\n")
  assert.equal(await readFile(join(root, "ignored.txt"), "utf8").catch(() => null), null)
  assert.equal(calls.length, 1)
  assert.equal(jj("log", "--no-graph", "-r", "@", "-T", "description").trim(), "✨ feat: add hello")
  passed = true
})
