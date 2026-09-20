/**
 * The two ways a rebuild can end badly, and why they end differently.
 *
 * The rebuild runs inside the observation that copies a run's engine records
 * into the control journal, so what it does on failure decides what a client
 * watching that run sees. A flow file that does not compile must cost the
 * rebuild and nothing else; a host shutting down must not be reported as a
 * rebuild that finished.
 */
import type * as Executable from "@smthrs/registry/Executable"
import { discoveryError } from "@smthrs/registry/RegistryError"
import { Cause, Effect, Exit, Layer, Logger } from "effect"
import { describe, expect, it } from "vitest"
import * as AuthoredRebuild from "../src/internal/AuthoredRebuild.ts"

const refreshing = (
  flow: () => Effect.Effect<never, never, never> | ReturnType<Executable.Refresh["flow"]>
): Executable.Refresh => ({ flow: flow as Executable.Refresh["flow"] })

const observed = async (refresh: Executable.Refresh) => {
  const logs: Array<string> = []
  const exit = await Effect.runPromiseExit(
    AuthoredRebuild.rebuild(refresh)("authored").pipe(
      Effect.provide(Layer.succeed(
        Logger.CurrentLoggers,
        new Set([
          Logger.make((entry) => void logs.push(`${entry.logLevel} ${String(entry.message)}`))
        ])
      ))
    )
  )
  return { exit, logs }
}

describe("rebuilding a flow a run authored", () => {
  it("says which flow it rebuilt", async () => {
    const { exit, logs } = await observed(
      refreshing(() => Effect.succeed({ _tag: "Registered" } as never))
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(logs.join("\n")).toContain("Rebuilt a flow's executable")
  })

  it("keeps the observation alive when the flow file cannot be registered", async () => {
    const { exit, logs } = await observed(
      refreshing(() =>
        Effect.succeed(
          { _tag: "Refused", error: { code: "invalid_module", message: "no default export" } } as never
        )
      )
    )

    // The run's own evidence is still being copied across. Losing it because
    // one file in a directory people edit does not compile would take the
    // node settlements, the approvals and the outcome with it.
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(logs.join("\n")).toContain("cannot register")
  })

  it("keeps the observation alive when the rebuild fails outright", async () => {
    const { exit, logs } = await observed(
      refreshing(() =>
        Effect.fail(
          discoveryError({
            code: "read_failed",
            method: "scan",
            description: "the flows directory disappeared"
          }) as never
        )
      )
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(logs.join("\n")).toContain("could not be rebuilt")
  })

  it("does not report a rebuild the host interrupted as one that finished", async () => {
    const { exit, logs } = await observed(refreshing(() => Effect.interrupt as never))

    // Swallowing this would let the copy carry on inside a scope that is
    // closing, and would write a log line claiming a rebuild that never ran.
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(logs).toEqual([])
  })
})
