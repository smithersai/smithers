import { FlowRegistry, registry as flowEntries } from "../../flows/registry"
// Your own flows on this device's engine (decision 0014 §2, docs/features/flows.md#your-own-flows): every `flow/*` flow
// runs as the browser's engine worker registers it (src/flows/registrations.ts), on the Node host over the compose
// Postgres, against ChatApi's real handler on this file's schema. The model is the only scripted seam: the endpoint's
// `agent` role answers with cells, which the drafting agent and the agent running a flow write.
import { Effect, Exit, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { eventually, stop, testFile, usage } from "../../../worker/test/harness.ts"
import { contents } from "../../../worker/test/harness.ts"
import * as Pg from "@effect/sql-pg"
import { PostgresDatabase } from "@smthrs/database"
import { digestSync, Uuid, WebCrypto } from "@smthrs/crypto"
import { FlowRuntime } from "@smthrs/flow"
import { QuickJSVariant, RealmFlow } from "@smthrs/harness"
import { ModelError } from "@smthrs/model"
import { EngineStore } from "@smthrs/flows"
import { Layer } from "effect"
import * as TestDatabase from "../../../db/TestDatabase.ts"
import * as Catalog from "../../flows/catalog"
import { cell, member, openAgent } from "../../test/agent"
import {
  type CodeState,
  FlowAnswer,
  FlowDelete,
  FlowDraftDelete,
  FlowDrafts,
  FlowList,
  FlowNew,
  FlowRead,
  FlowRun,
  FlowSave,
  FlowWrite,
} from "./flows"
import { DRAFT_ID_NAMESPACE, MAX_REALM_CALLS } from "./contract"
import { roundExecutionId, roundOf } from "./round"
import { renderSource, SOURCE_PATH } from "./source"
import { Retry } from "../runs/flows"
import { FlowsClient } from "./api"
import { FlowsRefused } from "./reference"
import { call, evaluate, removeDraft, writeOutcome } from "./steps"

const runtime = testFile("flows_ui")

/** A run of the agent takes several sealed model steps; under a loaded machine one test may take a minute. */
const SLOW = 90_000

beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE flow_drafts, flow_revisions, flows CASCADE`))
)

type Request = Parameters<Parameters<typeof openAgent>[1]>[0]

/** What the model answers a request with: one cell. */
const answer = (source: string) => Stream.make({ type: "text-delta" as const, id: "t", text: cell(source) }, usage, stop)

/** Everything `request` says: its system prompt and its messages. */
const said = (request: Request) => [...request.system.map((part) => part.text), ...contents(request)].join("\n")

/** Whether `request` is the drafting agent's, or the one running a person's flow. */
const drafting = (request: Request) => said(request).includes("You draft a person's own flow")
const running = (request: Request) => said(request).includes("You run one of the person's own flows")

/** A draft the agent answers with. */
const drafted = (overrides: Record<string, unknown> = {}) => ({
  description: "Switch this device to dark mode.",
  instructions: "Set the theme to dark, then say it is done.",
  flows: ["app/theme/set"],
  questions: [{ text: "Which mode?", assumed: "dark", blocking: false }],
  summary: "Sets dark mode.",
  ...overrides,
})

/** A model that drafts `draft` and, running a flow, follows `run`'s cells in turn. */
const scripted = (draft: () => object, run: ReadonlyArray<string> = ['ctx.done("Done.")']) => {
  const requests: Array<Request> = []
  let ran = 0
  const script = (request: Request) => {
    requests.push(request)
    if (drafting(request)) return answer(`ctx.done(${JSON.stringify(draft())})`)
    if (running(request)) return answer(run[Math.min(ran++, run.length - 1)]!)
    return Stream.empty
  }
  return { script, requests }
}

const opened: Array<{ readonly close: () => Promise<void> }> = []
afterEach(async () => {
  for (const each of opened.splice(0)) await each.close()
})

/** ChatApi and this device's engine, with `script` as the model. */
const device = async (script: Parameters<typeof openAgent>[1]) => {
  const agent = await openAgent(runtime, script, { actor: member, partsEvery: "20 millis" })
  const engine = await agent.engine()
  opened.push({ close: engine.kill })
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.exit(effect))
  return { agent, engine, run }
}

const draftRow = async (draftId: string) => {
  const [row] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{
      readonly status: string
      readonly round: number
      readonly name: string
      readonly files: ReadonlyArray<{ path: string; text: string }>
      readonly checks: ReadonlyArray<{ check: string; ok: boolean; code?: string }>
      readonly questions: ReadonlyArray<{ id: string; text: string; assumed: string; blocking: boolean; answer?: string }>
      readonly failure: string | null
      readonly flowId: string | null
    }>`SELECT status, round, name, files, checks, questions, failure, flow_id AS "flowId" FROM flow_drafts WHERE id = ${draftId}`))
  return row
}

describe("roundOf", () => {
  test("reads a draft's round from its execution id, and nothing from any other", () => {
    const draftId = crypto.randomUUID()
    expect(roundOf(roundExecutionId(draftId, 3))).toEqual({ draftId, round: 3 })
    expect(roundOf(`${draftId.toUpperCase()}:0`)).toEqual({ draftId, round: 0 })
    expect(roundOf(draftId)).toBeUndefined()
    expect(roundOf(`${draftId}:01`)).toBeUndefined()
    expect(roundOf("answer/chat/Respond@x:1/call/0.0")).toBeUndefined()
  })
})

describe("flow/new", () => {
  test("one round drafts the flow's source, checks it and writes the draft ready, with its questions", async () => {
    const model = scripted(() => drafted())
    const { engine, run } = await device(model.script)
    const draftId = crypto.randomUUID()

    const exit = await run(engine.flows.execute(FlowNew, {
      executionId: roundExecutionId(draftId, 0),
      payload: { name: "dark-mode", request: "Switch to dark mode" },
    }))

    expect(exit).toEqual(Exit.succeed({ draftId, round: 0, status: "ready", name: "dark-mode" }))
    const row = await draftRow(draftId)
    expect(row).toMatchObject({ status: "ready", round: 0, name: "dark-mode", failure: null, flowId: null })
    expect(row!.files).toEqual([{
      path: SOURCE_PATH,
      text: renderSource({
        name: "dark-mode",
        description: "Switch this device to dark mode.",
        flows: ["app/theme/set"],
        instructions: "Set the theme to dark, then say it is done.",
      }),
    }])
    expect(row!.checks.every((check) => check.ok)).toBe(true)
    expect(row!.questions).toEqual([{ id: "r0q1", text: "Which mode?", assumed: "dark", blocking: false }])
    // The drafting agent was shown the catalog a person's flow may call, and never the authoring acts.
    const prompt = said(model.requests.find(drafting)!)
    expect(prompt).toContain("- app/theme/set:")
    expect(prompt).not.toContain("- flow/new:")
  })
})

/** Drafts `name` to ready and saves it: the saved flow. */
const saveFlow = async (
  d: Awaited<ReturnType<typeof device>>,
  name: string,
) => {
  const draftId = crypto.randomUUID()
  const round = await d.run(d.engine.flows.execute(FlowNew, {
    executionId: roundExecutionId(draftId, 0),
    payload: { name, request: "Switch to dark mode" },
  }))
  expect(round).toMatchObject({ _tag: "Success", value: { status: "ready" } })
  const saved = await d.run(d.engine.flows.execute(FlowSave, { executionId: crypto.randomUUID(), payload: { draftId } }))
  expect(saved).toMatchObject({ _tag: "Success" })
  return { draftId, ...(saved as unknown as Exit.Success<{ flowId: string; revision: number }>).value }
}

/** Writes a draft round straight through ChatApi's route, as the person's own steps would. */
const writeRound = (d: Awaited<ReturnType<typeof device>>, draftId: string, write: object) =>
  d.agent.h.fetch(`/api/flow-drafts/${draftId}`, { method: "POST", body: JSON.stringify(write) })

const readyRound = (name: string, overrides: object = {}) => ({
  scope: "person",
  round: 0,
  request: "Switch to dark mode",
  name,
  status: "ready",
  summary: null,
  files: [{
    path: SOURCE_PATH,
    text: renderSource({ name, description: "Dark.", flows: [], instructions: "Go dark." }),
  }],
  checks: [{ check: "parses", ok: true }],
  questions: [],
  failure: null,
  flowId: null,
  ...overrides,
})

describe("flow/new, more rounds", () => {
  test("any other execution id starts a new draft of its own, named by that execution so a step run again writes the same one", async () => {
    const d = await device(scripted(() => drafted()).script)
    const executionId = `agent-${crypto.randomUUID()}`
    const exit = await d.run(d.engine.flows.execute(FlowNew, {
      executionId,
      payload: { name: "dark-mode", request: "Switch to dark mode" },
    }))
    expect(exit._tag).toBe("Success")
    const { draftId } = (exit as unknown as Exit.Success<{ draftId: string }>).value
    expect(draftId).toBe(await Effect.runPromise(Uuid.v5(DRAFT_ID_NAMESPACE, executionId).pipe(Effect.provide(WebCrypto.layer))))
    expect(await draftRow(draftId)).toMatchObject({ status: "ready", round: 0 })
  }, SLOW)

  test("a blocking question holds the round; the answers start round 1 as a run of its own, which drafts with them", async () => {
    let round = 0
    const model = scripted(() =>
      round++ === 0
        ? drafted({
          questions: [
            { text: "Light or dark?", assumed: "dark", blocking: true },
            { text: "Say it is done?", assumed: "yes", blocking: false },
          ],
        })
        : drafted({ questions: [], summary: "" })
    )
    const d = await device(model.script)
    const draftId = crypto.randomUUID()
    const payload = { name: "dark-mode", request: "Switch the mode" }

    expect(await d.run(d.engine.flows.execute(FlowNew, { executionId: roundExecutionId(draftId, 0), payload })))
      .toEqual(Exit.succeed({ draftId, round: 0, status: "needs_you", name: "dark-mode" }))
    // Save waits for the answer.
    expect(await d.run(d.engine.flows.execute(FlowSave, { executionId: crypto.randomUUID(), payload: { draftId } })))
      .toMatchObject({ _tag: "Failure" })

    const answered = await d.run(d.engine.flows.execute(FlowAnswer, {
      executionId: crypto.randomUUID(),
      payload: { draftId, round: 0, answers: [{ id: "r0q1", value: "light" }] },
    }))
    expect(answered).toEqual(Exit.succeed({ draftId, round: 1 }))
    // The next round runs on its own: joining it reads how it ended.
    expect(await d.run(d.engine.flows.execute(FlowNew, { executionId: roundExecutionId(draftId, 1), payload })))
      .toEqual(Exit.succeed({ draftId, round: 1, status: "ready", name: "dark-mode" }))
    const second = said(model.requests.filter(drafting).at(-1)!)
    expect(second).toContain("The person answered:\n- Light or dark? light")
    expect(second).toContain("The flow so far:")
    expect(await draftRow(draftId)).toMatchObject({ status: "ready", round: 1, questions: [] })

    // Answers to a round that has moved on are refused.
    const stale = await d.run(d.engine.flows.execute(FlowAnswer, {
      executionId: crypto.randomUUID(),
      payload: { draftId, round: 0, answers: [{ id: "r0q1", value: "dark" }] },
    }))
    expect(stale).toMatchObject({ _tag: "Failure" })
    expect(JSON.stringify(stale)).toContain("stale_round")
  }, SLOW)

  test("an agent that never drafts a valid flow fails the round, and the draft says so", async () => {
    const d = await device(scripted(() => ({ nope: true })).script)
    const draftId = crypto.randomUUID()
    expect(await d.run(d.engine.flows.execute(FlowNew, {
      executionId: roundExecutionId(draftId, 0),
      payload: { name: "dark-mode", request: "Switch to dark mode" },
    }))).toEqual(Exit.succeed({ draftId, round: 0, status: "failed", name: "dark-mode" }))
    expect(await draftRow(draftId)).toMatchObject({ status: "failed", failure: "undecodable", files: [], checks: [] })
    // Answering a failed round drafts again, from no file.
    expect(await d.run(d.engine.flows.execute(FlowAnswer, {
      executionId: crypto.randomUUID(),
      payload: { draftId, round: 0, answers: [{ id: "nothing", value: "Try again" }] },
    }))).toEqual(Exit.succeed({ draftId, round: 1 }))
    expect(await d.run(d.engine.flows.execute(FlowNew, {
      executionId: roundExecutionId(draftId, 1),
      payload: { name: "dark-mode", request: "Switch to dark mode" },
    }))).toEqual(Exit.succeed({ draftId, round: 1, status: "failed", name: "dark-mode" }))
  }, SLOW)

  test("a draft that fails a check fails its round, checks named and file shown, and won't save", async () => {
    const d = await device(scripted(() => drafted({ flows: ["repo/write"] })).script)
    const draftId = crypto.randomUUID()
    expect(await d.run(d.engine.flows.execute(FlowNew, {
      executionId: roundExecutionId(draftId, 0),
      payload: { name: "dark-mode", request: "Switch to dark mode" },
    }))).toEqual(Exit.succeed({ draftId, round: 0, status: "failed", name: "dark-mode" }))
    const row = (await draftRow(draftId))!
    expect(row).toMatchObject({ status: "failed", failure: "checks" })
    expect(row.checks).toContainEqual({ check: "calls", ok: false, code: "unknown" })
    expect(row.files).toHaveLength(1)
    const saved = await d.run(d.engine.flows.execute(FlowSave, { executionId: crypto.randomUUID(), payload: { draftId } }))
    expect(JSON.stringify(saved)).toContain('"code":"not_ready"')
  }, SLOW)

  test("a model that refuses the call fails the round no_model, and nothing it said reaches the draft", async () => {
    const SENTINEL = "SENTINEL-provider-said-this"
    const d = await device((request) =>
      drafting(request)
        ? Stream.fail(new ModelError.ModelError({ code: "no_route", message: SENTINEL, httpStatus: 409 }))
        : Stream.empty
    )
    const draftId = crypto.randomUUID()
    expect(await d.run(d.engine.flows.execute(FlowNew, {
      executionId: roundExecutionId(draftId, 0),
      payload: { name: "dark-mode", request: "Switch to dark mode" },
    }))).toEqual(Exit.succeed({ draftId, round: 0, status: "failed", name: "dark-mode" }))
    const row = (await draftRow(draftId))!
    expect(row).toMatchObject({ status: "failed", failure: "no_model", files: [], checks: [] })
    expect(JSON.stringify(row)).not.toContain(SENTINEL)
  }, SLOW)

  test("a name you have edits that flow: the round starts from its source, and saving makes revision 2", async () => {
    const model = scripted(() => drafted())
    const d = await device(model.script)
    const first = await saveFlow(d, "dark-mode")
    expect(first.revision).toBe(1)
    const second = await saveFlow(d, "dark-mode")
    expect(second).toMatchObject({ flowId: first.flowId, revision: 2 })
    expect(said(model.requests.filter(drafting).at(-1)!)).toContain(
      "The flow so far:\n// Drafted by Smithers from a prompt.",
    )
    expect(await draftRow(second.draftId)).toMatchObject({ status: "saved", flowId: first.flowId })
  }, SLOW)
})

describe("flow/save", () => {
  test("ChatApi's other refusals pass on: an edit of a flow deleted meanwhile is gone", async () => {
    const d = await device(scripted(() => drafted()).script)
    const first = await saveFlow(d, "dark-mode")
    const draftId = crypto.randomUUID()
    await d.run(d.engine.flows.execute(FlowNew, {
      executionId: roundExecutionId(draftId, 0),
      payload: { name: "dark-mode", request: "Switch to dark mode" },
    }))
    expect(await d.run(d.engine.flows.execute(FlowDelete, { executionId: crypto.randomUUID(), payload: { flowId: first.flowId } })))
      .toEqual(Exit.succeed({ deleted: true }))
    const saved = await d.run(d.engine.flows.execute(FlowSave, { executionId: crypto.randomUUID(), payload: { draftId } }))
    expect(JSON.stringify(saved)).toContain('"code":"gone"')
  }, SLOW)

  test("saving again answers the same flow; a name another draft took first is taken", async () => {
    const d = await device(scripted(() => drafted()).script)
    const one = crypto.randomUUID()
    const two = crypto.randomUUID()
    for (const draftId of [one, two]) {
      await d.run(d.engine.flows.execute(FlowNew, {
        executionId: roundExecutionId(draftId, 0),
        payload: { name: "dark-mode", request: "Switch to dark mode" },
      }))
    }
    const saved = await d.run(d.engine.flows.execute(FlowSave, { executionId: crypto.randomUUID(), payload: { draftId: one } }))
    expect(await d.run(d.engine.flows.execute(FlowSave, { executionId: crypto.randomUUID(), payload: { draftId: one } })))
      .toEqual(saved)
    const taken = await d.run(d.engine.flows.execute(FlowSave, { executionId: crypto.randomUUID(), payload: { draftId: two } }))
    expect(JSON.stringify(taken)).toContain("NameTaken")
  }, SLOW)

  test("refuses a draft that isn't ready, has no file, or holds a blocking question; passes other refusals on", async () => {
    const d = await device(scripted(() => drafted()).script)
    const cases: ReadonlyArray<readonly [object, string]> = [
      [{ status: "failed" }, "not_ready"],
      [{ files: [] }, "not_ready"],
      [{ questions: [{ id: "q", text: "Which?", assumed: "a", blocking: true }] }, "needs_you"],
      // A round written ready whose file no longer passes its checks (a call the catalog dropped since): checked again.
      [{
        files: [{
          path: SOURCE_PATH,
          text: renderSource({ name: "dark-mode", description: "Dark.", flows: ["repo/write"], instructions: "Go dark." }),
        }],
      }, "checks"],
    ]
    for (const [overrides, code] of cases) {
      const draftId = crypto.randomUUID()
      expect((await writeRound(d, draftId, readyRound("dark-mode", overrides))).status).toBe(200)
      const saved = await d.run(d.engine.flows.execute(FlowSave, { executionId: crypto.randomUUID(), payload: { draftId } }))
      expect([code, JSON.stringify(saved).includes(`"code":"${code}"`)]).toEqual([code, true])
    }
    // ChatApi's own refusal, for a draft that isn't the person's.
    const missing = await d.run(d.engine.flows.execute(FlowSave, { executionId: crypto.randomUUID(), payload: { draftId: crypto.randomUUID() } }))
    expect(JSON.stringify(missing)).toContain("not_found")
  }, SLOW)
})

describe("flow/run", () => {
  test("runs the latest revision: the agent follows it and calls what it lists, as the person", async () => {
    const model = scripted(() => drafted(), [
      'await ctx.call("app/theme/set", { mode: "dark" })',
      'ctx.done("Dark mode is on.")',
    ])
    const d = await device(model.script)
    await saveFlow(d, "dark-mode")
    const exit = await d.run(d.engine.flows.execute(FlowRun, {
      executionId: crypto.randomUUID(),
      payload: { name: "dark-mode", input: "please" },
    }))
    expect(exit).toEqual(Exit.succeed("Dark mode is on."))
    expect(d.agent.painted).toEqual(["dark"])
    // Asked what the flow's own step asks: its instructions, then its input.
    const prompt = said(model.requests.find(running)!)
    expect(prompt).toContain("Set the theme to dark, then say it is done.\n\nInput: please")
  }, SLOW)

  test("a call outside the flow's list is refused, and the agent sees only its list", async () => {
    const model = scripted(() => drafted({ flows: [] }), [
      'await ctx.call("app/theme/set", { mode: "dark" })',
      'ctx.done("I couldn\'t.")',
    ])
    const d = await device(model.script)
    await saveFlow(d, "dark-mode")
    const exit = await d.run(d.engine.flows.execute(FlowRun, { executionId: crypto.randomUUID(), payload: { name: "dark-mode" } }))
    expect(exit).toEqual(Exit.succeed("I couldn't."))
    expect(d.agent.painted).toEqual([])
    const prompt = said(model.requests.find(running)!)
    expect(prompt).toContain("Set the theme to dark, then say it is done.")
    expect(prompt).not.toContain("Input:")
    expect(prompt).not.toContain("app/navigate")
  }, SLOW)

  test("an agent that never finishes fails the run with a closed code", async () => {
    const d = await device(scripted(() => drafted(), ['console.log("thinking")']).script)
    await saveFlow(d, "dark-mode")
    const exit = await d.run(d.engine.flows.execute(FlowRun, { executionId: crypto.randomUUID(), payload: { name: "dark-mode" } }))
    expect(JSON.stringify(exit)).toContain("@smthrs/mvp/flows/FlowAgentFailed")
  }, SLOW)

  test("a name you don't have isn't found; a revision whose bytes changed, or that fails a check, is invalid", async () => {
    const d = await device(scripted(() => drafted()).script)
    const missing = await d.run(d.engine.flows.execute(FlowRun, { executionId: crypto.randomUUID(), payload: { name: "nothing" } }))
    expect(JSON.stringify(missing)).toContain("FlowNotFound")

    const saved = await saveFlow(d, "dark-mode")
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE flow_revisions SET source = source || ' ' WHERE flow_id = ${saved.flowId}`))
    const tampered = await d.run(d.engine.flows.execute(FlowRun, { executionId: crypto.randomUUID(), payload: { name: "dark-mode", revision: 1 } }))
    expect(JSON.stringify(tampered)).toContain('"check":"digest"')

    const forbidden = renderSource({ name: "dark-mode", description: "Dark.", flows: ["flow/new"], instructions: "Go." })
    const { digestSync } = await import("@smthrs/crypto")
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE flow_revisions SET source = ${forbidden}, digest = ${digestSync(forbidden)} WHERE flow_id = ${saved.flowId}`))
    const invalid = await d.run(d.engine.flows.execute(FlowRun, { executionId: crypto.randomUUID(), payload: { name: "dark-mode" } }))
    expect(JSON.stringify(invalid)).toContain('"check":"calls"')
  }, SLOW)
})

describe("a flow's code", () => {
  /** The saved flow's source with its step relabelled: code the system didn't write. */
  const relabelled = (source: string) => source.replace(`"dark-mode/agent"`, `"dark-mode/answer"`)

  /** `dark-mode`'s code as a person might write it: an agent step asked "Mine: <input>", then `body`. */
  const handWritten = (options: {
    readonly body: string
    readonly imports?: string
    readonly declare?: string
    readonly flows?: ReadonlyArray<string>
    readonly capabilities?: string
    readonly seat?: string
    readonly success?: string
  }) =>
    [
      options.imports ?? "",
      `import { AgentAction } from "@smthrs/agent"`,
      `import { Action, Flow } from "@smthrs/flow"`,
      `import { Node } from "@smthrs/plan"`,
      `import { Schema } from "effect"`,
      "",
      `const Agent = AgentAction.make("dark-mode/answer", {`,
      "  payload: { input: Schema.String },",
      "  output: Schema.String,",
      `  seat: ${JSON.stringify(options.seat ?? "agent")},`,
      "  prompt: ({ input }) => `Mine: ${input}`,",
      "})",
      options.declare ?? "",
      "",
      `export default Flow.make("dark-mode", {`,
      `  description: "Switch this device to dark mode.",`,
      `  capabilities: ${options.capabilities ?? "[]"},`,
      `  flows: ${JSON.stringify(options.flows ?? ["app/theme/set"])},`,
      "  payload: { input: Schema.String },",
      `  success: ${options.success ?? "Schema.String"},`,
      `  body: ${options.body},`,
      "})",
      "",
    ].join("\n")

  /** Writes `source` as dark-mode's next revision, edited from `revision`. */
  const writeCode = (d: Awaited<ReturnType<typeof device>>, revision: number, source: string) =>
    d.run(d.engine.flows.execute(FlowWrite, { executionId: crypto.randomUUID(), payload: { name: "dark-mode", revision, source } }))

  /**
   * The action steps of run `runId` and of every run under it, in the order they started: `flow: step, step` for each
   * run under it, as its run page lists them.
   */
  const stepsOf = async (d: Awaited<ReturnType<typeof device>>, runId: string) => {
    const lines: Array<string> = []
    const seen = new Set<string>()
    const visit = async (id: string, top: boolean): Promise<void> => {
      // A later round is linked under the round before it and under the run that awaits its lineage: listed once.
      if (seen.has(id)) return
      seen.add(id)
      const read = await Effect.runPromise(d.engine.inspection.inspect(id))
      // Only the steps that ran: a child or a handoff is a node of its own, and a branch's other arm never runs.
      const steps = read.steps.flatMap((step) =>
        step.action === null || step.kind === "FlowCall" || step.status !== "completed" ? [] : [step.action]
      )
      lines.push(top ? steps.join(", ") : `${read.run.flowName}: ${steps.join(", ")}`)
      for (const child of read.children) await visit(child.runId, false)
    }
    await visit(runId, true)
    return lines
  }

  test("flow/read reads a revision's code and where it runs; a name you don't have isn't found", async () => {
    const d = await device(scripted(() => drafted()).script)
    const saved = await saveFlow(d, "dark-mode")
    const read = await d.run(d.engine.flows.execute(FlowRead, { executionId: crypto.randomUUID(), payload: { name: "dark-mode" } }))
    expect(read).toEqual(Exit.succeed({
      flowId: saved.flowId,
      name: "dark-mode",
      revision: 1,
      source: renderSource({
        name: "dark-mode",
        description: "Switch this device to dark mode.",
        flows: ["app/theme/set"],
        instructions: "Set the theme to dark, then say it is done.",
      }),
      placement: "client",
    }))
    const missing = await d.run(d.engine.flows.execute(FlowRead, { executionId: crypto.randomUUID(), payload: { name: "nothing" } }))
    expect(JSON.stringify(missing)).toContain("FlowNotFound")
  }, SLOW)

  test("code written by hand saves as the next revision and runs in the realm: the agent gets the prompt the code rendered", async () => {
    const model = scripted(() => drafted(), ['ctx.done("Ran.")'])
    const d = await device(model.script)
    await saveFlow(d, "dark-mode")
    const { source } = (await d.run(d.engine.flows.execute(FlowRead, {
      executionId: crypto.randomUUID(),
      payload: { name: "dark-mode" },
    })) as unknown as Exit.Success<{ source: string }>).value

    expect(await writeCode(d, 1, relabelled(source))).toMatchObject({
      _tag: "Success",
      value: { name: "dark-mode", revision: 2, placement: "client" },
    })
    const runId = crypto.randomUUID()
    expect(await d.run(d.engine.flows.execute(FlowRun, { executionId: runId, payload: { name: "dark-mode", input: "please" } })))
      .toEqual(Exit.succeed("Ran."))
    // The prompt the relabelled step's own code rendered in the realm: the instructions, then the input.
    expect(said(model.requests.find(running)!)).toContain("Set the theme to dark, then say it is done.\n\nInput: please")
    // Its run: the load, then the code's lineage: an evaluation, the agent's call, and the evaluation that answered.
    expect(await stepsOf(d, runId)).toEqual([
      "flow/run/load",
      "flow/run/code: flow/run/evaluate, flow/run/call",
      "flow/run/prompt: flow/run/agent",
      "flow/run/code: flow/run/evaluate",
    ])
  }, SLOW)

  test("code calls a flow its list names and the agent, as the person's own flow, and answers with any value as text", async () => {
    const model = scripted(() => drafted(), ['ctx.done("Dark.")'])
    const d = await device(model.script)
    await saveFlow(d, "dark-mode")
    const source = handWritten({
      declare: `const SetTheme = Action.make("app/theme/set", { payload: { mode: Schema.String }, success: Schema.Unknown })`,
      body: `({ input }) => SetTheme.call({ mode: "dark" }).pipe(Node.bindPlanned(() => Agent.call({ input })),
    Node.map((answer) => ({ answer, done: true })))`,
      success: "Schema.Struct({ answer: Schema.String, done: Schema.Boolean })",
    })
    expect(await writeCode(d, 1, source)).toMatchObject({ _tag: "Success", value: { placement: "client" } })
    expect(await d.run(d.engine.flows.execute(FlowRun, { executionId: crypto.randomUUID(), payload: { name: "dark-mode", input: "please" } })))
      .toEqual(Exit.succeed('{"answer":"Dark.","done":true}'))
    expect(d.agent.painted).toEqual(["dark"])
    expect(said(model.requests.find(running)!)).toContain("Mine: please")
  }, SLOW)

  test("a flow's failure is the code's receipt, by its kind, which the code may catch", async () => {
    const d = await device(scripted(() => drafted()).script)
    await saveFlow(d, "dark-mode")
    const source = handWritten({
      flows: ["app/navigate"],
      declare: `const Go = Action.make("app/navigate", { payload: { to: Schema.String }, success: Schema.Unknown, error: Schema.String })`,
      body: `() => Go.call({ to: "javascript:alert(1)" }).pipe(Node.map(() => "moved"),
    Node.catch({ onFailure: (kind) => Node.succeed(kind).pipe(Node.map((k) => \`refused: \${k}\`)) }))`,
    })
    await writeCode(d, 1, source)
    expect(await d.run(d.engine.flows.execute(FlowRun, { executionId: crypto.randomUUID(), payload: { name: "dark-mode" } })))
      .toEqual(Exit.succeed("refused: NavigationRefused"))
  }, SLOW)

  test("the realm refuses a call outside the list, a loop past its limit, a module it lacks, and calls the host won't make", async () => {
    const model = scripted(() => drafted(), ['ctx.done("Ran.")'])
    const d = await device(model.script)
    await saveFlow(d, "dark-mode")
    const setTheme = `const SetTheme = Action.make("app/theme/set", { payload: { mode: Schema.String }, success: Schema.Unknown })`
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      [handWritten({ flows: [], declare: setTheme, body: `() => SetTheme.call({ mode: "dark" }).pipe(Node.map(() => "set"))` }),
        "FlowCallRefused", "action_not_allowed"],
      [handWritten({ body: "() => { while (true) {} }" }), "FlowLimitExceeded", "limit_exceeded"],
      [handWritten({ imports: `import { pipe } from "effect/Function"`, body: "({ input }) => Agent.call({ input: pipe(input, (x) => x) })" }),
        "FlowImportRefused", "forbidden_import"],
      [handWritten({ body: "() => { throw new Error('sensitive-user-content') }" }), "FlowCodeFailed", "execution_failed"],
      [handWritten({ seat: "coding", body: "({ input }) => Agent.call({ input })" }), "FlowCallRefused", "seat"],
      [handWritten({
        declare: `const SetTheme = Action.make("app/theme/set", { payload: { color: Schema.String }, success: Schema.Unknown })`,
        body: `() => SetTheme.call({ color: "dark" }).pipe(Node.map(() => "set"))`,
      }), "FlowCallRefused", "payload"],
      [handWritten({
        declare: `const Forged = Action.make("@smthrs/agent/AgentAction", { payload: { step: Schema.Number }, success: Schema.String })`,
        body: "() => Forged.call({ step: 1 })",
      }), "FlowCallRefused", "payload"],
    ]
    let revision = 1
    for (const [source, tag, code] of cases) {
      expect(await writeCode(d, revision++, source)).toMatchObject({ _tag: "Success", value: { placement: "client" } })
      const exit = await d.run(d.engine.flows.execute(FlowRun, { executionId: crypto.randomUUID(), payload: { name: "dark-mode" } }))
      expect([tag, code, JSON.stringify(exit)]).toEqual([tag, code, expect.stringContaining(`"_tag":"@smthrs/mvp/flows/${tag}","code":"${code}"`)])
      expect(JSON.stringify(exit)).not.toContain("sensitive-user-content")
    }
    expect(model.requests.filter(running)).toEqual([])
    expect(d.agent.painted).toEqual([])
  }, SLOW * 2)

  test("code that needs a machine saves as sandbox and its run fails before anything runs", async () => {
    const model = scripted(() => drafted(), ['ctx.done("Ran.")'])
    const d = await device(model.script)
    await saveFlow(d, "dark-mode")
    let revision = 1
    for (
      const source of [
        handWritten({ imports: `import { readFile } from "node:fs/promises"`, body: "({ input }) => Agent.call({ input })" }),
        handWritten({ capabilities: `["proc:spawn"]`, body: "({ input }) => Agent.call({ input })" }),
      ]
    ) {
      expect(await writeCode(d, revision++, source)).toMatchObject({ _tag: "Success", value: { placement: "sandbox" } })
      const refused = await d.run(d.engine.flows.execute(FlowRun, { executionId: crypto.randomUUID(), payload: { name: "dark-mode" } }))
      expect(JSON.stringify(refused)).toContain("@smthrs/mvp/flows/FlowNeedsSandbox")
    }
    expect(model.requests.filter(running)).toEqual([])
  }, SLOW)

  test("a killed engine resumes the code from its receipts: a sealed model call isn't asked again", async () => {
    let hang = true
    const answered: Array<string> = []
    const model = scripted(() => drafted())
    const script = (request: Request) => {
      if (!running(request)) return model.script(request)
      const prompt = said(request).includes("Mine: one") ? "second" : "first"
      answered.push(prompt)
      if (prompt === "second" && hang) return Stream.never
      return answer(`ctx.done(${JSON.stringify(prompt === "first" ? "one" : "two")})`)
    }
    const d = await device(script)
    await saveFlow(d, "dark-mode")
    await writeCode(d, 1, handWritten({
      body: "({ input }) => Agent.call({ input }).pipe(Node.bindPlanned((first) => Agent.call({ input: first })))",
    }))
    const runId = crypto.randomUUID()
    const payload = { name: "dark-mode", input: "zero" }
    void Effect.runPromise(Effect.exit(d.engine.flows.execute(FlowRun, { executionId: runId, payload })))
    await eventually(() => answered.includes("second"), 60_000)
    await d.engine.crash()
    hang = false
    const again = await d.agent.engine(d.engine.schema)
    opened.push({ close: again.kill })
    const exit = await Effect.runPromise(Effect.exit(
      again.driver.drive(FlowRun, { executionId: runId, payload }).pipe(
        Effect.andThen(again.flows.execute(FlowRun, { executionId: runId, payload })),
      ),
    ))
    expect(exit).toEqual(Exit.succeed("two"))
    // The first agent step's model call was sealed before the crash: only the second is asked again.
    expect(answered.filter((prompt) => prompt === "first")).toEqual(["first"])
  }, SLOW * 2)

  test("Stop cancels the code's run between its steps", async () => {
    const model = scripted(() => drafted())
    const d = await device((request) => (running(request) ? (model.requests.push(request), Stream.never) : model.script(request)))
    await saveFlow(d, "dark-mode")
    await writeCode(d, 1, handWritten({ body: "({ input }) => Agent.call({ input })" }))
    const runId = crypto.randomUUID()
    const ended = Effect.runPromise(Effect.exit(d.engine.flows.execute(FlowRun, { executionId: runId, payload: { name: "dark-mode" } })))
    await eventually(() => model.requests.some(running), 60_000)
    await Effect.runPromise(d.engine.flows.interrupt(FlowRun, runId))
    expect(Exit.hasInterrupts(await ended)).toBe(true)
    expect(model.requests.filter(running)).toHaveLength(1)
  }, SLOW)

  test("a write that fails a check, or from a revision another followed, is refused before or by ChatApi; one again isn't", async () => {
    const d = await device(scripted(() => drafted()).script)
    await saveFlow(d, "dark-mode")
    const write = (revision: number, source: string, name = "dark-mode") =>
      d.run(d.engine.flows.execute(FlowWrite, { executionId: crypto.randomUUID(), payload: { name, revision, source } }))
    const good = renderSource({ name: "dark-mode", description: "Dark.", flows: [], instructions: "Go dark." })

    expect(JSON.stringify(await write(1, good.replace(`Flow.make("dark-mode"`, `Flow.make("light-mode"`))))
      .toContain('"check":"name"')
    expect(JSON.stringify(await write(1, renderSource({ name: "dark-mode", description: "D.", flows: ["flow/new"], instructions: "Go." }))))
      .toContain('"check":"calls"')
    expect(await write(1, good)).toMatchObject({ _tag: "Success", value: { revision: 2 } })
    // The same write again, as a step tried again: the revision it made. Other bytes from that revision: stale.
    expect(await write(1, good)).toMatchObject({ _tag: "Success", value: { revision: 2 } })
    expect(JSON.stringify(await write(1, good.replace("Go dark.", "Go darker.")))).toContain('"code":"stale"')
    expect(JSON.stringify(await write(1, renderSource({ name: "other", description: "D.", flows: [], instructions: "Go." }), "other")))
      .toContain("FlowNotFound")
    // ChatApi saw only the writes the checks admitted.
    expect(d.agent.h.line("flow.route").filter((line) => line.annotations.route === "write").map((line) => line.annotations.status))
      .toEqual([200, 200, 409, 404])
  }, SLOW)

  test("a refused write is recorded by ChatApi's code, not_found, or unavailable", () => {
    expect(writeOutcome({ _tag: "@smthrs/mvp/flows/FlowsRefused", code: "stale" })).toBe("stale")
    expect(writeOutcome({ _tag: "@smthrs/mvp/flows/FlowNotFound" })).toBe("not_found")
    expect(writeOutcome({ _tag: "@smthrs/mvp/flows/FlowsUnavailable" })).toBe("unavailable")
  })
})

describe("flow/draft/delete", () => {
  test("deletes your draft and stops its round on this engine; again, or someone else's, deletes nothing", async () => {
    const SILENT = "SILENT-never-answered"
    // The drafting model call never answers: the round is live when the draft is deleted.
    const d = await device((request) => (drafting(request) ? Stream.never : Stream.empty))
    const draftId = crypto.randomUUID()
    const round = d.engine.flows.execute(FlowNew, {
      executionId: roundExecutionId(draftId, 0),
      payload: { name: "dark-mode", request: SILENT },
    })
    const ended = Effect.runPromise(Effect.exit(round))
    await eventually(async () => (await draftRow(draftId))?.status === "drafting", 30_000)
    expect(await d.run(d.engine.flows.execute(FlowDraftDelete, { executionId: crypto.randomUUID(), payload: { draftId } })))
      .toEqual(Exit.succeed({ deleted: true }))
    expect((await ended)._tag).toBe("Failure")
    expect(await d.run(d.engine.flows.execute(FlowDraftDelete, { executionId: crypto.randomUUID(), payload: { draftId } })))
      .toEqual(Exit.succeed({ deleted: false }))
    expect(await d.run(d.engine.flows.execute(FlowDraftDelete, {
      executionId: crypto.randomUUID(),
      payload: { draftId: crypto.randomUUID() },
    }))).toEqual(Exit.succeed({ deleted: false }))
  }, SLOW)
})

describe("run/retry of your flow", () => {
  test("pinned reruns the revision and flow that ran, even after a newer revision and the name went to another flow; current runs the latest", async () => {
    // Each draft carries its own instructions, so each revision's run says which it is.
    let version = 0
    const model = scripted(() => drafted({ instructions: `Version ${++version}: set the theme to dark.` }))
    const d = await device(model.script)
    const first = await saveFlow(d, "dark-mode")
    const runId = crypto.randomUUID()
    // A run that names no revision: it loads the latest, revision 1.
    expect(await d.run(d.engine.flows.execute(FlowRun, { executionId: runId, payload: { name: "dark-mode", input: "please" } })))
      .toMatchObject({ _tag: "Success" })
    expect(said(model.requests.filter(running).at(-1)!)).toContain("Version 1:")
    // A newer revision of the same flow.
    expect(await saveFlow(d, "dark-mode")).toMatchObject({ flowId: first.flowId, revision: 2 })

    /** Retries the first run with `version` and waits for the retried run's model call: what it was told. */
    const retried = async (version: "pinned" | "current") => {
      const before = model.requests.filter(running).length
      const act = await d.run(d.engine.flows.execute(Retry, { executionId: crypto.randomUUID(), payload: { runId, version } }))
      expect(act).toMatchObject({ _tag: "Success" })
      await eventually(() => model.requests.filter(running).length > before, 30_000)
      return said(model.requests.filter(running).at(-1)!)
    }
    expect(await retried("pinned")).toContain("Version 1:")
    expect(await retried("current")).toContain("Version 2:")

    // The flow is deleted and another takes its name: pinned still reruns what ran, from the deleted flow.
    expect(await d.run(d.engine.flows.execute(FlowDelete, { executionId: crypto.randomUUID(), payload: { flowId: first.flowId } })))
      .toEqual(Exit.succeed({ deleted: true }))
    const other = await saveFlow(d, "dark-mode")
    expect(other.flowId).not.toBe(first.flowId)
    expect(await retried("pinned")).toContain("Version 1:")
    expect(await retried("current")).toContain("Version 3:")
  }, SLOW * 2)
})

describe("removeDraft", () => {
  /** `flow/draft/delete/remove` over a ChatApi that refuses reading the draft with `status`. */
  const removing = (status: number) => {
    const deleted: Array<string> = []
    const client = Layer.succeed(FlowsClient)(FlowsClient.of({
      draft: () => Effect.fail(new FlowsRefused({ status, code: "refused" })),
      deleteDraft: (draftId: string) => Effect.sync(() => (deleted.push(draftId), true)),
    } as unknown as FlowsClient["Service"]))
    const exit = Effect.runPromise(Effect.exit(
      removeDraft({ draftId: "d" }).pipe(Effect.provide(client)) as Effect.Effect<{ deleted: boolean }, unknown>,
    ))
    return { exit, deleted }
  }

  test("a draft gone or not the person's deletes nothing; any other refusal, such as signed out, fails the step", async () => {
    for (const status of [403, 404]) {
      const r = removing(status)
      expect([status, await r.exit]).toEqual([status, Exit.succeed({ deleted: false })])
      expect(r.deleted).toEqual([])
    }
    const signedOut = removing(401)
    expect(await signedOut.exit).toMatchObject({ _tag: "Failure" })
    expect(JSON.stringify(await signedOut.exit)).toContain('"status":401')
    expect(signedOut.deleted).toEqual([])
  })
})

describe("flow/drafts", () => {
  test("lists your drafts not saved yet, newest first, by the id flow/draft/delete takes; saved or deleted ones drop out", async () => {
    const d = await device(scripted(() => drafted()).script)
    const list = () => d.run(d.engine.flows.execute(FlowDrafts, { executionId: crypto.randomUUID(), payload: {} }))
    expect(await list()).toEqual(Exit.succeed({ drafts: [] }))
    const [older, newer] = [crypto.randomUUID(), crypto.randomUUID()]
    expect((await writeRound(d, older, readyRound("dark-mode"))).status).toBe(200)
    expect((await writeRound(d, newer, readyRound(null as never, { status: "drafting", request: "Open the docs" })))
      .status).toBe(200)
    const saved = await saveFlow(d, "light-mode")

    expect(await list()).toEqual(Exit.succeed({
      drafts: [
        { draftId: newer, name: null, request: "Open the docs", status: "drafting" },
        { draftId: older, name: "dark-mode", request: "Switch to dark mode", status: "ready" },
      ],
    }))
    expect(saved.draftId).not.toBe(older)
    await d.run(d.engine.flows.execute(FlowDraftDelete, { executionId: crypto.randomUUID(), payload: { draftId: older } }))
    expect(await list()).toEqual(Exit.succeed({
      drafts: [{ draftId: newer, name: null, request: "Open the docs", status: "drafting" }],
    }))
  }, SLOW)
})

describe("flow/list and flow/delete", () => {
  test("lists your flows; deleting one removes it, and deleting it again deletes nothing", async () => {
    const d = await device(scripted(() => drafted()).script)
    const saved = await saveFlow(d, "dark-mode")
    expect(await d.run(d.engine.flows.execute(FlowList, { executionId: crypto.randomUUID(), payload: {} })))
      .toEqual(Exit.succeed({
        flows: [{ name: "dark-mode", description: "Switch this device to dark mode.", revision: 1, placement: "client" }],
      }))
    expect(await d.run(d.engine.flows.execute(FlowDelete, { executionId: crypto.randomUUID(), payload: { flowId: saved.flowId } })))
      .toEqual(Exit.succeed({ deleted: true }))
    expect(await d.run(d.engine.flows.execute(FlowDelete, { executionId: crypto.randomUUID(), payload: { flowId: saved.flowId } })))
      .toEqual(Exit.succeed({ deleted: false }))
    expect(await d.run(d.engine.flows.execute(FlowList, { executionId: crypto.randomUUID(), payload: {} })))
      .toEqual(Exit.succeed({ flows: [] }))
  }, SLOW)
})

describe("the agent's catalog", () => {
  test("outside any run, no agent asks: the whole catalog", async () => {
    const d = await device(scripted(() => drafted()).script)
    const url = await Effect.runPromise(TestDatabase.serverUrl)
    const store = PostgresDatabase.layer({ url: url.toString(), driver: Pg, schema: d.engine.schema })
    const names = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const source = yield* Catalog.source
      return (yield* source.bindings()).map((binding) => binding.descriptor.name)
    })).pipe(
      Effect.provideService(FlowRuntime.FlowRuntime, d.engine.flows),
      Effect.provide(FlowRegistry.layer),
      Effect.provide(EngineStore.RunInspection.layer.pipe(Layer.provide(store))),
    ))
    expect(names).toEqual(Catalog.agentFlows)
    const scoped = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const source = yield* Catalog.source
      return (yield* source.bindings()).map((binding) => binding.descriptor)
    })).pipe(
      Effect.provideService(FlowRuntime.FlowRuntime, d.engine.flows),
      Effect.provideService(FlowRegistry, { entries: flowEntries, names: ["app/theme/set"], entryOf: (name) => ({ ...flowEntries[name], changes: "updates this test's theme" }) }),
      Effect.provide(EngineStore.RunInspection.layer.pipe(Layer.provide(store))),
    ))
    expect(scoped.map((flow) => flow.name)).toEqual(["app/theme/set"])
    expect(scoped[0]!.description).toContain("Side effect: updates this test's theme")

  }, SLOW)
})

