/**
 * The journal shape of agent events projected by the executor.
 *
 * `AgentSession.test.ts` covers the events a live run produces. These
 * cases pin every payload field independently of the run that produced it.
 */
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as Digest from "@smthrs/core/Digest"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as Transcript from "@smthrs/harness/Transcript"
import { Redaction } from "@smthrs/journal"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Option, Result } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"

const identity = new Cell.CallIdentity({
  session: "session-1",
  frame: 2,
  cell: "sha256:cell",
  ordinal: 1,
  declaration: "sha256:declaration",
  layers: ["layer-a"]
})

describe("durable call identity", () => {
  it("joins starts and both settlement outcomes by dispatch coordinates, independent of emission order", () => {
    const first = new Cell.Call({ ...call, identity })
    const second = new Cell.Call({ ...call, identity: new Cell.CallIdentity({ ...identity, ordinal: 2 }) })
    const start = (value: Cell.Call) =>
      AgentSession.trace(
        new AgentEvent.CellCallStarted({
          eventType: "flows.harness.cell-call-started.v1",
          call: value
        })
      )!.payload as Record<string, unknown>
    const settle = (value: Cell.Call, outcome: "success" | "failure") =>
      AgentSession.trace(
        new AgentEvent.CellCallSettled({
          eventType: "flows.harness.cell-call-settled.v1",
          flowName: value.flowName,
          identity: value.identity,
          result: new Cell.CallResult({ outcome, value: null })
        })
      )!.payload as Record<string, unknown>

    const opened = [start(first), start(second)]
    const closed = [settle(second, "failure"), settle(first, "success")]
    expect(opened[0]!.callId).toMatch(/^cell-call-v1:[0-9a-f]{64}$/)
    expect(opened[0]!.callId).not.toBe(opened[1]!.callId)
    expect(closed.map((event) => event.callId)).toEqual([opened[1]!.callId, opened[0]!.callId])
    expect(start(new Cell.Call({ ...first, identity: new Cell.CallIdentity({ ...identity }) }))).toEqual(opened[0])
  })

  it("distinguishes every durable dispatch coordinate", () => {
    const original = AgentSession.callId(identity)
    // This versioned identity is a persisted wire contract, not an internal
    // hash callers may change without migrating their event readers.
    expect(original).toBe("cell-call-v1:18b4aad60dd9bbc9875dda2124e7dde13cc960181ebcb84729df8e461b1a2929")
    const changed = [
      { session: "another-session" },
      { frame: 3 },
      { cell: "another-cell" },
      { ordinal: 2 },
      { declaration: "another-declaration" },
      { layers: ["layer-b"] }
    ]
    expect(
      new Set(changed.map((change) => AgentSession.callId(new Cell.CallIdentity({ ...identity, ...change })))).size
    )
      .toBe(changed.length)
    for (const change of changed) {
      expect(AgentSession.callId(new Cell.CallIdentity({ ...identity, ...change })))
        .not.toBe(original)
    }
  })

  it("keeps legacy producer dedup keys when callId is added during a resumed run", () => {
    for (const kind of ["control.agent.cell-call-started", "control.agent.cell-call-settled"]) {
      const legacy = { flowName: "write", input: {}, outcome: "success", value: "written" }
      expect(AgentSession.traceIdentity(2, 4, "cell", kind, { ...legacy, callId: AgentSession.callId(identity) }))
        .toBe(AgentSession.traceIdentity(2, 4, "cell", kind, legacy))
    }
    // This migration rule applies only to call lifecycle records.
    expect(AgentSession.traceIdentity(2, 4, "cell", "control.agent.cell-printed", { callId: "a" }))
      .not.toBe(AgentSession.traceIdentity(2, 4, "cell", "control.agent.cell-printed", { callId: "b" }))
  })
})

