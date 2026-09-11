/**
 * Rebuilds journal databases from a distilled wave, so a past wave can be a
 * candidate in a best-of-n selection without keeping its workspaces.
 *
 *   node fixtures/rehydrate-journals.mjs <distilled.json> <out-dir> <run-index>
 *
 * `lib/narrowing-journals.mjs` distils a wave's journals down to the facts a
 * completion is judged on — every call's flow, input and result reading, and
 * every frame's digest, mutation answer and transition — and three of those
 * distillations are committed as the evidence the harness's own detectors are
 * tested against. This turns one back into `<out-dir>/<instance>-<index>/
 * engine.db`, which is exactly what `select-candidate.mjs` reads.
 *
 * It is how the selector is tested against two real runs of one instance. Wave
 * 10 and wave 11 ran the same five instances; both distillations survive, the
 * workspaces do not, and rehydrating them gives a two-candidate case whose
 * journals nothing synthesised.
 *
 * What is rebuilt is the *order* of a run, not its sequence numbers. Sequence
 * numbers are re-issued monotonically here, because the distillation records
 * them only for the events it kept and a call's `cell-call-started` has no
 * recorded number at all. Everything a predicate reads — flow, input, exit
 * status, digest, mutation, transition, and the order of all of it — is the
 * wave's own.
 *
 * Two optional fields let a hand-written distillation exercise the selector's
 * tie-breaks: `usage`, which is spread evenly across the run's model calls, and
 * `patchBytes`, which writes a patch of that size beside the journal when a
 * patches directory is given as a fourth argument.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

const [, , sourcePath, outArgument, indexArgument, patchesArgument] = process.argv
if (sourcePath === undefined || outArgument === undefined || indexArgument === undefined) {
  console.error("usage: rehydrate-journals.mjs <distilled.json> <out-dir> <run-index> [patches-dir]")
  process.exit(2)
}
if (!/^r[0-9]+$/u.test(indexArgument)) {
  console.error("rehydrate-journals.mjs: run index must match r<digits>")
  process.exit(2)
}

const source = JSON.parse(readFileSync(resolve(sourcePath), "utf8"))
// Each instance name becomes a path component, so it must be one: the same
// `<repo>__<issue>` shape `lib/run-paths.sh` accepts. Every name is checked
// before anything is written.
for (const journal of source.journals) {
  if (
    typeof journal.instance !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*__[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(journal.instance)
  ) {
    console.error(`rehydrate-journals.mjs: instance ${JSON.stringify(journal.instance)} must match <repo>__<issue>`)
    process.exit(2)
  }
}
const outDir = resolve(outArgument)
const patchesDir = patchesArgument === undefined ? undefined : resolve(patchesArgument)

/** A fixed epoch: a rehydrated journal must be byte-stable across builds. */
const EPOCH = 1_755_500_000_000

const ddl = `CREATE TABLE IF NOT EXISTS flows_journal_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  emitted_at_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
)`

/** The result value a distilled call's reading implies. */
const valueOf = (call) => {
  if (!call.ok) return null
  const value = {}
  if (typeof call.exit === "number") value.exitCode = call.exit
  if (call.probe === true) value.invalidProbe = { reason: "rehydrated", message: "rehydrated" }
  return value
}

const build = (journal) => {
  const events = []
  const turns = journal.frames.length
  const usage = journal.usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
  const share = (total, turn) =>
    turns === 0 ? 0 : turn === turns - 1 ? total - Math.floor(total / turns) * (turns - 1) : Math.floor(total / turns)

  // The run's opening measurement, as the first frame's `workspace-open`
  // boundary. `complete: true` with a digest is a walk that covered the tree;
  // an empty `openedOn` is distilled as a walk that did not.
  events.push([
    "flows.time-travel.effect-boundary",
    {
      version: 1,
      effect: {
        kind: "harness/boundary/workspace-open",
        status: "succeeded",
        output: {
          _tag: "Some",
          value: { complete: journal.openedOn !== "", digest: journal.openedOn, paths: 1 }
        }
      }
    }
  ])

  journal.frames.forEach((frame, turn) => {
    events.push(["control.agent.turn-opened", { seat: journal.seat ?? "openai:gpt-5.6-sol" }])
    events.push([
      "control.agent.model-settled",
      {
        text: "",
        usage: {
          inputTokens: share(usage.inputTokens ?? 0, turn),
          cachedInputTokens: share(usage.cachedInputTokens ?? 0, turn),
          outputTokens: share(usage.outputTokens ?? 0, turn)
        },
        durationMillis: 1000
      }
    ])
    for (const call of frame.calls) {
      events.push(["control.agent.cell-call-started", { flowName: call.flow, input: call.input }])
      events.push([
        "control.agent.cell-call-settled",
        call.ok
          ? { flowName: call.flow, outcome: "success", value: valueOf(call) }
          : { flowName: call.flow, outcome: "failure", message: "rehydrated failure" }
      ])
    }
    events.push([
      "control.agent.mutation-observed",
      {
        basis: frame.basis,
        mutated: frame.mutated,
        digest: frame.digest,
        paths: frame.digest === "" ? 0 : 1,
        declaredWrites: frame.calls.filter((call) => call.mutates === true).length
      }
    ])
    if (frame.transition !== "none") {
      events.push(["control.agent.transition-applied", { transition: { _tag: frame.transition } }])
    }
  })
  events.push(["control.run.completed", {}])

  const runDirectory = join(outDir, `${journal.instance}-${indexArgument}`)
  mkdirSync(runDirectory, { recursive: true })
  const path = join(runDirectory, "engine.db")
  rmSync(path, { force: true })
  const database = new DatabaseSync(path)
  database.exec(ddl)
  const insert = database.prepare(
    "insert into flows_journal_events (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
  const runId = `run-${journal.instance}-${indexArgument}`
  events.forEach(([eventType, payload], seq) => {
    insert.run(runId, seq, `${runId}-${seq}`, "rehydrated", seq, EPOCH + seq, eventType, JSON.stringify(payload), "{}")
  })
  database.close()

  if (patchesDir !== undefined) {
    mkdirSync(patchesDir, { recursive: true })
    writeFileSync(
      join(patchesDir, `${journal.instance}-${indexArgument}.patch`),
      "x".repeat(journal.patchBytes ?? 0)
    )
  }
  return events.length
}

let total = 0
for (const journal of source.journals) total += build(journal)
console.log(
  `rehydrate-journals.mjs: ${source.journals.length} journals as ${indexArgument} under ${outDir} (${total} events)`
)
