/**
 * Bash flow declaration and portable handler.
 *
 * Two ways in, and the difference is where the payload is parsed. `command` is
 * a line for the platform shell, exactly as before. `script` is program text
 * delivered to an interpreter on standard input, as data: nothing quotes it,
 * escapes it, or terminates it with a heredoc marker, so the class of failure
 * that produced `docker exec c bash -lc '…python - <<EOF…'` cannot occur. Its
 * `args` reach the script as arguments rather than as interpolated text.
 *
 * `container` names a container the host knows how to reach, and the argv is
 * built by the injected {@link Container} transport rather than typed by the
 * caller. A host that binds no transport refuses such a call by saying so; the
 * requirement is optional here precisely so a host without containers is not
 * forced to declare one.
 *
 * @since 1.0.0
 */

import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Path from "@smthrs/kernel/Path"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Container from "./Container.ts"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Diagnostics from "./internal/Diagnostics.ts"
import { outsideEnvelope } from "./internal/EnvelopePrecheck.ts"
import * as Exec from "./internal/Exec.ts"
import { elideMiddle as elide, MAX_SHELL_OUTPUT_BYTES } from "./internal/Text.ts"
import * as Probe from "./Probe.ts"
import * as StdError from "./StdError.ts"
import * as TreeFingerprint from "./TreeFingerprint.ts"

