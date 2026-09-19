import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test, type TestContext } from "node:test"
import * as Seat from "@smthrs/agent/Seat"
import { Control, ControlRpcs } from "@smthrs/control"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import { ModelEvent } from "@smthrs/model/ModelEvent"
import { Cause, Context, Deferred, Effect, Layer, Schema, Stream } from "effect"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as NetAddress from "effect/unstable/net/NetAddress"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import { layer } from "../coding/host.ts"
import { NativeCoding, nativeLayer } from "../coding/native.ts"
import { RepositoryRemote } from "../repository/remote.ts"
import { triggerCandidate } from "../repository/schema.ts"

const source = process.env.PLUE_CODING_ADAPTER_SOURCE, exporter = process.env.PLUE_JJ_EXPORT_BINARY
const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value))
const nativeOptions = {
  skip: source === undefined || exporter === undefined ? "Set the Plue native adapter and exporter paths" : false, timeout: 300000
}
const repo = "example/demo", workspaceId = "22222222-2222-4222-8222-222222222222"
const SCHEDULE = "0 9 * * 1-5"

/** Every fixture entry this host discovers, and why each one is there. */
const fixtures = (target: string, marker: string) => ({
  /** The supported form: one model this workspace's resolver answers. */
  "flows/nightly-report/flow.mdx": ["---", "description: A maintainer's own scheduled report.",
    "model: test:scripted", `capabilities: ["fs:read:**"]`, "budget:", "  tokens: 200000", "  milliseconds: 600000", "---", "Summarise the repository.", ""].join("\n"),
  /** Declares no ceiling, so `Descriptor.budgetOf` answers `{}` and nothing bounds an unattended fire. */
  "flows/unbounded-report/flow.mdx": ["---", "description: A scheduled report that declares no ceiling.",
    "model: test:scripted", `capabilities: ["fs:read:**"]`, "---", "Summarise the repository.", ""].join("\n"),
  /** Names one host delegate and no model, so no dispatch can launch it. */
  "flows/nightly-check/flow.mdx": ["---", "description: Run the reviewed command on a schedule.",
    "flows: [coding/CommandCheck]", `capabilities: ["proc:spawn:*", "fs:read:**"]`, "budget:", "  tokens: 200000", "  milliseconds: 600000", "---", target, ""].join("\n"),
  /** A model this workspace holds no credential for. */
  "flows/unbound-seat/flow.mdx": ["---", "description: A report on a provider this workspace has not connected.",
    "model: openai:gpt-5.6-sol", `capabilities: ["fs:read:**"]`, "budget:", "  tokens: 200000", "  milliseconds: 600000", "---", "Summarise the repository.", ""].join("\n"),
  /** Runnable, but declares an input schema the engine ignores. */
  "flows/declared-input/flow.mdx": ["---", "description: Run the reviewed command on a schedule.",
    "model: test:scripted", "input: { label: string }", `capabilities: ["fs:read:**"]`, "budget:", "  tokens: 200000", "  milliseconds: 600000", "---", "Summarise the repository.", ""].join("\n"),
  /** A module entry whose imports do not resolve: refused by the markdown gate. */
  "flows/module-entry/flow.ts": ['import { Flow } from "@smthrs/core"', 'import { Schema } from "effect"',
    'export default Flow.make({ description: "A module entry.", flows: ["coding/CommandCheck"], capabilities: ["proc:spawn:*"],',
    '  budget: { tokens: 200000, milliseconds: 600000 }, input: Schema.Unknown, output: Schema.Unknown })', ""].join("\n"),
  /** A module entry that imports cleanly, so it is the one an executable
   * catalog accepts. It records that its top-level code ran. */
  "flows/loaded-module/flow.ts": ['import { appendFileSync } from "node:fs"', 'import { Flow } from "@smthrs/core"', 'import { Schema } from "effect"',
    `appendFileSync(${JSON.stringify(marker)}, "loaded-module evaluated\\n")`,
    'export default Flow.make({ description: "A module entry that loads.", flows: ["coding/CommandCheck"], capabilities: ["proc:spawn:*"],',
    '  budget: { tokens: 200000, milliseconds: 600000 }, input: Schema.Unknown, output: Schema.Unknown })', ""].join("\n")
})

