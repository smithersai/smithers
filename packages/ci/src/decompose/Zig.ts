/**
 * What a CI step that runs `zig build` becomes.
 *
 * The Zig strategy says which files a build step reads, so such a step is
 * held to them. Two more things follow from what Zig is.
 *
 * A build step that only groups named steps, as `test` groups `test-core`
 * and `test-cli`, runs exactly what `zig build` of each of them runs. A CI
 * step that is nothing but `zig build test` therefore becomes one step per
 * named step, each with its own closure: a change reruns only the steps that
 * read it.
 *
 * A step held to its inputs cannot write beside them, and Zig writes a cache
 * where it starts. So the step is told to keep its two caches in the tool
 * cache, where they also last from one run to the next: Zig then rebuilds
 * and reruns only what a change reaches, by its own rules.
 *
 * @since 0.1.0
 */

import type { Closure } from "../contract/Closure.ts"
import { type Step, toolCache } from "../contract/Inventory.ts"
import { closureInputs, innerScript, zigStep } from "./Plan.ts"
import { type Command, commands, quote } from "./Shell.ts"

/**
 * The program a Zig step starts, as `Step.tools` names it. Its bytes are in
 * the key of the step's target, so another Zig release reruns the step.
 *
 * @category constants
 * @since 0.1.0
 */
export const tool = "zig"

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

/**
 * A step that runs Zig, made able to run held to its inputs: it names the
 * program it starts and keeps Zig's caches in the tool cache. What the step
 * already sets wins. With `sealed`, its inputs are everything it reads, so
 * it stays held to them after any step.
 *
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const dress = (step: Step, sealed: boolean): Step => ({
  ...step,
  env: { ...environment, ...step.env },
  tools: [...new Set([...(step.tools ?? []), tool])].sort(),
  ...(sealed ? { sealed: true } : {})
})

/**
 * The steps a CI step becomes when it is nothing but `zig build <step>` and
 * that build step only groups named steps: one `zig build <name>` per named
 * step, each held to its own closure. `undefined` when the command is more
 * than that, the build step groups nothing, or one closure is missing or
 * incomplete.
 *
 * @param step - The CI step.
 * @param groups - The named steps each build step groups.
 * @param closures - The closure of each build step by name.
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const split = (
  step: Step,
  groups: ReadonlyMap<string, ReadonlyArray<string>>,
  closures: ReadonlyMap<string, Closure>
): ReadonlyArray<Step> | undefined => {
  const build = soleBuild(step.command)
  const names = build === undefined ? [] : groups.get(build) ?? []
  const parts: Array<Step> = []
  for (const name of names) {
    const inputs = closureInputs(closures.get(name))
    if (inputs === undefined) return undefined
    parts.push(dress({
      ...step,
      id: `${step.id}:${name}`,
      command: `zig build ${quote(name)}`,
      ...(step.name === undefined ? {} : { name: `${step.name} (${name})` }),
      inputs: [...new Set(inputs)].sort(),
      from: step.id
    }, true))
  }
  return parts.length < 2 ? undefined : parts
}
