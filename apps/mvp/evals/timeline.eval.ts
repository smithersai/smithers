// `pnpm eval`: the timeline's summaries and phases (ruling FE-19) on realistic coding-agent conversations. The product's
// own durable flows (`timeline/summarize`, `timeline/phases`) run on the Node host's engine over the compose Postgres,
// so every model call is the flows' `ModelStep`, journaled and replayed as in the app, through the real segmentation
// plan (`planOf`). The flows' ledger here only records what they write. Quality is judged by the host's judge (Jev when
// `AI_GATEWAY_API_KEY` is set), plus boundary F1 against a person's own division of each conversation, and every fixture
// must clear absolute bars (evals/timelineGrades.ts). Nothing about the model or judge is scripted.
//
//   EVAL_ONLY=timeline         run only this eval
//   TIMELINE_EVAL_SEAT=luna    the subscription seat to grade (`claude-code:haiku`, `luna`)
//   TIMELINE_EVAL_MODEL=<json> else the model record to grade (default: `SUMMARY_MODEL`, else the deployment's default)
//   TIMELINE_EVAL_SAMPLE=24    entries judged per conversation
//   TIMELINE_EVAL_WRITE=1      record the scores in evals/timeline-baseline.json
import { NodeControl } from "@smthrs/cli"
import { Action, FlowRuntime } from "@smthrs/flow"
import { HostModel } from "@smthrs/model-host"
import { Evaluator, Model, ModelRequest, RequestExecutor } from "@smthrs/model"
import { EgressHttpClient } from "@smthrs/platform-node"
import { Cause, ConfigProvider, Context, Effect, Exit, Layer, Option, Scope, Stream } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { expect, test } from "vitest"
import { DEFAULT_CHAT_MODEL } from "../worker/ModelRoles.ts"
import { build } from "../worker/test/flowHost.ts"
import { Phases, type SegmentPayload, Summarize, SummaryFailed, type SummaryPayload } from "../src/features/timeline/flow.ts"
import { checkPlan, exchangeUnits, parseMark, phaseUnits, planOf, readOf, sealSpans, type Level, type SegmentPlan, type StoredSpan } from "../src/features/timeline/marks.ts"
import { registration, SummaryLedger, SummarySeat } from "../src/features/timeline/steps.ts"
import { boundaryF1, TIMELINE_FIXTURES, type TimelineFixture } from "./timelineFixtures"
import { gateFailures, phaseExchanges } from "./timelineGrades"

const NAME = "timeline"
const only = (process.env.EVAL_ONLY ?? "").split(",").map(name => name.trim()).filter(name => name !== "")
const SAMPLE = Number(process.env.TIMELINE_EVAL_SAMPLE ?? "24")
const BASELINE = new URL("timeline-baseline.json", import.meta.url)

const judge = NodeControl.layerSeatEvaluator(process.env).pipe(
  Layer.provide(NodeControl.layerRebuildableRequestExecutor(NodeControl.environmentDispatcher(process.env))),
)

type Row = { readonly id: string; readonly role: string; readonly status: string; readonly text: string; readonly questionId?: string; summary?: string; phase?: string; arc?: string }
const rowsOf = (fixture: TimelineFixture): ReadonlyArray<Row> => fixture.exchanges.flatMap(([question, answer], n): ReadonlyArray<Row> => [
  { id: `q${n}`, role: "user", status: "done", text: question },
  { id: `a${n}`, role: "assistant", status: answer.startsWith("I couldn't") ? "failed" : "done", text: answer, questionId: `q${n}` },
])

interface Graded { readonly modelId: string; readonly model: Model.Model; readonly route: { readonly prepare: SummarySeat["Service"]["route"]["prepare"] } }
/**
 * The summary role's seat, as the flows' `ModelStep` calls it: the flows name the role (`summary`), which the endpoint
 * resolves in the app, so the graded model gets its own id, in its call and in the step's key alike.
 */
const seatOf = (graded: Graded, spent: Spent) => {
  const named = (request: ModelRequest.ModelRequest) => ModelRequest.ModelRequest.make({ ...request, modelId: graded.modelId })
  return Layer.succeed(SummarySeat, {
    model: Model.make({ stream: request => {
      // A call's usage events carry its running totals: the last of each counter is the call's.
      const call: Record<string, number> = {}
      return graded.model.stream(named(request)).pipe(
        Stream.tap(event => Effect.sync(() => {
          if (event.type !== "usage") return
          for (const [name, value] of Object.entries(event)) if (typeof value === "number") call[name] = value
        })),
        Stream.ensuring(Effect.sync(() => {
          spent.calls++
          for (const [name, value] of Object.entries(call)) spent[name as keyof Spent] = (spent[name as keyof Spent] ?? 0) + value
        })),
      )
    } }),
    route: { prepare: request => graded.route.prepare(named(request)) },
  })
}

