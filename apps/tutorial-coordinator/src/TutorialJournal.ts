import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { LiveTutorialEventSchema, LiveTutorialRunSchema, LiveTutorialStartSchema, type LiveTutorialRun, type LiveTutorialStart } from "@smthrs/rpc/LiveTutorial"

const Artifacts = LiveTutorialRunSchema.pick({ result: true, plan: true, commits: true, diff: true, files: true,
  branch: true, baseCommitId: true, tests: true, change: true }).strict()
const artifactsOf = (run: LiveTutorialRun) => Artifacts.parse(Object.fromEntries(
  Object.keys(Artifacts.shape).filter(key => Object.hasOwn(run, key)).map(key => [key, (run as unknown as Record<string, unknown>)[key]])
))
const Baseline = z.object({ run: LiveTutorialRunSchema, input: LiveTutorialStartSchema,
  checkpoints: z.record(z.string(), z.string()) }).strict()
const Fact = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), value: Baseline }).strict(),
  z.object({ kind: z.literal("legacy-baseline"), value: Baseline }).strict(),
  z.object({ kind: z.literal("execution.claimed"), ownerId: z.string().min(1), executionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("execution.interrupted"), ownerId: z.string().min(1).nullable(), executionId: z.string().min(1), error: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("phase.changed"), phase: LiveTutorialRunSchema.shape.phase, error: z.string().nullable() }).strict(),
  z.object({ kind: z.literal("step.observed"), step: LiveTutorialEventSchema }).strict(),
  z.object({ kind: z.literal("artifacts.observed"), value: Artifacts }).strict(),
  z.object({ kind: z.literal("checkpoint.recorded"), name: z.string().min(1), value: z.string() }).strict()
])
type Fact = z.infer<typeof Fact>
const RecordSchema = z.object({ version: z.literal(1), runId: z.string(), sequence: z.number().int().positive(),
  at: z.number().finite(), previousHash: z.string(), fact: Fact, hash: z.string() }).strict()
export type TutorialJournalRecord = z.infer<typeof RecordSchema>
interface State { readonly run: LiveTutorialRun; readonly input: LiveTutorialStart; readonly checkpoints: Record<string, string>;
  readonly execution?: { readonly ownerId: string; readonly executionId: string } }
interface Head { readonly sequence: number; readonly hash: string }
interface Loaded { readonly state: State; readonly head: Head }
const genesis: Head = { sequence: 0, hash: "tutorial-genesis-v1" }
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}
const digest = (record: Omit<TutorialJournalRecord, "hash">): string => createHash("sha256").update(canonical(record)).digest("hex")
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)
export class TutorialJournalIntegrityError extends Error {
  constructor(reason: string) { super(`Tutorial journal refused ${reason}; saved evidence was preserved.`) }
}

/** Pure reduction. Clocks and effect/checkpoint outputs are recorded facts. */
export const reduceTutorialFact = (prior: State | undefined, fact: Fact, at: number): State => {
  if (fact.kind === "created" || fact.kind === "legacy-baseline") {
    if (prior !== undefined) throw new TutorialJournalIntegrityError("a repeated baseline")
    if (fact.kind === "created" && (fact.value.run.phase !== "queued" || fact.value.run.events.length !== 0 ||
      Object.keys(fact.value.checkpoints).length !== 0)) throw new TutorialJournalIntegrityError("invented initial history")
    for (const value of Object.values(fact.value.checkpoints)) JSON.parse(value)
    return structuredClone(fact.value)
  }
  if (prior === undefined) throw new TutorialJournalIntegrityError("a missing baseline")
  const next = structuredClone(prior)
  next.run.updatedAt = at
  switch (fact.kind) {
    case "execution.claimed":
      if (prior.execution !== undefined || prior.run.phase !== "queued" || fact.executionId !== prior.run.runId) {
        throw new TutorialJournalIntegrityError("a repeated execution claim")
      }
      return { ...next, run: { ...next.run, phase: "running" }, execution: { ownerId: fact.ownerId, executionId: fact.executionId } }
    case "execution.interrupted":
      if (prior.run.phase !== "running" || fact.executionId !== prior.run.runId || fact.ownerId !== (prior.execution?.ownerId ?? null)) {
        throw new TutorialJournalIntegrityError("a foreign execution interruption")
      }
      next.run.phase = "failed"
      next.run.error = fact.error
      for (const step of next.run.events) if (step.status === "running") { step.status = "failed"; step.finishedAt = at }
      break
    case "phase.changed":
      if (fact.phase === "queued" || (prior.run.phase !== "queued" && prior.run.phase !== "running")) {
        throw new TutorialJournalIntegrityError("a terminal run restart")
      }
      next.run.phase = fact.phase
      if (fact.error === null) delete next.run.error
      else next.run.error = fact.error
      break
    case "step.observed": {
      const index = next.run.events.findIndex(step => step.id === fact.step.id)
      if (index < 0) next.run.events.push(structuredClone(fact.step))
      else next.run.events[index] = structuredClone(fact.step)
      break
    }
    case "artifacts.observed":
      for (const key of Object.keys(Artifacts.shape)) delete (next.run as unknown as Record<string, unknown>)[key]
      Object.assign(next.run, structuredClone(fact.value))
      break
    case "checkpoint.recorded":
      if (Object.hasOwn(next.checkpoints, fact.name) && next.checkpoints[fact.name] !== fact.value) {
        throw new TutorialJournalIntegrityError("a changed checkpoint result")
      }
      JSON.parse(fact.value)
      next.checkpoints[fact.name] = fact.value
  }
  return { ...next, run: LiveTutorialRunSchema.parse(next.run) }
}