/** The one seat this workspace resolves. Every other seat refuses exactly as
 * the native resolver refuses a provider with no key. */
const scriptedSeats = () => {
  const model = Model.make({
    stream: () => Stream.fromIterable([
      ModelEvent.TextStart({ type: "text-start", id: "cell" }),
      ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: '```cell\nctx.done("The repository is quiet.");\n```' }),
      ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
      ModelEvent.Settle({ type: "settle", stopReason: "stop" })
    ])
  })
  return { resolve: (id: string) => id === "test:scripted"
    ? Effect.succeed(Seat.make({ id, modelId: "scripted", model, contextWindowTokens: 100000,
      route: { prepare: () => Effect.succeed({ routeId: "fixture", protocolId: "fixture", method: "POST" as const,
        url: "https://fixture.invalid", publicHeaders: {}, body: new TextEncoder().encode("{}"), bodyText: "{}" }) } }))
    : Effect.fail(new Seat.SeatUnresolved({ seat: id, message: `Set a provider key to run the ${id} seat` })) }
}

/** The one judge this host runs with, and the only reader it answers.
 *
 * The harness's completion brake never falls back: a claim no evaluator could
 * judge fails the run as `completion_unjudged`, so a host bound to
 * `Evaluator.layerUnavailable()` — which is what a machine with no
 * `AI_GATEWAY_API_KEY` binds — cannot finish the scripted `ctx.done` below.
 * This reads that one claim as done and modest so the completion stands, and
 * refuses every other question with the transport's own `unreachable`, which
 * is exactly what a keyless host answers each of them: no case here asserts
 * anything a judge decides, and none may start passing because a fixture
 * said yes. */
const scriptedEvaluator = Evaluator.layerScripted(request =>
  "complete" in request.questions && "overclaims" in request.questions
    ? { complete: { probability: 0.99 }, overclaims: { probability: 0.01 } }
    : Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "No evaluator is installed on this host" })))

interface Probe {
  readonly register: (request: Record<string, unknown>) => Promise<{ failure?: string; output?: any }>
  readonly plan: (flowId: string, input: unknown, key: string) => Promise<any>
  readonly approve: (plan: any) => Promise<unknown>
  /** Plan, approve and run one flow the way the app's Run door does. */
  readonly runFlow: (flowId: string, input: unknown, key: string) => Promise<Record<string, unknown> | undefined>
  readonly flows: () => Promise<ReadonlyArray<string>>
  readonly runs: () => Promise<ReadonlyArray<Record<string, unknown>>>
  readonly registrations: Array<Record<string, any>>
  readonly dispatches: Array<Record<string, any>>
  /** This host start's repository root, so a test can move the working copy. */
  readonly root: string
  /** The repository's own resolved head, so a fixture can name a real revision. */
  readonly head: any
}

/** One temporary repository, served by one host start at a time. A restart is
 * what makes a discovery snapshot move, so drift is proved across two. */
interface Fixture {
  readonly root: string
  readonly jj: (...args: string[]) => string
  readonly base: { repositoryPath: string; adapterPath: string; sourcePublication: "local-only"; exporterPath: string | undefined }
  readonly native: any
  /** Written by `flows/loaded-module/flow.ts` whenever its module body runs. */
  readonly marker: string
  readonly registrations: Array<Record<string, any>>
  readonly dispatches: Array<Record<string, any>>
  readonly settled: () => void
}