const call = new Cell.Call({
  flowName: "notes/save",
  input: { text: "Remember this." },
  capabilities: ["fs:write:notes/**"],
  effects: {
    reads: ["/notes/**"],
    writes: ["/notes/log.md"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  },
  placement: Option.none(),
  identity
})

const cell = Cell.source("ctx.done('done')")
const transition = new Cell.Complete({ output: "done" })
const outcome = new Cell.Settled({ transition })
const reason = new EngineLike.SuspendReason({ code: "waiting-input", message: "Needs an answer" })
const request = new Permission.PermissionRequired({
  requestId: "permission-1",
  runId: "run-1",
  capability: Capability.make("fs:write", "notes/log.md"),
  tier: "irreversible",
  meta: { flowName: "notes/save" }
})
const assistant = ModelRequest.Message.assistant([
  ModelRequest.TextPart.make({ text: "First line." }),
  ModelRequest.ToolCallPart.make({ id: "call-0", name: "cell", arguments: "{}" }),
  ModelRequest.TextPart.make({ text: "Second line." })
])

describe("trace", () => {
  it.each(
    [
      [
        "model-retried",
        new AgentEvent.ModelRetried({
          eventType: "flows.harness.model-retried.v1",
          attempt: 2,
          code: "transport",
          delayMillis: 2_137
        }),
        {
          eventType: "control.agent.model-retried",
          // The delay is journaled with the attempt: every retry of one sealed
          // step is written when that step settles, so the run's own event
          // timestamps cannot tell a backoff from an immediate re-fire, and a
          // wave report reads the schedule off this payload instead.
          payload: { attempt: 2, code: "transport", delayMillis: 2_137 }
        }
      ],
      [
        "discipline-armed",
        new AgentEvent.DisciplineArmed({
          eventType: "flows.harness.discipline-armed.v1",
          readOnlyCap: 12,
          maxFrames: 100,
          approvalChannel: false,
          modelCallMs: 300_000,
          repeatCap: 4,
          narrowingCap: 1,
          unmovedCap: 1,
          unresolvedCap: 1,
          calls: 64,
          memoryBytes: 134_217_728,
          steps: 1_000,
          timeMs: 30_000,
          callMs: 120_000,
          totalMs: 900_000
        }),
        {
          eventType: "control.agent.discipline-armed",
          payload: {
            readOnlyCap: 12,
            maxFrames: 100,
            // False says nobody can answer a park, so the loop refuses one
            // rather than leaving the run waiting on an operator who is not
            // there. It is journaled before the first frame, like every other
            // armed budget.
            approvalChannel: false,
            // The model-call budget is journaled beside the cell budgets, and
            // `control.agent.model-settled` already carries `durationMillis`
            // per call, so a report can grade every call against the ceiling
            // the run armed without re-instrumenting anything.
            modelCallMs: 300_000,
            // The convergence threshold, journaled for the same reason the
            // read cap is: a wave that records no repeat demand can then say
            // whether the control was armed and never needed, or never armed.
            repeatCap: 4,
            // The completion control, journaled for the same reason: it fires
            // at most once in a run and usually not at all, so its absence
            // from a wave says nothing unless the arming is on the record.
            narrowingCap: 1,
            // The two controls that judge what a completion is about rather
            // than how it was verified — whether the run changed anything, and
            // whether it answered the check that told it something was broken
            // — journaled for the same reason and read the same way.
            unmovedCap: 1,
            unresolvedCap: 1,
            calls: 64,
            memoryBytes: 134_217_728,
            steps: 1_000,
            timeMs: 30_000,
            callMs: 120_000,
            totalMs: 900_000
          }
        }
      ],
      [
        "cell-rejected-in-frame",
        new AgentEvent.CellRejectedInFrame({
          eventType: "flows.harness.cell-rejected-in-frame.v1",
          attempt: 2,
          code: "no_cell",
          message: "No cell was found in the response."
        }),
        {
          eventType: "control.agent.cell-rejected-in-frame",
          // A refused reply is a real model call, so the frame's re-ask is
          // spend a wave counting cost per frame must see. `attempt` is what
          // makes the ratio to the frame's settlement readable.
          payload: { attempt: 2, code: "no_cell", message: "No cell was found in the response." }
        }
      ],
      [
        "narrowed-demanded",
        new AgentEvent.NarrowedDemanded({
          eventType: "flows.harness.narrowed-demanded.v1",
          flow: "bash",
          broader: "{\"command\":\"run the whole check\"}",
          narrower: "{\"command\":\"run the whole check -select one\"}",
          broaderDigest: "tree-before",
          currentDigest: "tree-after",
          nextFrame: 19
        }),
        {
          eventType: "control.agent.narrowed-demanded",
          // Both inputs and both digests: the demand's whole justification is
          // the pair, and a grader must be able to second-guess it from the
          // journal without replaying the run.
          payload: {
            flow: "bash",
            broader: "{\"command\":\"run the whole check\"}",
            narrower: "{\"command\":\"run the whole check -select one\"}",
            broaderDigest: "tree-before",
            currentDigest: "tree-after",
            nextFrame: 19
          }
        }
      ],
      [
        "narrow-only-demanded",
        new AgentEvent.NarrowOnlyDemanded({
          eventType: "flows.harness.narrow-only-demanded.v1",
          flow: "bash",
          check: "{\"command\":\"run one case of the check\"}",
          targets: ["src/one.ts", "test/one.test.ts"],
          currentDigest: "tree-after",
          nextFrame: 21
        }),
        {
          eventType: "control.agent.narrow-only-demanded",
          // No broader input exists to pair the check against — that is what
          // separates this demand from `narrowed-demanded` — so `targets` is
          // the record of what the demand was about.
          payload: {
            flow: "bash",
            check: "{\"command\":\"run one case of the check\"}",
            targets: ["src/one.ts", "test/one.test.ts"],
            currentDigest: "tree-after",
            nextFrame: 21
          }
        }
      ],
      [
        "unmoved-demanded",
        new AgentEvent.UnmovedDemanded({
          eventType: "flows.harness.unmoved-demanded.v1",
          openedDigest: "tree-opened",
          currentDigest: "tree-opened",
          nextFrame: 7
        }),
        {
          eventType: "control.agent.unmoved-demanded",
          // Both digests, because the judgement is the comparison: one alone
          // cannot tell an unmoved tree from a measurement that never happened,
          // and the pair reconciles against the run's `mutation-observed`
          // record without replaying anything.
          payload: { openedDigest: "tree-opened", currentDigest: "tree-opened", nextFrame: 7 }
        }
      ],
      [
        "claim-demanded",
        new AgentEvent.ClaimDemanded({
          eventType: "flows.harness.claim-demanded.v1",
          complete: 0.11,
          overclaims: 0.93,
          invented: 0.94,
          latencyMs: 412,
          demanded: true,
          currentDigest: "tree-after",
          nextFrame: 12
        }),
        {
          eventType: "control.agent.claim-demanded",
          // All three probabilities and the latency, because this is the one
          // demand a grader cannot recompute: it is a model's answer, and
          // `demanded` is what separates a firing from a reading that agreed.
          // `invented` is the one that acts; the other two are journaled and
          // decide nothing. See `CompletionClaim`.
          payload: {
            complete: 0.11,
            overclaims: 0.93,
            invented: 0.94,
            latencyMs: 412,
            demanded: true,
            currentDigest: "tree-after",
            nextFrame: 12
          }
        }
      ],
      [
        "unresolved-demanded",
        new AgentEvent.UnresolvedDemanded({
          eventType: "flows.harness.unresolved-demanded.v1",
          flow: "bash",
          failed: "{\"command\":\"run the whole check\"}",
          instead: "{\"command\":\"diff it && run one case of the check\"}",
          currentDigest: "tree-after",
          nextFrame: 14
        }),
        {
          eventType: "control.agent.unresolved-demanded",
          // The failing reading and the one that displaced it, for the same
          // reason the narrowing pair travels together: either alone is
          // unremarkable and the demand is entirely about the two of them.
          payload: {
            flow: "bash",
            failed: "{\"command\":\"run the whole check\"}",
            instead: "{\"command\":\"diff it && run one case of the check\"}",
            currentDigest: "tree-after",
            nextFrame: 14
          }
        }
      ],
      [
        "sufficiency-observed",
        new AgentEvent.SufficiencyObserved({
          eventType: "flows.harness.sufficiency-observed.v1",
          flow: "bash",
          failed: "{\"command\":\"run the whole check\"}",
          passed: "{\"command\":\"run the whole check\"}",
          epoch: 3,
          nextFrame: 9
        }),
        {
          eventType: "control.agent.sufficiency-observed",
          // The only control in the set that is not a brake, and the only
          // event written for a frame that did nothing wrong. `epoch` is the
          // run's mutating-frame count when the failure was recorded, which is
          // what makes the before-and-after ordering checkable after the fact.
          payload: {
            flow: "bash",
            failed: "{\"command\":\"run the whole check\"}",
            passed: "{\"command\":\"run the whole check\"}",
            epoch: 3,
            nextFrame: 9
          }
        }
      ],
      [
        "vacuous-verification-observed",
        new AgentEvent.VacuousVerificationObserved({
          eventType: "flows.harness.vacuous-verification-observed.v1",
          flow: "bash",
          check: "{\"command\":\"run the whole check\"}",
          callDigest: "e3b0c44298fc1c14",
          nextFrame: 15
        }),
        {
          eventType: "control.agent.vacuous-verification-observed",
          // The stored input and the identity it was matched by: the whole
          // judgement is that this exact call had already been watched passing,
          // and a reader with only the text cannot tell an exact reuse from a
          // command that merely reads like one.
          payload: {
            flow: "bash",
            check: "{\"command\":\"run the whole check\"}",
            callDigest: "e3b0c44298fc1c14",
            nextFrame: 15
          }
        }
      ],
      [
        "read-only-demand-issued",
        new AgentEvent.ReadOnlyDemandIssued({
          eventType: "flows.harness.read-only-demand-issued.v1",
          streak: 12,
          cap: 12,
          nextFrame: 13
        }),
        {
          eventType: "control.agent.read-only-demand-issued",
          // The demand's issuance, kept apart from `read-only-demanded`, which
          // is the same demand's later answer: a crash between those two
          // boundaries must still leave the demand on the record.
          payload: { streak: 12, cap: 12, nextFrame: 13 }
        }
      ],
      [
        "read-only-demanded",
        new AgentEvent.ReadOnlyDemanded({
          eventType: "flows.harness.read-only-demanded.v1",
          streak: 12,
          cap: 12,
          nextFrame: 13,
          nextAction: "write"
        }),
        {
          eventType: "control.agent.read-only-demanded",
          payload: { streak: 12, cap: 12, nextFrame: 13, nextAction: "write" }
        }
      ],
      [
        "repeat-demanded",
        new AgentEvent.RepeatDemanded({
          eventType: "flows.harness.repeat-demanded.v1",
          frames: 4,
          cap: 4,
          nextFrame: 15
        }),
        {
          eventType: "control.agent.repeat-demanded",
          // Written when the demand is issued rather than when it is answered:
          // the answer is the shape of frame 15's calls, and those are already
          // journaled one at a time.
          payload: { frames: 4, cap: 4, nextFrame: 15 }
        }
      ],
      [
        "turn-opened",
        new AgentEvent.TurnOpened({
          eventType: "flows.harness.turn-opened.v1",
          seat: "anthropic:test-model",
          modelParams: ModelRequest.GenerationParams.make({ temperature: 0 }),
          activeToolNames: ["cell"],
          contextDigest: "sha256:context"
        }),
        {
          eventType: "control.agent.turn-opened",
          payload: { seat: "anthropic:test-model", contextDigest: "sha256:context" }
        }
      ],
      [
        "model-settled",
        new AgentEvent.ModelSettled({
          eventType: "flows.harness.model-settled.v1",
          message: assistant,
          usage: ModelEvent.Usage.make({ inputTokens: 12, outputTokens: 3 }),
          durationMillis: 1_250
        }),
        {
          eventType: "control.agent.model-settled",
          payload: {
            text: "First line.\nSecond line.",
            usage: { inputTokens: 12, outputTokens: 3 },
            durationMillis: 1_250
          }
        }
      ],
      [
        "cell-produced",
        new AgentEvent.CellProduced({ eventType: "flows.harness.cell-produced.v1", cell }),
        {
          eventType: "control.agent.cell-produced",
          payload: { language: cell.language, digest: cell.digest, text: cell.text }
        }
      ],
      [
        "cell-call-started",
        new AgentEvent.CellCallStarted({ eventType: "flows.harness.cell-call-started.v1", call }),
        {
          eventType: "control.agent.cell-call-started",
          payload: { callId: AgentSession.callId(identity), flowName: "notes/save", input: { text: "Remember this." } }
        }
      ],
      [
        "cell-call-settled",
        new AgentEvent.CellCallSettled({
          eventType: "flows.harness.cell-call-settled.v1",
          flowName: "notes/save",
          identity,
          result: new Cell.CallResult({ outcome: "failure", value: null, message: "The note was locked" })
        }),
        {
          eventType: "control.agent.cell-call-settled",
          payload: {
            callId: AgentSession.callId(identity),
            flowName: "notes/save",
            outcome: "failure",
            message: "The note was locked",
            value: null
          }
        }
      ],
      [
        "cell-printed",
        // The whole of the REPL mode's context channel. Journaled with the cell
        // that produced it, so a transcript projection rebuilds a resumed run's
        // window from the journal rather than by re-running anything.
        new AgentEvent.CellPrinted({
          eventType: "flows.harness.cell-printed.v1",
          cell: cell.digest,
          text: "found 2"
        }),
        { eventType: "control.agent.cell-printed", payload: { cell: cell.digest, text: "found 2" } }
      ],
      [
        "cell-settled",
        new AgentEvent.CellSettled({ eventType: "flows.harness.cell-settled.v1", cell: cell.digest, outcome }),
        { eventType: "control.agent.cell-settled", payload: { outcome } }
      ],
      ...[
        new Cell.Raised({ name: "TypeError", message: "cell threw" }),
        new Cell.Rejected({ code: "compile_failed", message: "invalid cell" })
      ].map((failure) =>
        [
          `cell-${failure._tag}`,
          new AgentEvent.CellSettled({
            eventType: "flows.harness.cell-settled.v1",
            cell: cell.digest,
            outcome: failure
          }),
          { eventType: "control.agent.cell-settled", payload: { outcome: failure } }
        ] as const
      ),
      [
        "checkpoint-minted",
        // The store's own name for the tree travels with the id, because the
        // frame that reads against a checkpoint is usually not the frame that
        // pinned it: a journal holding only the reading could not say which
        // tree it was a reading of, and a fails-before proof is that claim.
        new AgentEvent.CheckpointMinted({
          eventType: "flows.harness.checkpoint-minted.v1",
          id: "cp-3-1",
          ref: "refs/flows/checkpoints/cp-3-1",
          cell: cell.digest,
          ordinal: 1
        }),
        {
          eventType: "control.agent.checkpoint-minted",
          payload: { id: "cp-3-1", ref: "refs/flows/checkpoints/cp-3-1", cell: cell.digest, ordinal: 1 }
        }
      ],
      [
        "transition-applied",
        new AgentEvent.TransitionApplied({
          eventType: "flows.harness.transition-applied.v1",
          transition
        }),
        { eventType: "control.agent.transition-applied", payload: { transition } }
      ],
      [
        "suspended",
        new AgentEvent.Suspended({ eventType: "flows.harness.suspended.v1", reason }),
        { eventType: "control.agent.suspended", payload: { reason } }
      ],
      [
        "compaction-settled",
        new AgentEvent.CompactionSettled({
          eventType: "flows.harness.compaction-settled.v1",
          replacedPrefixDigest: "sha256:prefix",
          summary: ModelRequest.Message.assistant("Six frames of edits, summarised.")
        }),
        {
          eventType: "control.agent.compaction-settled",
          payload: { replacedPrefixDigest: "sha256:prefix" }
        }
      ],
      [
        "steering-drained",
        new AgentEvent.SteeringDrained({
          eventType: "flows.harness.steering-drained.v1",
          messages: [
            ModelRequest.Message.user("Stop rewriting the parser and fix the lockfile."),
            ModelRequest.Message.assistant("Acknowledged.")
          ]
        }),
        {
          eventType: "control.agent.steering-drained",
          // The operator's own words, which existed nowhere else in the
          // journal: the trail used to record only that some number of steers
          // had been drained. The role travels with each one because a drain
          // carries whatever the queue held.
          payload: {
            messages: [
              { role: "user", text: "Stop rewriting the parser and fix the lockfile." },
              { role: "assistant", text: "Acknowledged." }
            ]
          }
        }
      ],
      [
        "turn-closed",
        new AgentEvent.TurnClosed({
          eventType: "flows.harness.turn-closed.v1",
          stopReason: "tool-calls",
          outcome: "continue"
        }),
        {
          eventType: "control.agent.turn-closed",
          payload: { stopReason: "tool-calls", outcome: "continue" }
        }
      ],
      [
        "permission-required",
        new AgentEvent.PermissionRequired({ eventType: "flows.harness.permission-required.v1", request }),
        { eventType: "control.agent.permission-required", payload: { request } }
      ],
      [
        "aborted",
        new AgentEvent.Aborted({
          eventType: "flows.harness.aborted.v1",
          reason: "frame ceiling reached"
        }),
        {
          eventType: "control.agent.aborted",
          payload: { reason: "frame ceiling reached" }
        }
      ],
      [
        "resolved",
        new AgentEvent.Resolved({ eventType: "flows.harness.resolved.v1", message: assistant }),
        { eventType: "control.agent.resolved", payload: { text: "First line.\nSecond line." } }
      ],
      ...(["cell-settled", "transition-applied"] as const).map((tag) => {
        const transition = new Cell.Complete({ output: "x".repeat(131_072) })
        const outcome = new Cell.Settled({ transition })
        const value = transition.output
        const marker = {
          truncated: true,
          bytes: new TextEncoder().encode(value).byteLength,
          digest: Digest.digest(CanonicalJson.stringify(value))
        }
        return [
          `${tag} with oversized completion output`,
          tag === "cell-settled"
            ? new AgentEvent.CellSettled({ eventType: "flows.harness.cell-settled.v1", cell: cell.digest, outcome })
            : new AgentEvent.TransitionApplied({ eventType: "flows.harness.transition-applied.v1", transition }),
          {
            eventType: `control.agent.${tag}`,
            payload: tag === "cell-settled"
              ? { outcome: { ...outcome, transition: { ...transition, output: marker } } }
              : { transition: { ...transition, output: marker } }
          }
        ] as const
      })
    ] satisfies ReadonlyArray<readonly [string, AgentEvent.AgentEvent, unknown]>
  )(
    "projects %s with its durable payload",
    (_name, event, expected) => {
      expect(AgentSession.trace(event)).toEqual(expected)
    }
  )

  it("journals no model delta", () => {
    expect(
      AgentSession.trace(
        new AgentEvent.ModelDelta({
          eventType: "flows.harness.model-delta.v1",
          delta: { type: "text-delta", id: "text-0", text: "par" }
        })
      )
    ).toBeUndefined()
  })

  it("replaces an oversized call value with its byte count and full-value digest", () => {
    const value = "x".repeat(5 * 1024 * 1024)
    const projected = AgentSession.trace(
      new AgentEvent.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "read",
        identity,
        result: new Cell.CallResult({ outcome: "success", value })
      })
    )

    expect(projected).toEqual({
      eventType: "control.agent.cell-call-settled",
      payload: {
        callId: AgentSession.callId(identity),
        flowName: "read",
        outcome: "success",
        message: undefined,
        value: {
          truncated: true,
          bytes: new TextEncoder().encode(value).byteLength,
          digest: Digest.digest(CanonicalJson.stringify(value))
        }
      }
    })

    const small = { content: "unchanged" }
    expect(
      AgentSession.trace(
        new AgentEvent.CellCallSettled({
          eventType: "flows.harness.cell-call-settled.v1",
          flowName: "read",
          identity,
          result: new Cell.CallResult({ outcome: "success", value: small })
        })
      )
    ).toEqual({
      eventType: "control.agent.cell-call-settled",
      payload: {
        callId: AgentSession.callId(identity),
        flowName: "read",
        outcome: "success",
        message: undefined,
        value: small
      }
    })
  })

  it("replaces an oversized call input with its byte count and full-value digest", () => {
    // The record that OPENS a call is as large as the one that settles it: a
    // `write` carries the whole file in its input, so bounding only the
    // result left the durable trail unbounded on the way in.
    const text = "y".repeat(5 * 1024 * 1024)
    const input = { path: "/notes/log.md", text }
    const projected = AgentSession.trace(
      new AgentEvent.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: new Cell.Call({ ...call, flowName: "write", input })
      })
    )

    expect(projected).toEqual({
      eventType: "control.agent.cell-call-started",
      payload: {
        callId: AgentSession.callId(identity),
        flowName: "write",
        input: {
          truncated: true,
          bytes: new TextEncoder().encode(CanonicalJson.stringify(input)).byteLength,
          digest: Digest.digest(CanonicalJson.stringify(input))
        }
      }
    })
  })

  it("replaces an oversized failure message with its byte count and full-value digest", () => {
    // A failure message is free text the handler chose, and a compiler or a
    // test runner writes megabytes of it into one failed call.
    const message = "error: no such field\n".repeat(200_000)
    const projected = AgentSession.trace(
      new AgentEvent.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "test/run",
        identity,
        result: new Cell.CallResult({ outcome: "failure", value: null, message })
      })
    )

    expect(projected).toEqual({
      eventType: "control.agent.cell-call-settled",
      payload: {
        callId: AgentSession.callId(identity),
        flowName: "test/run",
        outcome: "failure",
        message: {
          truncated: true,
          bytes: new TextEncoder().encode(message).byteLength,
          digest: Digest.digest(CanonicalJson.stringify(message))
        },
        value: null
      }
    })
  })

  // The writer of these entries and the resume validator that reads them back
  // live in different packages. `trace` is typed against
  // `Transcript.ControlEventType`, so the namespace cannot be renamed on one
  // side alone: this pins the runtime half of that agreement.
  it("writes every journaled event under the namespace resume validation reads", () => {
    const events = [
      new AgentEvent.ModelRetried({
        eventType: "flows.harness.model-retried.v1",
        attempt: 1,
        code: "transport",
        delayMillis: 1
      }),
      new AgentEvent.TurnOpened({
        eventType: "flows.harness.turn-opened.v1",
        seat: "sdk:default",
        modelParams: ModelRequest.GenerationParams.make(),
        activeToolNames: [],
        contextDigest: "sha256:context"
      }),
      new AgentEvent.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition: new Cell.Continue({})
      })
    ]

    const projected = events.map((event) => AgentSession.trace(event)).filter((entry) => entry !== undefined)
    expect(projected).toHaveLength(events.length)
    for (const entry of projected) {
      expect(entry.eventType.startsWith(Transcript.controlEventPrefix)).toBe(true)
    }

    const entries = projected.map((entry, index) => ({
      seq: index + 1,
      eventType: entry.eventType,
      payload: { ...(entry.payload as Record<string, unknown>), journalVersion: Transcript.journalVersion }
    }))
    expect(Result.isSuccess(Transcript.validateJournal(entries as never))).toBe(true)
    // The same entries without the version stamp are exactly what resume must
    // refuse, which proves the filter selected them rather than skipping them.
    expect(Result.isFailure(
      Transcript.validateJournal(entries.map(({ payload: _payload, ...rest }) => ({ ...rest, payload: {} })) as never)
    )).toBe(true)
  })
})

