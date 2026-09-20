import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Audience from "@smthrs/build-cli/Audience"
import { makeCli } from "../../src/Cli.ts"
import { normalizeArguments } from "../../src/cli/Arguments.ts"
import type * as Bridge from "../../src/cli/ControlBridge.ts"

/** Invoke the public parser with isolated output and explicit process services. */
export const invokeCanonical = async (args: ReadonlyArray<string>, overrides: Bridge.Runtime = {}) => {
  const result = { stdout: "", stderr: "", codes: [] as Array<number> }
  const environment = overrides.environment ?? {}
  const presentation = Audience.fromArguments(args, { env: environment, stdout: false, stderr: false })
  const exit = (code: number) => {
    result.codes.push(code)
  }
  await makeCli({
    environment,
    evaluator: ScriptedJudge.layer,
    presentation,
    stdout: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stdout += text
      }
    },
    stderr: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stderr += text
      }
    },
    exit,
    ...overrides
  }).serve(Audience.incurArguments(normalizeArguments(args), presentation), {
    env: environment,
    exit,
    stdout: (text) => {
      result.stdout += text
    }
  })
  return result
}