async function makeRepository(t: TestContext): Promise<Fixture> {
  const temporary = await mkdtemp(join(tmpdir(), "repository-trigger-")), root = join(temporary, "repo")
  let passed = false
  t.diagnostic(`Native trigger evidence: ${temporary}`)
  t.after(() => passed ? rm(temporary, { recursive: true, force: true }) : Promise.resolve())
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Repository test")
  jj("config", "set", "--repo", "user.email", "repository@example.com")
  await writeFile(join(root, ".gitignore"), "node_modules\n.flows/\n")
  await writeFile(join(root, "README.md"), "# Trigger fixture\n")
  const marker = join(temporary, "module-evaluated.marker")
  const target = JSON.stringify({ argv: [process.execPath, "-e", "process.exit(0)"], cwd: ".", timeoutMs: 30000 })
  await mkdir(join(root, "node_modules/@smthrs"), { recursive: true })
  await symlink(fileURLToPath(new URL("../../packages/smithers/flows/core", import.meta.url)), join(root, "node_modules/@smthrs/core"))
  await symlink(fileURLToPath(new URL("../../node_modules/effect", import.meta.url)), join(root, "node_modules/effect"))
  for (const [name, contents] of Object.entries(fixtures(target, marker))) {
    await mkdir(join(root, name.split("/").slice(0, -1).join("/")), { recursive: true })
    await writeFile(join(root, name), contents)
  }
  jj("status")
  jj("new", "-m", "Declare the scheduled flows")
  jj("status")
  const config = join(temporary, "binding.json"), reporter = join(temporary, "reporter")
  const adapter = join(temporary, "adapter.py"), nativeSource = join(temporary, "native.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "host-repository", actorId: 42, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(nativeSource, (await readFile(source!, "utf8")).replace('"/usr/local/bin/smithers-jj-export"', JSON.stringify(exporter)))
  await writeFile(adapter, `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("coding",${JSON.stringify(nativeSource)})\ncoding=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(coding)\ncoding.REPORTER_SCRIPT=${JSON.stringify(reporter)}\ntry:\n print(json.dumps(coding.run_local(${JSON.stringify(config)}, engine="--engine" in sys.argv)))\nexcept coding.CodingError as error:\n print(json.dumps({"error":{"code":error.code,"message":error.message}}))\n sys.exit(1)\n`)
  const { platform } = await import("../../packages/smithers/src/internal/NodeControlHost.ts")
  const base = { repositoryPath: root, adapterPath: adapter, sourcePublication: "local-only" as const, exporterPath: exporter }
  const native = await Effect.runPromise(Effect.flatMap(NativeCoding, coding => coding.read()).pipe(
    Effect.provide(nativeLayer(base)), Effect.provide(platform.host), Effect.scoped))
  return { root, jj, base, native, marker, registrations: [], dispatches: [], settled: () => { passed = true } }
}

async function withHost(t: TestContext, fixture: Fixture, use: (probe: Probe) => Promise<void>) {
  const { platform } = await import("../../packages/smithers/src/internal/NodeControlHost.ts")
  const { root, base, native, registrations, dispatches } = fixture
  const remote = RepositoryRemote.of({ repo, workspaceId,
    source: Effect.succeed("smithers-cloud"),
    registrations: Effect.suspend(() => Effect.succeed(json(registrations.map((row, index) => ({
      id: `registration-${index}`, job: row.job, revision: row.body.revision, digest: row.body.digest, enabled: true }))))),
    history: Effect.succeed({ records: [], sources: [] }),
    pause: () => Effect.succeed(json({ enabled: false })),
    dispatches: () => Effect.succeed(json([])),
    createTrial: () => Effect.succeed(json({})),
    manual: (job, requestId, raw) => Effect.sync(() => {
      const value = raw as Record<string, any>
      dispatches.push({ job, requestId, body: value })
      return json({ dispatch_id: 7, registration_id: "33333333-3333-4333-8333-333333333333", revision: value.revision,
        digest: value.digest, status: "submitted", delivery_key: `manual:${requestId}`, job })
    }),
    register: (job, raw) => Effect.sync(() => {
      const body = raw as Record<string, any>
      registrations.push({ job, body })
      return json({ registration_id: "33333333-3333-4333-8333-333333333333", revision: body.revision, digest: body.digest,
        source_revision: body.source_revision, mode: "enabled", enabled: true, schedule: body.schedule,
        next_fire_at: "2026-09-18T09:00:00Z", timezone: "UTC" })
    })
  })
  const listening = await Effect.runPromise(Deferred.make<number>())
  const observedPlatform: NativeControl.Platform = { ...platform, evaluator: scriptedEvaluator, gateway: (health, options) => platform.gateway(health, options).pipe(Layer.tap(context => {
    const server = Context.get(context, HttpServer.HttpServer)
    if (!NetAddress.isInetAddress(server.address)) throw new Error("expected TCP gateway")
    return Deferred.succeed(listening, server.address.port)
  })) }
  const hostLayer = layer(observedPlatform, { ...base, gatewayId: "11111111-1111-4111-8111-111111111111", credential: "fixture-key",
    implementationModel: "test:scripted", checkEnvironment: { PATH: process.env.PATH! },
    repositoryRemote: Layer.succeed(RepositoryRemote, remote) }, scriptedSeats())
  await Effect.runPromise(Effect.gen(function*() {
    const control = yield* Control.Control
    yield* Effect.forkScoped(Serve.host({ host: "127.0.0.1", port: 0, listen: false, credential: "fixture-key" }, root).pipe(
      Effect.tapCause(cause => Effect.sync(() => t.diagnostic(Cause.pretty(cause))))))
    const port = yield* Deferred.await(listening).pipe(Effect.timeout("60 seconds"))
    const protocol = yield* Layer.build(RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${port}/rpc`,
      transformClient: client => HttpClient.mapRequest(client, HttpClientRequest.bearerToken("fixture-key")) }).pipe(
      Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson])))
    const client = yield* RpcClient.make(ControlRpcs.ControlRpcs).pipe(Effect.provide(protocol))
    const plan = (flowId: string, input: unknown, key: string): Promise<any> => Effect.runPromise(client.Plan({ flowId, input: json(input), idempotencyKey: key }))
    const approve = (planned: any): Promise<unknown> => Effect.runPromise(client.Approve({ ...planned.approval, scope: "once" }))
    const flows = (): Promise<ReadonlyArray<string>> => Effect.runPromise(Effect.map(client.List({ _tag: "flows" }),
      (listed: any) => (listed.items as ReadonlyArray<{ readonly flowId: string }>).map(item => item.flowId)))
    let attempt = 0
    const session = Math.random().toString(36).slice(2, 8)
    const runs = (): Promise<ReadonlyArray<Record<string, unknown>>> => Effect.runPromise(Effect.map(client.List({ _tag: "runs" }),
      (listed: any) => (listed.items as ReadonlyArray<any>).map(row => ({ runId: row.runId, flowId: row.flowId, status: row.status, waitingReason: row.waitingReason, pendingWaits: row.pendingWaits }))))
    const settle = (runId: string) => control.watch({ runId, follow: true }).pipe(
      Stream.takeUntil(event => event.kind === "control.engine.projection-settled"), Stream.runCollect,
      Effect.timeoutOrElse({ duration: "120 seconds", orElse: () => Effect.succeed([] as any) }))
    const runFlow = (flowId: string, input: unknown, key: string) => Effect.runPromise(Effect.gen(function*() {
      const planned: any = yield* client.Plan({ flowId, input: json(input), idempotencyKey: `${key}:plan` })
      yield* client.Approve({ ...planned.approval, scope: "once" })
      const launched: any = yield* client.Run({ _tag: "Plan", planId: planned.planId, digest: planned.digest, envelope: planned.envelope, idempotencyKey: `${key}:run` })
      yield* settle(launched.runId)
      return (yield* Effect.promise(runs)).find(row => row.runId === launched.runId)
    }).pipe(Effect.provideService(Control.Control, control)))
    const register = (request: Record<string, unknown>) => Effect.runPromise(Effect.gen(function*() {
      const key = `register:${session}:${String(request.slug)}:${String(request.operation ?? "register")}:${attempt++}`
      const planned: any = yield* client.Plan({ flowId: "repository/trigger", input: json(request), idempotencyKey: `${key}:plan` })
      yield* client.Approve({ ...planned.approval, scope: "once" })
      const launched: any = yield* client.Run({ _tag: "Plan", planId: planned.planId, digest: planned.digest, envelope: planned.envelope, idempotencyKey: `${key}:run` })
      const events = yield* settle(launched.runId)
      const outputs = (events as ReadonlyArray<any>).flatMap((event: any) => { const state = (event.payload as any)?.payload?.state
        return state?.flowName === "repository/Trigger" && state?.result?._tag === "Complete" && state.result.exit?._tag === "Success" ? [state.result.exit.value] : [] })
      if (outputs.length === 1) return { output: outputs[0] } as { failure?: string; output?: any }
      return { failure: JSON.stringify(events) } as { failure?: string; output?: any }
    }).pipe(Effect.provideService(Control.Control, control)))
    yield* Effect.promise(() => use({ register, plan, approve, runFlow, flows, runs, registrations, dispatches, root, head: native.head }))
  }).pipe(Effect.provide(hostLayer), Effect.scoped))
}

const proveTrigger = async (t: TestContext, use: (probe: Probe) => Promise<void>) => {
  const fixture = await makeRepository(t)
  await withHost(t, fixture, use)
  fixture.settled()
}

/** The exact sentence, as it survives JSON encoding inside a recorded event. */
const says = (recorded: string, sentence: string) =>
  assert(recorded.includes(JSON.stringify(sentence).slice(1, -1)), `expected the recorded refusal to say ${JSON.stringify(sentence)}; got ${recorded.slice(0, 4000)}`)

const REQUEST = { operation: "register", repo, slug: "nightly", flow: "nightly-report", schedule: SCHEDULE,
  input: { label: "nightly" }, approvedPlanId: "plan", approvedPlanDigest: "a".repeat(64) }

test("this host runs a maintainer's model-only markdown flow, and every flow the picker offers gets an answer naming it", nativeOptions, t =>
  proveTrigger(t, async probe => {
    const listed = await probe.flows()
    assert(listed.includes("repository/trigger"), `repository/trigger must be registered; got ${JSON.stringify(listed)}`)
    for (const name of ["nightly-report", "nightly-check", "unbound-seat", "declared-input", "module-entry", "loaded-module"]) {
      assert(listed.includes(name), `discovery lists ${name}; got ${JSON.stringify(listed)}`)
    }
    // The form the registrar admits is the form this host executes: plan it,
    // approve it, run it, and let the run settle on its own.
    const run = await probe.runFlow("nightly-report", { label: "nightly" }, "falsifier:nightly-report")
    assert.equal(run?.status, "completed", `a model-only markdown flow must run here; got ${JSON.stringify(run)}`)
    // The measured reason the gate keeps refusing module entries: a module
    // body reaches its host delegate's typed payload, not a prompt, so a
    // schedule's registered JSON cannot drive one.
    const module = await probe.runFlow("loaded-module", { label: "nightly" }, "measured:loaded-module")
    assert.equal(module?.status, "failed", `a module entry cannot run a schedule's input; got ${JSON.stringify(module)}`)
    // The picker and the registrar agree: every offered flow either registers
    // or is refused by a sentence that names it.
    for (const flow of ["nightly-report", "nightly-check", "unbound-seat", "declared-input", "module-entry", "loaded-module"]) {
      const answer = await probe.register({ ...REQUEST, slug: "picked", flow })
      says(String(answer.failure ?? JSON.stringify(answer.output)), `"${flow}"`)
    }
  }))

test("the form gate refuses a reserved name, an unknown flow, a module entry, a declared input schema, a missing model, an unresolvable seat and a sub-hourly schedule", nativeOptions, t =>
  proveTrigger(t, async probe => {
    const reserved = await probe.register({ ...REQUEST, flow: "repository/setup" })
    says(String(reserved.failure), `"repository/setup" is a reserved repository job; register it through repository setup.`)
    const unknown = await probe.register({ ...REQUEST, slug: "weekly", flow: "weekly-sweep" })
    says(String(unknown.failure), `No flow "weekly-sweep" is registered on this workspace. The workspace has: `)
    says(String(unknown.failure), "nightly-report")
    const module = await probe.register({ ...REQUEST, slug: "modular", flow: "module-entry" })
    says(String(module.failure), `"module-entry" is a flow.ts. Schedules run flow.mdx.`)
    // The entry a catalog accepts takes the same branch: the gate reads the
    // discovered body, never an import.
    const loaded = await probe.register({ ...REQUEST, slug: "loaded", flow: "loaded-module" })
    says(String(loaded.failure), `"loaded-module" is a flow.ts. Schedules run flow.mdx.`)
    const declared = await probe.register({ ...REQUEST, slug: "declared", flow: "declared-input" })
    says(String(declared.failure), `"declared-input" declares an input schema the engine ignores (discovery warning unsupported_input_schema). Remove it: a trigger delivers your registered input to the flow as JSON, unvalidated.`)
    const modelless = await probe.register({ ...REQUEST, slug: "delegated", flow: "nightly-check" })
    says(String(modelless.failure), `Add a model to "nightly-check" to schedule it.`)
    const unbound = await probe.register({ ...REQUEST, slug: "unbound", flow: "unbound-seat" })
    says(String(unbound.failure), `Connect openai to schedule "unbound-seat".`)
    const cron = await probe.register({ ...REQUEST, slug: "hourly", schedule: "0 * * *" })
    says(String(cron.failure), "schedule must have five cron fields in UTC")
    const frequent = await probe.register({ ...REQUEST, slug: "frequent", schedule: "*/5 * * * *" })
    says(String(frequent.failure), "Schedules run at most once an hour.")
    const unapproved = await probe.register({ ...REQUEST, slug: "unapproved", approvedPlanId: "", approvedPlanDigest: "" })
    says(String(unapproved.failure), "a flow trigger must name the plan a person approved")
    assert.equal(probe.registrations.length, 0, "no refused request may reach the repository registration")
  }))

test("the registrar registers only a plan a person approved, with the exact candidate and input", nativeOptions, t =>
  proveTrigger(t, async probe => {
    const input = { label: "nightly" }
    const planned = await probe.plan("nightly-report", input, `trigger:${repo}:nightly:plan`)
    assert.equal(planned.flowId, "nightly-report")
    // An unapproved plan registers nothing, and this registrar never approves
    // one: it reads its own journal for the decision a person made.
    const pending = await probe.register({ ...REQUEST, input, approvedPlanId: planned.planId, approvedPlanDigest: planned.digest })
    says(String(pending.failure), `The plan for "nightly-report" is pending; a person approves the preview before it can be scheduled.`)
    assert.equal(probe.registrations.length, 0, "an unapproved plan registers nothing")
    // The person approves, out of band, exactly as the app does.
    await probe.approve(planned)
    const registered = await probe.register({ ...REQUEST, input, approvedPlanId: planned.planId, approvedPlanDigest: planned.digest })
    assert(registered.output, `expected a registration receipt; runs=${JSON.stringify(await probe.runs())}; got ${String(registered.failure).slice(0, 2000)}`)
    assert.equal(probe.registrations.length, 1, JSON.stringify(probe.registrations))
    const sent = probe.registrations[0]!
    assert.equal(sent.job, "flow:nightly")
    assert.equal(sent.body.flow_id, "nightly-report")
    assert.equal(sent.body.mode, "enabled")
    assert.deepEqual(sent.body.events, [])
    assert.equal(sent.body.schedule, SCHEDULE)
    assert.deepEqual(sent.body.input, JSON.parse(JSON.stringify(input)), "the registration carries the user's input verbatim")
    assert.equal(sent.body.approved_plan_id, planned.planId)
    assert.equal(sent.body.approved_plan_digest, planned.digest)
    assert.equal(sent.body.execution_digest, planned.executionDigest)
    assert.equal(sent.body.revision, 1)
    assert.equal(sent.body.digest, triggerCandidate({ operation: "register", repo, slug: "nightly", flow: "nightly-report",
      schedule: SCHEDULE, input: JSON.parse(JSON.stringify(input)) } as any))
    assert.equal(registered.output.registration.timezone, "UTC")
    assert.equal(registered.output.planDigest, planned.digest)
    assert.equal(registered.output.testRunId, undefined, "no test run is claimed when the caller ran none")
  }))

/*
 * Walk run 3, defect D3-N2: `Plan checks/fast` answered `"budget": {}` on the
 * canary box, the registration carried that envelope, and Smithers Cloud
 * refused it — `automatic work needs the reviewed envelope and finite
 * token/time limits` (plue internal/services/repository_jobs.go
 * `validateRepositoryJob`). The registration's own limits are what bound every
 * unattended fire, so the request carries them and this host binds them into
 * the envelope it registers, capped by the deployment ceiling.
 */
test("a flow that declares no ceiling registers only with the limits the registration names, never above the deployment ceiling", nativeOptions, t =>
  proveTrigger(t, async probe => {
    const input = { label: "nightly" }
    const planned = await probe.plan("unbounded-report", input, "trigger:unbounded:plan")
    assert.deepEqual(planned.envelope.budget, {}, `an undeclared ceiling plans empty; got ${JSON.stringify(planned.envelope)}`)
    await probe.approve(planned)
    const request = { ...REQUEST, slug: "unbounded", flow: "unbounded-report", input,
      approvedPlanId: planned.planId, approvedPlanDigest: planned.digest }
    const unbounded = await probe.register(request)
    says(String(unbounded.failure), "The job declaration has no bounded reviewed execution policy")
    const over = await probe.register({ ...request, budget: { tokens: 200001, milliseconds: 600000 } })
    says(String(over.failure), "The job declaration has no bounded reviewed execution policy")
    const long = await probe.register({ ...request, budget: { tokens: 150000, milliseconds: 7200001 } })
    says(String(long.failure), "The job declaration has no bounded reviewed execution policy")
    assert.equal(probe.registrations.length, 0, `nothing unbounded may register; got ${JSON.stringify(probe.registrations)}`)
    const bounded = await probe.register({ ...request, budget: { tokens: 150000, milliseconds: 600000 } })
    assert(bounded.output, `expected a receipt once the registration names its limits; got ${String(bounded.failure).slice(0, 2000)}`)
    assert.equal(probe.registrations.length, 1, JSON.stringify(probe.registrations))
    assert.deepEqual(probe.registrations[0]!.body.envelope.budget, { tokens: 150000, milliseconds: 600000 },
      "the registered envelope carries the reviewed limits, which is what Smithers Cloud validates")
    // Not asserted on `bounded.output`: a run's own result travels through the
    // journal, whose `Redaction.isSensitiveKey` reads `tokens` as a credential
    // and writes `"[REDACTED]"` in its place (packages/smithers/agent/src/Budget.ts
    // records the same trap). The registration body above never enters a journal.
  }))

/* A flow that declares its own ceiling keeps it, and the registration may tighten it but never loosen it. */
test("a declared ceiling is what registers when the registration names no limits, and a named limit replaces it", nativeOptions, t =>
  proveTrigger(t, async probe => {
    const input = { label: "nightly" }
    const planned = await probe.plan("nightly-report", input, "trigger:declared:plan")
    await probe.approve(planned)
    const request = { ...REQUEST, input, approvedPlanId: planned.planId, approvedPlanDigest: planned.digest }
    const declared = await probe.register(request)
    assert(declared.output, `expected a receipt; got ${String(declared.failure).slice(0, 2000)}`)
    assert.deepEqual(probe.registrations[0]!.body.envelope.budget, { tokens: 200000, milliseconds: 600000 })
    const tightened = await probe.register({ ...request, slug: "tighter", budget: { tokens: 50000, milliseconds: 300000 } })
    assert(tightened.output, `expected a receipt; got ${String(tightened.failure).slice(0, 2000)}`)
    assert.deepEqual(probe.registrations[1]!.body.envelope.budget, { tokens: 50000, milliseconds: 300000 })
  }))

test("the registrar reads the approved plan by id under the app's own request key, and refuses one that no longer reproduces", nativeOptions, async t => {
  const fixture = await makeRepository(t)
  let approved: any
  await withHost(t, fixture, async probe => {
    // The app's per-request key. The host never reproduces it; it reads the
    // plan a person approved by the id the app sent.
    approved = await probe.plan("nightly-report", { label: "nightly" }, "trigger:req-1:plan")
    await probe.approve(approved)
    const registered = await probe.register({ ...REQUEST, requestId: "req-1", input: { label: "nightly" },
      approvedPlanId: approved.planId, approvedPlanDigest: approved.digest })
    assert(registered.output, `expected a receipt for the plan approved under the app's key; got ${String(registered.failure).slice(0, 2000)}`)
    assert.equal(registered.output.requestId, "req-1")
    assert.equal(fixture.registrations.length, 1, JSON.stringify(fixture.registrations))
    const other = await probe.register({ ...REQUEST, slug: "other", requestId: "req-2", input: { label: "weekly" },
      approvedPlanId: approved.planId, approvedPlanDigest: approved.digest })
    says(String(other.failure), `The approved plan for "nightly-report" was made for different input.`)
    assert.equal(fixture.registrations.length, 1, "a plan approved for other input registers nothing")
  })
  // The flow changes. Discovery is a per-start snapshot, so only a restart
  // moves the execution digest the person approved.
  await writeFile(join(fixture.root, "flows/nightly-report/flow.mdx"), ["---", "description: A maintainer's own scheduled report.",
    "model: test:scripted", `capabilities: ["fs:read:**"]`, "budget:", "  tokens: 200000", "  milliseconds: 600000", "---", "Summarise the repository, briefly.", ""].join("\n"))
  fixture.jj("status")
  await withHost(t, fixture, async probe => {
    const stale = await probe.register({ ...REQUEST, slug: "stale", requestId: "req-3", input: { label: "nightly" },
      approvedPlanId: approved.planId, approvedPlanDigest: approved.digest })
    says(String(stale.failure), `The approved plan no longer reproduces for "nightly-report"; review the preview and approve it again.`)
    assert.equal(fixture.registrations.length, 1, "an approval of bytes that changed registers nothing")
  })
  fixture.settled()
})

test("a flow edited after its approval registers nothing, so no source revision names unapproved bytes", nativeOptions, t =>
  proveTrigger(t, async probe => {
    const input = { label: "nightly" }
    const planned = await probe.plan("nightly-report", input, "trigger:edited:plan")
    await probe.approve(planned)
    // The person approved these bytes. The working copy moves before the
    // registration reaches the snapshot the receipt would name.
    await writeFile(join(probe.root, "flows/nightly-report/flow.mdx"), ["---", "description: A maintainer's own scheduled report.",
      "model: test:scripted", `capabilities: ["fs:read:**"]`, "budget:", "  tokens: 200000", "  milliseconds: 600000", "---", "Summarise the repository and open an issue.", ""].join("\n"))
    const edited = await probe.register({ ...REQUEST, requestId: "edited", input,
      approvedPlanId: planned.planId, approvedPlanDigest: planned.digest })
    says(String(edited.failure), `"nightly-report" changed on disk. Review the preview and approve it again.`)
    assert.equal(probe.registrations.length, 0, "edited bytes register nothing")
  }))

test("two manual fires of one schedule are two dispatches", nativeOptions, t =>
  proveTrigger(t, async probe => {
    const input = { label: "nightly" }
    const planned = await probe.plan("nightly-report", input, "trigger:fire-request:plan")
    await probe.approve(planned)
    const registered = await probe.register({ ...REQUEST, requestId: "fire-request", input,
      approvedPlanId: planned.planId, approvedPlanDigest: planned.digest })
    assert(registered.output, `expected a registration to fire; got ${String(registered.failure).slice(0, 2000)}`)
    const fire = { operation: "fire", repo, slug: "nightly", flow: "nightly-report", schedule: SCHEDULE, input }
    const first = await probe.register(fire)
    const second = await probe.register(fire)
    assert(first.output && second.output, `both fires must dispatch; got ${String(first.failure ?? second.failure).slice(0, 2000)}`)
    assert.notEqual(first.output.requestId, second.output.requestId, "a second run now is a second dispatch, not a replay of the first")
    assert.equal(probe.dispatches.length, 2, JSON.stringify(probe.dispatches))
    assert.notEqual(probe.dispatches[0]!.requestId, probe.dispatches[1]!.requestId, "Plue deduplicates on the request id, so it must differ")
    for (const sent of probe.dispatches) {
      assert.equal(sent.job, "flow:nightly")
      assert.equal(sent.body.step_id, "fire")
      assert.equal(sent.body.revision, 1)
    }
  }))

test("the registrar never resolves an approval, installs a grant, or submits one", nativeOptions, t =>
  proveTrigger(t, async () => {
    const text = await readFile(new URL("../repository/triggers.ts", import.meta.url), "utf8")
    for (const forbidden of ["resolveApproval", "installBulkGrant", "Approval.Submit", "registerApproval"]) {
      assert(!text.includes(forbidden), `triggers.ts must not call ${forbidden}`)
    }
  }))