/**
 * Registry name for the bash flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "bash"

/**
 * Model-facing description of the bash flow.
 *
 * Capped at 200 characters and read every frame, which is why the
 * invalid-probe contract is not restated here: the cell contract teaches it
 * once, and a result that has one explains itself.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description =
  "Run a shell command, or an interpreter over a script passed as data instead of quoted into a line. container routes it through the host's container transport. mode:hermetic pre-checks path tokens."

/**
 * Default command timeout in milliseconds.
 *
 * Ten minutes lets full builds and test suites finish while ensuring a stalled
 * process eventually releases the flow.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_TIMEOUT_MS = 600_000

const Command = Schema.optional(Schema.String.annotate({
  description: "Shell command line to execute; give this or script, never both"
}))
const Script = Schema.optional(Schema.String.annotate({
  description: "Program text delivered to the interpreter on stdin as data, so it needs no quoting or heredoc"
}))
const Interpreter = Schema.optional(Schema.String.annotate({
  description:
    "Program that reads script on stdin; defaults to bash. python, python3, sh, zsh, node, ruby and perl are known"
}))
const Args = Schema.optional(
  Schema.Array(Schema.String).annotate({
    description: "Arguments passed to the script as data, never interpolated into it"
  })
)
const Stdin = Schema.optional(Schema.String.annotate({
  description: "Text written to the command's standard input; use script instead when the text is the program"
}))
const ContainerName = Schema.optional(Schema.String.annotate({
  description: "Run inside this container through the host's container transport; requires mode:unhermetic"
}))
const Cwd = Schema.optional(Schema.String).annotate({
  description: "Working directory for the command",
  message: "cwd must be a path string. For a checkpoint, pass { at: ctx.base } as the third ctx.call argument."
})
const Env = Schema.optional(
  Schema.Record(Schema.String, Schema.String).annotate({ description: "Environment variables for the command" })
)
const TimeoutMs = Schema.optional(Schema.Number).annotate({
  description: "Wall-clock timeout in milliseconds; defaults to 600000 ms",
  message: "timeoutMs must be a number of milliseconds."
})

/**
 * Input schema for the bash flow.
 *
 * The mode named `hermetic` requires explicit read and write envelopes for a
 * lexical pre-check; it does not by itself confine the process. Unhermetic mode
 * deliberately omits those declarations so the distinction stays visible in
 * the input shape.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("hermetic").annotate({
      description: "Lexically pre-check explicit path tokens against declared reads and writes; does not sandbox"
    }),
    command: Command,
    script: Script,
    interpreter: Interpreter,
    args: Args,
    stdin: Stdin,
    container: ContainerName,
    reads: Schema.Array(Schema.NonEmptyString).annotate({ description: "Paths or path globs the command may read" }),
    writes: Schema.Array(Schema.NonEmptyString).annotate({ description: "Paths or path globs the command may write" }),
    cwd: Cwd,
    env: Env,
    timeoutMs: TimeoutMs
  }),
  Schema.Struct({
    // Omitted means unhermetic: it is the envelope `effects` already declares
    // for every call, so the default grants nothing a named mode would not.
    mode: Schema.Literal("unhermetic").annotate({
      description: "Run without a declared filesystem envelope as an irreversible effect; the default"
    }).pipe(Schema.optionalKey, Schema.withDecodingDefaultKey(Effect.succeed("unhermetic" as const))),
    command: Command,
    script: Script,
    interpreter: Interpreter,
    args: Args,
    stdin: Stdin,
    container: ContainerName,
    cwd: Cwd,
    env: Env,
    timeoutMs: TimeoutMs
  })
])

/**
 * Decoded input accepted by the bash handler.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * Output schema for the bash flow.
 *
 * `invalidProbe` is reserved: `bash` never sets it. Exit code 126 or 127
 * does not prove the shell refused to launch the command, because a launched
 * runner can return either status after running a check. Reading a runner's
 * own wording is a judgment rather than a fact, and `Probe.classify` makes it
 * with Jev for the `test` flow, whose caller is asking about a suite; a shell
 * call is any command at all and stays free of the gateway. See `Probe`.
 *
 * The `<stream>Truncated` flags are a wire convention, not a display detail.
 * A truncated capture is a fragment of what the process printed, and the
 * harness reads these flags to refuse a later write of those exact bytes —
 * `@smthrs/harness/TruncatedOutput` is the consuming half. Renaming a flag, or
 * dropping it when the capture is cut, disarms that guard silently.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  exitCode: Schema.Number.annotate({ description: "Command exit code, including non-zero codes" }),
  stdout: Schema.String.annotate({
    description:
      "Captured stdout; when stdoutTruncated is true, only its start and end, with one line naming the bytes omitted between them"
  }),
  stderr: Schema.String.annotate({
    description:
      "Captured stderr; when stderrTruncated is true, only its start and end, with one line naming the bytes omitted between them"
  }),
  stdoutTruncated: Schema.Boolean.annotate({
    description:
      "Whether stdout exceeded the capture limit, leaving stdout a fragment that must not be written to a file"
  }),
  stderrTruncated: Schema.Boolean.annotate({
    description:
      "Whether stderr exceeded the capture limit, leaving stderr a fragment that must not be written to a file"
  }),
  stdoutDroppedBytes: Schema.Number.annotate({ description: "UTF-8 bytes omitted from the middle of stdout" }),
  stderrDroppedBytes: Schema.Number.annotate({ description: "UTF-8 bytes omitted from the middle of stderr" }),
  invalidProbe: Schema.optional(
    Probe.InvalidProbe.annotate({
      description: "Reserved for a confirmed launch failure; an exit code alone does not establish one"
    })
  ),
  mutated: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Present for a containerised command whose working directory was measured before and after it: true when the tree changed, false when it held still. Absent when the tree was not measured, which is never read as unchanged."
    })
  )
})

/**
 * Decoded output returned by the bash handler.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * The text of a stream cut to its start and end: the start, one line naming
 * the bytes omitted between them, and the end. A host that captures output
 * itself, such as a terminal behind {@link inTerminal}, cuts with this so every
 * {@link Output} reads the same.
 *
 * @category rendering
 * @since 1.0.0-rc.5
 */
export const elideMiddle: (start: string, droppedBytes: number, end: string) => string = elide

