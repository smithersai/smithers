/**
 * The sixth brake, driven through the branch that owns it.
 *
 * `Frame.judgeCompletion` is the seam: it is where the five deterministic
 * brakes are ordered, where the caps are spent, and where the claim brake was
 * added last. Driving the module alone would prove the decision rule and
 * nothing about the precedence, the cap, or the no-op, which are the three
 * things a brake wired into an ordered list can get wrong.
 *
 * Nothing here reaches a network: every evaluation is answered by
 * `Evaluator.layerScripted`, and the cases about a transport that cannot
 * answer bind `Evaluator.layerUnavailable()` or script a failure.
 *
 * The rule the cases pin: the brake never falls back and it never goes quiet.
 * A completion nothing could judge fails the turn as `completion_unjudged`
 * naming the reason, and a claim the record does not support fails it as
 * `claim_unproven` once the run has had its frame to prove it — both the way
 * `read_only_cap` fails a turn, rather than standing.
 */
import { ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as CellTurn from "../src/CellTurn.ts"
import * as CompletionClaim from "../src/CompletionClaim.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as Frame from "../src/internal/frame.ts"

const task = "Make AdminSite.catch_all_view() preserve the query string on an APPEND_SLASH redirect."
const claim = "Updated AdminSite.catch_all_view() to preserve query strings."

const window = ContextWindow.make({
  modelId: "test-model",
  segments: [
    {
      kind: "instructions",
      zone: "prefix",
      content: [ModelRequest.SystemPart.make({ text: `The task for this run:\n\n${task}` })]
    }
  ]
})

const base = CellTurn.make({
  session: "session-1",
  seat: "anthropic:test-model",
  modelParams: ModelRequest.GenerationParams.make(),
  layers: [],
  capabilityEnvelope: [],
  placement: Option.none(),
  contextWindow: window,
  maxFrames: 10
})

const tree = (digest: string) => Option.some(new EngineLike.Observation({ digest, paths: 3, complete: true }))

const call = (changes: Partial<Frame.ObservedCall> = {}): Frame.ObservedCall => ({
  flow: "bash",
  ok: true,
  summary: "",
  ordinal: 1,
  mutates: false,
  signature: "pytest tests",
  subject: "pytest tests",
  at: undefined,
  input: { command: "pytest tests" },
  value: { exitCode: 0, stdout: "148 passed" },
  message: undefined,
  invalidProbe: undefined,
  failing: false,
  passing: true,
  ...changes
})

/**
 * One completion judged, over a run whose tree moved and whose calls give the
 * deterministic five nothing to name — so whatever fires here is the sixth.
 */
const judge = (options: {
  readonly layer?: Layer.Layer<Evaluator.Evaluator>
  readonly changes?: Frame.StateChanges
  readonly calls?: ReadonlyArray<Frame.ObservedCall>
  readonly closed?: string
} = {}) => {
  const state = new CellTurn.State({ ...base, openingDigest: "t0", ...options.changes })
  const judged = Frame.judgeCompletion(
    state,
    Frame.account({
      state,
      calls: options.calls ?? [],
      opened: tree("t0"),
      closed: tree(options.closed ?? "t1"),
      minted: [],
      bindings: [],
      captures: []
    }),
    state.contextWindow,
    claim
  )
  return Effect.provide(judged, options.layer ?? Evaluator.layerUnavailable())
}

/** One judgement, which must not fail. */
const settled = (options: Parameters<typeof judge>[0] = {}) => Effect.runPromise(judge(options))

/**
 * The typed failure one judgement ended in. A success here is the brake
 * falling back, which is the thing this file exists to refuse.
 */
const unjudged = async (options: Parameters<typeof judge>[0] = {}): Promise<HarnessError> => {
  const outcome = await Effect.runPromise(Effect.result(judge(options)))
  if (outcome._tag !== "Failure") throw new Error("the claim stood where nothing could judge it")
  return outcome.failure
}

/** A scripted evaluator that also records what it was asked. */
const scripted = (answers: Readonly<Record<string, Evaluator.ScriptedAnswer>>) => {
  const asked: Array<Evaluator.Request> = []
  const layer = Evaluator.layerScripted((request) => {
    asked.push(request)
    return answers
  })
  return { asked, layer }
}

const refusing = (error: Evaluator.EvaluatorError) => {
  const asked: Array<Evaluator.Request> = []
  const layer = Evaluator.layerScripted((request) => {
    asked.push(request)
    return Effect.fail(error)
  })
  return { asked, layer }
}

describe("the claim brake", () => {
  it("fails the turn on a host that binds no evaluator, naming it unconfigured", async () => {
    const error = await unjudged({ layer: Layer.empty as Layer.Layer<Evaluator.Evaluator> })

    expect(error.code).toBe("completion_unjudged")
    expect(error.message).toContain("unconfigured")
  })

  it("fails the turn when the bound evaluator has no transport behind it", async () => {
    const error = await unjudged()

    expect(error.code).toBe("completion_unjudged")
    expect(error.message).toContain("unreachable")
  })

  it("hands back a completion Jev reads as unproven, once, and spends its own cap", async () => {
    const jev = scripted({ complete: { probability: 0.1 }, overclaims: { probability: 0.4 } })
    const judged = await settled({ layer: jev.layer })

    expect(judged.demand?.event).toMatchObject({
      _tag: "claim-demanded",
      complete: 0.1,
      overclaims: 0.4,
      demanded: true,
      nextFrame: 1
    })
    expect(judged.demand?.spent).toEqual({ claimDemands: 1 })
    // The demand is the event, so it is journaled once and not twice.
    expect(judged.observed).toBeUndefined()
    // The prose names what is missing, asks for the working, and quotes no
    // probability: a score in front of a model is a score to negotiate. It
    // also re-quotes no task, so `Transcript` rebuilds it from the event.
    expect(judged.demand?.note).toContain("state the working")
    expect(judged.demand?.note).not.toContain("0.1")
    expect(judged.demand?.note).not.toContain(task)
    expect(jev.asked).toHaveLength(1)
  })

  it("journals the reading of a claim it lets through, and demands nothing", async () => {
    const jev = scripted({ complete: { probability: 0.9 }, overclaims: { probability: 0.2 } })
    const judged = await settled({ layer: jev.layer })

    expect(judged.demand).toBeUndefined()
    expect(judged.observed).toMatchObject({
      _tag: "claim-demanded",
      complete: 0.9,
      overclaims: 0.2,
      demanded: false
    })
  })

  it("hands back a claim that asserts more than the evidence shows, however complete it looks", async () => {
    const jev = scripted({ complete: { probability: 0.5 }, overclaims: { probability: 0.85 } })
    const judged = await settled({ layer: jev.layer })

    expect(judged.demand?.event).toMatchObject({ _tag: "claim-demanded", demanded: true })
  })

  it("does not keep the answer it takes away, so the budget cannot hand it back", async () => {
    const jev = scripted({ complete: { probability: 0.1 }, overclaims: { probability: 0.4 } })
    const judged = await settled({ layer: jev.layer })

    // The five measured demands keep the bounced answer for the budget notice;
    // this one read the sentence and refused it. See `CompletionDemand.keeps`.
    expect(judged.demand?.keeps).toBe(false)
  })

  it("reads the claim again once the cap is spent, and ends the run rather than letting it stand", async () => {
    const jev = scripted({ complete: { probability: 0.1 }, overclaims: { probability: 0.9 } })
    const judged = await settled({ layer: jev.layer, changes: { claimCap: 1, claimDemands: 1 } })

    // The cap is the frames the run is given, not the completions that are
    // read: a spent cap used to mean the second claim stood unread.
    expect(jev.asked).toHaveLength(1)
    expect(judged.demand).toBeUndefined()
    expect(judged.observed).toMatchObject({ _tag: "claim-demanded", demanded: false })
    expect(judged.unproven?.code).toBe("claim_unproven")
    expect(judged.unproven?.message).toContain("overclaimed")
    expect(judged.unproven?.message).toContain("came back still unproven")
    // Both probabilities are in the failure, so a wave is graded from the runs
    // it ended as well as from the readings it journaled.
    expect(judged.unproven?.message).toContain("complete 0.10")
    expect(judged.unproven?.message).toContain("overclaims 0.90")
  })

  it("lets a claim the run went and proved stand, cap spent or not", async () => {
    const jev = scripted({ complete: { probability: 0.95 }, overclaims: { probability: 0.02 } })
    const judged = await settled({ layer: jev.layer, changes: { claimCap: 1, claimDemands: 1 } })

    expect(judged.unproven).toBeUndefined()
    expect(judged.demand).toBeUndefined()
    expect(judged.observed).toMatchObject({ _tag: "claim-demanded", demanded: false })
  })

  it("ends the run when there is no frame to hand the claim back to, and says so", async () => {
    const jev = scripted({ complete: { probability: 0.1 }, overclaims: { probability: 0.9 } })
    // The last frame of the budget: nothing can be demanded here, and standing
    // would make an unsupported sentence the run's answer.
    const judged = await settled({ layer: jev.layer, changes: { frame: 9 } })

    expect(judged.demand).toBeUndefined()
    expect(judged.unproven?.code).toBe("claim_unproven")
    expect(judged.unproven?.message).toContain("no frame left to hand it back to")
  })

  it("gives a run three frames to prove a claim by default, and no more", () => {
    // One was too few on a real seat: this seat claims a fix before making the
    // edit, and a run bounced once then killed had the bug still in the file.
    expect(CellTurn.defaultClaimDemands).toBe(3)
    expect(new CellTurn.State({ ...base, openingDigest: "t0" }).claimCap).toBe(3)
  })

  it("reads nothing at all when the cap disarms it", async () => {
    const jev = scripted({ complete: { probability: 0.1 }, overclaims: { probability: 0.9 } })
    const judged = await settled({ layer: jev.layer, changes: { claimCap: 0 } })

    expect(jev.asked).toEqual([])
    expect(judged.demand).toBeUndefined()
    expect(judged.observed).toBeUndefined()
    expect(judged.unproven).toBeUndefined()
  })

  it("fails the turn when the evaluator refuses, times out, or is unreachable, naming which", async () => {
    for (const code of ["refused", "timeout", "unreachable", "empty", "invalid_answer"] as const) {
      const jev = refusing(new Evaluator.EvaluatorError({ code, message: `scripted ${code}` }))
      const error = await unjudged({ layer: jev.layer })

      expect(error.code, code).toBe("completion_unjudged")
      expect(error.message, code).toContain(code)
      // The transport's own words survive into the journal line.
      expect(error.message, code).toContain(`scripted ${code}`)
      expect(jev.asked, code).toHaveLength(1)
    }
  })

  it("carries the transport's error as the cause, so nothing is laundered", async () => {
    const failure = new Evaluator.EvaluatorError({ code: "refused", status: 503, message: "gateway down" })
    const error = await unjudged({ layer: refusing(failure).layer })

    expect((error.cause as Record<string, unknown> | undefined)?.["code"]).toBe("refused")
  })

  it("is never consulted when a deterministic brake already named something", async () => {
    const jev = scripted({ complete: { probability: 0.1 }, overclaims: { probability: 0.9 } })
    // The tree the run was handed is the tree it is completing on.
    const judged = await settled({ layer: jev.layer, closed: "t0" })

    expect(judged.demand?.event._tag).toBe("unmoved-demanded")
    expect(judged.demand?.spent).toEqual({ unmovedDemands: 1 })
    expect(jev.asked).toEqual([])
  })

  it("sends the task, the claim, the tree fact and the last check, and no ledger", async () => {
    const jev = scripted({ complete: { probability: 0.9 }, overclaims: { probability: 0.1 } })
    await settled({
      layer: jev.layer,
      calls: [
        call({ ordinal: 1, input: { command: "grep -rn catch_all_view" }, value: { matches: 2 } }),
        call({
          ordinal: 2,
          input: { command: "pytest tests/admin_views" },
          value: { exitCode: 0, stdout: "148 passed" }
        })
      ]
    })

    const state = jev.asked[0]?.state as Record<string, unknown>
    expect(state["task"]).toContain(task)
    expect(state["claim"]).toBe(claim)
    expect(state["treeMoved"]).toBe(true)
    expect(state["lastCheck"]).toEqual({
      command: "{\"command\":\"pytest tests/admin_views\"}",
      exitCode: 0,
      output: "{\"exitCode\":0,\"stdout\":\"148 passed\"}"
    })
    // Every question the classifier declares, and no ledger, transcript or
    // call history under any name.
    expect(Object.keys(state).sort()).toEqual(["claim", "lastCheck", "task", "treeMoved"])
    expect(Object.keys(jev.asked[0]?.questions ?? {}).sort()).toEqual(["complete", "overclaims"])
  })

  it("reads the task off the instructions text and off nothing else", async () => {
    const jev = scripted({ complete: { probability: 0.9 }, overclaims: { probability: 0.1 } })
    const mixed = ContextWindow.make({
      modelId: "test-model",
      segments: [
        // Not the task: the cell contract and the flow catalog land here.
        { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
        {
          kind: "instructions",
          zone: "prefix",
          // A part that carries no text at all, which an instructions segment
          // may hold and which teaches the brake nothing.
          content: [ModelRequest.Message.user("hello"), ModelRequest.SystemPart.make({ text: `The task: ${task}` })]
        },
        // Not the task either: the transcript is where the model's own words
        // are, and a claim judged against them would be judged against itself.
        { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }
      ]
    })
    const state = new CellTurn.State({ ...base, contextWindow: mixed, openingDigest: "t0" })
    await Effect.runPromise(
      Effect.provide(
        Frame.judgeCompletion(
          state,
          Frame.account({
            state,
            calls: [],
            opened: tree("t0"),
            closed: tree("t1"),
            minted: [],
            bindings: [],
            captures: []
          }),
          mixed,
          claim
        ),
        jev.layer
      )
    )

    expect((jev.asked[0]?.state as Record<string, unknown>)["task"]).toBe(`The task: ${task}`)
  })

  it("quotes the newest check that reported an exit status, past a write and a failure", async () => {
    const jev = scripted({ complete: { probability: 0.9 }, overclaims: { probability: 0.1 } })
    await settled({
      layer: jev.layer,
      calls: [
        call({
          ordinal: 1,
          input: { command: "check a.py" },
          value: { exitCode: 1, stdout: "2 failed" },
          failing: true,
          passing: false
        }),
        // A write is not a reading of the tree, and a call that failed
        // observed nothing; neither can be the check the claim rests on.
        call({ ordinal: 2, mutates: true, flow: "edit", input: { path: "a.py" }, value: { exitCode: 0 } }),
        call({ ordinal: 3, ok: false, input: { command: "check a.py" }, value: { exitCode: 0 } })
      ]
    })

    expect((jev.asked[0]?.state as Record<string, unknown>)["lastCheck"]).toEqual({
      command: "{\"command\":\"check a.py\"}",
      exitCode: 1,
      output: "{\"exitCode\":1,\"stdout\":\"2 failed\"}"
    })
  })

  it("omits the last check when the completing frame reported no exit status", async () => {
    const jev = scripted({ complete: { probability: 0.9 }, overclaims: { probability: 0.1 } })
    await settled({
      layer: jev.layer,
      calls: [call({ input: { path: "admin.py" }, value: { text: "..." }, failing: false, passing: false })]
    })

    expect(Object.keys(jev.asked[0]?.state as Record<string, unknown>).sort()).toEqual([
      "claim",
      "task",
      "treeMoved"
    ])
  })
})

describe("the decision rule", () => {
  it("demands only at the two strict thresholds", () => {
    expect(CompletionClaim.find({ complete: CompletionClaim.disprovenAt, overclaims: 0 })).toEqual({
      complete: CompletionClaim.disprovenAt,
      overclaims: 0
    })
    expect(CompletionClaim.find({ complete: CompletionClaim.disprovenAt + 0.01, overclaims: 0 })).toBeUndefined()
    expect(CompletionClaim.find({ complete: 1, overclaims: CompletionClaim.overclaimedAt })).toEqual({
      complete: 1,
      overclaims: CompletionClaim.overclaimedAt
    })
    expect(CompletionClaim.find({ complete: 1, overclaims: CompletionClaim.overclaimedAt - 0.01 })).toBeUndefined()
  })

  it("keeps the thresholds strict, because a false pass is still guarded and a false demand is not", () => {
    expect(CompletionClaim.disprovenAt).toBeLessThan(0.5)
    expect(CompletionClaim.overclaimedAt).toBeGreaterThan(0.5)
  })
})

describe("the evidence the brake sends", () => {
  it("keeps the newest bytes of a long output and says how many it dropped", () => {
    const clipped = CompletionClaim.newest("head".padEnd(CompletionClaim.outputBytes + 64, "x") + "TAIL")

    expect(clipped.endsWith("TAIL")).toBe(true)
    expect(clipped).toContain("elided")
    expect(clipped.startsWith("head")).toBe(false)
  })

  it("leaves an output inside the bound exactly as it was", () => {
    expect(CompletionClaim.newest("148 passed")).toBe("148 passed")
  })
})
