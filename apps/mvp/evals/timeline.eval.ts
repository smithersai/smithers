// `pnpm eval`: the timeline's summaries and phases (ruling FE-19) on realistic coding-agent conversations. The real
// summary model, sent the exact requests the flows send (`summaryRequest`, `segmentRequest`), through the real
// segmentation plan (`planOf`, `cleanSpans`). Quality is judged by the host's judge (Jev when `AI_GATEWAY_API_KEY` is set),
// plus boundary F1 against a person's own division of each conversation. Nothing about the model or judge is scripted.
//
//   EVAL_ONLY=timeline         run only this eval
//   TIMELINE_EVAL_SEAT=luna    the subscription seat to grade (`claude-code:haiku`, `luna`)
//   TIMELINE_EVAL_MODEL=<json> else the model record to grade (default: `SUMMARY_MODEL`, else the deployment's default)
//   TIMELINE_EVAL_SAMPLE=24    entries judged per conversation
//   TIMELINE_EVAL_WRITE=1      write evals/timeline-baseline.json instead of comparing with it
import { NodeControl } from "@smthrs/cli"
import { HostModel } from "@smthrs/model-host"
import { Evaluator, type Model, ModelEvent, ModelRequest, RequestExecutor } from "@smthrs/model"
import { EgressHttpClient } from "@smthrs/platform-node"
import { ConfigProvider, Context, Effect, Layer, Option, Scope, Stream } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { expect, test } from "vitest"
import { DEFAULT_CHAT_MODEL } from "../worker/ModelRoles.ts"
import { exchangeUnits, parseMark, phaseUnits, planOf, cleanSpans, type Level, type SegmentPlan } from "../src/features/timeline/marks.ts"
import { cleanSummary, segmentRequest, summaryRequest } from "../src/features/timeline/steps.ts"
import { boundaryF1, TIMELINE_FIXTURES, type TimelineFixture } from "./timelineFixtures"

const NAME = "timeline"
const only = (process.env.EVAL_ONLY ?? "").split(",").filter(name => name !== "")
const SAMPLE = Number(process.env.TIMELINE_EVAL_SAMPLE ?? "24")
const BASELINE = new URL("timeline-baseline.json", import.meta.url)
/** How far a score may fall below its baseline before the eval fails. */
const TOLERANCE = 0.1

const judge = NodeControl.layerSeatEvaluator(process.env).pipe(
  Layer.provide(NodeControl.layerRebuildableRequestExecutor(NodeControl.environmentDispatcher(process.env))),
)

type Row = { readonly id: string; readonly role: string; readonly status: string; readonly text: string; readonly questionId?: string; summary?: string; phase?: string; arc?: string }
const rowsOf = (fixture: TimelineFixture): ReadonlyArray<Row> => fixture.exchanges.flatMap(([question, answer], n): ReadonlyArray<Row> => [
  { id: `q${n}`, role: "user", status: "done", text: question },
  { id: `a${n}`, role: "assistant", status: answer.startsWith("I couldn't") ? "failed" : "done", text: answer, questionId: `q${n}` },
])

/** The flow's request, to the graded model: the role's name is the endpoint's to resolve, so a seat gets its own. */
const ask = (model: Model.Model, modelId: string) => (request: ModelRequest.ModelRequest) =>
  model.stream(ModelRequest.ModelRequest.make({ ...request, modelId })).pipe(Stream.runCollect, Effect.map(events => ModelEvent.settledMessage([...events] as Array<ModelEvent.ModelEvent>).message.content
    .filter(part => part.type === "text").map(part => part.text).join("")))

const QUESTIONS = {
  entryAccurate: "`summary` is a timeline label for `message`. Is everything it says supported by `message` (and `question`, when given)? A correct, shorter statement passes; an invented file, number or outcome fails.",
  entrySpecific: "Would `summary` help a person find this message again in a long chat: does it name what was asked or what happened, rather than a generic status such as 'Reply sent', 'Answer given' or 'Done'? It must read as plain human words of at most eight words.",
  boundaries: "`phases` divides `exchanges` into phases. Do the phases follow changes of goal or topic, with steps toward one goal (including failures and retries) kept together, rather than splitting evenly or arbitrarily?",
  titles: "Does every phase's `title` name the specific work in plain human words, as in 'Researching issue 450' or 'Fixing flaky checkout tests', never a generic label such as 'Conversation' or 'Various tasks'?",
  faithful: "Is each phase's `summary` faithful to its exchanges: it says what happened and how it ended, and invents nothing?",
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

/** Entry summaries for `fixture`, as the flow makes them, written onto its rows. */
const summarizeAll = (call: ReturnType<typeof ask>, rows: ReadonlyArray<Row>) => Effect.forEach(rows, (row, index) => Effect.gen(function* () {
  const question = row.questionId === undefined ? rows[index - 1]?.text : rows.find(other => other.id === row.questionId)?.text
  const text = yield* call(summaryRequest({ role: row.role === "user" ? "user" : "assistant", text: row.text, ...(question === undefined ? {} : { question }) }))
  const summary = cleanSummary(text)
  if (summary !== undefined) row.summary = summary
  return { id: row.id, message: row.text, question, raw: text, summary }
}), { concurrency: 4 })

/** Runs segmentation as a conversation grows: every plan the device would make, in order, on summaries. */
const segmentAll = (call: ReturnType<typeof ask>, rows: ReadonlyArray<Row>) => Effect.gen(function* () {
  let calls = 0, invalid = 0
  const apply = (plan: SegmentPlan, text: string, field: "phase" | "arc") => {
    const spans = cleanSpans(text, plan)
    if (spans === undefined) { invalid++; return false }
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
        const text = yield* call(segmentRequest(plan))
        if (!apply(plan, text, level === 1 ? "phase" : "arc")) break
      }
    }
  }
  return { calls, invalid }
})

