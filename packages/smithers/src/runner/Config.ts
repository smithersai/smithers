/**
 * A runner's configuration file and its token.
 *
 * `runner.json` is the runner host's own: it names the host the runner pulls
 * from, the checkouts it works in, and what each opaque agent profile runs.
 * The host never sees it. The token is the runner's only credential, kept in a
 * `0600` file under the state directory; only its SHA-256 leaves the machine,
 * for an admin to register the runner.
 *
 * @since 1.0.0
 */

import * as AgentRunner from "@smthrs/agent/AgentRunner"
import { Effect, Schema } from "effect"
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import * as Admission from "./Admission.ts"

const NonEmpty = Schema.String.check(Schema.isMinLength(1))
const EnvName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))

/**
 * What one profile runs: the agent's command line, extra environment, an
 * optional `prestart` command whose `NAME=VALUE` lines join the agent's
 * environment (and whose `account=<label>` line names the account it chose),
 * the variables whose values the runner scrubs from what it uploads, the ends
 * that ask for another generation instead of failing (`refusal`, the agent's
 * stop reason; `exit`, the agent exiting mid-turn; `error`, an error answer to
 * a request, which is how an agent reports a missing login or a limit), how
 * the agent's permission requests are answered, and how a steer reaches it:
 * `native` (unless set) hands it to the turn in flight over
 * `_session/steering` when the agent advertises it, `prompt` always cancels
 * the turn and prompts with it, for an agent whose native steering moves its
 * running command to the background and ends its turn.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Profile = Schema.Struct({
  argv: Schema.Array(NonEmpty).check(Schema.isMinLength(1)),
  env: Schema.optional(Schema.Record(EnvName, Schema.String)),
  prestart: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
  secretEnv: Schema.optional(Schema.Array(EnvName)),
  retryOn: Schema.optional(Schema.Array(Schema.Literals(["refusal", "exit", "error"]))),
  permission: Schema.optional(Schema.Literals(["allow", "reject"])),
  steering: Schema.optional(Schema.Literals(["native", "prompt"]))
})

/**
 * What one profile runs, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Profile = typeof Profile.Type

/**
 * When the runner takes another job ({@link Admission}): while its load
 * stays under `loadPerCpu` of its CPUs (0.5 unless set), its state
 * directory's disk has `diskFloorGb` free (40 unless set), counting each job
 * it just claimed as `jobLoad` (1 unless set) until that job's load shows.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AdmissionConfig = Schema.Struct({
  loadPerCpu: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0.05, maximum: 1000 }))),
  diskFloorGb: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
  jobLoad: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 64 })))
})

/**
 * `runner.json`: the host's origin (absent: the runner is its own host, and
 * its lanes are control runs under `lanes.root`, the state directory unless
 * set), the runner's registered name, how many
 * jobs it runs at once (4 unless set), where it keeps its state
 * (`~/.smithers/runner` unless set), how often it heartbeats a job (10 s) and
 * claims again after an empty claim (2 s), when it admits a job
 * ({@link AdmissionConfig}), and, for an overflow runner, how long a job
 * must have waited before it takes it (`minQueuedSeconds`) and how long it
 * serves with no job before it ends (`idleExitSeconds`, never unless set),
 * each repository's local jj mirror
 * by the host's repository id, and its profiles by name.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Config = Schema.Struct({
  origin: Schema.optional(NonEmpty),
  lanes: Schema.optional(Schema.Struct({ root: Schema.optional(NonEmpty) })),
  name: AgentRunner.Name,
  capacity: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))),
  stateDir: Schema.optional(NonEmpty),
  heartbeatSeconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 }))),
  pollSeconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 }))),
  admission: Schema.optional(AdmissionConfig),
  minQueuedSeconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400 }))),
  idleExitSeconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400 }))),
  repositories: Schema.Record(NonEmpty, Schema.Struct({ mirror: NonEmpty })),
  profiles: Schema.Record(AgentRunner.Profile, Profile)
})

/**
 * `runner.json`, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Config = typeof Config.Type

/**
 * A checked configuration: the origin without a trailing slash, the defaults
 * filled in (the admission policy's too), and the state directory and the
 * lanes' project root as absolute paths.
 *
 * @category models
 * @since 1.0.0
 */
export interface Checked extends Omit<Config, "admission"> {
  readonly capacity: number
  readonly stateDir: string
  readonly lanesRoot: string
  readonly heartbeatSeconds: number
  readonly pollSeconds: number
  readonly admission: Admission.Policy
}

/**
 * The configuration or the token couldn't be used. `message` names the field
 * or the file's role, never a value from it.
 *
 * @category errors
 * @since 1.0.0
 */
export class RunnerConfigError extends Schema.TaggedError<RunnerConfigError>()("@smthrs/cli/Runner/RunnerConfigError", {
  message: Schema.String
}) {}

