import type { Effect } from "effect"
import type * as Command from "../src/Command.vibe"
import type * as FlowInvoker from "../src/FlowInvoker.vibe"
import type { FsError } from "../src/FsError.vibe"
import type * as Route from "../src/Route.vibe"

declare module "../src/Route.vibe" {
  interface Manifest {
    readonly "typed/scalar": { readonly input: number; readonly output: number }
    readonly "typed/review": {
      readonly input: { readonly title: string }
      readonly output: { readonly accepted: boolean }
    }
    // Schema.DateFromString: the manifest declares the decoded Schema.Type
    // members, never the encoded Schema.Encoded strings.
    readonly "typed/date": { readonly input: Date; readonly output: Date }
  }
}

declare const surface: Command.CommandSurface

const _call0 = surface.call("typed/review", { title: "review" })
const input: Route.Input<"typed/review"> = { title: "review" }
const output: Route.Output<"typed/review"> = { accepted: true }
void input
void output

// @ts-expect-error unknown route names are rejected once a manifest is installed
const _call1 = surface.call("typed/typo", { title: "review" })
// @ts-expect-error route-specific input is checked
const _call2 = surface.call("typed/review", { title: 1 })

const scalar: Effect.Effect<number, FsError, FlowInvoker.FlowInvoker> = surface.call("typed/scalar", 42)
void scalar
// @ts-expect-error encoded strings are not decoded numeric input
const _call3 = surface.call("typed/scalar", "42")

const when: Route.Input<"typed/date"> = new Date("2026-01-01T00:00:00.000Z")
const at: Route.Output<"typed/date"> = new Date("2026-01-01T00:00:00.000Z")
void when
void at
const dated: Effect.Effect<Date, FsError, FlowInvoker.FlowInvoker> = surface.call("typed/date", when)
void dated
// @ts-expect-error encoded strings are not decoded date input
const _call4 = surface.call("typed/date", "2026-01-01T00:00:00.000Z")
