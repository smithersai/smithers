/**
 * The entry module the SandboxedFlow suites bundle into the guest.
 *
 * One module exports several child flows because the guest runner finds the
 * flow the host names by tag among the entry's exports, so one bundle serves
 * every case. `layer` is the convention the runner reads: the implementations
 * of every action a flow here names.
 *
 * Everything an implementation touches is the GUEST's: `process.cwd()` is the
 * session workdir, `/etc/os-release` is the guest image's, and a file written
 * here lands in the workspace the host reads back as the diff.
 */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const AddEleven = Action.make("flows/SandboxedFlow/fixtures/AddEleven", {
  payload: { n: Schema.Number },
  success: Schema.Number
})

/** The smallest child: n + 11. */
export const Sum = Flow.make("flows/SandboxedFlow/fixtures/Sum", {
  payload: { n: Schema.Number },
  success: Schema.Number,
  body: (payload) => AddEleven.call(payload)
})

export class Refused extends Schema.TaggedError<Refused>()("flows/SandboxedFlow/fixtures/Refused", {
  reason: Schema.String
}) {}

export const Refuse = Action.make("flows/SandboxedFlow/fixtures/Refuse", {
  payload: { reason: Schema.String, chatter: Schema.Number },
  success: Schema.Void,
  error: Refused
})

/** Writes `chatter` characters to stdout, then fails with a typed error. */
export const Failing = Flow.make("flows/SandboxedFlow/fixtures/Failing", {
  payload: { reason: Schema.String, chatter: Schema.Number },
  success: Schema.Void,
  error: Refused,
  body: (payload) => Refuse.call(payload)
})

export const WriteFiles = Action.make("flows/SandboxedFlow/fixtures/WriteFiles", {
  payload: { count: Schema.Number, bytes: Schema.Number, directory: Schema.String },
  success: Schema.Number
})

/** Writes `count` files of `bytes` bytes each under `directory` in the workspace. */
export const Writer = Flow.make("flows/SandboxedFlow/fixtures/Writer", {
  payload: { count: Schema.Number, bytes: Schema.Number, directory: Schema.String },
  success: Schema.Number,
  body: (payload) => WriteFiles.call(payload)
})

export const Inspection = Schema.Struct({
  seed: Schema.String,
  osRelease: Schema.String,
  runtime: Schema.String,
  cwd: Schema.String
})

export const Inspect = Action.make("flows/SandboxedFlow/fixtures/Inspect", {
  payload: { marker: Schema.String },
  success: Inspection
})

/**
 * Reports what the guest can see: a `seed.txt` the host may have left in the
 * workspace, the image's `/etc/os-release`, the runtime, and the working
 * directory; and writes `marker` to `marker.txt` so the host can read a file
 * only the guest wrote.
 */
export const Inspector = Flow.make("flows/SandboxedFlow/fixtures/Inspector", {
  payload: { marker: Schema.String },
  success: Inspection,
  body: (payload) => Inspect.call(payload)
})

export const Edit = Action.make("flows/SandboxedFlow/fixtures/Edit", {
  payload: { path: Schema.String, text: Schema.String, remove: Schema.String },
  success: Schema.Void
})

/** Rewrites `path` with `text` and deletes `remove`, both in the workspace. */
export const Editor = Flow.make("flows/SandboxedFlow/fixtures/Editor", {
  payload: { path: Schema.String, text: Schema.String, remove: Schema.String },
  success: Schema.Void,
  body: (payload) => Edit.call(payload)
})

export const Sleep = Action.make("flows/SandboxedFlow/fixtures/Sleep", {
  payload: { ms: Schema.Number },
  success: Schema.Void
})

/** Sleeps `ms` milliseconds of wall-clock time. */
export const Sleeper = Flow.make("flows/SandboxedFlow/fixtures/Sleeper", {
  payload: { ms: Schema.Number },
  success: Schema.Void,
  body: (payload) => Sleep.call(payload)
})

export const Fill = Action.make("flows/SandboxedFlow/fixtures/Fill", {
  payload: { bytes: Schema.Number },
  success: Schema.String
})

/** Returns a string of `bytes` characters. */
export const Filler = Flow.make("flows/SandboxedFlow/fixtures/Filler", {
  payload: { bytes: Schema.Number },
  success: Schema.String,
  body: (payload) => Fill.call(payload)
})

