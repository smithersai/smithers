/**
 * Failure control: what runs, what unwinds, and what the plan shows first.
 *
 * `@smthrs/patterns` gives every container two halves. `make` builds the
 * conservative topology (every rung, member, and compensation that could be
 * reached) so a reader sees the failure paths before anything runs. `run` is
 * the Effect that performs the value-dependent branch.
 *
 * This example releases a build: bounded checks, a quarantined flake, an
 * escalating fixer, and a saga that unwinds a half-finished deploy. Plain
 * Effect recovers a typed rejection and releases the lock even on interruption.
 */
import { Flow, Graph } from "@smthrs/flow"
import { Bounded, Escalation, type PatternError, Quarantine, Saga } from "@smthrs/patterns"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** The failure the deploy's third step raises. */
export class Rejected extends Schema.TaggedError<Rejected>()("examples/Rejected", {
  step: Schema.String
}) {}

/** A declared call that echoes its own name, so a built graph can name it. */
const call = (name: string) =>
  Flow.make(name, {
    payload: { input: Schema.Unknown },
    success: Schema.Unknown,
    body: Node.capture({ name }, () => Node.succeed({ from: name }))
  })

/** The deploy, declared. Nothing runs; this is the plan the operator reads. */
export const deployment = Saga.make({
  steps: [
    { id: "reserve", action: call("reserve"), compensation: call("release") },
    { id: "upload", action: call("upload"), compensation: call("delete") },
    { id: "activate", action: call("activate"), compensation: call("roll-back") }
  ],
  onFailure: "compensate"
})

/** The deploy plan, including the input every step receives. */
export const deploymentGraph = Graph.build(deployment, { input: { release: "v1" } })

/** Every call the declaration reaches, forward steps then compensations. */
export const declaredCalls: ReadonlyArray<string> = Graph.nodes(deploymentGraph)
  .filter((node) => node.kind === "FlowCall" && node.id !== "root")
  .map((node) => (node.draft.material.body as { readonly flow: string }).flow)

/** What the release did, in the order it did it. */
export interface Summary {
  readonly checks: Readonly<Record<string, string>>
  readonly quarantined: ReadonlyArray<string>
  readonly fixedAt: number
  readonly deploy: ReadonlyArray<string>
  readonly outcome: string
  readonly lockHeld: boolean
}

/**
 * The failures this release can end in: a pattern's own declaration or runtime
 * failure, and the deploy's typed rejection.
 */
export type ReleaseError = PatternError.PatternError | Rejected

/** Recovers a deploy rejection and releases its lock on every exit. */
export const protectRelease = <R, R2>(
  body: Effect.Effect<unknown, ReleaseError, R>,
  release: Effect.Effect<unknown, never, R2>
): Effect.Effect<string, PatternError.PatternError, R | R2> =>
  body.pipe(
    Effect.as("released"),
    Effect.catchTag("examples/Rejected", () => Effect.succeed("compensated")),
    Effect.ensuring(release)
  )

export const main = (): Effect.Effect<Summary, ReleaseError> =>
  Effect.gen(function*() {
    const trace: Array<string> = []
    let lockHeld = true
    const record = <A>(name: string, value: A): Effect.Effect<A> =>
      Effect.sync(() => {
        trace.push(name)
        return value
      })

    // Two checks at a time, the release blocker first.
    const check = (name: string) => Effect.sync(() => `${name}-clean`)
    const checks = yield* Bounded.run(
      { lint: check("lint"), types: check("types"), audit: check("audit") },
      { concurrency: 2, priorities: { audit: 9 } }
    )

    // A flaky check must not interrupt the two beside it.
    const settled = yield* Quarantine.run({
      unit: check("unit"),
      flake: Effect.fail(new Rejected({ step: "flake" })),
      e2e: check("e2e")
    }, { policy: "quarantine" })
    const quarantined = Object.keys(settled).filter((member) => Quarantine.isQuarantined(settled[member]))

    // Try the cheap fixer, then the thorough one. The ladder stops at the
    // first rung whose result does not report a failure.
    const fixed = yield* Escalation.run({ report: quarantined }, {
      rungs: [
        () => Effect.succeed({ ok: false, by: "formatter" }),
        () => Effect.succeed({ ok: true, by: "rewriter" })
      ]
    })

    // The deploy holds a lock, and the finalizer releases it on every path.
    const outcome = yield* protectRelease(
      Saga.run({ release: "v1" }, {
        steps: [
          {
            id: "reserve",
            action: () => record("reserve", "slot-7"),
            compensation: () => record("release", undefined)
          },
          {
            id: "upload",
            action: () => record("upload", "bundle-9"),
            compensation: () => record("delete", undefined)
          },
          {
            id: "activate",
            action: () =>
              Effect.flatMap(
                record("activate", undefined),
                () => Effect.fail(new Rejected({ step: "activate" }))
              ),
            compensation: () => record("roll-back", undefined)
          }
        ],
        onFailure: "compensate-and-fail"
      }),
      Effect.sync(() => {
        lockHeld = false
      })
    )

    return {
      checks,
      quarantined,
      fixedAt: fixed.level,
      deploy: trace,
      outcome,
      lockHeld
    }
  })