/**
 * The state directory when the configuration names none.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultStateDir = (home: string = homedir()): string => join(home, ".smithers", "runner")

/**
 * Where the runner's token lives under `stateDir`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const tokenFile = (stateDir: string): string => join(stateDir, "runner-token")

const expand = (path: string, home: string): string =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : resolve(path)

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Config))

/**
 * Checks a decoded configuration: the origin, when set, is `https`, or `http`
 * on this machine only; every mirror is an absolute path.
 *
 * @category constructors
 * @since 1.0.0
 */
export const check = (config: Config, home: string = homedir()): Effect.Effect<Checked, RunnerConfigError> =>
  Effect.gen(function*() {
    const origin = config.origin === undefined ? undefined : yield* checkOrigin(config.origin)
    for (const [repository, { mirror }] of Object.entries(config.repositories)) {
      if (!isAbsolute(mirror)) {
        return yield* new RunnerConfigError({ message: `repositories.${repository}.mirror must be an absolute path` })
      }
    }
    const stateDir = expand(config.stateDir ?? defaultStateDir(home), home)
    return {
      ...config,
      ...(origin === undefined ? {} : { origin }),
      capacity: config.capacity ?? 4,
      heartbeatSeconds: config.heartbeatSeconds ?? 10,
      pollSeconds: config.pollSeconds ?? 2,
      admission: {
        loadPerCpu: config.admission?.loadPerCpu ?? Admission.defaults.loadPerCpu,
        diskFloorGb: config.admission?.diskFloorGb ?? Admission.defaults.diskFloorGb,
        jobLoad: config.admission?.jobLoad ?? Admission.defaults.jobLoad
      },
      stateDir,
      lanesRoot: config.lanes?.root === undefined ? stateDir : expand(config.lanes.root, home)
    }
  })

/** An origin `https`, or `http` on this machine only, with no path: itself without a trailing slash. */
const checkOrigin = (origin: string) =>
  Effect.gen(function*() {
    const url = yield* Effect.try({
      try: () => new URL(origin),
      catch: () => new RunnerConfigError({ message: "origin is not a URL" })
    })
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      return yield* new RunnerConfigError({ message: "origin must be https, or http on localhost" })
    }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      return yield* new RunnerConfigError({ message: "origin must be an origin, with no path" })
    }
    return url.origin
  })

/**
 * Reads and checks `runner.json` at `path`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const load = (path: string, home: string = homedir()): Effect.Effect<Checked, RunnerConfigError> =>
  Effect.try({
    try: () => readFileSync(path, "utf8"),
    catch: () => new RunnerConfigError({ message: "the configuration file can't be read" })
  }).pipe(
    Effect.flatMap((text) =>
      decodeConfig(text).pipe(
        Effect.mapError(() => new RunnerConfigError({ message: "the configuration file isn't a runner.json" }))
      )
    ),
    Effect.flatMap((config) => check(config, home))
  )

/**
 * A token's SHA-256, as an admin registers it: 64 lowercase hex.
 *
 * @category constructors
 * @since 1.0.0
 */
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

/**
 * Makes the runner's token: 32 random bytes as base64url in
 * {@link tokenFile}, mode `0600`, refusing to replace one unless `rotate`.
 * Answers only the token's SHA-256.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeToken = (
  stateDir: string,
  options: { readonly rotate?: boolean | undefined } = {}
): Effect.Effect<{ readonly sha256: string; readonly file: string }, RunnerConfigError> =>
  Effect.try({
    try: () => {
      const file = tokenFile(stateDir)
      if (existsSync(file) && options.rotate !== true) return undefined
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const token = randomBytes(32).toString("base64url")
      writeFileSync(file, `${token}\n`, { mode: 0o600 })
      chmodSync(file, 0o600)
      return { sha256: sha256(token), file }
    },
    catch: () => new RunnerConfigError({ message: "the token file can't be written" })
  }).pipe(
    Effect.flatMap((made) =>
      made === undefined
        ? Effect.fail(new RunnerConfigError({ message: "a token exists already; pass --rotate to replace it" }))
        : Effect.succeed(made)
    )
  )

/**
 * Reads the runner's token from {@link tokenFile}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const readToken = (stateDir: string): Effect.Effect<string, RunnerConfigError> =>
  Effect.try({
    try: () => readFileSync(tokenFile(stateDir), "utf8").trim(),
    catch: () => new RunnerConfigError({ message: "no runner token; run `smthrs runner token` first" })
  }).pipe(
    Effect.flatMap((token) =>
      token.length === 0
        ? Effect.fail(new RunnerConfigError({ message: "the runner token file is empty" }))
        : Effect.succeed(token)
    )
  )
