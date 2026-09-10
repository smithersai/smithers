import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Control, ControlRpcs } from "@smthrs/control"
import * as Model from "@smthrs/model/Model"
import { ModelEvent } from "@smthrs/model/ModelEvent"
import { Cause, Context, Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import * as HttpServer from "effect/unstable/http/HttpServer"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import { layer } from "../coding/host.ts"
import { NativeCoding, nativeLayer } from "../coding/native.ts"
import { RequestResult } from "../coding/schema.ts"
import { PocResult } from "../coding/poc.ts"
import { operations } from "../wiki/operations.ts"
import { policySources } from "../wiki/reuse.ts"
import type { PageSpec } from "../wiki/schema.ts"

const source = process.env.PLUE_CODING_ADAPTER_SOURCE
const exporter = process.env.PLUE_JJ_EXPORT_BINARY
const authoring = process.env.SMITHERS_ACCEPTANCE_SOURCE_ROOT ?? new URL("../", import.meta.url).pathname
test("configured request host verifies wiki, prototypes, consumes steering, replans and implements through native correction", {
  skip: source === undefined || exporter === undefined ? "Set PLUE_CODING_ADAPTER_SOURCE and PLUE_JJ_EXPORT_BINARY to Plue's native artifacts" : false,
  timeout: 1_200_000
}, async t => {
  const { platform } = process.versions.bun
    ? await import("../../packages/smithers/src/internal/BunControl.ts")
    : await import("../../packages/smithers/src/internal/NodeControlHost.ts")
  // Keep the OS spelling: macOS /var resolves through /private/var. Existing
  // Write/Edit/ApplyPatch must work across Preserve's canonical sibling paths.
  const temporary = await mkdtemp(join(tmpdir(), "coding-request-host-"))
  let passed = false
  t.diagnostic(`Native host evidence: ${temporary}`)
  t.after(() => passed ? rm(temporary, { recursive: true, force: true }) : Promise.resolve())
  const root = join(temporary, "repo")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Native Coding Host")
  jj("config", "set", "--repo", "user.email", "acceptance@example.com")
  await mkdir(join(root, "flows", "coding", "implementation"), { recursive: true })
  await mkdir(join(root, "flows", "coding", "request"), { recursive: true })
  for (const file of ["flow.ts", "schema.ts", "implementation/flow.ts", "request/flow.ts"]) {
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
  await writeFile(join(root, "guide.md"), "# File verifier\n\nThe verifier reads hello.txt.\n")
  await mkdir(join(root, "flows", "wiki"), { recursive: true })
  for (const file of policySources) await cp(join(authoring, "..", file), join(root, file))
  const page: PageSpec = { id: "verifier", title: "File verifier", kind: "current", purpose: "Find the current verifier.",
    document: "guide.md", inputs: ["verify.mjs", ...policySources], related: [] }
  const wikiOutput = join(root, ".flows", "wiki")
  const wiki = operations({ root, output: wikiOutput })
  const evidence = await Effect.runPromise(wiki.collect(page).pipe(Effect.provide(platform.host)))
  const wikiReview = { sections: evidence.sections.map(section => ({ id: section.id, verdict: "supported", explanation: "The fixture reads its file.",
    citations: [{ path: "verify.mjs", line: 1, quote: "import {readFileSync} from 'node:fs';" }] })) }
  jj("status")
  const config = join(temporary, "coding.json"), reporter = join(temporary, "reporter"), wrapper = join(temporary, "adapter.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "host-acceptance", actorId: 42, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  const adapterSource = join(temporary, "native-adapter.py")
  await writeFile(adapterSource, (await readFile(source!, "utf8")).replace('"/usr/local/bin/smithers-jj-export"', JSON.stringify(exporter)))
  await writeFile(wrapper, `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("coding",${JSON.stringify(adapterSource)})\ncoding=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(coding)\ncoding.REPORTER_SCRIPT=${JSON.stringify(reporter)}\ntry:\n print(json.dumps(coding.run_local(${JSON.stringify(config)}, engine="--engine" in sys.argv)))\nexcept coding.CodingError as error:\n print(json.dumps({"error":{"code":error.code,"message":error.message}}))\n sys.exit(1)\n`)
  const options = { repositoryPath: root, adapterPath: wrapper, credential: "fixture-key",
    gatewayId: "11111111-1111-4111-8111-111111111111", implementationModel: "test:scripted", exporterPath: exporter,
    planning: { wikiOutput, pages: [page], reviewer: "scripted-host-acceptance/v1", implementation: "coding/implementation", checks: ["fast", "slow"].map(tier => ({
      id: tier, target: "hello.txt", flow: `checks/${tier}`, tier: tier as "fast" | "slow", required: true
    })) } }
  const initial = await Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read()).pipe(
    Effect.provide(nativeLayer(options)), Effect.provide(platform.host), Effect.scoped))
  assert.equal(initial.head.kind, "resolved")
  const calls: string[] = []
  const planningEntered = await Effect.runPromise(Deferred.make<void>())
  const steeringAdmitted = await Effect.runPromise(Deferred.make<void>())
  const feedbackText = "Keep the exact greeting and describe the compact layout in the revised plan."
  let planningPasses = 0
  t.after(() => passed ? Promise.resolve() : writeFile(join(temporary, "model-requests.json"), JSON.stringify(calls.map(value => JSON.parse(value)), null, 2)))
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
    const serialized = JSON.stringify(request)
    calls.push(serialized)
    const review = serialized.includes("Review a coding request against supplied repository memory")
    const planning = serialized.includes("Plan one linear mythical coding progression")
    const wikiReviewing = serialized.includes("Review a repository wiki page against its exact source snapshot")
    const draftingPoc = serialized.includes("Draft a small disposable file-level prototype")
    const reviewingPoc = serialized.includes("Review this actually materialized, discarded file-level prototype")
    const response = wikiReviewing ? wikiReview
      : draftingPoc ? { explanation: "Try a deliberately incomplete greeting in the discarded prototype.", files: [{ path: "hello.txt", content: "prototype greeting\n" }] }
      : reviewingPoc ? { findings: ["The measured prototype greeting differs from the verifier's expected text; no checks ran."], nextPlan: "Use the exact expected real greeting for implementation." }
      : review ? { explanation: "The repository has a file verifier; preserve its expected contents.", clarification: "" }
      : { rationale: "Append one native atom and use both registered checks.", baseChangeId: initial.head.changeId,
          changes: [{ id: "hello", title: "Hello", intent: "Write the requested file.", checks: ["fast", "slow"],
            atoms: [{ changeId: null, message: "✨ feat: add hello", intent: "Write hello.txt", reads: ["verify.mjs"], writes: ["hello.txt"] }] }] }
    const emitted = review || planning || wikiReviewing || draftingPoc || reviewingPoc ? `
      const forbidden = await ctx.call("write", ${JSON.stringify({path:join(root,"planner-mutation.txt"),content:"must not persist"})});
      if (forbidden.ok !== false) throw new Error("planning unexpectedly had mutation authority");
      ctx.done(${JSON.stringify(response)});` : cell
    const events = Stream.fromIterable([
      ModelEvent.TextStart({ type: "text-start", id: "cell" }),
      ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + emitted + "\n```" }),
      ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
      ModelEvent.Settle({ type: "settle", stopReason: "stop" })
    ])
    // Hold the second planning response while the actual Control operation
    // admits a root message. The coordinator must consume it after this plan
    // completes and replan before any implementation begins.
    return planning && ++planningPasses === 2
      ? Stream.fromEffect(Deferred.succeed(planningEntered, undefined).pipe(
        Effect.andThen(Deferred.await(steeringAdmitted)))).pipe(Stream.flatMap(() => events))
      : events
  }) })
  const seats = { resolve: (id: string) => Effect.succeed({ id, modelId: "scripted", model, contextWindowTokens: 100_000,
    route: { prepare: () => Effect.succeed({ routeId: "fixture", protocolId: "fixture", method: "POST" as const,
      url: "https://fixture.invalid", publicHeaders: {}, body: new TextEncoder().encode("{}"), bodyText: "{}" }) } }) }
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
    assert.deepEqual(health.capabilities, ["coding-plan/v1", "coding-request/v1"])
    assert.equal(Serve.health(root).capabilities, undefined, "ordinary CLI health does not claim native coding")
    // Use the actual bearer-authenticated HTTP protocol for every mutation.
    // An in-process operator approval cannot prove a hosted UI can approve.
    const protocol = yield* Layer.build(RpcClient.layerProtocolHttp({
      url: `http://127.0.0.1:${port}/rpc`,
      transformClient: client => HttpClient.mapRequest(client, HttpClientRequest.bearerToken("fixture-key"))
    }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson])))
    const remote = yield* RpcClient.make(ControlRpcs.ControlRpcs).pipe(Effect.provide(protocol))
    const card = yield* remote.Plan({ flowId: "coding/request", input: { prompt: "Write hello.txt", feedback: "Keep the verifier unchanged.", maxRounds: 2 } })
    yield* remote.Approve(card.approval)
    const receipt = yield* remote.Run({ _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope, idempotencyKey: "native-request-host" })
    assert.equal(receipt._tag, "Accepted")
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) throw new Error("expected accepted native run")
    const runId = receipt.runId
    yield* Effect.forkScoped(Deferred.await(planningEntered).pipe(Effect.andThen(Effect.gen(function*() {
      const steering = yield* remote.Steer({ runId, message: { runId, messageId: "native-request-poc-feedback", body: feedbackText,
        principal: { id: "native-host-fixture", kind: "human", stampedAt: 0 }, createdAt: 0 }, idempotencyKey: "native-request-poc-feedback" })
      assert.equal(steering._tag, "Accepted")
      yield* Deferred.succeed(steeringAdmitted, undefined)
    }))))
    return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
      Stream.tap(event => Effect.promise(() => appendFile(join(temporary, "control-events.ndjson"), JSON.stringify(event) + "\n"))),
      Stream.takeUntil(event => event.kind === "control.engine.projection-settled"), Stream.runCollect,
      Effect.timeout("600 seconds"))
  }).pipe(Effect.provide(layer(observedPlatform, options, seats)), Effect.scoped))
  const failed = result.find(event => event.kind === "control.run.failed")
  assert.equal(failed, undefined, JSON.stringify({ failed, contents: await readFile(join(root, "hello.txt"), "utf8").catch(() => null),
    history: jj("log", "--no-graph", "-r", "all()", "-T", "change_id ++ ' ' ++ description"),
    evidence: result.filter(event => event.kind === "control.engine.event").slice(-20) }))
  assert(result.some(event => event.kind === "control.run.completed"))
  assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "hello from the real agent cell\n")
  assert.equal(await readFile(join(root, "ignored.txt"), "utf8").catch(() => null), null)
  assert.equal(await readFile(join(root, "planner-mutation.txt"), "utf8").catch(() => null), null)
  await writeFile(join(temporary, "model-requests.json"), JSON.stringify(calls.map(value => JSON.parse(value)), null, 2))
  assert.equal(calls.length, 10, "One wiki review, three planning passes, POC draft/review and one implementation; unchanged wiki reviews reuse actual receipts")
  const planningCalls = calls.filter(value => value.includes("Plan one linear mythical coding progression"))
  assert.equal(planningCalls.length, 3)
  const implementationIndex = calls.findIndex(value => ![
    "Review a repository wiki page", "Review a coding request", "Plan one linear mythical coding progression",
    "Draft a small disposable file-level prototype", "Review this actually materialized"
  ].some(marker => value.includes(marker)))
  assert(implementationIndex > calls.indexOf(planningCalls[2]!), "native implementation must follow the third, steered plan")
  assert(planningCalls[1]!.includes("Keep the verifier unchanged."))
  assert(planningCalls[1]!.includes("Saved disposable file-level POC: drafted-unvalidated"))
  assert(!planningCalls[1]!.includes(feedbackText), "a root request message must not be consumed by the in-flight model turn")
  for (const text of [feedbackText, "Keep the verifier unchanged.", "Saved disposable file-level POC: drafted-unvalidated", "request message"]) {
    assert(planningCalls[2]!.includes(text), `replanning must retain ${text}`)
  }
  assert.ok(calls.some(call => call.includes("The verifier reads hello.txt.")), "planning must receive verified repository memory")
  const completed = Schema.Struct({ payload: Schema.Struct({ state: Schema.Struct({
    flowName: Schema.Literal("coding/Request"), result: Schema.Struct({ _tag: Schema.Literal("Complete"),
      exit: Schema.Struct({ _tag: Schema.Literal("Success"), value: RequestResult }) })
  }) }) })
  const outcomes = result.filter(event => event.kind === "control.engine.event").flatMap(event => {
    const decoded = Schema.decodeUnknownOption(completed)(event.payload)
    return Option.isSome(decoded) ? [decoded.value.payload.state.result.exit.value] : []
  })
  assert.equal(outcomes.length, 1, "the actual Request child must have one typed completed result")
  assert.equal(outcomes[0]!.outcome.status, "validated")
  const completedPoc = Schema.Struct({ payload: Schema.Struct({ state: Schema.Struct({
    flowName: Schema.Literal("coding/Poc"), result: Schema.Struct({ _tag: Schema.Literal("Complete"),
      exit: Schema.Struct({ _tag: Schema.Literal("Success"), value: PocResult }) })
  }) }) })
  const prototypes = result.filter(event => event.kind === "control.engine.event").flatMap(event => {
    const decoded = Schema.decodeUnknownOption(completedPoc)(event.payload)
    return Option.isSome(decoded) ? [decoded.value.payload.state.result.exit.value] : []
  })
  assert.equal(prototypes.length, 1, "the discarded prototype remains inspectable in its own native child result")
  assert.equal(prototypes[0]!.status, "drafted-unvalidated")
  assert.equal(prototypes[0]!.source.commitId, initial.head.commitId)
  assert.deepEqual(prototypes[0]!.changes.files.map(({ path, before, after }) => ({ path, before, after })),
    [{ path: "hello.txt", before: null, after: "prototype greeting\n" }])
  assert(prototypes[0]!.changes.preview.content.includes("prototype greeting"))
  assert.equal(outcomes[0]!.plan.observedHead?.commitId, initial.head.commitId)
  assert.equal(outcomes[0]!.outcome.result?.changes[0]?.implementation.atoms[0]?.changeId,
    jj("log", "--no-graph", "-r", "@", "-T", "change_id").trim())
  assert.equal(jj("log", "--no-graph", "-r", "@", "-T", "description").trim(), "✨ feat: add hello")
  if (process.env.SMITHERS_ACCEPTANCE_EVENTS) {
    await cp(join(temporary, "control-events.ndjson"), process.env.SMITHERS_ACCEPTANCE_EVENTS)
  }
  passed = true
})
