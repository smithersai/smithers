import { expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import { durableWriteDoors } from "../../../scripts/durable-write-doors"
import { createAppStore } from "./AppStore"
import type { ControllerContext } from "./controller/context"
import { createFailureController } from "./controller/failures"
import { latestOrdinal } from "./controller/spokenLines"
import { scopedControllers } from "./ControllerTestScope"
import { recordingAgent, unavailableRepositories } from "./TestFixtures"

/*
 * THE CLASS, ENUMERATED.
 *
 * Twice running this lane stated a safety property about EVERY door and
 * measured it at one. "A lost act is never silent" held until a reviewer drove
 * two refused presses at one door. "The failure mode is one duplicate line,
 * never silence" held until a reviewer drove two lost acts at two doors inside
 * one window. Both sentences were true where they were measured and false one
 * door over, and the report said the class was closed both times.
 *
 * So the class is driven here, from the inventory that defines it
 * (scripts/durable-write-doors.ts): every declared flow whose handler can
 * reach a durable write, found by walking the flow declarations and the write
 * sites rather than by anybody's memory. The test reads that inventory at run
 * time, so a door declared tomorrow is driven tomorrow, and a door that cannot
 * be driven is NAMED in a failure rather than skipped in silence.
 *
 * Two layers, because they answer two different questions.
 *
 *   1. REACHED. Every door is run through the seam every door shares: this
 *      browser refuses the commit that records the command itself
 *      (controller/commandIntents.ts), so the act reaches nothing for a reason
 *      that is not the person's, at a door that needs no card on screen. That
 *      is what makes the inventory's flows real lost acts and not just names.
 *
 *   2. COUNTED. Every door's name is then driven through
 *      `surfaceCommandFailure` — the one place that decides whether a lost act
 *      gets a line — in the overlap the reviewer drove: two acts admitted
 *      before either settles, one door speaking its own sentence inside both
 *      windows. Layer 1 cannot stage that overlap, because the store rolls a
 *      refused commit's whole batch back and takes the other door's line with
 *      it; this layer holds the transcript still and asks the question.
 *
 * RepositorySetupRunMode.test.tsx drives the same overlap end to end through
 * the real card, two real doors and a real refused write, which is what pins
 * the line this file dispatches to the line a real door speaks.
 */

const createAppController = scopedControllers({ wiki: true, mythicalHistory: true, pluginLibrary: true })

const STORAGE_FULL =
  "This browser has no room left for Smithers' saved data, so that change was not saved. Free space for this site in your browser settings, then make the change again."

/** A lost act as the admit seam reports one (controller/commandIntents.ts). */
const lostAct = { status: "failed", error: STORAGE_FULL, persistenceFailed: true, writeRefused: true } as const

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

/**
 * This browser's saved data, with the commit that records ONE named command
 * refused. The staged envelope carries the accepted intent row verbatim, so
 * the commit to refuse is named rather than counted: a background write that
 * lands in between cannot steal the refusal meant for a door.
 */
const flakyStorage = (): StorageApi & { refuseCommandWrites: (flow: string, times: number) => void } => {
  const data = new Map<string, string>()
  let marker: string | undefined
  let remaining = 0
  return {
    refuseCommandWrites: (flow, times) => {
      marker = JSON.stringify(`"name":"${flow}","actor":"user","source":"command"`).slice(1, -1)
      remaining = times
    },
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (key.endsWith(".staged") && remaining > 0 && marker !== undefined && value.includes(marker)) {
        remaining -= 1
        throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
      }
      data.set(key, value)
    },
    removeItem: (key) => void data.delete(key)
  }
}

const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Layer 1: every door reaches the lost-write path, through the real controller.
// ---------------------------------------------------------------------------

interface Reached {
  readonly flow: string
  /** Lines the person got for two lost acts at this door, one after the other. */
  readonly lines: number
  /** The door was registered in the command surface this controller exposes. */
  readonly registered: boolean
}

const reachEveryDoor = async (): Promise<ReadonlyArray<Reached>> => {
  const results: Array<Reached> = []
  for (const door of durableWriteDoors()) {
    const storage = flakyStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    await store.dispatch({
      type: "identity.session.loaded", actor: "system", state: "signed-in",
      login: "maintainer", allowlisted: true, admin: true, scopesPlain: null
    }).isPersisted.promise
    const controller = createAppController(store, unavailableRepositories, recordingAgent([]), {
      // No poll of its own: the only writes in this test are the acts under test.
      workflowPollMs: 100_000,
      toastDebounceMs: 0,
      fetchImpl: async () => Response.json({}, { status: 404 }),
      bootstrap: {
        apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
        capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null
      }
    })
    try {
      storage.refuseCommandWrites(door.flow, 2)
      const registered = controller.runCommand(door.flow)
      // Each act settles before the next is admitted: two acts refused inside
      // one commit are rolled back together, which is the store's business and
      // not the rule under test. The overlap is layer 2's question.
      await settle(150)
      controller.runCommand(door.flow)
      await settle(150)
      const lines = [...store.collections.messages.values()].filter(message => message.text === STORAGE_FULL).length
      results.push({ flow: door.flow, lines, registered })
    } finally {
      await controller.dispose().catch(() => {})
      await store.dispose?.().catch(() => {})
    }
  }
  return results
}

