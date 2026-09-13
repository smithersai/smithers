/*
 * Saved runs from the pre-live tutorial retain working read/trace doors.
 * New tutorial execution is covered by controller/liveTutorial.test.ts. Pinned here because each of these
 * shipped broken once: Start clicked twice toasted "no longer available",
 * Transcript sent the practice key to the gateway and got the relay's
 * envelope refusal back, and the trace's own chips were cloud-only doors.
 */
import { describe, expect, test } from "bun:test"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { json, memoryStorage, silentAgent, unavailableRepositories } from "./TestFixtures"
import { namesPractice, PRACTICE_CARD, PRACTICE_REPO, PRACTICE_RUN_ID, practiceJournal, practiceTranscript } from "./practice/PracticeRepository"

const createAppController = scopedControllers()
const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

/** Every request the controller makes, and a refusal for each: the practice repository must need none. */
const services = () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const value: AppServices = {
    workflowPollMs: 1,
    toastDebounceMs: 0,
    toastAutoDismissMs: 10_000,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const absolute = new URL(url, "https://app.test")
      if (absolute.pathname.endsWith("/contents/.smithers/factory.json")) return json(404, { status: "error", message: "no projection" })
      calls.push({ path: absolute.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
      return json(400, { ok: false, error: { message: "Body must be { repo, procedure, payload? }." } })
    }
  }
  return { services: value, calls }
}

const said = (outcome: { status: string; value?: string; error?: string }): string =>
  outcome.status === "failed" ? (outcome.error ?? "") : (outcome.value ?? "")

/** The replay lands at once under reduced motion; the tests never wait on its ten-second presentation. */
const reducedMotion = () => {
  const previous = (globalThis as { matchMedia?: unknown }).matchMedia
  ;(globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({ matches: query.includes("reduce"), media: query })
  return () => { (globalThis as { matchMedia?: unknown }).matchMedia = previous }
}

const planned = async () => {
  const store = await webStore()
  const double = services()
  const controller = createAppController(store, unavailableRepositories, silentAgent, double.services)
  // A saved pre-live tutorial run remains readable after upgrading.
  await store.dispatch({ type: "card.upsert", actor: "system", card: {
    id: PRACTICE_CARD.run, kind: "run-trace", title: "Saved example run", status: "active", createdAt: 1, ordinal: store.nextOrdinal(),
    payload: { repo: PRACTICE_REPO, runId: PRACTICE_RUN_ID, workflow: "tutorial-change", kind: "change", phase: "completed",
      steps: practiceJournal.steps.map(step => step.text), result: practiceJournal.result, lastSeq: practiceJournal.events.length,
      events: practiceJournal.events, input: { practice: true, tutorialScope: { repoKey: PRACTICE_REPO, playthrough: 0 } } }
  } }).isPersisted.promise
  return { store, controller, double }
}

describe("the practice run's reads", () => {
  test("runs.logs shows the bundled transcript on the run card, signed out, with no gateway request", async () => {
    const restore = reducedMotion()
    try {
      const { store, controller, double } = await planned()
      /* The card's own Transcript button: the run id and the source card, never the practice key. */
      const shown = await controller.commands.run("runs.logs", `sourceCard=${PRACTICE_CARD.run} ${PRACTICE_RUN_ID}`)
      expect(shown.status).toBe("executed")
      expect(said(shown)).toContain(`transcript run=${PRACTICE_RUN_ID}`)
      const card = store.collections.cards.get(PRACTICE_CARD.run)
      expect(card?.kind === "run-trace" && card.payload.facet).toBe("transcript")
      expect(card?.kind === "run-trace" && card.payload.follow).toBe(false)
      const rows = card?.kind === "run-trace" ? card.payload.transcriptRows ?? [] : []
      expect(rows.length).toBe(practiceJournal.events.length)
      expect(rows[0]).toEqual({ sequence: 1, turn: 1, at: practiceJournal.events[0]!.occurredAt, kind: "agent.turn-opened", text: "Turn 1 opened." })
      expect(rows.at(-1)?.text).toBe(practiceJournal.result)
      expect(double.calls).toEqual([])

      const back = await controller.commands.run("runs.steps", `sourceCard=${PRACTICE_CARD.run} ${PRACTICE_RUN_ID}`)
      expect(back.status).toBe("executed")
      const view = await controller.commands.run("runs.trace.view", `sourceCard=${PRACTICE_CARD.run} ${PRACTICE_RUN_ID} timeline`)
      expect(view.status).toBe("executed")
      const filtered = await controller.commands.run("runs.trace.filter", `sourceCard=${PRACTICE_CARD.run} ${PRACTICE_RUN_ID} failed`)
      expect(filtered.status).toBe("executed")
      const live = await controller.commands.run("runs.trace.live", `sourceCard=${PRACTICE_CARD.run} ${PRACTICE_RUN_ID}`)
      expect(live.status).toBe("executed")
      const after = store.collections.cards.get(PRACTICE_CARD.run)
      expect(after?.kind === "run-trace" && after.payload.facet).toBe("steps")
      expect(after?.kind === "run-trace" && after.payload.traceView).toBe("timeline")
      expect(after?.kind === "run-trace" && after.payload.filter).toBe("failed")
      expect(double.calls).toEqual([])
    } finally {
      restore()
    }
  })

  test("the practice run is named by its key, its run id, or its cards; the transcript is the journal in order", () => {
    expect(namesPractice(PRACTICE_REPO)).toBe(true)
    expect(namesPractice(`sourceCard=${PRACTICE_CARD.run} ${PRACTICE_RUN_ID}`)).toBe(true)
    expect(namesPractice(`sourceCard=${PRACTICE_CARD.plan} ${PRACTICE_CARD.plan}`)).toBe(true)
    expect(namesPractice("sourceCard=live-tutorial-research observed-run")).toBe(true)
    expect(namesPractice(`sourceCard=flow-run-run-1 run-1`)).toBe(false)
    expect(namesPractice(`owner/repo ${PRACTICE_RUN_ID}x`)).toBe(false)
    const rows = practiceTranscript()
    expect(rows.map((row) => row.sequence)).toEqual(practiceJournal.events.map((event) => event.sequence))
    expect(rows.find((row) => row.kind === "agent.cell-call-settled" && row.text.includes("failure"))?.turn).toBe(1)
    expect(rows.filter((row) => row.kind === "agent.turn-opened")).toHaveLength(4)
  })
})
