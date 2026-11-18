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
 * `atOnce` and still run at the same time.
 *
 * Zig writes a cache beside `build.zig` and another in the home directory.
 * The step is told to keep both in the tool cache. There they last from one
 * run to the next, so a step that does run again compiles and reruns only
 * what the change reaches, by Zig's own rules; and they stay out of what the
 * step is seen to read, so Zig's cache never makes it run again.
 *
 * That holds for every step that starts `zig` where the repository's root
 * is, whatever else is in it: `zig build test --summary all`, `zig test
 * src/main.zig`, a build after another command. Left beside `build.zig`, the
 * cache is a file the step read that a fresh checkout does not have, and the
 * step would run again on every one.
 *
 * @since 0.1.0
 */

import { type Step, toolCache } from "../contract/Inventory.ts"
import { innerScript, zigStep } from "./Plan.ts"
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

const only = (list: ReadonlyArray<Command> | undefined): string | undefined => {
  // Whatever joins two commands, or decides whether one runs, can change the step's verdict.
  if (list === undefined || !list.every(plain)) return undefined
  const rest = list.filter((command) => command.words[0]?.text !== "set" || command.assignments.length > 0)
  const [command, ...more] = rest
  if (command === undefined || more.length > 0 || command.assignments.length > 0) return undefined
  const script = innerScript(command)
  if (script !== undefined) return only(commands(script))
  return command.words.every((word) => word.literal) ? zigStep(command.words.map((word) => word.text)) : undefined
}

/**
 * The build step a command runs, when the command is nothing but
 * `zig build <step>`: alone, or after `set` lines, or as the whole script of
 * a `bash -c`. Any other command beside it could change the verdict, so the
 * answer is then `undefined`.
 *
 * @throws {never}
 * @category reading
 * @since 0.1.0
 */
export const soleBuild = (command: string): string | undefined => only(commands(command))

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
 * True when the step starts `zig` in the repository's root: one of its
 * commands is `zig`, alone or beside others, straight or inside a `bash -c`.
 *
 * False when the step starts somewhere else or changes directory, because
 * the cache directories are given from where Zig starts; when it names
 * Zig's cache itself, which it then expects beside `build.zig`; and when its
 * shell is more than this reader reads.
 *
 * @throws {never}
 * @category reading
 * @since 0.1.0
 */
export const runs = (step: Step): boolean => {
  if ((step.cwd !== "" && step.cwd !== ".") || step.command.includes("zig-cache")) return false
  const started = programs(commands(step.command))
  return started !== undefined && started.includes("zig") && !started.some((program) => moves.has(program))
}

/**
 * A step that runs Zig, told where Zig keeps its caches. What the step
 * already sets wins. The step names no inputs: it is observed.
 *
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const dress = (step: Step): Step => ({ ...step, env: { ...environment, ...step.env } })

/**
 * The steps a CI step becomes when it is nothing but `zig build <step>` and
 * that build step only groups named steps: one `zig build <name>` per named
 * step, each marked `atOnce`, as one build runs them. `undefined` when the
 * command is more than that or the build step groups fewer than two.
 *
 * @param step - The CI step.
 * @param groups - The named steps each build step groups.
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const split = (
  step: Step,
  groups: ReadonlyMap<string, ReadonlyArray<string>>
): ReadonlyArray<Step> | undefined => {
  const build = soleBuild(step.command)
  const names = build === undefined ? [] : groups.get(build) ?? []
  if (names.length < 2) return undefined
  return names.map((name) =>
    dress({
      ...step,
      id: `${step.id}:${name}`,
      command: `zig build ${quote(name)}`,
      ...(step.name === undefined ? {} : { name: `${step.name} (${name})` }),
      from: step.id,
      atOnce: true
    })
  )
}
