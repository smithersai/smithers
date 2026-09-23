/**
 * Proves `lib/jev-replay.mjs` rebuilds the supervisor's snapshot from a
 * journal, offline, and scores readings the way its report claims.
 *
 *   node fixtures/check-jev-replay.mjs
 *
 * One synthetic journal is written to a temp dir with the `control.agent.*`
 * rows the harness journals: a first request carrying the task, three frames
 * (a read-only frame, an edit, and a failing check re-run over the same tree),
 * and one demand. The replay is run in `--dry-run`, so nothing is asked and
 * nothing is spent, and the snapshots are asserted field by field against
 * what `CellTurn` would have carried. The scoreboard is then fed hand-written
 * readings so precision and recall are checked on numbers a person can add up.
 *
 * Offline, spends nothing, needs no docker.
 *
 * @since 0.1.0
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArguments, replay, scoreboard, snapshots } from "../lib/jev-replay.mjs"
import { read } from "../lib/journal-facts.mjs"

const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-jev-replay-"))

/** Writes one journal database out of a list of `[type, payload]` events. */
const journal = (name, events) => {
  const directory = join(temporary, name)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "engine.db")
  const database = new DatabaseSync(path)
  database.exec(
    "create table flows_journal_events ("
      + " run_id text not null, seq integer not null, event_id text not null unique,"
      + " source_id text not null, source_seq integer not null, emitted_at_ms integer not null,"
      + " event_type text not null, payload_json text not null, meta_json text not null,"
      + " primary key (run_id, seq))"
  )
  const insert = database.prepare(
    "insert into flows_journal_events"
      + " (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)"
      + " values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
  events.forEach(([type, payload], index) => {
    insert.run("run-1", index, `e${index}`, "agent", index, 1000 + index, type, JSON.stringify(payload), "{}")
  })
  database.close()
  return path
}

