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
        "vacuous-verification-observed",
        new AgentEvent.VacuousVerificationObserved({
          eventType: "flows.harness.vacuous-verification-observed.v1",
          flow: "bash",
          check: "{\"command\":\"run the whole check\"}",
          signature: "e3b0c44298fc1c14",
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
            signature: "e3b0c44298fc1c14",
            nextFrame: 15
          }
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
          payload: { flowName: "notes/save", input: { text: "Remember this." } }
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
      payload: { flowName: "read", outcome: "success", message: undefined, value: small }
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
        transition: new Cell.Continue({ context: [], state: null })
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
