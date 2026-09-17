import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { Control, ControlRpcs } from "@smthrs/control"
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
const fixtures = (target: string) => ({
  /** Names one delegate this host registered, so the catalog can run it. */
  "flows/nightly-check/flow.mdx": ["---", "description: Run the reviewed command on a schedule.",
    "flows: [coding/CommandCheck]", `capabilities: ["proc:spawn:*", "fs:read:**"]`, "budget:", "  tokens: 200000", "  milliseconds: 600000", "---", target, ""].join("\n"),
  /** The form §1.8.1 calls the supported one: a model and no delegate. */
  "flows/model-only/flow.mdx": ["---", "description: A maintainer's own scheduled report.",
    "model: test:scripted", `capabilities: ["fs:read:**"]`, "budget:", "  tokens: 200000", "  milliseconds: 600000", "---", "Summarise the repository.", ""].join("\n"),
  /** Runnable, but declares an input schema the engine ignores. */
  "flows/declared-input/flow.mdx": ["---", "description: Run the reviewed command on a schedule.",
    "flows: [coding/CommandCheck]", "input: { label: string }", `capabilities: ["proc:spawn:*"]`, "budget:", "  tokens: 200000", "  milliseconds: 600000", "---", target, ""].join("\n"),
  /** A module entry: refused by the markdown slice, by name and by file. */
  "flows/module-entry/flow.ts": ['import { Flow } from "@smthrs/core"', 'import { Schema } from "effect"',
    'export default Flow.make({ description: "A module entry.", flows: ["coding/CommandCheck"], capabilities: ["proc:spawn:*"],',
    '  budget: { tokens: 200000, milliseconds: 600000 }, input: Schema.Unknown, output: Schema.Unknown })', ""].join("\n")
})

interface Probe {
  readonly register: (request: Record<string, unknown>) => Promise<{ failure?: string; output?: any }>
  readonly plan: (flowId: string, input: unknown, key: string) => Promise<any>
  readonly approve: (plan: any) => Promise<unknown>
  readonly flows: () => Promise<ReadonlyArray<string>>
  readonly runs: () => Promise<ReadonlyArray<Record<string, unknown>>>
  readonly registrations: Array<Record<string, any>>
  /** The repository's own resolved head, so a fixture can name a real revision. */
  readonly head: any
}

async function proveTrigger(t: TestContext, use: (probe: Probe) => Promise<void>) {
  const { platform } = await import("../../packages/smithers/src/internal/NodeControlHost.ts")
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
  const target = JSON.stringify({ argv: [process.execPath, "-e", "process.exit(0)"], cwd: ".", timeoutMs: 30000 })
  for (const [name, contents] of Object.entries(fixtures(target))) {
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
  const base = { repositoryPath: root, adapterPath: adapter, sourcePublication: "local-only" as const, exporterPath: exporter }
  const native = await Effect.runPromise(Effect.flatMap(NativeCoding, coding => coding.read()).pipe(
    Effect.provide(nativeLayer(base)), Effect.provide(platform.host), Effect.scoped))
  const registrations: Array<Record<string, any>> = []
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
  const observedPlatform: NativeControl.Platform = { ...platform, gateway: (health, options) => platform.gateway(health, options).pipe(Layer.tap(context => {
    const server = Context.get(context, HttpServer.HttpServer)
    if (!NetAddress.isInetAddress(server.address)) throw new Error("expected TCP gateway")
    return Deferred.succeed(listening, server.address.port)
  })) }
  const hostLayer = layer(observedPlatform, { ...base, gatewayId: "11111111-1111-4111-8111-111111111111", credential: "fixture-key",
    implementationModel: "test:scripted", checkEnvironment: { PATH: process.env.PATH! },
    repositoryRemote: Layer.succeed(RepositoryRemote, remote) })
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
    const runs = (): Promise<ReadonlyArray<Record<string, unknown>>> => Effect.runPromise(Effect.map(client.List({ _tag: "runs" }),
      (listed: any) => (listed.items as ReadonlyArray<any>).map(row => ({ runId: row.runId, flowId: row.flowId, status: row.status, waitingReason: row.waitingReason, pendingWaits: row.pendingWaits }))))
    const register = (request: Record<string, unknown>) => Effect.runPromise(Effect.gen(function*() {
      const key = `register:${String(request.slug)}:${String(request.operation ?? "register")}:${attempt++}`
      const planned: any = yield* client.Plan({ flowId: "repository/trigger", input: json(request), idempotencyKey: `${key}:plan` })
      yield* client.Approve({ ...planned.approval, scope: "once" })
      const launched: any = yield* client.Run({ _tag: "Plan", planId: planned.planId, digest: planned.digest, envelope: planned.envelope, idempotencyKey: `${key}:run` })
      const events = yield* control.watch({ runId: launched.runId, follow: true }).pipe(
        Stream.takeUntil(event => event.kind === "control.engine.projection-settled"), Stream.runCollect, Effect.timeoutOrElse({ duration: "100 seconds", orElse: () => Effect.succeed([] as any) }))
      const outputs = (events as ReadonlyArray<any>).flatMap((event: any) => { const state = (event.payload as any)?.payload?.state
        return state?.flowName === "repository/Trigger" && state?.result?._tag === "Complete" && state.result.exit?._tag === "Success" ? [state.result.exit.value] : [] })
      if (outputs.length === 1) return { output: outputs[0] } as { failure?: string; output?: any }
      return { failure: JSON.stringify(events) } as { failure?: string; output?: any }
    }).pipe(Effect.provideService(Control.Control, control)))
    yield* Effect.promise(() => use({ register, plan, approve, flows, runs, registrations, head: native.head }))
  }).pipe(Effect.provide(hostLayer), Effect.scoped))
  passed = true
}