const gradeFixture = (call: ReturnType<typeof ask>, fixture: TimelineFixture) => Effect.gen(function* () {
  const rows = rowsOf(fixture).map(row => ({ ...row }))
  const entries = yield* summarizeAll(call, rows)
  const madeShare = entries.filter(entry => entry.summary !== undefined).length / entries.length
  const stride = Math.max(1, Math.floor(entries.length / SAMPLE))
  const sampled = entries.filter((_, index) => index % stride === 0).slice(0, SAMPLE).filter(entry => entry.summary !== undefined)
  const judged = yield* Effect.forEach(sampled, entry => booleans(["entryAccurate", "entrySpecific"], { message: entry.message, question: entry.question ?? null, summary: entry.summary }), { concurrency: 4 })
  const { calls, invalid } = yield* segmentAll(call, rows)
  const phases = rows.flatMap((row, index) => {
    const mark = parseMark(row.phase)
    return Option.isSome(mark) ? [{ from: index / 2, ...mark.value }] : []
  })
  const found = phases.map(phase => phase.from)
  const graded = phases.length === 0 ? { boundaries: 0, titles: 0, faithful: 0 } : yield* booleans(["boundaries", "titles", "faithful"], {
    exchanges: fixture.exchanges.map(([question, answer], n) => ({ n, question, answer })),
    phases: phases.map(({ from, title, summary }) => ({ from, title, summary })),
  })
  return {
    name: fixture.name, entries: entries.length, summariesMade: madeShare,
    entryAccurate: mean(judged.map(answer => answer.entryAccurate)), entrySpecific: mean(judged.map(answer => answer.entrySpecific)),
    boundaryF1: boundaryF1(found, fixture.phases), phases: phases.map(({ from, title, summary, closed }) => ({ from, title, summary, closed })),
    truth: fixture.phases, calls, invalidCalls: invalid, ...graded,
    samples: entries.slice(0, 12).map(({ id, summary, raw }) => ({ id, summary: summary ?? null, raw })),
  }
})

test.skipIf(only.length > 0 && !only.includes(NAME))("timeline: summaries and phases read as a person would write them", async () => {
  const scope = Effect.runSync(Scope.make())
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
  const call = ask(real.model, real.modelId)
  const results = await Effect.runPromise(Effect.forEach(TIMELINE_FIXTURES, fixture => gradeFixture(call, fixture)))
  const scores = {
    summariesMade: mean(results.map(result => result.summariesMade)),
    entryAccurate: mean(results.map(result => result.entryAccurate)),
    entrySpecific: mean(results.map(result => result.entrySpecific)),
    boundaryF1: mean(results.map(result => result.boundaryF1)),
    boundaries: mean(results.map(result => result.boundaries)),
    titles: mean(results.map(result => result.titles)),
    faithful: mean(results.map(result => result.faithful)),
  }
  const report = { eval: NAME, model: real.modelId, scores, fixtures: results }
  mkdirSync(new URL("results/", import.meta.url), { recursive: true })
  writeFileSync(new URL(`results/${NAME}-${new Date().toISOString().replaceAll(":", "-")}.json`, import.meta.url), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ model: real.modelId, scores, calls: results.map(result => result.calls), phases: results.map(result => result.phases.map(phase => `${phase.from}:${phase.title}`)) }, null, 1))
  if (process.env.TIMELINE_EVAL_WRITE === "1" || !existsSync(BASELINE)) {
    writeFileSync(BASELINE, `${JSON.stringify({ model: real.modelId, scores }, null, 2)}\n`)
    return
  }
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { readonly scores: Record<string, number> }
  for (const [name, score] of Object.entries(scores)) expect(score, name).toBeGreaterThanOrEqual((baseline.scores[name] ?? 0) - TOLERANCE)
})
