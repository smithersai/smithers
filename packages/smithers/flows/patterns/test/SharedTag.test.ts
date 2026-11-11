/**
 * Two unnamed patterns of one kind with equal bounds are two declarations.
 *
 * The engine resolves a flow by its tag and runs the LAST registration under
 * it, so a default tag built from the kind and its bounds alone gave two such
 * patterns one tag, and executing the first silently ran the second's members.
 * The default tag now names the members too, so each pattern runs its own.
 */
import { describe, it } from "@effect/vitest"
import { Interpreter } from "@smthrs/flow"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as ReviewLoop from "../src/ReviewLoop.vibe"
import { execute, member } from "./Execute.ts"

const review = member("sharedTag/review", () => ({ approved: true }), { output: Schema.Unknown })
const revise = member("sharedTag/revise", ({ output }) => output, {
  output: Schema.Unknown,
  review: Schema.Unknown,
  round: Schema.Unknown
})

const research = ReviewLoop.make({
  produce: member("sharedTag/research", ({ input }) => `research:${input}`),
  review,
  revise,
  maxRounds: 3
})
const build = ReviewLoop.make({
  produce: member("sharedTag/build", ({ input }) => `build:${input}`),
  review,
  revise,
  maxRounds: 3
})

describe("default pattern tags", () => {
  it("give two unnamed patterns of one kind and equal bounds two tags", () => {
    expect(research._tag).not.toBe(build._tag)
  })

  it("run each pattern's own members when both are registered with one engine", async () => {
    await expect(
      execute(research as never, { input: "q" }, "shared-tag-research", Interpreter.layer(build as never) as never)
    )
      .resolves.toEqual({ _tag: "Approved", output: "research:q" })
    await expect(
      execute(build as never, { input: "q" }, "shared-tag-build", Interpreter.layer(research as never) as never)
    )
      .resolves.toEqual({ _tag: "Approved", output: "build:q" })
  })
})
