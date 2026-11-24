import * as Effect from "effect/Effect"
import { afterEach, describe, expect, it } from "vitest"
import * as FlowInvoker from "../src/FlowInvoker.vibe"
import * as Incur from "../src/Incur.vibe"
import * as IncurHost from "../src/internal/IncurHost.ts"
import { makeRoute } from "./helpers.vibe"

const ambient = globalThis.process
const globals = globalThis as { process: typeof ambient | undefined }

/** Runs on a runtime that has no `process`, as a Worker or a browser does. */
const withoutProcess = async <A>(body: () => A | Promise<A>): Promise<A> => {
  globals.process = undefined
  try {
    return await body()
  } finally {
    globals.process = ambient
  }
}

/** A host that records what the served CLI reads and writes. */
const recordingHost = (argv: ReadonlyArray<string> = []) => {
  const read: Array<string> = []
  const writes: Array<string> = []
  const exits: Array<number> = []
  const host: IncurHost.Host = {
    argv: () => argv,
    env: (name) => {
      read.push(name)
      return undefined
    },
    stdout: (text) => {
      writes.push(text)
    },
    exit: (code) => {
      exits.push(code)
    }
  }
  return { host, read, writes, exits }
}

const seen: Array<unknown> = []

const createCli = (host?: IncurHost.Host) => {
  const program = Incur.createCli("smithers", [makeRoute("review")]).pipe(
    Effect.provide(FlowInvoker.layerNoop({
      invoke: ({ input }) => {
        seen.push(input)
        return Effect.succeed({ accepted: true, number: (input as { number: number }).number })
      }
    }))
  )
  return Effect.runPromise(host === undefined ? program : Effect.provideService(program, Incur.Host, host))
}

// A segment longer than a route segment may be: `serve` refuses it before any
// dispatch, in this package's own code.
const refused = "x".repeat(5_000)

describe("Incur host", () => {
  afterEach(() => {
    seen.length = 0
  })

  it("has no reference to a bare process in the ambient host", async () => {
    const inert = await withoutProcess(() => {
      IncurHost.ambientHost.stdout("dropped")
      IncurHost.ambientHost.exit(1)
      return { argv: IncurHost.ambientHost.argv(), complete: IncurHost.ambientHost.env("COMPLETE") }
    })
    expect(inert).toEqual({ argv: [], complete: undefined })
  })

  it("reads the ambient process when the runtime has one", () => {
    expect(IncurHost.ambientHost.argv()).toEqual(ambient.argv.slice(2))
    expect(IncurHost.ambientHost.env("PATH")).toBe(ambient.env.PATH)
  })

  it("serves a refusal with no process and no provided host, writing nowhere", async () => {
    const cli = await createCli()
    await expect(withoutProcess(() => cli.serve([refused]))).resolves.toBeUndefined()
    await cli.close()
  })

  it("serves a refusal with no process through the provided host", async () => {
    const recorded = recordingHost()
    const cli = await createCli(recorded.host)
    await withoutProcess(() => cli.serve([refused]))
    expect(recorded.read).toEqual(["COMPLETE"])
    expect(JSON.parse(recorded.writes.join(""))).toMatchObject({ ok: false, error: { code: "resource_limit" } })
    expect(recorded.exits).toEqual([1])
    await cli.close()
  })

  it("takes the command line from the provided host when serve gets no argv", async () => {
    const recorded = recordingHost(["review", "--number", "7", "--format", "json"])
    const cli = await createCli(recorded.host)
    await cli.serve()
    expect(seen).toEqual([{ number: 7 }])
    // Incur writes a dispatched command's output through the host too.
    expect(JSON.parse(recorded.writes.join(""))).toMatchObject({ number: 7 })
    expect(recorded.exits).toEqual([])
    await cli.close()
  })

  it("prefers the channels a serve call passes over the host's", async () => {
    const recorded = recordingHost()
    const cli = await createCli(recorded.host)
    const writes: Array<string> = []
    const exits: Array<number> = []
    await cli.serve([refused], { stdout: (text) => writes.push(text), exit: (code) => exits.push(code) })
    expect(writes.join("")).toContain("resource_limit")
    expect(exits).toEqual([1])
    expect(recorded.writes).toEqual([])
    expect(recorded.exits).toEqual([])
    await cli.close()
  })

  it("passes a leading option to Incur whole instead of splitting it on slashes", async () => {
    const recorded = recordingHost()
    const cli = await createCli(recorded.host)
    await cli.serve(["--config=/etc/app.json", "review", "--number", "3", "--format", "json"])
    // Incur names the token it could not place, which shows it arrived whole.
    expect(JSON.parse(recorded.writes.join(""))).toMatchObject({
      code: "COMMAND_NOT_FOUND",
      message: "'--config=/etc/app.json' is not a command for 'smithers'."
    })
    expect(seen).toEqual([])
    await cli.close()
  })
})