/**
 * Static conservative effect envelope for the bash flow.
 *
 * The declaration is the registry-time worst case because the mode is not
 * known until an invocation is decoded.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({
  tier: "irreversible",
  mode: "expected",
  reads: [],
  writes: []
})

/**
 * Narrows the effect envelope for a decoded invocation.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (input: Input) =>
  input.mode === "hermetic"
    ? envelope({
      tier: "irreversible",
      mode: "hermetic",
      reads: input.reads,
      writes: input.writes
    })
    : envelope({
      tier: "irreversible",
      mode: "expected",
      reads: [],
      writes: []
    })

/**
 * Capabilities required by the bash flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("proc:spawn", "*")]

/**
 * Declaration-only bash flow.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = { name, description, input: Input, output: Output, capabilities, effects } as const

/*
 * `bash` declares no activity on purpose. What a shell call does is in the
 * command, not in the declaration: the same flow runs a test suite, a type
 * check, and `cat`. A reader that recognises a direct runner says so from the
 * recorded command; everything else stays unknown, which is what an absent
 * activity means.
 */

/**
 * How one recorded call to this flow reads: the verb for each settlement, the
 * input field that is its subject, and the measured output fields a one-line
 * summary may count.
 *
 * Display metadata only, governed by `@smthrs/registry`
 * `Descriptor.CallPresentation` and checked where `StandardFlows` binds it.
 *
 * @category presentation
 * @since 1.0.0-rc.0
 */
export const presentation = {
  verb: { pending: "running", success: "ran", failure: "failed to run" },
  subject: "command",
  result: "command"
} as const

/**
 * Select standard input explicitly. Shells need `--` before script arguments
 * so even an argument such as `-c` cannot replace the stdin program.
 * Other supported interpreters treat arguments after `-` as program data.
 */
const stdinArguments = (interpreter: string): ReadonlyArray<string> | undefined => {
  switch (interpreter) {
    case "bash":
    case "zsh":
    case "sh":
    case "dash":
      return ["-s", "--"]
    case "python":
    case "python3":
    case "node":
    case "ruby":
    case "perl":
      return ["-"]
    default:
      return undefined
  }
}

/** Whether a script is shell text the lexical pre-check can actually read. */
const shells = new Set(["bash", "zsh", "sh", "dash"])

/** What one invocation runs, before any container transport rewrites it. */
interface Plan {
  readonly file: string
  readonly args: ReadonlyArray<string> | undefined
  readonly stdin: string | undefined
  readonly env: Record<string, string> | undefined
  readonly quoted: string
}

const invalid = (message: string): StdError.StdError => new StdError.StdError({ code: "invalid_input", message })

/** The invocation an input names, or the failure explaining why it names none. */
const plan = (input: Input): Plan | StdError.StdError => {
  const interpreter = input.interpreter ?? "bash"
  if (input.command !== undefined && input.script !== undefined) {
    return invalid("Give command or script, never both: a script is program text, a command is a shell line")
  }
  if (input.command === undefined && input.script === undefined) {
    return invalid("Give either command (a shell line) or script (program text run by interpreter)")
  }
  if (input.script !== undefined && input.stdin !== undefined) {
    return invalid("A script already arrives on standard input, so it cannot also carry stdin")
  }
  if (input.command !== undefined && input.args !== undefined) {
    return invalid("args belong to a script; a command carries its own arguments in the line")
  }
  if (input.command !== undefined && input.interpreter !== undefined) {
    return invalid("interpreter runs a script; a command runs in the platform shell")
  }
  if (input.mode === "hermetic" && input.container !== undefined) {
    return invalid(
      "A container has its own filesystem, so declared reads and writes cannot describe it. Use mode:unhermetic for a containerised command"
    )
  }
  if (input.mode === "hermetic" && input.script !== undefined && !shells.has(interpreter)) {
    return invalid(
      `The hermetic pre-check reads shell text, and ${interpreter} is not a shell. Run this script with mode:unhermetic, or express it as shell`
    )
  }
  if (input.command !== undefined) {
    return { file: input.command, args: undefined, stdin: input.stdin, env: input.env, quoted: input.command }
  }
  const selector = stdinArguments(interpreter)
  if (selector === undefined) {
    return invalid(`Unsupported script interpreter: ${interpreter}`)
  }
  const args = [...selector, ...(input.args ?? [])]
  return {
    file: interpreter,
    args,
    stdin: input.script,
    env: input.env,
    quoted: [interpreter, ...args].join(" ")
  }
}

