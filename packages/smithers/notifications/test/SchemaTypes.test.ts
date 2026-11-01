/**
 * The reference promises that every schema export also names its decoded type.
 * These are compile-time assertions: each name below is used in type position,
 * so a schema that exports only a value fails `tsc -p tsconfig.test.json`.
 */
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Notification from "../src/Notification.vibe"
import * as SteerPayload from "../src/SteerPayload.ts"

const humanSteer: Notification.HumanSteer = {
  _tag: "human-steer",
  id: "steer",
  delivery: "steer",
  targetLineageId: "run/root",
  provenance: { sourceRunId: "s", sourceLineageId: "s/root", sourceTurn: 0, sourceActor: "human" },
  payload: { body: "ship it" }
}

const humanFollowup: Notification.HumanFollowup = { ...humanSteer, _tag: "human-followup", delivery: "queue" }

const systemEvent: Notification.SystemEvent = {
  ...humanSteer,
  _tag: "system-event",
  delivery: "queue",
  coalescingKey: "budget"
}

const message: SteerPayload.MessagePayload = { kind: "Message", body: "ship it" }
const seat: SteerPayload.SeatPayload = { kind: "Seat", seat: "reviewer" }
const thinking: SteerPayload.ThinkingPayload = { kind: "Thinking", thinking: "high" }
const tools: SteerPayload.ToolsPayload = { kind: "Tools", toolNames: ["grep"] }

describe("schema exports name their decoded type", () => {
  it("types each notification variant by its schema name", () => {
    expect([humanSteer, humanFollowup, systemEvent].map((value) => value._tag)).toEqual([
      "human-steer",
      "human-followup",
      "system-event"
    ])
  })

  it("types each steer payload variant by its schema name", () => {
    expect([message, seat, thinking, tools].map((value) => value.kind)).toEqual([
      "Message",
      "Seat",
      "Thinking",
      "Tools"
    ])
  })
})

describe("Notification.humanSteer", () => {
  it("builds a person's steer to a run's own lineage, with attribution only when given", () => {
    const payload = { kind: "Message", body: "Use tabs" }
    expect(Notification.humanSteer({ runId: "todo:a", id: "steer-1", actor: "person:ben", payload })).toEqual({
      _tag: "human-steer",
      id: "steer-1",
      delivery: "steer",
      targetLineageId: "todo:a",
      provenance: { sourceRunId: "todo:a", sourceLineageId: "todo:a", sourceTurn: 0, sourceActor: "person:ben" },
      payload
    })
    const attributed = Notification.humanSteer({
      runId: "todo:a",
      id: "steer-2",
      actor: "person:ben",
      payload,
      attribution: { login: "ben" }
    })
    expect(attributed.provenance.attribution).toEqual({ login: "ben" })
    expect(Schema.decodeUnknownSync(Notification.Notification)(attributed)).toEqual(attributed)
  })
})
