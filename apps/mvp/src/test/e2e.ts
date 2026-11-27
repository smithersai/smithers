import { ShapeSource } from "@smthrs/effect-electric"
import type { Interpreter } from "@smthrs/flow"
import { Effect } from "effect"
import { type AppOptions, type BootOptions, realServices, start } from "../boot"
import type { Question } from "../features/chat/api"
import { AuthFaults, EngineFaults, type QuestionFault, QuestionFaults, faultyServices, shardFaults } from "./faults"

// The app on faulty services, for the end-to-end tests of unhappy paths (docs/rules.md, test.faults-by-injection).
// Under `alchemy dev`, main.tsx loads this module when the page's URL carries `?faults`; a production build drops that
// branch, and this module with it. The services' switches go on `window.faults`, so a test throws them with
// `page.evaluate(() => window.faults.shapes.down())`. The browser reaches ChatApi and Electric through the faulty
// services, the real ones behind switches; a sync switch is thrown on Electric's shapes and on the page's reads of
// conversations' messages shards alike (src/test/faults.ts `ShardFaults`), so sync is down, refused, stalled or
// corrupt for both.

/** What a test can throw, on `window.faults`. Each mirrors a switch of the faulty services (src/test/faults.ts). */
export interface Switches {
  readonly shapes: {
    readonly down: (requests?: ShapeSource.Requests) => void
    readonly refuse: (status?: number, requests?: ShapeSource.Requests) => void
    readonly stall: (requests?: ShapeSource.Requests) => void
    readonly corrupt: (requests?: ShapeSource.Requests) => void
    readonly failures: () => number
    readonly heal: () => void
  }
  readonly questions: { readonly failNext: (fault: QuestionFault) => void; readonly asked: () => ReadonlyArray<Question> }
  readonly engine: {
    readonly refuseStarts: (flow: string) => void
    readonly holdStarts: () => void
    readonly releaseStarts: () => void
    readonly refuseResults: (flow: string, code: Interpreter.InterpreterError["code"]) => void
  }
  /** Every session read, the tab's and its engine worker's, answers 503 while down (src/test/authFaults.ts). */
  readonly session: { readonly down: () => void; readonly heal: () => void }
}

/** Whether the page opens with every session read answering 503, from `?faults=session-503`. */
export const sessionDown = (search: string): boolean => new URLSearchParams(search).get("faults") === "session-503"

/** The sync switches a page can open with: the shape source's, and the shard reads'. */
interface SyncSwitches {
  readonly down: () => Effect.Effect<void>
  readonly refuse: (status?: number) => Effect.Effect<void>
  readonly stall: () => Effect.Effect<void>
  readonly corrupt: () => Effect.Effect<void>
}

/**
 * The sync switch the page opens with, from `?faults=<switch>`: `down`, `refuse` (400), `refuse-<status>`, `stall` or
 * `corrupt`. Bare `?faults`, or `?faults=session-503`, opens it healthy.
 */
export const opening = (search: string): (<S extends SyncSwitches>(switches: S) => Effect.Effect<void>) | undefined => {
  const value = new URLSearchParams(search).get("faults") ?? ""
  const [name, status] = value.split("-")
  switch (name) {
    case "down":
      return (shapes) => shapes.down()
    case "refuse":
      return (shapes) => (status === undefined ? shapes.refuse() : shapes.refuse(Number(status)))
    case "stall":
      return (shapes) => shapes.stall()
    case "corrupt":
      return (shapes) => shapes.corrupt()
    default:
      return undefined
  }
}

/**
 * Starts the app as `start` does, on the faulty services, and puts their switches on `target.faults` (the window's)
 * once its services are built: a test waits for them with `page.waitForFunction(() => "faults" in window)`.
 */
export const startWithFaults = async (page: AppOptions & BootOptions, search: string, target: object) => {
  let rendered!: () => void
  const ready = new Promise<void>((resolve) => { rendered = resolve })
  // `?faults=recovery`: the first three reads of messages shards answer 503, a finite outage the page recovers from.
  const shards = shardFaults(new URLSearchParams(search).get("faults") === "recovery" ? 3 : 0)
  const thrown = opening(search)
  if (thrown !== undefined) Effect.runSync(thrown(shards.service))
  const { runtime, stop } = start(
    { ...page, fetch: shards.wrap(page.fetch), render: (...views) => { page.render(...views); rendered() } },
    faultyServices(page, thrown, sessionDown(search)),
  )
  const [shapes, questions, engine, session] = await runtime.runPromise(Effect.all([ShapeSource.Faults, QuestionFaults, EngineFaults, AuthFaults]))
  const reads = shards.service
  const faults: Switches = {
    shapes: {
      down: (requests) => runtime.runSync(Effect.andThen(shapes.down(requests), reads.down())),
      refuse: (status, requests) => runtime.runSync(Effect.andThen(shapes.refuse(status, requests), reads.refuse(status))),
      stall: (requests) => runtime.runSync(Effect.andThen(shapes.stall(requests), reads.stall())),
      corrupt: (requests) => runtime.runSync(Effect.andThen(shapes.corrupt(requests), reads.corrupt())),
      heal: () => runtime.runSync(Effect.andThen(shapes.heal, reads.heal)),
      failures: () => runtime.runSync(reads.failures),
    },
    questions: {
      failNext: (fault) => runtime.runSync(questions.failNext(fault)),
      asked: () => runtime.runSync(questions.asked),
    },
    engine: {
      refuseStarts: (flow) => runtime.runSync(engine.refuseStarts(flow)),
      holdStarts: () => runtime.runSync(engine.holdStarts),
      releaseStarts: () => runtime.runSync(engine.releaseStarts),
      refuseResults: (flow, code) => runtime.runSync(engine.refuseResults(flow, code)),
    },
    session: {
      down: () => runtime.runSync(session.down),
      heal: () => runtime.runSync(session.heal),
    },
  }
  Object.assign(target, { faults })
  await ready
  return { stop }
}

/** An isolated faulty host capability; unrelated clients and engine services remain the real ones. */
export const startWithAdmissionFaults = (page: AppOptions & BootOptions, target: object) => {
  let refusing = false
  const snapshot = page.host.writeSnapshot
  const host = { ...page.host, ...(snapshot === undefined ? {} : { writeSnapshot: { ...snapshot, stage: (value: unknown) => refusing ? undefined : snapshot.stage(value) } }) }
  const { stop } = start({ ...page, host }, realServices(page))
  Object.assign(target, { admissionFaults: { refuseInputs: () => { refusing = true }, heal: () => { refusing = false } } })
  return { stop }
}


/** Cold reads are held through the injected HTTP service; all released reads reach the real backend. */
export const startWithColdReads = async (page: AppOptions & BootOptions, target: object) => {
  const { coldReadsFor, heldFetch } = await import("./coldReads")
  return start({ ...page, fetch: heldFetch(page.fetch, coldReadsFor(target)) }, realServices(page))
}