/** The exact sentence, as it survives JSON encoding inside a recorded event. */
const says = (recorded: string, sentence: string) =>
  assert(recorded.includes(JSON.stringify(sentence).slice(1, -1)), `expected the recorded refusal to say ${JSON.stringify(sentence)}; got ${recorded.slice(0, 4000)}`)

/** The input `coding/CommandCheck` decodes: one immutable revision and one
 * declared check. It is the registered input a fire would replay verbatim. */
const checkInput = (head: any) => ({
  implementation: { change: "nightly", parent: head, atoms: [head], head, reads: [], writes: [] },
  check: { id: "nightly", target: "nightly-check", flow: "nightly-check", flowDigest: "b".repeat(64), tier: "fast", required: true }
})
const REQUEST = { operation: "register", repo, slug: "nightly", flow: "nightly-check", schedule: SCHEDULE,
  input: { label: "nightly" }, approvedPlanId: "plan", approvedPlanDigest: "a".repeat(64) }

test("the registrar is a registered flow and this host runs no model-only maintainer markdown flow", nativeOptions, t =>
  proveTrigger(t, async probe => {
    const listed = await probe.flows()
    assert(listed.includes("repository/trigger"), `repository/trigger must be registered; got ${JSON.stringify(listed)}`)
    assert(listed.includes("nightly-check"), "a markdown flow naming one registered delegate is runnable")
    // The form the contract calls the supported one is not runnable on this
    // host at all: it delegates to "agent", which this host never registers.
    // It is listed, because discovery found it, and it still cannot run: the
    // listing a maintainer picks from is not the set this host can execute.
    assert(listed.includes("model-only"), `discovery lists the model-only flow; got ${JSON.stringify(listed)}`)
    const refused = await probe.register({ ...REQUEST, slug: "modelonly", flow: "model-only" })
    says(String(refused.failure), `"model-only" is not runnable on this workspace: `)
    says(String(refused.failure), `flow "model-only" delegates to "agent", which no registered flow provides`)
  }))

