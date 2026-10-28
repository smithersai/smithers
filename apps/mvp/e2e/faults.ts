import type { Page } from "@playwright/test"
import type { ShapeSource } from "@smthrs/effect-electric"
import type { Question } from "../src/features/chat/api"
import type { Switches } from "../src/test/e2e"
import type { QuestionFault } from "../src/test/faults"
import { guard } from "./target"

// The only way an e2e test makes ChatApi or Electric fail (docs/rules.md, test.faults-by-injection): it opens the app
// on its faulty services and throws their switches (src/test/e2e.ts). Nothing intercepts a request. A page at
// `/app?faults` runs the real services behind those switches, healthy until a test throws one; `/app?faults=down`
// opens it with sync already down. Happy paths open `/app`, on the real services alone.

/**
 * The app on its faulty services, healthy, or opened with a switch already thrown: a shape switch, or `session-503`,
 * every session read, the engine worker's included, answering 503.
 */
export const faultyApp = (opening?: "down" | "refuse" | `refuse-${number}` | "stall" | "corrupt" | "session-503") => {
  // A dev build only: `requires("faults")`.
  guard("faults")
  return opening === undefined ? "/app?faults" : `/app?faults=${opening}`
}

type OnWindow = { readonly faults: Switches }

/** The switches of the app on `page`, which a test opened at `faultyApp()`. Each waits until the app has built them. */
export const faults = (page: Page) => {
  guard("faults")
  const built = async () => {
    await page.waitForFunction(() => "faults" in window, undefined, { timeout: 30_000 })
  }
  return {
    admission: {
      refuseInputs: async () => { await built(); await page.evaluate(() => (window as unknown as OnWindow).faults.admission.refuseInputs()) },
      heal: async () => { await built(); await page.evaluate(() => (window as unknown as OnWindow).faults.admission.heal()) },
    },
    shapes: {
      /** Shape requests fail on the network and never reach Electric, as when the sync service is down. */
      down: async (requests?: ShapeSource.Requests) => {
        await built()
        await page.evaluate((requests) => (window as unknown as OnWindow).faults.shapes.down(requests), requests)
      },
      /** Back to the real shape source. */
      heal: async () => {
        await built()
        await page.evaluate(() => (window as unknown as OnWindow).faults.shapes.heal())
      },
    },
    questions: {
      /** The next question fails as `fault`; every later one goes through. */
      failNext: async (fault: QuestionFault) => {
        await built()
        await page.evaluate((fault) => (window as unknown as OnWindow).faults.questions.failNext(fault), fault)
      },
      /** Every question the app asked ChatApi's client, in order, including ones a fault kept off the network. */
      asked: async (): Promise<ReadonlyArray<Question>> => {
        await built()
        return page.evaluate(() => (window as unknown as OnWindow).faults.questions.asked())
      },
    },
    session: {
      /** Back to the real session read, in the tab and its engine worker: ChatApi says who is signed in again. */
      heal: async () => {
        await built()
        await page.evaluate(() => (window as unknown as OnWindow).faults.session.heal())
      },
    },
    engine: {
      /** The named flow cannot be admitted by this tab's engine; every other flow uses the real service. */
      refuseStarts: async (flow: string) => {
        await built()
        await page.evaluate((flow) => (window as unknown as OnWindow).faults.engine.refuseStarts(flow), flow)
      },
      /** Every run this tab starts waits until released, as when its engine worker is still loading. */
      holdStarts: async () => {
        await built()
        await page.evaluate(() => (window as unknown as OnWindow).faults.engine.holdStarts())
      },
      /**
       * The end of every run of `flow` in this tab reads as the engine refusing it with `code`, as a run parked under one
       * build of the app and resumed under the next reads `plan_changed` or `payload_changed`. A page opened again is a
       * new build: healthy.
       */
      refuseResults: async (flow: string, code: "plan_changed" | "payload_changed") => {
        await built()
        await page.evaluate(({ flow, code }) => (window as unknown as OnWindow).faults.engine.refuseResults(flow, code), { flow, code })
      },
    },
  }
}
