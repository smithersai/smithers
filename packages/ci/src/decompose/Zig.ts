/**
 * What a CI step that runs `zig build` becomes.
 *
 * A Zig step names no inputs. Its tests write where they start
 * (`std.testing.tmpDir` makes `.zig-cache/tmp` there and stops the test when
 * it cannot), so the step cannot be held to a list of files. It runs in the
 * open and is observed: it runs again only when a file its last run read has
 * changed, which for a build is the files the compiler read.
 *
 * Two things follow from what Zig is.
 *
 * A build step that only groups named steps, as `test` groups `test-core`
 * and `test-cli`, runs exactly what `zig build` of each of them runs. A CI
 * step that is nothing but `zig build test` therefore becomes one step per
 * named step: a change reruns only the steps whose own run read it. Zig ran
 * those named steps at the same time in one tree, so the steps are marked
 * `atOnce` and still run at the same time. A flag that only changes how the
 * run is reported or how much runs at once, as in `zig build test --summary
 * all`, is given to each of them; any other flag keeps the step whole.
 *
 * Zig writes a cache beside `build.zig` and another in the home directory.
 * The step is told to keep both in the tool cache. There they last from one
 * run to the next, so a step that does run again compiles and reruns only
 * what the change reaches, by Zig's own rules; and they stay out of what the
 * step is seen to read, so Zig's cache never makes it run again.
 *
 * That holds for every step that starts `zig`, whatever else is in it:
 * `zig build test --summary all`, `zig test src/main.zig`, a build after
 * another command, a build in a directory under the root. Left beside
 * `build.zig`, the cache is a file the step read that a fresh checkout does
 * not have, and the step would run again on every one.
 *
 * @since 0.1.0
 */

import { type Step, toolCache } from "../contract/Inventory.ts"
import { innerScript } from "./Plan.ts"
import { type Command, commands, quote } from "./Shell.ts"

/**
 * Where a Zig step keeps the caches Zig would write beside `build.zig` and
 * in the home directory.
 *
 * @category constants
 * @since 0.1.0
 */
export const environment: Readonly<Record<string, string>> = {
  ZIG_GLOBAL_CACHE_DIR: `${toolCache}/zig/global`,
  ZIG_LOCAL_CACHE_DIR: `${toolCache}/zig/local`
}

const plain = (command: Command): boolean =>
  (command.joint === "first" || command.joint === ";") && !command.piped && !command.background && !command.conditional

/**
 * One `zig build`: the build step it runs, `install` when it names none, and
 * the flags it was given, in order.
 *
 * @category models
 * @since 0.1.0
 */
export interface Build {
  readonly step: string
  readonly flags: ReadonlyArray<string>
}

// Flags of `zig build` (0.17) that change neither which steps a build step groups nor what a step does: how the
// run is reported, and how much runs at once. Every other flag can: `-D` options and `--release` change the build
// itself, `--maxrss` skips steps by what runs beside them, and what follows `--` goes to a program.
const alone = /^(?:--verbose|-j[0-9]+|-freference-trace(?:=[0-9]+)?|-fno-reference-trace)$/
const valued: ReadonlySet<string> = new Set([
  "--summary",
  "--color",
  "--error-style",
  "--multiline-errors",
  "--test-timeout",
  "--seed"
])

const buildOf = (words: ReadonlyArray<string>): Build | undefined => {
  if (words[0] !== "zig" || words[1] !== "build") return undefined
  const flags: Array<string> = []
  let step: string | undefined = undefined
  for (let index = 2; index < words.length; index++) {
    const word = words[index] as string
    const value = words[index + 1]
    if (valued.has(word) && value !== undefined) {
      flags.push(word, value)
      index += 1
    } else if (alone.test(word)) flags.push(word)
    // A flag not listed above, a flag with its value missing, or a second build step.
    else if (word.startsWith("-") || step !== undefined) return undefined
    else step = word
  }
  return { step: step ?? "install", flags }
}

const only = (list: ReadonlyArray<Command> | undefined): Build | undefined => {
  // Whatever joins two commands, or decides whether one runs, can change the step's verdict.
  if (list === undefined || !list.every(plain)) return undefined
  const rest = list.filter((command) => command.words[0]?.text !== "set" || command.assignments.length > 0)
  const [command, ...more] = rest
  if (command === undefined || more.length > 0 || command.assignments.length > 0) return undefined
  const script = innerScript(command)
  if (script !== undefined) return only(commands(script))
  return command.words.every((word) => word.literal) ? buildOf(command.words.map((word) => word.text)) : undefined
}