const reached = reachEveryDoor()

test("every door in the inventory can be driven through the lost-write path", async () => {
  const results = await reached
  expect(results.length).toBe(durableWriteDoors().length)
  // Named, never skipped: a door this test cannot reach is a hole in the claim.
  const undriven = results.filter(result => result.lines === 0)
    .map(result => `${result.flow}: ${result.registered ? "registered, but no lost act" : "not registered in this controller"}`)
  expect(undriven).toEqual([])
}, 600_000)

test("two lost acts at one door each get their own line, at every door", async () => {
  const results = await reached
  const wrong = results.filter(result => result.lines !== 2)
    .map(result => `${result.flow}: ${result.lines} lines for 2 lost acts`)
  expect(wrong).toEqual([])
}, 600_000)

// ---------------------------------------------------------------------------
// Layer 2: the overlap, at every door, through the code that decides it.
// ---------------------------------------------------------------------------

const surfacing = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let disposed = false
  const cleanups: Array<() => void> = []
  const ctx = {
    store,
    get disposed() { return disposed },
    onDispose: (cleanup: () => void) => { cleanups.push(cleanup) },
    toastRuns: new Map<string, number>(),
    toastDebounceMs: 0,
    toastAutoDismissMs: 0,
    commands: { find: () => undefined },
    unref: () => {}
  } as unknown as ControllerContext
  const { surfaceCommandFailure } = createFailureController(ctx)
  /*
   * A transcript that has already said something. The high-water mark of an
   * EMPTY transcript is 0 and the first line's ordinal is also 0, so an act
   * admitted into an empty transcript can never match the line that follows
   * it — it would repeat a line rather than swallow one, which is the safe
   * direction but not the case under test. A person who has lost two acts has
   * been talking to this app for a while.
   */
  await store.dispatch({ type: "message.appended", actor: "system", text: "Ready when you are." }).isPersisted.promise
  /** A door's own line, dispatched as controller/repositorySetup.ts speaks one. */
  const speakAsADoor = async (): Promise<void> => {
    await store.dispatch({ type: "message.appended", actor: "system", text: STORAGE_FULL, spoken: true }).isPersisted.promise
  }
  const said = (): number => [...store.collections.messages.values()].filter(message => message.text === STORAGE_FULL).length
  return {
    store, surfaceCommandFailure, speakAsADoor, said,
    window: () => latestOrdinal(store.collections),
    close: async () => { disposed = true; for (const cleanup of cleanups) cleanup(); await store.dispose?.().catch(() => {}) }
  }
}

/**
 * The shape R104d drove, at one pair of doors: both acts are admitted before
 * either settles, so both windows are open when the first door speaks; the
 * sentences are a closed table, so both acts carry the same one.
 */
const overlap = async (first: string, second: string): Promise<number> => {
  const t = await surfacing()
  try {
    const window = t.window()
    await t.speakAsADoor()
    t.surfaceCommandFailure(first, lostAct, window)
    t.surfaceCommandFailure(second, lostAct, window)
    return t.said()
  } finally { await t.close() }
}

test("two lost acts inside one window each get their own line, at every door", async () => {
  const wrong: Array<string> = []
  for (const door of durableWriteDoors()) {
    const lines = await overlap(door.flow, door.flow)
    if (lines !== 2) wrong.push(`${door.flow}: ${lines} lines for 2 lost acts in one window`)
  }
  expect(wrong).toEqual([])
}, 600_000)

test("two lost acts at two different doors inside one window each get their own line", async () => {
  const doors = durableWriteDoors()
  const wrong: Array<string> = []
  for (const [index, door] of doors.entries()) {
    const neighbour = doors[(index + 1) % doors.length]!
    const lines = await overlap(door.flow, neighbour.flow)
    if (lines !== 2) wrong.push(`${door.flow} then ${neighbour.flow}: ${lines} lines for 2 lost acts in one window`)
  }
  expect(wrong).toEqual([])
}, 600_000)

test("a door that already said it is still not repeated, at every door", async () => {
  const wrong: Array<string> = []
  for (const door of durableWriteDoors()) {
    const t = await surfacing()
    try {
      const window = t.window()
      await t.speakAsADoor()
      t.surfaceCommandFailure(door.flow, lostAct, window)
      if (t.said() !== 1) wrong.push(`${door.flow}: ${t.said()} lines for 1 lost act its own door already said`)
    } finally { await t.close() }
  }
  expect(wrong).toEqual([])
}, 600_000)

test("a door's sentence from before this act's window never stands in for it", async () => {
  const wrong: Array<string> = []
  for (const door of durableWriteDoors()) {
    const t = await surfacing()
    try {
      // Minutes ago, at some other door: said, settled, and nothing to do with now.
      await t.speakAsADoor()
      const window = t.window()
      t.surfaceCommandFailure(door.flow, lostAct, window)
      if (t.said() !== 2) wrong.push(`${door.flow}: ${t.said()} lines when an older line stood in the transcript`)
    } finally { await t.close() }
  }
  expect(wrong).toEqual([])
}, 600_000)