/**
 * The plan, refused when its input names no one invocation or when a hermetic
 * call's paths fall outside its declared envelope. Spawned and terminal
 * execution share this one check.
 */
const precheck = (input: Input, path: Path.Path): Plan | StdError.StdError => {
  const intent = plan(input)
  if (intent instanceof StdError.StdError || input.mode !== "hermetic") return intent
  // A planned call carries exactly one of command or script.
  return outsideEnvelope(input, input.command ?? input.script!, path) ?? intent
}

/** The container a call runs in, the deadline it runs under there, and the nonce that frames its report. */
interface Frame {
  readonly container: string
  readonly nonce: string
  readonly seconds: number
}

/** The plan as the host will spawn it, once the container transport has had it. */
const routed = (
  plan: Plan,
  input: Input,
  transport: Option.Option<Container.Container>,
  frame: Frame | undefined
): Effect.Effect<Plan, StdError.StdError> => {
  if (frame === undefined) return Effect.succeed(plan)
  if (Option.isNone(transport)) return Effect.fail(Container.unavailable(frame.container))
  return Effect.map(
    transport.value.exec(request(plan, input, frame)),
    (routing): Plan => ({
      file: routing.file,
      args: routing.args,
      stdin: plan.stdin,
      env: routing.env,
      // Diagnostics describe the logical invocation, not transport arguments.
      quoted: plan.quoted
    })
  )
}

/**
 * One containerised request, always through a login shell.
 *
 * A container's environment is what its profile makes it. The images this
 * harness runs against activate the project's interpreter — a conda env, a
 * virtualenv, a modified `PATH` — from `/etc/profile.d`, so a program spawned
 * directly by `docker exec` gets a different Python from the one that owns the
 * repository's dependencies. That is measured, not theoretical: r90 typed
 * `docker exec … bash -lc '…'` by hand and got the activation for free, r91
 * routed `interpreter: "python3"` straight at the container and filled its
 * traces with `ModuleNotFoundError: No module named 'numpy'` and
 * `exec: "/usr/local/bin/python": no such file or directory`. Thirty of 45
 * instances then spent 138 cells scanning `/opt` for the real interpreter.
 *
 * So the login shell is the transport's, not the caller's. A command line is
 * one argument to `bash -lc`, as before. A program run under an interpreter
 * becomes `bash -lc 'exec "$@"' bash <interpreter> <args…>`: the shell reads
 * the profile, then `exec` replaces it with the interpreter, so the script
 * still arrives on the inherited standard input and no argument is ever
 * re-parsed as shell text.
 *
 * That login shell runs under `TreeFingerprint.around`, which measures the
 * working directory before and after it in the same transport call. The
 * host's workspace walk cannot see a container's filesystem, so the tree is
 * measured where it is; every way that can fail is read as "unmeasured" and
 * reported as an absent `mutated`, never as a tree that held still.
 *
 * The same script enforces the call's deadline inside the container. Killing
 * the host's `docker` process stops neither the command, which ran on beside
 * later ones, nor a transport that answers only when the exec ends from
 * losing every byte the command printed. The script stops the command, still
 * measures, and says in its line that the deadline fired.
 */
const request = (plan: Plan, input: Input, frame: Frame): Container.Request => ({
  container: frame.container,
  file: "sh",
  args: [
    "-c",
    TreeFingerprint.around(),
    "sh",
    frame.nonce,
    String(frame.seconds),
    "bash",
    ...(plan.args === undefined
      ? ["-lc", plan.file]
      : ["-lc", `exec "$@"`, "bash", plan.file, ...plan.args])
  ],
  ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  ...(input.env === undefined ? {} : { env: input.env }),
  stdin: plan.stdin !== undefined
})

