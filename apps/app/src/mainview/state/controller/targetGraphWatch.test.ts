/*
 * The run overlay's ATTACHMENT lifecycle, at the TargetRunClient seam.
 *
 * TargetRunClient keeps a `target-run:<runId>` topic subscribed for as long as
 * any listener is registered, and re-announces `target-run.attach` for every
 * live topic after a reconnect. A listener left behind on a finished run
 * therefore makes the app re-attach to dead runs for the rest of the session,
 * and the folded state grows without bound. The overlay releases on `exit` —
 * while KEEPING the fold, so a timeline card opened after the run settled
 * still paints from it.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { TargetRunFrame } from "@smthrs/rpc/LocalApp"
import { createAppStore } from "../AppStore"
import type { TargetRunClient } from "../TargetRunClient"
import type { ControllerContext } from "./context"
import { createTargetGraphController } from "./targetGraph"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

/** A client that records what is attached, so "still listening" is observable. */
const recordingRuns = () => {
  const live = new Map<string, (frame: TargetRunFrame) => void>()
  const client: TargetRunClient = {
    attach: (runId, onFrame) => {
      live.set(runId, onFrame)
      return () => void live.delete(runId)
    },
    dispose: () => live.clear()
  }
  return {
    client,
    live,
    emit: (runId: string, frame: TargetRunFrame) => live.get(runId)?.(frame)
  }
}

const harness = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const finalizers: Array<() => void> = []
  const ctx = {
    store,
    baseUrl: "http://local.test",
    commandActor: "user" as const,
    onDispose: (finalizer: () => void) => void finalizers.push(finalizer)
  } as unknown as ControllerContext
  const runs = recordingRuns()
  const controller = createTargetGraphController(ctx, { nextOrdinal: () => 1, runs: runs.client })
  store.dispatch({
    type: "card.upsert",
    actor: "user",
    card: {
      id: "graph-force",
      kind: "graph",
      title: "force graph",
      status: "acted",
      createdAt: 0,
      ordinal: 0,
      payload: { repoId: "force", repoName: "force", status: "done" }
    }
  })
  return { store, controller, runs, dispose: () => finalizers.forEach((finalizer) => finalizer()) }
}

const NODE: TargetRunFrame = {
  type: "node",
  at: 1_000,
  node: { label: "//src:typeCheck", status: "ran", startedAt: 500, endedAt: 1_000, durationMs: 500 }
}

describe("the run overlay's attachment", () => {
  test("a started run paints the graph card and holds one attachment", async () => {
    const { store, controller, runs } = await harness()
    controller.noteRunStarted("force", "run-1", "//src:typeCheck")
    expect([...runs.live.keys()]).toEqual(["run-1"])
    runs.emit("run-1", NODE)
    const card = store.collections.cards.get("graph-force")
    if (card?.kind !== "graph") throw new Error("expected a graph card")
    expect(card.payload.runId).toBe("run-1")
    expect(card.payload.run?.nodes.map((node) => node.label)).toEqual(["//src:typeCheck"])
  })

  test("the attachment is released when the run exits", async () => {
    const { controller, runs } = await harness()
    controller.noteRunStarted("force", "run-1", "//src:typeCheck")
    runs.emit("run-1", NODE)
    expect(runs.live.size).toBe(1)
    runs.emit("run-1", { type: "exit", code: 0 })
    expect(runs.live.size).toBe(0)
  })

  test("a timeline opened after the run settled still paints from the kept fold", async () => {
    const { store, controller, runs } = await harness()
    controller.noteRunStarted("force", "run-1", "//src:typeCheck")
    runs.emit("run-1", NODE)
    runs.emit("run-1", { type: "exit", code: 0 })
    await controller.showTimeline("force", "run-1")
    const timeline = store.collections.cards.get("run-timeline-run-1")
    if (timeline?.kind !== "run-timeline") throw new Error("expected a run-timeline card")
    expect(timeline.payload.nodes.map((node) => node.label)).toEqual(["//src:typeCheck"])
    /* And it does NOT re-attach to a run that already exited. */
    expect(runs.live.size).toBe(0)
  })

  test("a run that errors before a summary settles the timeline as failed", async () => {
    const { store, controller, runs } = await harness()
    controller.noteRunStarted("force", "run-1", "//src:typeCheck")
    await controller.showTimeline("force", "run-1")
    runs.emit("run-1", { type: "error", message: "loader disappeared" })
    runs.emit("run-1", { type: "exit", code: null })
    const timeline = store.collections.cards.get("run-timeline-run-1")
    if (timeline?.kind !== "run-timeline") throw new Error("expected a run-timeline card")
    expect(timeline.payload.status).toBe("failed")
    expect(timeline.payload.error).toBe("loader disappeared")
  })

  test("disposing the controller releases every attachment it still holds", async () => {
    const { controller, runs, dispose } = await harness()
    controller.noteRunStarted("force", "run-1", "//src:typeCheck")
    expect(runs.live.size).toBe(1)
    dispose()
    expect(runs.live.size).toBe(0)
  })
})