/**
 * The migration half of the projection.
 *
 * `traceIdentity` hashes the payload, so giving an event type fields it did
 * not have changes what its identity derives to. A run journaled by the old
 * producer and resumed under the new one re-projects its whole recorded prefix
 * with the new fields, derives identities none of the recorded rows carry, and
 * `UNIQUE (run_id, source_id, source_seq)` admits every one of them: the prefix
 * is published a second time. `lateFields` is what keeps the old keys, and
 * these cases are the proof that it does — over the real projection, not over
 * the exclusion set's contents.
 */
describe("late payload fields", () => {
  const enriched = [
    new AgentEvent.CellRejectedInFrame({
      eventType: "flows.harness.cell-rejected-in-frame.v1",
      attempt: 2,
      code: "no_cell",
      message: "No cell was found in the response."
    }),
    new AgentEvent.ReadOnlyDemandIssued({
      eventType: "flows.harness.read-only-demand-issued.v1",
      streak: 12,
      cap: 12,
      nextFrame: 13
    }),
    new AgentEvent.NarrowOnlyDemanded({
      eventType: "flows.harness.narrow-only-demanded.v1",
      flow: "bash",
      check: "{\"command\":\"run one case of the check\"}",
      targets: ["src/one.ts"],
      currentDigest: "tree-after",
      nextFrame: 21
    }),
    new AgentEvent.SufficiencyObserved({
      eventType: "flows.harness.sufficiency-observed.v1",
      flow: "bash",
      failed: "{\"command\":\"run the whole check\"}",
      passed: "{\"command\":\"run the whole check\"}",
      epoch: 3,
      nextFrame: 9
    }),
    new AgentEvent.SteeringDrained({
      eventType: "flows.harness.steering-drained.v1",
      messages: [ModelRequest.Message.user("Fix the lockfile.")]
    })
  ] satisfies ReadonlyArray<AgentEvent.AgentEvent>

  /** The bytes the executor derives an identity from: the projection, JSON-normalized. */
  const material = (event: AgentEvent.AgentEvent) =>
    JSON.parse(JSON.stringify(AgentSession.trace(event)!.payload)) as Record<string, unknown>

  it("keeps a resumed old-producer prefix deduplicating across every enriched arm", () => {
    for (const event of enriched) {
      const projected = AgentSession.trace(event)!
      // The old producer wrote these five through the `default` arm: the same
      // event type, derived from `_tag`, with an empty payload. The enriched
      // arm must land on that same identity or the resumed prefix republishes.
      expect(projected.eventType).toBe(`control.agent.${event._tag}`)
      const populated = material(event)
      expect(Object.keys(populated).length).toBeGreaterThan(0)
      expect(AgentSession.traceIdentity(4, 2, cell.digest, projected.eventType, populated))
        .toBe(AgentSession.traceIdentity(4, 2, cell.digest, projected.eventType, {}))
    }
  })

  it("still separates an enriched event by where it sits", () => {
    // The exclusion is not a licence to drop the event from the sequence
    // space: two sufficiency observations at different coordinates remain two
    // identities, which is what admits the second one at all.
    const event = enriched[3]!
    const type = AgentSession.trace(event)!.eventType
    const payload = material(event)
    const base = AgentSession.traceIdentity(4, 2, cell.digest, type, payload)
    expect(AgentSession.traceIdentity(5, 2, cell.digest, type, payload)).not.toBe(base)
    expect(AgentSession.traceIdentity(4, 3, cell.digest, type, payload)).not.toBe(base)
    expect(AgentSession.traceIdentity(4, 2, "sha256:other", type, payload)).not.toBe(base)
  })

  it("excludes only the fields the table names, and only for the type it names them under", () => {
    // A field the table does not list still contributes, so the mechanism
    // cannot quietly collapse two different events onto one key.
    const observed = "control.agent.sufficiency-observed"
    expect(AgentSession.traceIdentity(4, 2, cell.digest, observed, { epoch: 3, verdict: "a" }))
      .not.toBe(AgentSession.traceIdentity(4, 2, cell.digest, observed, { epoch: 3, verdict: "b" }))
    // `streak` and `cap` are late on the issuance and original on the answer.
    // The table is keyed by event type, so the answer keeps hashing them.
    const answered = (streak: number) =>
      AgentSession.traceIdentity(4, 2, cell.digest, "control.agent.read-only-demanded", {
        streak,
        cap: 12,
        nextFrame: 13,
        nextAction: "write"
      })
    expect(answered(12)).not.toBe(answered(11))
  })

  it("derives an identity for an event type that names an Object.prototype key", () => {
    // The event type is read off a decoded event, so it is host data. A plain
    // object literal resolves `lateFields["constructor"]` through the
    // prototype to a function — truthy, so `??` cannot catch it — and the
    // membership test then throws on a value that was never an entry.
    for (const type of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(() => AgentSession.traceIdentity(4, 2, cell.digest, type, { streak: 3 })).not.toThrow()
    }
    // Nothing is excluded for such a type, so its payload still separates it.
    expect(AgentSession.traceIdentity(4, 2, cell.digest, "constructor", { streak: 3 }))
      .not.toBe(AgentSession.traceIdentity(4, 2, cell.digest, "constructor", { streak: 4 }))
  })

  it("reads the prose out of whatever role the drain carried", () => {
    // A drain carries whatever the queue held, and the queue admits any
    // transcript message: a tool result keeps its prose in `content` rather
    // than in a text part, and an assistant turn carries a tool call between
    // its text parts that `cell-call-started` has already journaled on its own.
    expect(
      AgentSession.trace(
        new AgentEvent.SteeringDrained({
          eventType: "flows.harness.steering-drained.v1",
          messages: [
            ModelRequest.Message.tool(
              ModelRequest.ToolResultPart.make({ toolCallId: "call-0", content: "exit 0" })
            ),
            assistant
          ]
        })
      )
    ).toEqual({
      eventType: "control.agent.steering-drained",
      payload: {
        messages: [
          { role: "tool", text: "exit 0" },
          { role: "assistant", text: "First line.\nSecond line." }
        ]
      }
    })
  })

  it("bounds one steering insert without erasing the steers around it", () => {
    // A steer is whatever an operator pasted, and the trail is a durable
    // journal row: one pasted file must not take the row, or the identity
    // hashing behind it, with it.
    const pasted = "z".repeat(5 * 1024 * 1024)
    expect(
      AgentSession.trace(
        new AgentEvent.SteeringDrained({
          eventType: "flows.harness.steering-drained.v1",
          messages: [ModelRequest.Message.user(pasted), ModelRequest.Message.user("And keep the tests green.")]
        })
      )
    ).toEqual({
      eventType: "control.agent.steering-drained",
      payload: {
        messages: [
          {
            role: "user",
            text: {
              truncated: true,
              bytes: new TextEncoder().encode(pasted).byteLength,
              digest: Digest.digest(CanonicalJson.stringify(pasted))
            }
          },
          { role: "user", text: "And keep the tests green." }
        ]
      }
    })
  })
})

/*
 * The journal is redacted on its write path, by field name. A projected
 * payload that a reader must reconcile against another row therefore has to
 * survive that pass: a field the redactor replaces is a fact the journal
 * records and can never answer.
 */
describe("what survives the journal's own redaction", () => {
  it("keeps the call digest a vacuous-verification observation is reconciled by", () => {
    const projected = AgentSession.trace(
      new AgentEvent.VacuousVerificationObserved({
        eventType: "flows.harness.vacuous-verification-observed.v1",
        flow: "bash",
        check: "{\"command\":\"run the whole check\"}",
        callDigest: "e3b0c44298fc1c14",
        nextFrame: 15
      })
    )
    // The whole judgement is that THIS call had already been watched passing.
    // Redacted, the row says a call was, and names none.
    expect(Redaction.make()(projected.payload)).toEqual({
      flow: "bash",
      check: "{\"command\":\"run the whole check\"}",
      callDigest: "e3b0c44298fc1c14",
      nextFrame: 15
    })
  })

  it("still refuses a field named after a credential, so the narrowing is this field and not the rule", () => {
    expect(Redaction.isSensitiveKey("signature")).toBe(true)
    expect(Redaction.isSensitiveKey("callDigest")).toBe(false)
  })
})