describe("flow/run/evaluate and flow/run/call", () => {
  const source = renderSource({ name: "dark-mode", description: "Dark.", flows: [], instructions: "Go dark." })
  const state = (overrides: Partial<CodeState> = {}): CodeState => ({
    flowId: "00000000-0000-4000-8000-000000000001",
    name: "dark-mode",
    revision: 1,
    digest: digestSync(overrides.source ?? source),
    source,
    runtime: RealmFlow.version,
    allowed: [],
    input: "",
    receipts: [],
    ...overrides,
  })
  const evaluated = (value: CodeState, variant: Layer.Layer<QuickJSVariant.Variant> = RealmFlow.layerDefaultVariant) =>
    Effect.runPromise(Effect.exit(evaluate(value).pipe(Effect.provide(variant))))
  const failedWith = (exit: Exit.Exit<unknown, unknown>, tag: string, code: string) =>
    expect(JSON.stringify(exit)).toContain(`"_tag":"@smthrs/mvp/flows/${tag}","code":"${code}"`)

  test("refuses a run pinned under another realm, code whose bytes changed or won't compile, and a realm that can't start", async () => {
    failedWith(await evaluated(state({ runtime: "another-realm" })), "FlowCodeFailed", "version")
    failedWith(await evaluated(state({ digest: "0".repeat(64) })), "FlowCodeFailed", "invalid_source")
    failedWith(await evaluated(state({ source: "export default {" })), "FlowCodeFailed", "invalid_source")
    // The host's QuickJS build, injected faulty: the realm can't start, and nothing private says why.
    const broken = QuickJSVariant.layerVariant({
      type: "sync",
      importFFI: async () => {
        throw Error("private-host-path")
      },
      importModuleLoader: async () => {
        throw Error("private-host-path")
      },
    })
    const exit = await evaluated(state(), broken)
    failedWith(exit, "FlowCodeFailed", "runtime_failed")
    expect(JSON.stringify(exit)).not.toContain("private-host-path")
  })

  test("asks for the agent on the prompt the code rendered, and ends a run past its host calls", async () => {
    const chained = source.replace(
      "body: ({ input }) => Agent.call({ input }),",
      "body: ({ input }) => { let node = Agent.call({ input }); for (let n = 0; n < 9; n++) node = node.pipe(Node.bindPlanned((x) => Agent.call({ input: x }))); return node },",
    ).replace(`import { Flow } from "@smthrs/flow"`, `import { Flow } from "@smthrs/flow"\nimport { Node } from "@smthrs/plan"`)
    let current = state({ source: chained, input: "go" })
    for (let n = 0; n < MAX_REALM_CALLS; n++) {
      const exit = await evaluated(current)
      if (exit._tag !== "Success" || exit.value._tag !== "Action") throw new Error(`Expected call ${n}: ${JSON.stringify(exit)}`)
      expect(exit.value).toMatchObject({ name: RealmFlow.agentAction, payload: { seat: "agent", prompt: n === 0 ? "Go dark.\n\nInput: go" : "Go dark.\n\nInput: a" } })
      current = { ...current, receipts: [...current.receipts, { ...exit.value, outcome: { _tag: "Success", value: "a" } }] }
    }
    failedWith(await evaluated(current), "FlowLimitExceeded", "too_many_calls")
  })

  test("the host refuses a call outside the pin's list, and one a person's flow may never make", async () => {
    // Inert services: the call is refused before the run or the engine is read.
    const refused = (allowed: ReadonlyArray<string>, name: string) =>
      Effect.runPromise(Effect.exit(call({
        pin: { flowId: "f", name: "dark-mode", revision: 1, digest: "d", allowed },
        call: { _tag: "Action", key: "k", name, payload: {} },
      }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, { executionId: "run" } as never),
        Effect.provideService(FlowRuntime.FlowRuntime, {} as never),
      ) as Effect.Effect<unknown, unknown>))
    failedWith(await refused([], "app/theme/set"), "FlowCallRefused", "action_not_allowed")
    failedWith(await refused(["flow/new"], "flow/new"), "FlowCallRefused", "action_not_allowed")
  })
})