const opened = ["control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }]
const requested = (frame, system) => ["control.agent.model-requested", { scope: "s", frame, attempt: 1, purpose: "frame", system }]
const settled = (text) => ["control.agent.model-settled", { text, usage: { inputTokens: 1, outputTokens: 1 } }]
const produced = (text) => ["control.agent.cell-produced", { language: "js", digest: "d", text }]
const printed = (text) => ["control.agent.cell-printed", { cell: "d", text }]
const call = (flowName, input, value = {}, outcome = "success") => [
  ["control.agent.cell-call-started", { flowName, input }],
  ["control.agent.cell-call-settled", { flowName, outcome, value }]
]
const observed = (digest, mutated) => ["control.agent.mutation-observed", { basis: "observed", digest, mutated, paths: 3, declaredWrites: mutated ? 1 : 0 }]
const transition = (tag) => ["control.agent.transition-applied", { transition: { _tag: tag } }]

try {
  const path = journal("one__one-1", [
    // Frame 0: the task travels in the first request's last system text. A
    // grep that changes nothing.
    requested(0, ["cell contract", "flow catalog", "The task for this run:\n\nFix add()."]),
    opened,
    // The run's opening measurement, which is what `treeMoved` compares against.
    ["flows.time-travel.effect-boundary", {
      effect: { kind: "harness/boundary/workspace-open", status: "succeeded", output: { _tag: "Some", value: { digest: "t0", complete: true } } }
    }],
    settled("Looking first.\n\n```cell\nawait ctx.call('grep', {pattern:'add'})\n```"),
    produced("await ctx.call('grep', {pattern:'add'})"),
    ...call("grep", { pattern: "add" }, { matches: [] }),
    printed("no matches"),
    observed("t0", false),
    transition("continue"),
    // Frame 1: an edit that moves the tree, then the check fails.
    opened,
    settled("Editing.\n\n```cell\n...\n```"),
    produced("await ctx.call('edit', {path:'a.py'}); await ctx.call('bash', {command:'pytest'})"),
    ...call("edit", { path: "a.py" }, {}),
    ...call("bash", { command: "pytest" }, { exitCode: 1, stdout: "1 failed" }),
    printed("1 failed"),
    observed("t1", true),
    transition("continue"),
    // Frame 2: the same check again over the unchanged tree, still failing,
    // and the run is told it is repeating itself.
    opened,
    settled("Retrying.\n\n```cell\n...\n```"),
    produced("await ctx.call('bash', {command:'pytest'})"),
    ...call("bash", { command: "pytest" }, { exitCode: 1, stdout: "1 failed" }),
    printed("1 failed"),
    observed("t1", false),
    transition("continue"),
    ["control.agent.repeat-demanded", { frames: 1, cap: 1, nextFrame: 3 }]
  ])

  const facts = read(path)
  assert.equal(facts.task, "The task for this run:\n\nFix add().", "the task is the first request's last system text")
  assert.equal(facts.frames.length, 3)
  assert.equal(facts.frames[1].cell, "await ctx.call('edit', {path:'a.py'}); await ctx.call('bash', {command:'pytest'})")
  assert.equal(facts.frames[2].printed, "1 failed")

  const built = snapshots(facts)
  assert.equal(built.length, 3, "one snapshot per frame")
  assert.equal(built[0].frames.length, 1)
  assert.equal(built[2].frames.length, 3, "the third snapshot carries the newest three frames")
  assert.equal(built[2].task, facts.task)
  assert.deepEqual(built[2].candidates, [])
  assert.deepEqual(built[2].recalled, [])
  assert.equal(built[2].frames[2].transition, "continue")
  assert.equal(built[2].frames[1].mutated, true)
  assert.equal(built[2].frames[2].prose, "Retrying.\n\n```cell\n...\n```")

  const s0 = built[0].signals
  assert.equal(s0.frame, 0)
  assert.equal(s0.readOnlyFrames, 1, "frame 0 changed nothing")
  assert.equal(s0.repeatFrames, 0)
  assert.equal(s0.mutations, 0)
  assert.equal(s0.treeMoved, false)
  assert.equal(s0.checksRun, 1, "the grep is a check")
  assert.equal(s0.checksFailing, 0)
  assert.equal(s0.callsSettled, 1)

  const s1 = built[1].signals
  assert.equal(s1.readOnlyFrames, 0, "frame 1 moved the tree")
  assert.equal(s1.mutations, 1)
  assert.equal(s1.treeMoved, true)
  assert.equal(s1.checksFailing, 1, "pytest last reported failing")
  assert.equal(s1.failuresUnanswered, 1)
  assert.equal(s1.callsSettled, 3)

  const s2 = built[2].signals
  assert.equal(s2.readOnlyFrames, 1)
  assert.equal(s2.repeatFrames, 1, "frame 2 issued only a call frame 1 had issued, and changed nothing")
  assert.equal(s2.mutations, 1)
  assert.equal(s2.checksRun, 2, "grep and pytest are the distinct checks")
  assert.equal(s2.checksFailing, 1)
  assert.equal(s2.callsFailed, 0)
  assert.equal(s2.narrowingDemands, 0)
  assert.equal(s2.sufficiencyStated, false)

  // The snapshot encodes under the harness's own schema, which is what the
  // live path sends: a shape drift here would be `invalid_question` on the wire.
  const { Schema } = await import("effect")
  const Supervisor = await import("../../../packages/smithers/agent/harness/src/Supervisor.ts")
  for (const snapshot of built) Schema.encodeUnknownSync(Supervisor.Snapshot)(snapshot)

  // The dry run through the command surface: one journal, three frames, no ask.
  const options = parseArguments([temporary, "--dry-run", "--suffix", "-1"])
  const report = await replay(options, {})
  assert.equal(report.journals, 1)
  assert.equal(report.frames, 3)
  assert.equal(report.readings, 0)
  assert.equal(report.runs[0].id, "one__one")
  assert.equal(report.runs[0].label, undefined, "no manifest, no label")

  // A directory whose names carry no matching suffix holds no journals.
  const none = await replay(parseArguments([temporary, "--dry-run", "--suffix", "-r97"]), {})
  assert.equal(none.journals, 0)

  // The scoreboard on numbers a person can add up. Positive predicts unresolved.
  const reading = (thrashing, onTarget, needsHelp = "none", frustrated = "none") => ({
    thrashing,
    onTarget,
    suspect: 0.1,
    emotions: { frustrated, anxious: "none", scared: "none", confused: "none", confident: "none" },
    needsHelp
  })
  const board = scoreboard([
    { id: "a", label: "unresolved", readings: [reading(0.2, 0.9), reading(0.8, 0.9, "stuck", "strong")] },
    { id: "b", label: "unresolved", readings: [reading(0.2, 0.9)] },
    { id: "c", label: "resolved", readings: [reading(0.9, 0.9)] },
    { id: "d", label: "resolved", readings: [reading(0.1, 0.9)] },
    { id: "e", label: undefined, readings: [reading(0.9, 0.1)] },
    { id: "f", label: "unresolved", readings: [] }
  ])
  assert.equal(board.labelled, 4, "an unlabelled run and a run with no reading score nothing")
  assert.equal(board.unresolved, 2)
  const row = (signal, frame) => board.rows.find((entry) => entry.signal === signal && entry.frame === frame)
  const flagLast = row("on_target<0.5 || thrashing>0.5", "last")
  assert.deepEqual([flagLast.tp, flagLast.fp, flagLast.fn, flagLast.tn], [1, 1, 1, 1])
  assert.equal(flagLast.precision, 0.5)
  assert.equal(flagLast.recall, 0.5)
  const stuck = row("needs_help=stuck", "any")
  assert.deepEqual([stuck.tp, stuck.fp, stuck.fn, stuck.tn], [1, 0, 1, 2])
  assert.equal(stuck.precision, 1)
  const frustrated = row("frustrated=strong", "last")
  assert.deepEqual([frustrated.tp, frustrated.fp], [1, 0])
  assert.ok(row("confident=mild|strong", "any") !== undefined)
  assert.ok(row("needs_help!=none", "last") !== undefined)

  // Without a key the live path refuses before reading a journal.
  await assert.rejects(replay(parseArguments([temporary]), {}), /AI_GATEWAY_API_KEY/)

  console.log("check-jev-replay: ok")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
