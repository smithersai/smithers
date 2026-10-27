import { ShapeSource } from "@smthrs/effect-electric"
import type { Interpreter } from "@smthrs/flow"
import { Effect } from "effect"
import { type AppOptions, type BootOptions, start } from "../boot"
import type { Question } from "../features/chat/api"
import { AuthFaults, EngineFaults, ShapeRecovery, type QuestionFault, QuestionFaults, faultyServices } from "./faults"

// The app on faulty services, for the end-to-end tests of unhappy paths (docs/rules.md, test.faults-by-injection).
// Under `alchemy dev`, main.tsx loads this module when the page's URL carries `?faults`; a production build drops that
// branch, and this module with it. The services' switches go on `window.faults`, so a test throws them with
// `page.evaluate(() => window.faults.shapes.down())`. Nothing here intercepts a request: the browser reaches ChatApi
// and Electric through the faulty services, the real ones behind switches.

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

/**
 * The shape source's switch the page opens with, from `?faults=<switch>`: `down`, `refuse` (400), `refuse-<status>`,
 * `stall` or `corrupt`. Bare `?faults`, or `?faults=session-503`, opens it healthy.
 */
export const opening = (search: string): ((switches: ShapeSource.Switches) => Effect.Effect<void>) | undefined => {
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
  const { runtime, stop } = start({ ...page, render: (...views) => { page.render(...views); rendered() } }, faultyServices(page, opening(search), new URLSearchParams(search).get("faults") === "recovery" ? 3 : 0, sessionDown(search)))
  const [shapes, questions, engine, session] = await runtime.runPromise(Effect.all([ShapeSource.Faults, QuestionFaults, EngineFaults, AuthFaults]))
  const recovery = await runtime.runPromise(Effect.service(ShapeRecovery))
  const faults: Switches = {
    shapes: {
      down: (requests) => runtime.runSync(shapes.down(requests)),
      refuse: (status, requests) => runtime.runSync(shapes.refuse(status, requests)),
      stall: (requests) => runtime.runSync(shapes.stall(requests)),
      corrupt: (requests) => runtime.runSync(shapes.corrupt(requests)),
      heal: () => runtime.runSync(shapes.heal),
      failures: () => runtime.runSync(recovery.failures),
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