export const replayTutorialJournal = (input: ReadonlyArray<unknown>, expected?: Head): Loaded => {
  let state: State | undefined, head = genesis
  let runId: string | undefined
  for (const raw of input) {
    const parsed = RecordSchema.safeParse(raw)
    if (!parsed.success || !same(parsed.data, raw)) throw new TutorialJournalIntegrityError("an unknown or malformed event")
    const { hash, ...record } = parsed.data
    if ((runId !== undefined && record.runId !== runId) || record.sequence !== head.sequence + 1 ||
      record.previousHash !== head.hash || digest(record) !== hash) throw new TutorialJournalIntegrityError("a changed or missing event")
    state = reduceTutorialFact(state, record.fact, record.at)
    if (state.run.runId !== record.runId) throw new TutorialJournalIntegrityError("a foreign run")
    runId = record.runId; head = { sequence: record.sequence, hash }
  }
  if (state === undefined || (expected !== undefined && !same(head, expected))) throw new TutorialJournalIntegrityError("a missing head or suffix")
  return { state, head }
}

/** Journal, head, run body and action checkpoints commit in one SQLite transaction. */
export class TutorialJournal {
  private loaded = new WeakMap<LiveTutorialRun, Loaded>()
  readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
    db.exec("CREATE TABLE IF NOT EXISTS tutorial_events(run TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run,sequence)); CREATE TABLE IF NOT EXISTS tutorial_heads(run TEXT PRIMARY KEY,sequence INTEGER NOT NULL,hash TEXT NOT NULL);")
    const ids = db.prepare("SELECT id FROM runs UNION SELECT run AS id FROM tutorial_heads UNION SELECT run AS id FROM tutorial_events").all() as { id: string }[]
    for (const { id } of ids) {
      const head = this.head(id)
      const events = this.history(id)
      if (head === undefined && events.length === 0) {
        const row = db.prepare("SELECT body,input FROM runs WHERE id=?").get(id) as { body: string; input: string }
        const run = LiveTutorialRunSchema.parse(JSON.parse(row.body)), input = LiveTutorialStartSchema.parse(JSON.parse(row.input))
        const checkpoints = Object.fromEntries((db.prepare("SELECT name,value FROM checkpoints WHERE run=?").all(id) as { name: string; value: string }[]).map(row => [row.name, row.value]))
        this.commit(run, undefined, [{ kind: "legacy-baseline", value: { run, input, checkpoints } }], run.updatedAt)
      } else {
        if (head === undefined) throw new TutorialJournalIntegrityError("a missing stream head")
        const verified = replayTutorialJournal(events, head)
        this.transaction(() => { this.assertHead(id, head); this.writeCaches(verified.state) })
      }
    }
  }
  private head(id: string): Head | undefined {
    return this.db.prepare("SELECT sequence,hash FROM tutorial_heads WHERE run=?").get(id) as Head | undefined
  }
  history(id: string): TutorialJournalRecord[] {
    return (this.db.prepare("SELECT body FROM tutorial_events WHERE run=? ORDER BY sequence").all(id) as { body: string }[]).map(row => JSON.parse(row.body))
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try { const result = work(); this.db.exec("COMMIT"); return result }
    catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  private assertHead(id: string, expected: Head | undefined): void {
    if (!same(this.head(id), expected)) throw new TutorialJournalIntegrityError("a stale writer")
  }
  private writeCaches(state: State): void {
    const { run, input, checkpoints } = state
    this.db.prepare("INSERT INTO runs(id,session,playthrough,key,plan,body,input) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session=excluded.session,playthrough=excluded.playthrough,key=excluded.key,plan=excluded.plan,body=excluded.body,input=excluded.input")
      .run(run.runId, run.sessionId, input.playthrough, input.idempotencyKey, input.planId ?? null, JSON.stringify(run), JSON.stringify(input))
    this.db.prepare("DELETE FROM checkpoints WHERE run=?").run(run.runId)
    for (const [name, value] of Object.entries(checkpoints)) this.db.prepare("INSERT INTO checkpoints(run,name,value) VALUES(?,?,?)").run(run.runId, name, value)
  }
  private commit(run: LiveTutorialRun, prior: Loaded | undefined, facts: Fact[], at: number): void {
    let state = prior?.state, head = prior?.head ?? genesis
    const records = facts.map(fact => {
      const checked = Fact.parse(fact)
      state = reduceTutorialFact(state, checked, at)
      const record = { version: 1 as const, runId: run.runId, sequence: head.sequence + 1, at, previousHash: head.hash, fact: checked }
      const sealed = { ...record, hash: digest(record) }
      head = { sequence: sealed.sequence, hash: sealed.hash }
      return sealed
    })
    if (state === undefined) throw new TutorialJournalIntegrityError("an empty stream")
    const accepted = state
    this.transaction(() => {
      this.assertHead(run.runId, prior?.head)
      for (const record of records) this.db.prepare("INSERT INTO tutorial_events(run,sequence,body) VALUES(?,?,?)").run(run.runId, record.sequence, JSON.stringify(record))
      this.db.prepare("INSERT INTO tutorial_heads(run,sequence,hash) VALUES(?,?,?) ON CONFLICT(run) DO UPDATE SET sequence=excluded.sequence,hash=excluded.hash")
        .run(run.runId, head.sequence, head.hash)
      this.writeCaches(accepted)
    })
    this.loaded.set(run, { state: structuredClone(accepted), head })
    run.updatedAt = accepted.run.updatedAt
  }
  create(run: LiveTutorialRun, input: LiveTutorialStart): void {
    this.commit(run, undefined, [{ kind: "created", value: { run, input, checkpoints: {} } }], run.createdAt)
  }
  /** Accept execution ownership before calling any external operation. No implicit takeover. */
  claim(run: LiveTutorialRun, ownerId: string): boolean {
    const prior = this.loaded.get(run)
    if (prior === undefined) throw new TutorialJournalIntegrityError("an unowned execution claim")
    if (prior.state.execution !== undefined || prior.state.run.phase !== "queued") return false
    this.commit(run, prior, [{ kind: "execution.claimed", ownerId, executionId: run.runId }], Date.now())
    run.phase = "running"
    return true
  }
  /** The caller must first acquire the process-lifetime coordinator lock.
   * Preserve receipts and identity; an interrupted external effect is not replayed.
   */
  interrupt(run: LiveTutorialRun): boolean {
    const prior = this.loaded.get(run)
    if (prior === undefined) throw new TutorialJournalIntegrityError("an unowned interruption")
    if (prior.state.run.phase !== "running") return false
    this.commit(run, prior, [{ kind: "execution.interrupted", ownerId: prior.state.execution?.ownerId ?? null,
      executionId: prior.state.run.runId, error: "This action was interrupted. Retry the action." }], Date.now())
    Object.assign(run, structuredClone(this.loaded.get(run)!.state.run))
    return true
  }
  get(session: string, id: string): LiveTutorialRun | undefined {
    const head = this.head(id)
    if (head === undefined) {
      if (this.db.prepare("SELECT 1 FROM runs WHERE id=? UNION SELECT 1 FROM tutorial_events WHERE run=? LIMIT 1").get(id, id)) {
        throw new TutorialJournalIntegrityError("a missing stream head")
      }
      return undefined
    }
    const loaded = replayTutorialJournal(this.history(id), head)
    if (loaded.state.run.sessionId !== session) return undefined
    const run = structuredClone(loaded.state.run)
    this.loaded.set(run, loaded)
    return run
  }
  all(): Array<{ run: LiveTutorialRun; input: LiveTutorialStart }> {
    if (this.db.prepare("SELECT 1 FROM (SELECT id FROM runs UNION SELECT run AS id FROM tutorial_events) source LEFT JOIN tutorial_heads ON source.id=tutorial_heads.run WHERE tutorial_heads.run IS NULL LIMIT 1").get()) {
      throw new TutorialJournalIntegrityError("a missing stream head")
    }
    return (this.db.prepare("SELECT run FROM tutorial_heads ORDER BY rowid").all() as { run: string }[]).map(({ run: id }) => {
      const loaded = replayTutorialJournal(this.history(id), this.head(id))
      const run = structuredClone(loaded.state.run)
      this.loaded.set(run, loaded)
      return { run, input: structuredClone(loaded.state.input) }
    })
  }
  save(run: LiveTutorialRun): void {
    const prior = this.loaded.get(run)
    if (prior === undefined) throw new TutorialJournalIntegrityError("an unowned run snapshot")
    const next = LiveTutorialRunSchema.parse(run), facts: Fact[] = []
    if (next.runId !== prior.state.run.runId || next.sessionId !== prior.state.run.sessionId ||
      next.operation !== prior.state.run.operation || next.createdAt !== prior.state.run.createdAt) {
      throw new TutorialJournalIntegrityError("changed run identity")
    }
    if (next.phase !== prior.state.run.phase || next.error !== prior.state.run.error) {
      facts.push({ kind: "phase.changed", phase: next.phase, error: next.error ?? null })
    }
    const steps = new Map(prior.state.run.events.map(step => [step.id, step]))
    const ids = new Set(next.events.map(step => step.id))
    if ([...steps.keys()].some(id => !ids.has(id)) || ids.size !== next.events.length) throw new TutorialJournalIntegrityError("removed or repeated steps")
    for (const step of next.events) if (!same(step, steps.get(step.id))) facts.push({ kind: "step.observed", step })
    const artifacts = artifactsOf(next), previous = artifactsOf(prior.state.run)
    if (!same(artifacts, previous)) facts.push({ kind: "artifacts.observed", value: artifacts })
    if (facts.length > 0) this.commit(run, prior, facts, Date.now())
  }
  checkpoint(run: LiveTutorialRun, name: string): string | undefined { return this.loaded.get(run)?.state.checkpoints[name] }
  recordCheckpoint(run: LiveTutorialRun, name: string, value: string): void {
    const prior = this.loaded.get(run)
    if (prior === undefined) throw new TutorialJournalIntegrityError("an unowned checkpoint")
    this.commit(run, prior, [{ kind: "checkpoint.recorded", name, value }], Date.now())
  }
  verify(id: string): boolean {
    const head = this.head(id)
    if (head === undefined) throw new TutorialJournalIntegrityError("a missing head")
    const { state } = replayTutorialJournal(this.history(id), head)
    const row = this.db.prepare("SELECT body,input FROM runs WHERE id=?").get(id) as { body: string; input: string } | undefined
    const checkpoints = Object.fromEntries((this.db.prepare("SELECT name,value FROM checkpoints WHERE run=?").all(id) as { name: string; value: string }[]).map(row => [row.name, row.value]))
    return row !== undefined && same(JSON.parse(row.body), state.run) && same(JSON.parse(row.input), state.input) && same(checkpoints, state.checkpoints)
  }
  remove(run: LiveTutorialRun): void {
    const prior = this.loaded.get(run)
    if (prior === undefined) throw new TutorialJournalIntegrityError("an unowned prune")
    this.transaction(() => {
      this.assertHead(run.runId, prior.head)
      for (const table of ["checkpoints", "tutorial_events", "tutorial_heads"]) this.db.prepare(`DELETE FROM ${table} WHERE run=?`).run(run.runId)
      this.db.prepare("DELETE FROM runs WHERE id=?").run(run.runId)
    })
  }
}