/** Runs `Sum` as a child execution of its own, a boundary the guest engine has to drive. */
export const Nested = Flow.make("flows/SandboxedFlow/fixtures/Nested", {
  payload: { n: Schema.Number },
  success: Schema.Number,
  body: (payload) => Sum.child(payload)
})

export const Die = Action.make("flows/SandboxedFlow/fixtures/Die", {
  payload: { message: Schema.String, shape: Schema.Literals(["error", "cyclic", "large"]) },
  success: Schema.Void
})

/**
 * Dies with a plain `Error` carrying `message`, with an untagged object that
 * refers to itself, or with an untagged object whose fields run long.
 */
export const Dying = Flow.make("flows/SandboxedFlow/fixtures/Dying", {
  payload: { message: Schema.String, shape: Schema.Literals(["error", "cyclic", "large"]) },
  success: Schema.Void,
  body: (payload) => Die.call(payload)
})

export const FailPlain = Action.make("flows/SandboxedFlow/fixtures/FailPlain", {
  payload: { text: Schema.String },
  success: Schema.Void,
  error: Schema.String
})

/** Fails with a bare string. */
export const Plain = Flow.make("flows/SandboxedFlow/fixtures/Plain", {
  payload: { text: Schema.String },
  success: Schema.Void,
  error: Schema.String,
  body: (payload) => FailPlain.call(payload)
})

export const FailCyclic = Action.make("flows/SandboxedFlow/fixtures/FailCyclic", {
  payload: {},
  success: Schema.Void,
  error: Schema.Unknown
})

/**
 * Fails with an untagged object that refers to itself. The engine encodes an
 * action's typed error for its journal before anything else sees it, so what
 * reaches the runner is the engine's own refusal to encode it.
 */
export const Cyclic = Flow.make("flows/SandboxedFlow/fixtures/Cyclic", {
  payload: {},
  success: Schema.Void,
  error: Schema.Unknown,
  body: (payload) => FailCyclic.call(payload)
})

export const Interrupt = Action.make("flows/SandboxedFlow/fixtures/Interrupt", {
  payload: {},
  success: Schema.Void
})

/** Interrupts itself. */
export const Interrupting = Flow.make("flows/SandboxedFlow/fixtures/Interrupting", {
  payload: {},
  success: Schema.Void,
  body: (payload) => Interrupt.call(payload)
})

const text = async (path: string): Promise<string> => existsSync(path) ? readFile(path, "utf8") : "(absent)"

const cyclic = (): unknown => {
  const self: { readonly kind: string; loop?: unknown } = { kind: "cyclic" }
  self.loop = self
  return self
}

export const layer = Layer.mergeAll(
  // A `.child()` boundary opens a real execution of its callee, so the callee
  // has to be registered in the guest runtime beside the flow the host asked
  // for; the entry's layer is where that registration travels.
  Interpreter.layer(Sum),
  Die.toLayer(({ message, shape }) =>
    Effect.die(shape === "error" ? new Error(message) : shape === "cyclic" ? cyclic() : { detail: message })
  ),
  FailPlain.toLayer(({ text }) => Effect.fail(text)),
  FailCyclic.toLayer(() => Effect.fail(cyclic())),
  Interrupt.toLayer(() => Effect.interrupt),
  AddEleven.toLayer(({ n }) => Effect.succeed(n + 11)),
  Refuse.toLayer(({ chatter, reason }) =>
    Effect.gen(function*() {
      yield* Effect.sync(() => process.stdout.write(`${"c".repeat(chatter)}\n`))
      return yield* Effect.fail(new Refused({ reason }))
    })
  ),
  WriteFiles.toLayer(({ bytes, count, directory }) =>
    Effect.promise(async () => {
      await mkdir(directory, { recursive: true })
      for (let index = 0; index < count; index++) {
        await writeFile(join(directory, `file-${index}.bin`), new Uint8Array(bytes).fill(index % 256))
      }
      return count
    })
  ),
  Inspect.toLayer(({ marker }) =>
    Effect.promise(async () => {
      await writeFile("marker.txt", marker)
      return {
        seed: await text("seed.txt"),
        osRelease: await text("/etc/os-release"),
        runtime: "Bun" in globalThis ? "bun" : `node ${process.version}`,
        cwd: process.cwd()
      }
    })
  ),
  Edit.toLayer(({ path, remove, text }) =>
    Effect.promise(async () => {
      await writeFile(path, text)
      await rm(remove)
    })
  ),
  Sleep.toLayer(({ ms }) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))),
  Fill.toLayer(({ bytes }) => Effect.succeed("x".repeat(bytes)))
)