/** What the graded model reported spending, summed over every call the flows made. */
interface Spent { calls: number; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cachedInputTokens?: number; costUsd?: number }

/** The flows' record of a run: every claim is this run's, and what they record is what the eval grades. */
const recordingLedger = () => {
  const summaries = new Map<string, string>()
  const spans = new Map<string, ReadonlyArray<StoredSpan>>()
  const layer = Layer.succeed(SummaryLedger, SummaryLedger.of({
    claim: () => Effect.succeed(true),
    record: ({ messageId, summary }) => Effect.sync(() => { summaries.set(messageId, summary) }),
    release: () => Effect.void,
    claimSpans: () => Effect.succeed(true),
    recordSpans: ({ messageId, level, revision, spans: written }) => Effect.sync(() => { spans.set(`${level}:${messageId}:${revision}`, written) }),
    releaseSpans: () => Effect.void,
  }))
  return { summaries, spans, layer }
}

/** The product's flows on the Node host's durable engine, for one eval run. */
const engineFor = (graded: Graded, spent: Spent) => Effect.gen(function* () {
  const ledger = recordingLedger()
  const { context } = yield* build(registration.pipe(
    Layer.provide(ledger.layer), Layer.provide(seatOf(graded, spent)), Layer.provideMerge(Action.layerImplementations),
  ))
  const flows = Context.get(context, FlowRuntime.FlowRuntime)
  /** A flow's outcome: its value, or `invalid` when the model's text was unusable; any other failure fails the eval. */
  const run = <A>(execution: Effect.Effect<A, unknown, never>) => Effect.exit(execution).pipe(Effect.flatMap(exit => {
    if (Exit.isSuccess(exit)) return Effect.succeed(exit.value as A | "invalid")
    const error = Cause.squash(exit.cause)
    return error instanceof SummaryFailed && error.code === "invalid" ? Effect.succeed("invalid" as const) : Effect.die(error)
  }))
  return {
    ledger,
    summarize: (executionId: string, payload: SummaryPayload) =>
      run(flows.execute(Summarize, { executionId, payload }).pipe(Effect.provide(context)) as Effect.Effect<unknown, unknown, never>),
    segment: (executionId: string, payload: SegmentPayload) =>
      run(flows.execute(Phases, { executionId, payload }).pipe(Effect.provide(context)) as Effect.Effect<unknown, unknown, never>),
  }
})
type Engine = Effect.Success<ReturnType<typeof engineFor>>

const QUESTIONS = {
  entryAccurate: "`summary` is a timeline label for `message`. Is everything it says supported by `message` (and `question`, when given)? A correct, shorter statement passes; an invented file, number or outcome fails.",
  entrySpecific: "Would `summary` help a person find this message again in a long chat: does it name what was asked or what happened, rather than a generic status such as 'Reply sent', 'Answer given' or 'Done'? It must read as plain human words of at most eight words.",
  boundaries: "`phases` divides `exchanges` into phases. Do the phases follow changes of goal or topic, with steps toward one goal (including failures and retries) kept together, rather than splitting evenly or arbitrarily?",
  titles: "Does every phase's `title` name the specific work in plain human words, as in 'Researching issue 450' or 'Fixing flaky checkout tests', never a generic label such as 'Conversation' or 'Various tasks'?",
  faithful: "`phase` is one phase of a chat between a person and a coding agent, and `exchanges` are the exchanges it spans. Is every statement in `phase.summary` and `phase.title` supported by `exchanges`: every version, number, file, issue, pull request, name and outcome exactly as they state it? Leaving details out is fine; a wrong, invented or misattributed detail (such as the version a release is compared with named as the release itself) fails.",
}
const booleans = (ids: ReadonlyArray<keyof typeof QUESTIONS>, state: unknown) =>
  Effect.gen(function* () {
    const evaluator = yield* Evaluator.Evaluator
    const note = "The state holds model output from a chat app's navigation timeline. Judge only the question asked."
    const response = yield* evaluator.evaluate({
      state, seatNote: note,
      questions: Object.fromEntries(ids.map(id => [id, Evaluator.BooleanQuestion.of({ instructions: `${note}\n\n${QUESTIONS[id]}` })])),
    })
    return Object.fromEntries(ids.map(id => {
      const answer = response.answers[id]
      return [id, answer?.type === "boolean" ? answer.probability : 0]
    })) as Record<keyof typeof QUESTIONS, number>
  }).pipe(Effect.provide(judge))