/**
 * How long past a containerised command's own overrun the host waits for the
 * transport to answer: one round trip, measured at 2.8 s to a remote sandbox
 * on 2026-11-11, with room for a slow one.
 */
const transportMillis = 15_000

/** What a command printed, and its exit code unless the host's clock stopped it first. */
interface Ran {
  readonly captured: Exec.Captured
  readonly exitCode: number | undefined
}

/** What a command printed, bounded, with the tree movement a container measured. */
const printed = (
  captured: Exec.Captured,
  stderr: string,
  mutated: boolean | undefined
): StdError.PartialOutput => ({
  stdout: captured.stdout,
  stderr,
  stdoutTruncated: captured.stdoutDroppedBytes > 0,
  stderrTruncated: captured.stderrDroppedBytes > 0,
  stdoutDroppedBytes: captured.stdoutDroppedBytes,
  stderrDroppedBytes: captured.stderrDroppedBytes,
  ...(mutated === undefined ? {} : { mutated })
})

/**
 * Executes a shell command through the permission-aware kernel service.
 *
 * Non-zero exit codes remain successful values. Only timeout, host, permission,
 * and declared-envelope pre-check failures use the typed error channel. A
 * timeout carries what the command printed before it was stopped as
 * `output`, cut on the same terms as a finished command's.
 *
 * On this host the time limit is the host's own clock. In a container it is
 * enforced inside the container by `TreeFingerprint.around`, in the same
 * transport call, so the command is stopped where it runs and its output
 * comes back even over a transport that answers only when the call ends. The
 * host's clock then waits {@link TreeFingerprint.overrunSeconds} and one round
 * trip longer, for a transport that never answers at all.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("Bash.run")(function*(
  input: Input
): Effect.fn.Return<Output, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner | Path.Path> {
  const intent = precheck(input, yield* Path.Path)
  if (intent instanceof StdError.StdError) return yield* Effect.fail(intent)
  const limitMillis = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const frame: Frame | undefined = input.container === undefined ? undefined : {
    container: input.container,
    nonce: yield* TreeFingerprint.nonce,
    seconds: TreeFingerprint.deadlineSeconds(limitMillis)
  }
  const transport = yield* Effect.serviceOption(Container.Container)
  const spawned = yield* routed(intent, input, transport, frame)

  // The working directory belongs to the container. The transport supplies
  // any environment overrides its host process needs to forward into it.
  const ran = yield* Exec.exec(spawned.file, {
    ...(input.cwd === undefined || frame !== undefined ? {} : { cwd: input.cwd }),
    ...(spawned.env === undefined ? {} : { env: spawned.env }),
    timeoutMs: frame === undefined
      ? limitMillis
      : frame.seconds * 1000 + TreeFingerprint.overrunSeconds * 1000 + transportMillis,
    maxCaptureBytes: MAX_SHELL_OUTPUT_BYTES,
    overflow: "ends",
    ...(spawned.args === undefined ? {} : { args: spawned.args }),
    ...(spawned.stdin === undefined ? {} : { stdin: spawned.stdin })
  }).pipe(
    Effect.map((result): Ran => ({ captured: result, exitCode: result.exitCode })),
    // A timeout always captures, so `captured` is present here.
    Effect.catchIf(
      (error) => error.code === "timeout",
      (error) => Effect.succeed<Ran>({ captured: error.captured!, exitCode: undefined })
    ),
    Effect.mapError((error) => Exec.toStdError(spawned.quoted, error))
  )
  // A containerised command ran between two measurements of its tree, under
  // its deadline, and ended its standard error with the report; see
  // `TreeFingerprint.around`. A report framed for another call is the
  // command's own output.
  const tree = frame === undefined ? undefined : TreeFingerprint.split(ran.captured.stderr, frame.nonce)
  const mutated = tree === undefined ? undefined : TreeFingerprint.moved(tree.before, tree.after)
  const output = printed(ran.captured, tree === undefined ? ran.captured.stderr : tree.stderr, mutated)
  if (ran.exitCode === undefined || tree?.timedOut === true) {
    return yield* Effect.fail(
      new StdError.StdError({ code: "timeout", message: `Command timed out: ${spawned.quoted}`, limitMillis, output })
    )
  }
  // A command on this host may have changed files a language server holds
  // open; a container's files are not the ones it was sent.
  if (frame === undefined) yield* Diagnostics.refresh
  // Exit codes alone cannot establish whether the shell refused to launch a
  // command or a launched runner chose that status after executing tests.
  return { exitCode: ran.exitCode, ...output }
})

/**
 * What one call runs, after planning and before any transport: the program,
 * its arguments (absent for a shell command line), standard input, the
 * caller's environment, and the logical invocation as a person reads it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Invocation {
  readonly file: string
  readonly args: ReadonlyArray<string> | undefined
  readonly stdin: string | undefined
  readonly env: Record<string, string> | undefined
  readonly quoted: string
}

/**
 * The invocation `input` names, or the typed refusal explaining why it names
 * none. The same plan {@link run} spawns; a terminal provider runs it instead.
 *
 * @category constructors
 * @since 1.0.0
 */
