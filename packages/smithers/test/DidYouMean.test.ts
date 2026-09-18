/**
 * The suggestion an unknown verb earns, the cases that withhold it, and the
 * line a Jev failure leaves in its place.
 *
 * The decision runs on `Evaluator.layerScripted`, so no case needs a gateway
 * key or a socket. The scripted layer records the request, which is how the
 * outbound state and the offered options are pinned: they are what Jev reads.
 * The last two cases drive the real command tree with no key configured, so
 * the wiring at the call site is exercised too.
 */
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, type Layer } from "effect"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { didYouMean } from "../src/DidYouMean.ts"
import * as Unsupported from "../src/Unsupported.ts"
import * as Verb from "../src/Verb.ts"

const asked: Array<Evaluator.Request> = []

const scripted = (answer: Evaluator.ScriptedAnswer) =>
  Evaluator.layerScripted((request) => {
    asked.push(request)
    return { meant: answer }
  })

const ask = (
  typed: string,
  args: ReadonlyArray<string>,
  evaluator: Layer.Layer<Evaluator.Evaluator>
): Promise<string | undefined> => {
  asked.length = 0
  return Effect.runPromise(didYouMean(typed, args).pipe(Effect.provide(evaluator)))
}

describe("didYouMean", () => {
  it("suggests the verb Jev names when it is sure enough", async () => {
    const line = await ask("stauts", ["run-42"], scripted({ choice: "status", probabilities: { status: 0.93 } }))

    expect(line).toBe("Did you mean: smithers status?")
  })

  it("sends the typed verb and the rest of the command line as the state", async () => {
    await ask("stauts", ["run-42", "--json"], scripted({ choice: "status", probabilities: { status: 0.93 } }))

    expect(asked).toHaveLength(1)
    expect(asked[0]!.state).toEqual({ typed: "stauts", args: "run-42 --json" })
  })

  it("offers every shipped verb, described by its own help line, plus none", async () => {
    await ask("stauts", [], scripted({ choice: "none" }))

    const question = asked[0]!.questions["meant"]!
    expect(question.type).toBe("choice")
    const criteria = question.criteria as Readonly<Record<string, string>>
    expect(Object.keys(criteria)).toEqual([...Verb.names, "none"])
    expect(criteria["status"]).toBe(Verb.find("status")!.help)
  })

  it("says nothing when Jev answers none", async () => {
    expect(await ask("qqqq", [], scripted({ choice: "none", probabilities: { none: 0.99 } }))).toBeUndefined()
  })

  it("says nothing below the confidence floor", async () => {
    const unsure = scripted({ choice: "status", probabilities: { status: 0.5, ls: 0.5 } })

    expect(await ask("stauts", [], unsure)).toBeUndefined()
  })

  it("names the failure when Jev cannot be asked", async () => {
    const line = await ask("stauts", [], Evaluator.layerUnavailable())

    expect(line).toBe("Could not ask Jev for a suggestion: unreachable")
    expect(asked).toHaveLength(0)
  })

  it("never asks about a removed verb, whose migration prose stands alone", async () => {
    const refused = Unsupported.refusal(["rewind"])!

    expect(refused.message).toContain("smthrs rewind was removed in 1.0.0-rc.0")
    expect(await ask("rewind", [], scripted({ choice: "status", probabilities: { status: 0.99 } }))).toBeUndefined()
    expect(asked).toHaveLength(0)
  })

  it("never asks about a shipped verb or one of its aliases", async () => {
    const confident = scripted({ choice: "ls", probabilities: { ls: 0.99 } })

    expect(await ask("status", [], confident)).toBeUndefined()
    expect(await ask("why", [], confident)).toBeUndefined()
    expect(asked).toHaveLength(0)
  })
})

const invoke = async (argv: Array<string>) => {
  const codes: Array<number> = []
  let stdout = ""
  await makeCli({ environment: {}, exit: (code) => codes.push(code) }).serve(argv, {
    env: {},
    exit: (code) => codes.push(code),
    stdout: (text) => {
      stdout += text
    }
  })
  return { codes, stdout }
}

describe("the unknown verb the parser refuses", { timeout: 120_000 }, () => {
  /**
   * The wiring, on the real command tree, with no gateway key: the parser's
   * refusal keeps its code and its exit status, the line names the transport
   * it could not reach, and no handler ran to print it.
   */
  it("gains one line under the refusal, and the exit code is the parser's", async () => {
    const { codes, stdout } = await invoke(["stauts"])

    expect(stdout).toContain("COMMAND_NOT_FOUND")
    expect(stdout.trimEnd().endsWith("Could not ask Jev for a suggestion: unreachable")).toBe(true)
    expect(codes).toEqual([1])
  })

  it("leaves a command that runs alone", async () => {
    const { codes, stdout } = await invoke(["--version"])

    expect(stdout).not.toContain("Jev")
    expect(codes).toEqual([])
  })
})