const mean = (values: ReadonlyArray<number>) => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

/** Entry summaries for `fixture`, made by the summarize flow and written onto its rows. */
const summarizeAll = (engine: Engine, rows: ReadonlyArray<Row>) => Effect.forEach(rows, (row, index) => Effect.gen(function* () {
  const question = row.questionId === undefined ? rows[index - 1]?.text : rows.find(other => other.id === row.questionId)?.text
  const id = row.id
  yield* engine.summarize(`summary/${id}`, {
    id, revision: "eval", role: row.role === "user" ? "user" : "assistant", text: row.text, ...(question === undefined ? {} : { question }),
  })
  const summary = engine.ledger.summaries.get(id)
  if (summary !== undefined) row.summary = summary
  return { id: row.id, message: row.text, question, summary }
}), { concurrency: 4 })

/** Runs segmentation as a conversation grows: every plan the device would make, in order, on summaries. */
const segmentAll = (engine: Engine, fixture: string, rows: ReadonlyArray<Row>) => Effect.gen(function* () {
  let calls = 0, invalid = 0
  const apply = (plan: SegmentPlan, outcome: unknown, field: "phase" | "arc", units: Parameters<typeof checkPlan>[0]) => {
    const sent = engine.ledger.spans.get(`${plan.level}:${plan.anchorId}:${plan.revision}`)
    // The server's part of a record: it seals what a device sent over the items it holds (worker/TimelineSummaries.ts).
    const ids = checkPlan(units, plan.anchorId, readOf(plan.items))
    const spans = sent === undefined || typeof ids === "string" ? undefined : sealSpans(sent, ids)
    if (outcome === "invalid" || spans === undefined) { invalid++; return false }
    const at = rows.findIndex(row => row.id === plan.anchorId)
    for (const row of rows.slice(at)) delete row[field]
    for (const span of spans) rows.find(row => row.id === span.id)![field] = span.mark
    return true
  }
  // Grow one exchange at a time, so the open phase updates as it would live.
  const count = rows.length / 2
  for (let n = 1; n <= count; n++) {
    const seen = rows.slice(0, n * 2)
    for (const level of [1, 2] as ReadonlyArray<Level>) {
      for (let guard = 0; guard < 40; guard++) {
        const units = level === 1 ? exchangeUnits(seen) : phaseUnits(seen)
        const plan = planOf(units, level)
        if (plan === undefined) break
        calls++
        const outcome = yield* engine.segment(`phases/${fixture}/${plan.level}/${plan.anchorId}/${plan.revision}`, plan)
        if (!apply(plan, outcome, level === 1 ? "phase" : "arc", units)) break
      }
    }
  }
  return { calls, invalid }
})

const gradeFixture = (engine: Engine, fixture: TimelineFixture) => Effect.gen(function* () {
  const rows = rowsOf(fixture).map(row => ({ ...row, id: `${fixture.name}/${row.id}`, ...(row.questionId === undefined ? {} : { questionId: `${fixture.name}/${row.questionId}` }) }))
  const entries = yield* summarizeAll(engine, rows)
  const madeShare = entries.filter(entry => entry.summary !== undefined).length / entries.length
  const stride = Math.max(1, Math.floor(entries.length / SAMPLE))
  const sampled = entries.filter((_, index) => index % stride === 0).slice(0, SAMPLE).filter(entry => entry.summary !== undefined)
  const judged = yield* Effect.forEach(sampled, entry => booleans(["entryAccurate", "entrySpecific"], { message: entry.message, question: entry.question ?? null, summary: entry.summary }), { concurrency: 4 })
  const { calls, invalid } = yield* segmentAll(engine, fixture.name, rows)
  const phases = rows.flatMap((row, index) => {
    const mark = parseMark(row.phase)
    return Option.isSome(mark) ? [{ from: index / 2, ...mark.value }] : []
  })
  const found = phases.map(phase => phase.from)
  const whole = phases.length === 0 ? { boundaries: 0, titles: 0 } : yield* booleans(["boundaries", "titles"], {
    exchanges: fixture.exchanges.map(([question, answer], n) => ({ n, question, answer })),
    phases: phases.map(({ from, title, summary }) => ({ from, title, summary })),
  })
  // Each phase on its own exchanges: one wrong phase in nine is a ninth of the score, not all of it or none.
  const perPhase = yield* Effect.forEach(phaseExchanges(phases, fixture.exchanges), ({ from, title, summary, exchanges }) =>
    booleans(["faithful"], { phase: { from, title, summary }, exchanges }).pipe(Effect.map(answer => ({ from, faithful: answer.faithful }))), { concurrency: 4 })
  const graded = { boundaries: whole.boundaries, titles: whole.titles, faithful: mean(perPhase.map(phase => phase.faithful)) }
  return {
    name: fixture.name, entries: entries.length, summariesMade: madeShare,
    entryAccurate: mean(judged.map(answer => answer.entryAccurate)), entrySpecific: mean(judged.map(answer => answer.entrySpecific)),
    boundaryF1: boundaryF1(found, fixture.phases), phases: phases.map(({ from, title, summary, closed }) => ({ from, title, summary, closed })),
    truth: fixture.phases, calls, invalidCalls: invalid, ...graded, faithfulByPhase: perPhase,
    samples: entries.slice(0, 12).map(({ id, summary }) => ({ id, summary: summary ?? null })),
  }
})

