import * as AgentEvent from "@smthrs/harness/AgentEvent"
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Host from "../src/host.vibe"
import * as Session from "../src/session.ts"
import { Workspace } from "../src/workspace.ts"

const setup = () => {
  let input: Host.TurnInput | undefined
  let resolve!: (outcome: Host.Outcome) => void
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-steer-")),
    judged: false,
    dispose: async () => {},
    run: (value) => {
      input = value
      return {
        done: new Promise((done) => {
          resolve = done
        }),
        cancel: () => resolve({ _tag: "cancelled" })
      }
    }
  }
  const workspace = new Workspace({ host, workerSeat: "worker:test", history: () => [], persist: () => {} })
  return { workspace, input: () => input, complete: (outcome: Host.Outcome) => resolve(outcome) }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const text = (message: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }) =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("")

describe("steering a worker", () => {
  it("refuses before the worker runs and after it settles", async () => {
    const f = setup()
    f.workspace.request({ id: "fix", title: "Fix", prompt: "Fix it." })
    expect(f.workspace.steer("fix", "also the docs")).toBe(false)
    await tick()
    f.complete({ _tag: "done", answer: "Fixed." })
    await tick()
    expect(f.workspace.steer("fix", "also the docs")).toBe(false)
    expect(f.workspace.steer("missing", "hello")).toBe(false)
  })

  it("delivers a steer at the worker's next cell boundary and shows it in the worker's transcript", async () => {
    const f = setup()
    f.workspace.request({ id: "fix", title: "Fix", prompt: "Fix it." })
    await tick()
    expect(f.workspace.steer("fix", "also the docs")).toBe(true)
    const items = f.workspace.transcript("fix").items
    expect(items.at(-1)).toMatchObject({ kind: "user", text: "also the docs", queued: true })
    const source = f.input()?.steering
    expect(source).toBeDefined()
    const drain = Effect.runSync(source!.drain({ boundary: "cell-1", wouldIdle: false }))
    expect(drain.inserts.map(text)).toEqual(["also the docs"])
    const file = f.workspace.snapshot().tabs[0]!.file
    expect(Session.load(file).some((record) => record.type === "user" && record.text === "also the docs")).toBe(true)
    f.workspace.dispose()
  })

  it("records actual delivery and preserves later undelivered text through completion and replay", async () => {
    const f = setup()
    try {
      f.workspace.request({ id: "fix", title: "Fix", prompt: "Fix it." })
      await tick()
      const input = f.input()!
      expect(f.workspace.steer("fix", "first steer")).toBe(true)
      expect(f.workspace.steer("fix", "second steer")).toBe(true)
      const users = () =>
        f.workspace.transcript("fix").items.flatMap((item) =>
          item.kind === "user" ? [{ text: item.text, queued: item.queued }] : []
        )
      expect(users()).toMatchObject([
        { text: "Fix it.", queued: undefined },
        { text: "first steer", queued: true },
        { text: "second steer", queued: true }
      ])
      const drained = Effect.runSync(input.steering!.drain({ boundary: "cell-1", wouldIdle: false }))
      expect(drained.inserts.map(text)).toEqual(["first steer", "second steer"])
      // Draining alone is not the persisted host notification.
      expect(users().filter((item) => item.queued)).toHaveLength(2)
      input.onEvent(
        new AgentEvent.SteeringDrained({
          eventType: "flows.harness.steering-drained.v1",
          messages: drained.inserts
        })
      )
      expect(users().filter((item) => item.queued)).toHaveLength(0)
      const empty = Effect.runSync(input.steering!.drain({ boundary: "cell-2", wouldIdle: false }))
      expect(empty.inserts).toEqual([])
      expect(f.workspace.steer("fix", "late undelivered steer")).toBe(true)
      input.onEvent(
        new AgentEvent.SteeringDrained({
          eventType: "flows.harness.steering-drained.v1",
          messages: empty.inserts
        })
      )
      const expected = [
        { text: "Fix it.", queued: undefined },
        { text: "first steer", queued: false },
        { text: "second steer", queued: false },
        { text: "late undelivered steer", queued: true }
      ]
      expect(users()).toMatchObject(expected)
      f.complete({ _tag: "done", answer: "Fixed." })
      await tick()
      expect(users()).toMatchObject(expected)
      expect(f.workspace.transcript("fix").items.at(-1)).toMatchObject({
        kind: "note",
        text: "Not delivered: late undelivered steer"
      })
      const records = Session.load(f.workspace.snapshot().tabs[0]!.file)
      expect(records.filter((record) => record.type === "user")).toHaveLength(4)
      expect(records.filter((record) => record.type === "event" && record.event._tag === "steering-drained"))
        .toHaveLength(2)
      expect(
        Session.restore(records).transcript.items.flatMap((item) =>
          item.kind === "user" ? [{ text: item.text, queued: item.queued }] : []
        )
      ).toEqual(expected)
      expect(f.workspace.snapshot().tabs[0]!.status).toBe("done")
    } finally {
      f.workspace.dispose()
    }
  })
})