test("the form gate refuses a reserved name, an unknown flow, a module entry and a declared input schema", nativeOptions, t =>
  proveTrigger(t, async probe => {
    const reserved = await probe.register({ ...REQUEST, flow: "repository/setup" })
    says(String(reserved.failure), `"repository/setup" is a reserved repository job; register it through repository setup.`)
    const unknown = await probe.register({ ...REQUEST, slug: "weekly", flow: "weekly-sweep" })
    says(String(unknown.failure), `No flow "weekly-sweep" is registered on this workspace. The workspace has: `)
    says(String(unknown.failure), "nightly-check")
    const module = await probe.register({ ...REQUEST, slug: "modular", flow: "module-entry" })
    says(String(module.failure), `Scheduled triggers run single-file markdown flows. "module-entry" is a module entry (flow.ts).`)
    const declared = await probe.register({ ...REQUEST, slug: "declared", flow: "declared-input" })
    says(String(declared.failure), `"declared-input" declares an input schema the engine ignores (discovery warning unsupported_input_schema). Remove it: a trigger delivers your registered input to the flow as JSON, unvalidated.`)
    const cron = await probe.register({ ...REQUEST, slug: "hourly", schedule: "0 * * *" })
    says(String(cron.failure), "schedule must have five cron fields in UTC")
    const unapproved = await probe.register({ ...REQUEST, slug: "unapproved", approvedPlanId: "", approvedPlanDigest: "" })
    says(String(unapproved.failure), "a flow trigger must name the plan a person approved")
    assert.equal(probe.registrations.length, 0, "no refused request may reach the repository registration")
  }))

test("the registrar registers only a plan a person approved, with the exact candidate and input", nativeOptions, t =>
  proveTrigger(t, async probe => {
    const input = checkInput(probe.head)
    const planned = await probe.plan("nightly-check", input, `trigger:${repo}:nightly:plan`)
    assert.equal(planned.flowId, "nightly-check")
    // An unapproved plan registers nothing, and this registrar never approves
    // one: it reads its own journal for the decision a person made.
    const pending = await probe.register({ ...REQUEST, input, approvedPlanId: planned.planId, approvedPlanDigest: planned.digest })
    says(String(pending.failure), `The plan for "nightly-check" is pending; a person approves the preview before it can be scheduled.`)
    assert.equal(probe.registrations.length, 0, "an unapproved plan registers nothing")
    // The person approves, out of band, exactly as the app does.
    await probe.approve(planned)
    const registered = await probe.register({ ...REQUEST, input, approvedPlanId: planned.planId, approvedPlanDigest: planned.digest })
    assert(registered.output, `expected a registration receipt; runs=${JSON.stringify(await probe.runs())}; got ${String(registered.failure).slice(0, 2000)}`)
    assert.equal(probe.registrations.length, 1, JSON.stringify(probe.registrations))
    const sent = probe.registrations[0]!
    assert.equal(sent.job, "flow:nightly")
    assert.equal(sent.body.flow_id, "nightly-check")
    assert.equal(sent.body.mode, "enabled")
    assert.deepEqual(sent.body.events, [])
    assert.equal(sent.body.schedule, SCHEDULE)
    assert.deepEqual(sent.body.input, JSON.parse(JSON.stringify(input)), "the registration carries the user's input verbatim")
    assert.equal(sent.body.approved_plan_id, planned.planId)
    assert.equal(sent.body.approved_plan_digest, planned.digest)
    assert.equal(sent.body.execution_digest, planned.executionDigest)
    assert.equal(sent.body.revision, 1)
    assert.equal(sent.body.digest, triggerCandidate({ operation: "register", repo, slug: "nightly", flow: "nightly-check",
      schedule: SCHEDULE, input: JSON.parse(JSON.stringify(input)) } as any))
    assert.equal(registered.output.registration.timezone, "UTC")
    assert.equal(registered.output.planDigest, planned.digest)
    assert.equal(registered.output.testRunId, undefined, "no test run is claimed when the caller ran none")
  }))

test("the registrar never resolves an approval, installs a grant, or submits one", nativeOptions, t =>
  proveTrigger(t, async () => {
    const text = await readFile(new URL("../repository/triggers.ts", import.meta.url), "utf8")
    for (const forbidden of ["resolveApproval", "installBulkGrant", "Approval.Submit", "registerApproval"]) {
      assert(!text.includes(forbidden), `triggers.ts must not call ${forbidden}`)
    }
  }))
