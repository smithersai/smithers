/**
 * The four measured demands and the unmoved-tree demand, replayed over the
 * three waves they were designed against.
 *
 * The first fixture is the five journals of SWE-bench wave 9, distilled by
 * `packages/smithers/agent/harness/benchmarks/swebench/lib/narrowing-journals.mjs` to exactly what the detectors
 * read: every settled call's flow, input and outcome, what its result said
 * about its subject's exit status and about whether it ran a check at all, the
 * digest each frame closed on and whether that frame moved the tree, and the
 * digest the run opened on. Nothing here is a reconstruction: every field is
 * copied out of a `control.agent.*` event or a `workspace-open` boundary.
 *
 * Three of those runs resolved their instance. The demands must be silent on
 * all three, and this file is where that is enforced: a change to any detector
 * that starts asking something of `astropy__astropy-8707`,
 * `pydata__xarray-7393` or `sphinx-doc__sphinx-11445` has to explain itself
 * against real journals rather than against a memory of what a wave once did.
 * `astropy__astropy-8707` is the sharpest of the three — it ran a broad check
 * after its edit, was told "2 failed, 148 passed", and completed anyway, which
 * is why `UnresolvedFailure` is not a rule about failing checks.
 *
 * The two that did not resolve are the two the demands were written for.
 * `django__django-16612` completed after seven frames that made no editing call
 * of any kind, on the digest it opened on, with a sentence describing an edit;
 * its captured patch was zero bytes. `pytest-dev__pytest-6197` ran
 * `pytest -rA testing/python/collect.py` after its final edit, was told "2
 * failed, 72 passed", ran four named cases out of that same file, was told "4
 * passed", and completed on the second reading.
 *
 * The second fixture is wave 10, distilled the same way, and the fourth demand
 * — `NarrowedCheck.findOnly` — was read off it. Together the two files are
 * every completion two graded waves produced, and the whole set is replayed
 * through one driver so a detector that starts asking something new of a run
 * that resolved has to explain itself against ten real journals.
 *
 * The third fixture is the r97 full-bench wave — 45 journals, distilled by
 * `packages/smithers/agent/harness/benchmarks/swebench/lib/r97-narrow-only-journals.mjs` — and it is the file the
 * narrow-only demand's precision was measured on: five firings, of which
 * three were wrong, each answered by the identical completion re-issued with
 * a sentence saying the check carried no filter. It carries two things the
 * older fixtures predate: the task text each run was handed, because the
 * demand now reads taught terms off it, and per-call checkpoint marks,
 * because a reading pinned to `ctx.base` never enters the live ledger and a
 * replay that folded one in found narrowings the wave never saw.
 *
 * The replay drives the controller's own two phases, `Frame.account` and
 * `Frame.judgeCompletion`, over every frame of a journal, so the ledgers, the
 * digests, the stability stamp, the precedence and the caps are the ones a run
 * ships with. The loop also needs a model, a sandbox and an engine, and none of
 * those decide anything here.
 */
import { ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Option, type Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as CellTurn from "../src/CellTurn.ts"
import type * as CompletionClaim from "../src/CompletionClaim.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as FailedCall from "../src/FailedCall.ts"
import * as Frame from "../src/internal/frame.ts"
import * as UnobservedCall from "../src/internal/unobservedCall.ts"
import * as UnresolvedFailure from "../src/UnresolvedFailure.ts"
import journals from "./fixtures/completionJournals.json" with { type: "json" }
import r97 from "./fixtures/r97Journals.json" with { type: "json" }
import waveTen from "./fixtures/wave10Journals.json" with { type: "json" }

type Journal = typeof journals.journals[number]

/** One demand the replayed controller issued on a `complete` transition. */
interface Fired {
  /** The demand's journal event tag. */
  readonly demand: string
  /** Seq of the `transition-applied` event the demand was issued at. */
  readonly seq: number
  /** Seqs of the calls the demand names, where it names any. */
  readonly names: ReadonlyArray<number>
  /** The subjects the demand is about, where it is about subjects. */
  readonly targets?: ReadonlyArray<string> | undefined
}

/** How one replay is armed. Everything not named is the shipped default. */
interface Replay {
  /**
   * The task text the run was handed, which the loop puts in the prefix and
   * the narrow-only demand reads taught terms off. The two older fixtures
   * predate its capture and replay with none, which is the harsher world for
   * that demand: every excuse it grants is one these replays do without.
   */
  readonly prompt?: string
  /**
   * Whether every check is the run's declared one. These journals predate the
   * declared check (#3994), so the replay reads every check as declared by
   * default: the harshest reading of the relations a declared check carries.
   */
  readonly declared?: boolean
  /**
   * The claim brake's cap and the reading it gets back. Unset is the shipped
   * default, `CellTurn.defaultClaimDemands` of zero: no model is asked, and
   * the unmoved-tree demand, which only ever takes an unsupported reading's
   * place, is never issued.
   */
  readonly claim?: { readonly cap: number; readonly reading: CompletionClaim.Probabilities }
}

/** A complete workspace measurement of one digest. */
const tree = (digest: string) => Option.some(new EngineLike.Observation({ digest, paths: 1, complete: true }))

/**
 * Replays one run's frames through the controller until its first demand or
 * the first completion that stands.
 *
 * A run ends on a completion that stands, so later frames are not frames this
 * controller would have run. Frames after a demand answered the demand the
 * wave itself issued, so the replay stops at its own first one too.
 *
 * Two inputs the fixtures do not carry are stated here rather than invented.
 * The journals record no cell source, and `FailedCall` and `UnobservedCall`
 * read nothing else, so both caps are spent; no completing frame in the three
 * fixtures settled a failed call. The journals record each frame's closing
 * digest, and every frame's measurement covered the tree, so a frame opens on
 * the digest the frame before it closed on and the first on `openedOn`; the
 * replay checks that it finds every change the wave recorded.
 */
const replay = (journal: Journal, options: Replay = {}): ReadonlyArray<Fired> => {
  const declared = options.declared ?? true
  let state = CellTurn.make({
    session: journal.instance,
    seat: "anthropic:replay",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: [],
    capabilityEnvelope: [],
    placement: Option.none(),
    contextWindow: options.prompt === undefined
      ? ContextWindow.empty("replay")
      : ContextWindow.make({
        modelId: "replay",
        segments: [{
          kind: "instructions",
          zone: "prefix",
          content: [ModelRequest.SystemPart.make({ text: options.prompt })]
        }]
      }),
    maxFrames: journal.frames.length + 1,
    ...(options.claim === undefined ? {} : { claimCap: options.claim.cap })
  })
  state = new CellTurn.State({
    ...state,
    failedCallDemands: FailedCall.cap,
    unobservedDemands: UnobservedCall.cap
  })
  const reading = options.claim?.reading
  const seqOf = new Map<string, number>()
  let opened = journal.openedOn
  for (const frame of journal.frames) {
    const calls = frame.calls.map((call, index): Frame.ObservedCall => {
      // The r97 distiller drops an input the call never had; the loop reads one
      // as `null`.
      const input = ("input" in call ? call.input : null) as Schema.Json
      const subject = `${call.flow}:${JSON.stringify(input)}`
      // A checkpointed call ran against `ctx.base`; only the r97 fixture
      // records the mark, and none records which checkpoint.
      const at = "checkpointed" in call && call.checkpointed === true ? "base" : undefined
      const value = ("exit" in call ? { exitCode: call.exit } : {}) as Schema.Json
      const probe = "probe" in call
      seqOf.set(subject, call.seq)
      return {
        flow: call.flow,
        ok: call.ok,
        summary: "",
        ordinal: index + 1,
        mutates: call.mutates,
        remote: false,
        signature: at === undefined ? subject : `${subject}@${at}`,
        subject,
        at,
        input,
        declared,
        value,
        message: undefined,
        invalidProbe: probe ? { reason: "invalid_probe", message: "" } : undefined,
        failing: call.ok && !probe && UnresolvedFailure.failed(value),
        passing: call.ok && !probe && UnresolvedFailure.passed(value)
      }
    })
    const accounting = Frame.account({
      state,
      calls,
      opened: tree(opened),
      closed: tree(frame.digest),
      minted: [],
      bindings: [],
      captures: []
    })
    // Today's controller also counts a write that failed, which the waves'
    // controller did not, so the replay may only find more change than the
    // wave recorded, never less.
    if (frame.mutated && !accounting.mutated) {
      throw new Error(`${journal.instance} frame ${frame.seq}: the replay lost a change the wave measured`)
    }
    opened = frame.digest
    const labelled = new Map(accounting.facts.checks.map((check) => [check.label, seqOf.get(check.signature) ?? 0]))
    const seq = (label: string) => labelled.get(label) ?? 0
    if (frame.transition === "complete") {
      const judged = Effect.runSync(
        Frame.judgeCompletion(
          state,
          accounting,
          state.contextWindow,
          "done",
          reading === undefined ? undefined : () => Effect.succeed({ ...reading, latencyMs: 1 })
        ).pipe(Effect.provide(Evaluator.layerUnavailable()))
      )
      if (judged.demand === undefined) return []
      const event = judged.demand.event
      const at = frame.transitionSeq ?? 0
      switch (event._tag) {
        case "unresolved-demanded":
          return [{ demand: event._tag, seq: at, names: [seq(event.failed), seq(event.instead)] }]
        case "narrowed-demanded":
          return [{ demand: event._tag, seq: at, names: [seq(event.broader), seq(event.narrower)] }]
        case "narrow-only-demanded":
          return [{ demand: event._tag, seq: at, names: [seq(event.check)], targets: event.targets }]
        default:
          return [{ demand: event._tag, seq: at, names: [] }]
      }
    }
    state = new CellTurn.State({ ...state, ...accounting.facts, frame: state.frame + 1 })
  }
  return []
}

/** What an armed claim brake reads off a sentence the record does not support. */
const unsupported: CompletionClaim.Probabilities = { complete: 0.1, overclaims: 0.4, invented: 0.6 }
/** What it reads off one the record does support. */
const supported: CompletionClaim.Probabilities = { complete: 0.9, overclaims: 0.1, invented: 0.05 }

const journalOf = (instance: string): Journal => {
  const found = journals.journals.find((entry) => entry.instance === instance)
  if (found === undefined) throw new Error(`the wave-9 fixture is missing ${instance}`)
  return found
}

describe("the completion demands over the recorded wave", () => {
  it.each(
    journals.journals.filter((journal) =>
      journal.instance !== "django__django-16612" && journal.instance !== "pytest-dev__pytest-6197"
    )
  )("demands nothing of $instance, which resolved", (journal) => {
    expect(replay(journal)).toEqual([])
  })

  it("demands the missing change exactly once of django__django-16612", () => {
    const journal = journalOf("django__django-16612")

    // Seven frames, eleven calls — three `read`, seven `grep`, one `bash` —
    // and not one editing call. Every frame closed on the digest the run
    // opened on, and the run completed with "Updated
    // `AdminSite.catch_all_view()` to preserve query strings when
    // `APPEND_SLASH` redirects add a trailing slash."
    expect(journal.frames).toHaveLength(7)
    expect(journal.frames.every((frame) => !frame.mutated)).toBe(true)
    // An unmoved tree alone is no demand: a read-only question is answered on
    // the tree it was asked on (#2937). The tree fact takes the claim brake's
    // bounce only where that brake read the sentence as unsupported, so the
    // demand exists only for a workflow that armed the brake.
    expect(replay(journal, { claim: { cap: 1, reading: unsupported } })).toEqual([{
      demand: "unmoved-demanded",
      // `transition-applied` on the seventh frame.
      seq: 229,
      names: []
    }])
  })

  it("demands nothing of django__django-16612 under the shipped claim cap of zero", () => {
    // `CellTurn.defaultClaimDemands` is zero: no model reads the claim, and
    // nothing the four measured demands read is wrong with this run.
    expect(CellTurn.defaultClaimDemands).toBe(0)
    expect(replay(journalOf("django__django-16612"))).toEqual([])
  })

  it("lets django__django-16612 stand where the armed brake reads its claim as supported", () => {
    expect(replay(journalOf("django__django-16612"), { claim: { cap: 1, reading: supported } })).toEqual([])
  })

  it("demands nothing of pytest-dev__pytest-6197 had the run declared no check", () => {
    // The same frames with no call the run declared as its check: the broad
    // `pytest -rA` that failed is then a reading like any other, and holds
    // nothing (#3994).
    expect(replay(journalOf("pytest-dev__pytest-6197"), { declared: false })).toEqual([])
  })

  it("demands the unanswered failure exactly once of pytest-dev__pytest-6197", () => {
    const journal = journalOf("pytest-dev__pytest-6197")

    expect(journal.frames).toHaveLength(14)
    expect(replay(journal)).toEqual([{
      demand: "unresolved-demanded",
      // `transition-applied` on the fourteenth frame, which made no call at
      // all — which is why `NarrowedCheck`, whose subject is the completing
      // frame's own checks, has nothing to say about this run.
      seq: 446,
      // Seq 394: `pytest -rA testing/python/collect.py`, exit 1, "2 failed, 72
      // passed", taken over the tree the run went on to complete on. Seq 429:
      // a `git diff` of two source files joined onto four named cases out of
      // that same file, exit 0, "4 passed". The first was never run again.
      names: [394, 429]
    }])
  })

  it("reads the failing check off the wave's own exit statuses and not off its output", () => {
    // The distinction the demand rests on, stated against the bytes: both
    // instances ran a broad check after their edit and both were told two
    // things failed. Nothing in the record separates those two results, and
    // nothing may — counting failures means parsing a runner's output, which
    // would make this a rule about pytest rather than a rule about evidence.
    const failing = (instance: string) =>
      journalOf(instance).frames.flatMap((frame) =>
        frame.calls.filter((call) => "exit" in call && call.exit !== 0 && !("probe" in call))
          .map((call) => call.seq)
      )

    expect(failing("pytest-dev__pytest-6197")).toEqual([58, 394])
    expect(failing("astropy__astropy-8707")).toEqual([57, 120, 191])
  })
})

/**
 * The same four detectors, replayed over the next wave.
 *
 * Wave 10 is the first wave run with all three completion demands armed, and it
 * is where the fourth came from. Its record: astropy and sphinx resolved,
 * django completed twice over a tree it never moved and shipped an empty patch,
 * xarray never completed at all, and pytest lost the same instance for a fourth
 * consecutive wave — this time by editing correctly, running
 * `pytest -rA testing/test_collection.py -k "collect_init_tests or
 * collect_pkg_init_only"`, and completing on it. That command names the file
 * holding the one test the patch broke, the filter deselects it, and the run
 * never ran that file any other way. `NarrowedCheck.find` compares a completion
 * against the broader checks the run already took and there were none, which is
 * the hole `findOnly` closes.
 *
 * Two instances of the fixture matter beyond the one that fires. Sphinx's
 * completing frame is the shape a par round has — chmod, edit, compile, replay
 * the probe byte for byte, run two whole test files, diff — and it must be left
 * alone. Astropy's completing frame made no call at all, which is the other way
 * a run reaches `complete` with nothing for this detector to read.
 */
describe("the completion demands over the wave that armed them", () => {
  const wave10 = (instance: string): Journal => {
    const found = waveTen.journals.find((entry) => entry.instance === instance)
    if (found === undefined) throw new Error(`the wave-10 fixture is missing ${instance}`)
    return found as Journal
  }

  it.each(
    waveTen.journals.filter((journal) =>
      journal.instance !== "django__django-16612" && journal.instance !== "pytest-dev__pytest-6197"
    )
  )("demands nothing of $instance", (journal) => {
    expect(replay(journal as Journal)).toEqual([])
  })

  it("demands the missing change of django__django-16612, which shipped an empty patch, only under an armed brake", () => {
    const journal = wave10("django__django-16612")

    // Two frames and one call. The first frame completed on a seven-block reply
    // whose last block the harness of the day executed alone, against a tree
    // where the six before it had never run.
    expect(journal.frames).toHaveLength(2)
    expect(replay(journal)).toEqual([])
    expect(replay(journal, { claim: { cap: 1, reading: unsupported } })).toEqual([
      { demand: "unmoved-demanded", seq: 25, names: [] }
    ])
  })

  it("demands the unconditioned reading exactly once of pytest-dev__pytest-6197", () => {
    const journal = wave10("pytest-dev__pytest-6197")
    const fired = replay(journal)

    expect(fired).toEqual([{
      // `transition-applied` on the twelfth frame, the one that edited,
      // compiled, re-ran the reproduction, and ran the filtered check.
      demand: "narrow-only-demanded",
      seq: 416,
      // Seq 413: `pytest -rA testing/test_collection.py -k "collect_init_tests
      // or collect_pkg_init_only"`, exit 0, the last check the run ever ran.
      names: [413],
      // What the demand is about. The container root and the scratch directory
      // a single command creates are not in it: `names` does not read
      // `/testbed` as a subject, and a path no other check of the run mentions
      // is not one either.
      targets: ["/opt/miniconda3/envs/testbed/bin/python", "testing/test_collection.py"]
    }])
  })
})

/**
 * The same four detectors, replayed over the r97 full-bench wave.
 *
 * Forty-five journals, and the wave the narrow-only demand's precision was
 * measured on. It fired five times. Twice it was right: `psf__requests-1766`
 * and `psf__requests-2317` each completed on `pytest -rA test_requests.py -k
 * <phrase>`, a filtered reading of a file the run held no other reading of.
 * Three times it was wrong: `astropy__astropy-14365`, `pydata__xarray-7233`
 * and `pydata__xarray-7393` each completed on `<interpreter> -m pytest -rA
 * <whole test module>` — the exact command shape their task text prescribes,
 * with no filter of any kind — and each answered the demand by re-issuing the
 * identical completion with a sentence saying so. Three wasted full-context
 * frames, no information.
 *
 * What separates the five in the record is the phrase the run itself added.
 * Every non-target term of the three wrong completions is the task text's own
 * vocabulary (`pytest`, `-rA`, the container, `unhermetic`), the input's own
 * shape (`command`, `timeoutMs`, `120000`), or phrasing the run's other
 * checks already carry (`-m`, off `-m py_compile`); the two right ones each
 * carry `-k` and its argument, found nowhere else in the run and taught by
 * nothing. `findOnly` condition 2 is that separation, and this suite is the
 * measurement it must keep answering to.
 */
describe("the completion demands over the r97 wave", () => {
  const wave = r97.journals as ReadonlyArray<Journal & { readonly prompt: string }>
  const demanded = new Map<string, ReadonlyArray<Fired>>([
    // The two filtered completions the demand exists for, at the exact
    // `transition-applied` the wave bounced them on.
    ["psf__requests-1766", [{
      demand: "narrow-only-demanded",
      seq: 168,
      // Seq 164: `pytest -rA test_requests.py -k digest`, exit 0. `digest` is
      // vocabulary the run's own greps carry; `-k` alone is the phrase it
      // added, and one unexcused condition is enough.
      names: [164],
      targets: ["/opt/miniconda3/envs/testbed/bin/python", "test_requests.py"]
    }]],
    ["psf__requests-2317", [{
      demand: "narrow-only-demanded",
      seq: 244,
      // Seq 240: `pytest -rA test_requests.py -k unicode_method_name`, exit 0.
      names: [240],
      targets: ["/opt/miniconda3/envs/testbed/bin/python", "test_requests.py"]
    }]],
    // The demands the other three detectors issued, unchanged: nothing about
    // condition 2 may move a demand that was never narrow-only's to issue.
    ["astropy__astropy-14369", [{ demand: "unresolved-demanded", seq: 368, names: [294, 331] }]],
    ["astropy__astropy-8707", [{ demand: "narrowed-demanded", seq: 399, names: [319, 395] }]],
    ["django__django-14351", [{ demand: "unresolved-demanded", seq: 548, names: [412, 540] }]],
    ["django__django-15569", [{ demand: "unresolved-demanded", seq: 232, names: [195, 224] }]],
    ["pytest-dev__pytest-6197", [{ demand: "unresolved-demanded", seq: 365, names: [337, 361] }]],
    ["sphinx-doc__sphinx-7757", [{ demand: "narrowed-demanded", seq: 243, names: [104, 221] }]],
    ["sympy__sympy-13878", [{ demand: "unresolved-demanded", seq: 508, names: [427, 493] }]]
  ])
  // The demands today's controller issues that the wave's did not. Each run
  // edited and then ran a broad check in the same frame, was told it failed,
  // and completed on a different reading of the same subject. The wave's
  // controller stamped every check of an editing frame unstable, so it never
  // held that failure against the closing tree; `Frame.account` stamps a check
  // with no standing write after it as a reading of the tree the frame closed
  // on, so the failure stands unanswered and the demand names it.
  const positional = new Map<string, ReadonlyArray<Fired>>([
    ["django__django-13212", [{ demand: "unresolved-demanded", seq: 332, names: [232, 297] }]],
    ["django__django-13343", [{ demand: "unresolved-demanded", seq: 293, names: [229, 258] }]],
    ["matplotlib__matplotlib-24970", [{ demand: "unresolved-demanded", seq: 200, names: [151, 187] }]],
    ["sympy__sympy-18763", [{ demand: "unresolved-demanded", seq: 133, names: [100, 120] }]]
  ])
  const falsePositives = [
    "astropy__astropy-14365",
    "pydata__xarray-7233",
    "pydata__xarray-7393"
  ]

  it.each(
    wave.filter((journal) =>
      !demanded.has(journal.instance) && !positional.has(journal.instance) &&
      !falsePositives.includes(journal.instance)
    )
  )(
    "demands nothing of $instance, as the wave itself did not",
    (journal) => {
      expect(replay(journal, { prompt: journal.prompt })).toEqual([])
    }
  )

  it.each(wave.filter((journal) => positional.has(journal.instance)))(
    "demands the failure $instance ran after its edit, which the wave's frame-wide stamp never held",
    (journal) => {
      expect(replay(journal, { prompt: journal.prompt })).toEqual(positional.get(journal.instance))
    }
  )

  it.each(wave.filter((journal) => falsePositives.includes(journal.instance)))(
    "no longer bounces $instance, which ran the taught command whole",
    (journal) => {
      expect(replay(journal, { prompt: journal.prompt })).toEqual([])
    }
  )

  it.each(wave.filter((journal) => demanded.has(journal.instance)))(
    "still demands of $instance exactly what the wave demanded",
    (journal) => {
      expect(replay(journal, { prompt: journal.prompt })).toEqual(demanded.get(journal.instance))
    }
  )

  it("fires on all five again when the taught text is withheld", () => {
    // The excuse is load-bearing, in both directions: strip the task text and
    // the three wrong demands come back — `pytest` and `-rA` become phrases
    // nothing accounts for — while the two right ones never needed it.
    const bounced = wave
      .filter((journal) => replay(journal).some((fired) => fired.demand === "narrow-only-demanded"))
      .map((journal) => journal.instance)

    expect(bounced).toEqual([
      "astropy__astropy-14365",
      "psf__requests-1766",
      "psf__requests-2317",
      "pydata__xarray-7233",
      "pydata__xarray-7393"
    ])
  })
})