export const invocation = (input: Input): Invocation | StdError.StdError => plan(input)

/**
 * {@link run}'s contract through a registered terminal (T-TRM-05): the same
 * plan, hermetic pre-check, bounded output and diagnostics refresh, with
 * execution supplied by `execute` instead of a spawn on this host. A terminal
 * has no container transport, so a containerised call is refused before it
 * reaches `execute`.
 *
 * @category handlers
 * @since 1.0.0
 */
export const inTerminal = <R>(
  execute: (input: Input) => Effect.Effect<Output, StdError.StdError, R>
) =>
  Effect.fn("Bash.inTerminal")(function*(
    input: Input
  ): Effect.fn.Return<Output, StdError.StdError, R | Path.Path> {
    const intent = precheck(input, yield* Path.Path)
    if (intent instanceof StdError.StdError) return yield* Effect.fail(intent)
    if (input.container !== undefined) return yield* Effect.fail(Container.unavailable(input.container))
    const output = yield* execute(input)
    // The terminal ran on this workspace: files a language server holds may
    // have changed, exactly as after a spawn here.
    yield* Diagnostics.refresh
    return output
  })

/**
 * The refusal a sealed host answers a call that names another container with.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export const outsideContainer = (sealedTo: string, requested: string): StdError.StdError =>
  new StdError.StdError({
    code: "outside_container",
    message:
      `This host runs commands only inside container "${sealedTo}", not "${requested}". Omit container: every command already runs there.`
  })

/**
 * {@link run}, sealed to one container.
 *
 * A host that must not be reachable from the cell (a benchmark host holding
 * other tasks' tests and reference solutions, say) binds this instead of
 * {@link run}. Every call runs in `sealedTo`: a call that names no container
 * is routed there, so nothing can run on the host by omission and a cell need
 * not repeat the name on every command. A call naming any other container,
 * the empty string included, fails with `outside_container` before anything
 * is spawned.
 *
 * `options.cwd` is the directory a call that names none runs in: the
 * container's name for the task's tree. Without it such a call runs where the
 * transport starts it, the image's working directory.
 *
 * @category handlers
 * @since 1.0.0-rc.1
 */
export const sealed = (sealedTo: string, options?: { readonly cwd?: string | undefined }) =>
(
  input: Input
): Effect.Effect<Output, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner | Path.Path> =>
  input.container !== undefined && input.container !== sealedTo
    ? Effect.fail(outsideContainer(sealedTo, input.container))
    : run({
      ...input,
      container: sealedTo,
      ...(input.cwd === undefined && options?.cwd !== undefined ? { cwd: options.cwd } : {})
    })