/**
 * The one build a command is, when the command is nothing but
 * `zig build <step>`: alone, or after `set` lines, or as the whole script of
 * a `bash -c`, with no flag but those that only change how the run is
 * reported or how much runs at once (`--summary all`, `--color off`,
 * `--verbose`, `-j4`). Any other command beside it could change the verdict,
 * and any other flag what is built, so the answer is then `undefined`.
 *
 * @throws {never}
 * @category reading
 * @since 0.1.0
 */
export const sole = (command: string): Build | undefined => only(commands(command))

/**
 * The build step of {@link sole}.
 *
 * @throws {never}
 * @category reading
 * @since 0.1.0
 */
export const soleBuild = (command: string): string | undefined => sole(command)?.step

/**
 * How many directories under the repository's root a step starts in, or
 * `undefined` when where it starts is not a plain path under the root: a
 * path from `/` or the home directory, one that climbs out, one with a
 * variable in it.
 */
const depth = (cwd: string): number | undefined => {
  const parts = cwd.split("/").filter((part) => part !== "" && part !== ".")
  return /^[/~]|\$/.test(cwd) || parts.includes("..") ? undefined : parts.length
}

/**
 * True when the step starts in the repository's root, where its `build.zig`
 * is the one whose named steps are read.
 *
 * @throws {never}
 * @category reading
 * @since 0.1.0
 */
export const atRoot = (step: Step): boolean => depth(step.cwd) === 0

/** Commands after which a path that does not start at `/` names another place. */
const moves: ReadonlySet<string> = new Set(["cd", "pushd", "popd"])

/** The program of every command a script can run, or `undefined` when one of them cannot be told. */
const programs = (list: ReadonlyArray<Command> | undefined): ReadonlyArray<string> | undefined => {
  if (list === undefined) return undefined
  const found: Array<string> = []
  for (const command of list) {
    const head = command.words[0]
    // Only variables are set: no program starts.
    if (head === undefined) continue
    const script = innerScript(command)
    const inner = script === undefined ? [head.text] : programs(commands(script))
    // A program named by a variable could be `zig`, or `cd`.
    if (inner === undefined || !head.literal) return undefined
    found.push(...inner)
  }
  return found
}

/**
 * True when the step starts `zig` in a directory this reader can name from
 * the repository's root: one of its commands is `zig`, alone or beside
 * others, straight or inside a `bash -c`.
 *
 * False when the step changes directory or starts outside the repository,
 * where this reader cannot say which project Zig builds; when it names Zig's
 * cache itself, which it then expects beside `build.zig`; and when its shell
 * is more than this reader reads.
 *
 * @throws {never}
 * @category reading
 * @since 0.1.0
 */
export const runs = (step: Step): boolean => {
  if (depth(step.cwd) === undefined || step.command.includes("zig-cache")) return false
  const started = programs(commands(step.command))
  return started !== undefined && started.includes("zig") && !started.some((program) => moves.has(program))
}

/**
 * A step that runs Zig, told where Zig keeps its caches. The tool cache is in
 * Smithers build's cache directory, outside the checkout, and each directory
 * is named whole, so a step that starts in a directory under the root is
 * given the same ones as a step at the root.
 * What the step already sets wins. The step names no inputs: it is observed.
 *
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const dress = (step: Step): Step => ({ ...step, env: { ...environment, ...step.env } })

/**
 * The steps a CI step becomes when it is nothing but `zig build <step>` in
 * the repository's root and that build step only groups named steps: one
 * `zig build <name>` per named step, with the flags the step gave, each
 * marked `atOnce`, as one build runs them. `undefined` when the command is
 * more than that, the step starts elsewhere, or the build step groups fewer
 * than two.
 *
 * @param step - The CI step.
 * @param groups - The named steps each build step of the root's build groups.
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const split = (
  step: Step,
  groups: ReadonlyMap<string, ReadonlyArray<string>>
): ReadonlyArray<Step> | undefined => {
  const build = atRoot(step) ? sole(step.command) : undefined
  const names = build === undefined ? [] : groups.get(build.step) ?? []
  if (build === undefined || names.length < 2) return undefined
  const flags = build.flags.map((flag) => ` ${quote(flag)}`).join("")
  return names.map((name) =>
    dress({
      ...step,
      id: `${step.id}:${name}`,
      command: `zig build ${quote(name)}${flags}`,
      ...(step.name === undefined ? {} : { name: `${step.name} (${name})` }),
      from: step.id,
      atOnce: true
    })
  )
}
