/**
 * The steering payload as a wire: what a control plane writes into a durable
 * notification, and what a harness reads back out of one.
 */
import { describe, expect, it } from "vitest"
import type * as Notification from "../src/Notification.ts"
import * as SteerPayload from "../src/SteerPayload.ts"

describe("SteerPayload.decode", () => {
  it("reads a body-only payload as a message", () => {
    // The shape every steer had before the vocabulary widened. Payloads of it
    // are already sitting in journals, so it has to keep decoding.
    expect(SteerPayload.decode({ body: "ship it" })).toEqual({ kind: "Message", body: "ship it" })
  })

  it("reads each tagged item back as itself", () => {
    expect(SteerPayload.decode({ kind: "Message", body: "ship it" })).toEqual({
      kind: "Message",
      body: "ship it"
    })
    expect(SteerPayload.decode({ kind: "Seat", seat: "reviewer" })).toEqual({
      kind: "Seat",
      seat: "reviewer"
    })
    expect(SteerPayload.decode({ kind: "Thinking", thinking: "high" })).toEqual({
      kind: "Thinking",
      thinking: "high"
    })
    expect(SteerPayload.decode({ kind: "Tools", toolNames: ["grep", "edit"] })).toEqual({
      kind: "Tools",
      toolNames: ["grep", "edit"]
    })
  })

  it("refuses a payload it cannot classify rather than guessing", () => {
    // A notification the control plane did not write — a webhook body, a
    // system event — is not a steer item, and rendering it as one would put
    // an unrelated payload in front of the model as an instruction.
    expect(SteerPayload.decode({ status: "deploy finished" })).toBeUndefined()
    expect(SteerPayload.decode({ kind: "Seat" })).toBeUndefined()
    expect(SteerPayload.decode({ kind: "Tools", toolNames: [] })).toBeUndefined()
    expect(SteerPayload.decode({ kind: "Thinking", thinking: "enormous" })).toBeUndefined()
    expect(SteerPayload.decode("ship it")).toBeUndefined()
    expect(SteerPayload.decode(null)).toBeUndefined()
  })

  it("reads the item out of a record that carries more than the item", () => {
    // A control plane stores the steer inside an envelope — who asked, when,
    // which run — and the harness only wants the part that changes the turn.
    expect(
      SteerPayload.decode({
        messageId: "steer-1",
        runId: "run-1",
        kind: "Seat",
        seat: "reviewer",
        createdAt: 1
      })
    ).toEqual({ kind: "Seat", seat: "reviewer" })
  })

  it("round-trips every item through the JSON a journal stores", () => {
    const items: ReadonlyArray<SteerPayload.SteerPayload> = [
      { kind: "Message", body: "ship it" },
      { kind: "Seat", seat: "reviewer" },
      { kind: "Thinking", thinking: "minimal" },
      { kind: "Tools", toolNames: ["grep"] }
    ]
    for (const item of items) {
      expect(SteerPayload.decode(JSON.parse(JSON.stringify(item)))).toEqual(item)
    }
  })
})

describe("SteerPayload.encode", () => {
  it("writes every item with its kind, including a message", () => {
    // The body-only form is read for compatibility and never written: a
    // payload written today tells its reader what it is.
    expect(SteerPayload.encode({ kind: "Message", body: "ship it" })).toEqual({
      kind: "Message",
      body: "ship it"
    })
    expect(SteerPayload.encode({ kind: "Tools", toolNames: ["grep"] })).toEqual({
      kind: "Tools",
      toolNames: ["grep"]
    })
  })

  it("shares no mutable structure with the item it was given", () => {
    // The control plane hands this record to an admission that serializes it
    // later, so an array still aliased to the caller would change what is
    // durably journaled after the call returned.
    const toolNames: [string, ...Array<string>] = ["grep"]
    const encoded = SteerPayload.encode({ kind: "Tools", toolNames })
    toolNames.push("write")

    expect(encoded).toEqual({ kind: "Tools", toolNames: ["grep"] })
  })

  it("populates a notification payload without an assertion", () => {
    // The payload field is typed as JSON, and `encode` exists to fill it. This
    // is a compile-time check under `tsc -p tsconfig.test.json`: a result
    // typed as a record of `unknown` is not JSON, so every admission had to
    // cast around it, and a cast accepts a payload that is not JSON too.
    const item: SteerPayload.SteerPayload = { kind: "Tools", toolNames: ["grep"] }
    const notification: Notification.HumanSteer = {
      _tag: "human-steer",
      id: "steer-1",
      delivery: "steer",
      targetLineageId: "run/root",
      provenance: { sourceRunId: "run", sourceLineageId: "run/root", sourceTurn: 0, sourceActor: "human:will" },
      payload: SteerPayload.encode(item)
    }

    expect(SteerPayload.decode(notification.payload)).toEqual(item)
  })
})
