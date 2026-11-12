/**
 * The verbs the unified tree once handed to the legacy Effect parser as argv.
 *
 * `ControlCommands.ts` spelled each of those flags twice: once as a zod option
 * and once as the `--flag` it forwarded to `Bridge.invoke`. Since 4ad4d129 both
 * spellings call one shared Effect and the flat spelling is a hidden transition
 * alias that keeps its prior contract, so a flag a canonical verb gains is not
 * added to its alias. This walks every bridged verb's local control help and
 * asserts each flag it declares is one the legacy verb declares too, or one of
 * the reviewed options the canonical verb gained after its alias froze. The
 * connection options and the unified globals are the bridge's own and are
 * translated, not forwarded.
 */
import { NodeServices } from "@effect/platform-node"
import { Control } from "@smthrs/control"
import { Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { TestConsole } from "effect/testing"
import { Cli } from "incur"
import { describe, expect, it } from "vitest"
import * as Bridge from "../src/cli/ControlBridge.ts"
import { createApprovalsCli, createFlowCli, createRunsCli } from "../src/cli/ControlCommands.ts"
import { cli } from "../src/Command.ts"
import * as Output from "../src/Output.ts"
import { packageVersion } from "../src/Version.ts"

/** Each unified verb that still forwards argv, and the legacy verb it reaches. */
const bridged: ReadonlyArray<{ readonly unified: ReadonlyArray<string>; readonly legacy: string }> = [
  { unified: ["flow", "list"], legacy: "ls" },
  { unified: ["flow", "plan"], legacy: "plan" },
  { unified: ["flow", "start"], legacy: "up" },
  { unified: ["flow", "execute"], legacy: "run" },
  { unified: ["runs", "output"], legacy: "output" },
  { unified: ["runs", "cancel"], legacy: "cancel" },
  { unified: ["runs", "resume"], legacy: "resume" },
  { unified: ["runs", "signal"], legacy: "signal" },
  { unified: ["runs", "steer"], legacy: "steer" },
  { unified: ["approvals", "approve"], legacy: "approve" },
  { unified: ["approvals", "deny"], legacy: "deny" }
]

/**
 * The options a canonical verb gained after its flat alias froze, exactly. A
 * missing entry and an entry the alias now declares both fail.
 */
const canonicalOnly: Readonly<Record<string, ReadonlyArray<string>>> = {
  // 425ae130 waits for a signal's delivery or rejection (#4247).
  "runs signal": ["--timeout", "--wait"]
}

const kebab = (key: string): string => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`

/** The connection options are the bridge's own; it translates them, never forwards them. */
const connection = new Set(Object.keys(Bridge.connectionOptions.shape).map(kebab))

const flagsOf = (text: string): ReadonlyArray<string> => [...new Set(text.match(/--[a-z][a-z-]*/g) ?? [])]

const unifiedHelp = async (path: ReadonlyArray<string>): Promise<string> => {
  let stdout = ""
  await Cli.create("smithers").command(createFlowCli()).command(createRunsCli()).command(createApprovalsCli()).serve([
    ...path,
    "--help"
  ], {
    env: {},
    stdout: (text) => {
      stdout += text
    },
    exit: () => {}
  })
  return stdout
}

const legacyHelp = (verb: string): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function*() {
      yield* Command.runWith(cli, { version: packageVersion })([verb, "--help"])
      return (yield* TestConsole.logLines).join("\n")
    }).pipe(Effect.provide(Layer.mergeAll(TestConsole.layer, Output.layer, Control.layerNoop, NodeServices.layer)))
  )

describe("bridged verb flag parity", () => {
  it.each(bridged)("$unified forwards only flags the legacy $legacy verb declares", async ({ legacy, unified }) => {
    // The group's help lists every Incur global; a verb's help adds its own.
    const globals = new Set(flagsOf(await unifiedHelp(unified.slice(0, -1))))
    const forwarded = flagsOf(await unifiedHelp(unified)).filter((flag) => !globals.has(flag) && !connection.has(flag))
    const declared = flagsOf(await legacyHelp(legacy))
    expect(declared.length).toBeGreaterThan(0)
    const path = unified.join(" ")
    expect(forwarded.filter((flag) => !declared.includes(flag)).sort(), path).toEqual(canonicalOnly[path] ?? [])
  })
})