test.skipIf(only.length > 0 && !only.includes(NAME))("timeline: summaries and phases read as a person would write them", async () => {
  const scope = Effect.runSync(Scope.make())
  try {
    const seat = process.env.TIMELINE_EVAL_SEAT
    // A subscription seat (`claude-code:haiku`, `luna`) or the summary role's record, whichever is set; the request is the flows' own.
    const real = seat !== undefined
      ? await Effect.runPromise(Effect.gen(function* () {
        // Built in the eval's own scope: the seat's transport must outlive this effect.
        const executors = yield* Layer.build(NodeControl.layerRebuildableRequestExecutor(NodeControl.environmentDispatcher(process.env)))
        const resolver = yield* NodeControl.scopedSeatResolver(process.env, Context.get(executors, RequestExecutor.RequestExecutor))
        return yield* resolver.resolve(seat)
      }).pipe(Scope.provide(scope)))
      : await Effect.runPromise(Effect.gen(function* () {
        const fetch = yield* EgressHttpClient.providerFetch(process.env)
        const record = process.env.TIMELINE_EVAL_MODEL ?? process.env.SUMMARY_MODEL
        return yield* Effect.gen(function* () { return yield* HostModel }).pipe(
          Effect.provide(HostModel.layerConfig("TIMELINE_MODEL", DEFAULT_CHAT_MODEL, { fetch })),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...process.env, ...(record === undefined ? {} : { TIMELINE_MODEL: record }) }))),
        )
      }).pipe(Scope.provide(scope)))
    const spent: Spent = { calls: 0 }
    const results = await Effect.runPromise(Effect.gen(function* () {
      const engine = yield* engineFor(real, spent)
      return yield* Effect.forEach(TIMELINE_FIXTURES, fixture => gradeFixture(engine, fixture))
    }).pipe(Scope.provide(scope)))
    const scores = {
      summariesMade: mean(results.map(result => result.summariesMade)),
      entryAccurate: mean(results.map(result => result.entryAccurate)),
      entrySpecific: mean(results.map(result => result.entrySpecific)),
      boundaryF1: mean(results.map(result => result.boundaryF1)),
      boundaries: mean(results.map(result => result.boundaries)),
      titles: mean(results.map(result => result.titles)),
      faithful: mean(results.map(result => result.faithful)),
    }
    // Per 100 messages: every summary and segmentation call the conversations needed, over the messages they hold.
    const messages = results.reduce((sum, result) => sum + result.entries, 0)
    const per100 = Object.fromEntries(Object.entries(spent).map(([name, value]) => [name, Math.round(value * 100 / messages * 1000) / 1000]))
    const report = { eval: NAME, model: real.modelId, scores, messages, spent, per100Messages: per100, fixtures: results }
    mkdirSync(new URL("results/", import.meta.url), { recursive: true })
    writeFileSync(new URL(`results/${NAME}-${new Date().toISOString().replaceAll(":", "-")}.json`, import.meta.url), `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({ model: real.modelId, scores, per100Messages: per100, failures: results.flatMap(result => gateFailures(result.name, result)), calls: results.map(result => result.calls), phases: results.map(result => result.phases.map(phase => `${phase.from}:${phase.title}`)) }, null, 1))
    const perFixture = Object.fromEntries(results.map(({ name, summariesMade, entryAccurate, entrySpecific, boundaryF1, boundaries, titles, faithful, invalidCalls, calls }) =>
      [name, { summariesMade, entryAccurate, entrySpecific, boundaryF1, boundaries, titles, faithful, invalidCalls, calls }]))
    if (process.env.TIMELINE_EVAL_WRITE === "1") writeFileSync(BASELINE, `${JSON.stringify({ model: real.modelId, scores, per100Messages: per100, fixtures: perFixture }, null, 2)}\n`)
    // Every fixture clears every bar on its own: a mean hides the one conversation whose phases are wrong.
    expect(results.flatMap(result => gateFailures(result.name, result))).toEqual([])
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})
