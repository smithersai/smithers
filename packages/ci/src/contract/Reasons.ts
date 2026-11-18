/**
 * Why a job is not replayed, in words a person can act on.
 *
 * Each feature an inventory or a replay records has one sentence here, with
 * the next step where there is one. The program prints these sentences and the
 * command reference lists them, and a test holds the two together and holds
 * every feature the program can record to having one.
 *
 * @since 0.1.0
 */

/**
 * One reason: a sentence whose subject is the job. `{}` in `sentence` is
 * filled with what `subject` finds in the entries' details, or with `none`
 * when it finds nothing. `slot` names that value in the docs.
 *
 * @category models
 * @since 0.1.0
 */
export interface Reason {
  readonly sentence: string
  readonly next?: string
  readonly slot?: string
  readonly none?: string
  readonly subject?: (detail: string) => string | undefined
}

/** What a detail says after the file it starts with. */
const afterFile = (detail: string): string => detail.slice(detail.indexOf(": ") + 2)

const matched = (pattern: RegExp) => (detail: string): string | undefined => pattern.exec(afterFile(detail))?.[1]

const systems: Readonly<Record<string, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" }

const whole = (detail: string): string => detail

/**
 * Every reason, by the feature recorded for it.
 *
 * @category constants
 * @since 0.1.0
 */
export const reasons: Readonly<Record<string, Reason>> = {
  attribute: { sentence: "is a recipe with an attribute that changes how it runs" },
  "automatic-variable": { sentence: "uses a variable only Make can fill in" },
  "changes-machine": {
    sentence: "changes the machine it runs on: {}",
    slot: "WHAT",
    none: "it installs or starts something outside the checkout",
    subject: whole
  },
  checkout: { sentence: "checks out something other than the commit being replayed" },
  "computed-name": { sentence: "sets a Make variable whose name is computed" },
  condition: { sentence: "runs only when a condition holds that a replay cannot check" },
  "condition-false": { sentence: "does not run on this kind of change" },
  conditional: { sentence: "depends on a Make conditional" },
  container: {
    sentence: "runs inside a container, which only GitHub starts",
    next: "the job stays in your CI as it is"
  },
  "continue-on-error": { sentence: "may fail without failing the run, so its result says nothing" },
  "default-rule": { sentence: "relies on the Makefile's default rule" },
  define: { sentence: "uses a Make `define` block" },
  "fails-here": {
    sentence: "fails on this machine: {}",
    slot: "ERROR",
    none: "it did not pass",
    subject: whole
  },
  "dependency-arguments": { sentence: "passes arguments to a recipe it depends on" },
  docker: {
    sentence: "runs {}, and a container daemon can reach every file of this machine",
    next: "pass --allow-docker to replay it",
    slot: "PROGRAM",
    none: "a container program",
    subject: (detail) => /^runs (.+)$/.exec(detail)?.[1]
  },
  "double-colon": { sentence: "has a Make double-colon rule" },
  "duplicate-recipe": { sentence: "is defined more than once in the Justfile" },
  "empty-command": { sentence: "has a step with no command" },
  environment: { sentence: "deploys to an environment" },
  expansion: { sentence: "expands to more of the Makefile" },
  expression: { sentence: "depends on a value known only while the CI runs" },
  "file-target": { sentence: "has the name of a file in the repository, so Make may skip it" },
  function: { sentence: "calls a Make function" },
  "grouped-targets": { sentence: "is built together with other Make rules" },
  "host-action": { sentence: "only prepares the CI machine, which a replay does itself" },
  "ignored-failure": { sentence: "ignores a failing command, so its result says nothing" },
  "implicit-rule": { sentence: "depends on a file Make builds by its own rules" },
  include: { sentence: "includes a Makefile that was not read" },
  interpreter: { sentence: "runs in an interpreter other than a plain shell" },
  load: { sentence: "loads a Make extension" },
  "long-running": { sentence: "keeps running until it is stopped" },
  "make-setting": { sentence: "sets something that changes how Make runs" },
  "malformed-env": { sentence: "sets an environment variable to a list or mapping" },
  "malformed-file": { sentence: "is in a file that cannot be read", next: "fix the file" },
  "malformed-job": { sentence: "is written in a way that cannot be read" },
  "malformed-script": { sentence: "is a script that is not text" },
  "malformed-step": { sentence: "has a step that cannot be read" },
  matrix: { sentence: "has a matrix known only while the workflow runs" },
  "missing-prerequisite": { sentence: "needs a file that no rule builds and the repository lacks" },
  "missing-tool": {
    sentence: "needs {}, which this machine does not have",
    next: "install it and run smithers-ci again",
    slot: "TOOL",
    none: "a tool",
    subject: whole
  },
  module: { sentence: "needs a recipe from a Justfile module that was not read" },
  needs: {
    sentence: "needs {}, which is not replayed",
    slot: "JOB",
    none: "a job",
    subject: (detail) => /needs (.+?), which is not replayed/.exec(detail)?.[1]
  },
  "no-command": { sentence: "has no command to run: all its steps only prepare the CI machine" },
  "no-target": { sentence: "has a step Smithers CI could not turn into a build step" },
  "not-selected": { sentence: "runs builds `--targets` did not name", next: "add them to `--targets`" },
  "not-smithers-build": { sentence: "runs nothing from Smithers build" },
  "other-system": {
    sentence: "runs only on {}",
    next: "run smithers-ci on that system",
    slot: "SYSTEM",
    none: "another operating system",
    subject: (detail) => {
      const system = /runs on ([^;]+);/.exec(detail)?.[1]
      return system === undefined ? undefined : systems[system] ?? system
    }
  },
  "package-turbo": { sentence: "is in a package whose Turborepo settings were not read" },
  "pattern-rule": { sentence: "depends on a Make pattern rule" },
  platform: { sentence: "does not run on this operating system" },
  "positional-arguments": { sentence: "reads the arguments of its recipe" },
  "recipe-argument": { sentence: "needs a value for a recipe argument" },
  "recursive-make": { sentence: "runs Make on itself" },
  "release-trigger": { sentence: "runs for a release, never for a change" },
  runner: { sentence: "picks its runner while the workflow runs" },
  "runner-variable": { sentence: "reads a variable only the CI machine sets" },
  "second-expansion": { sentence: "uses Make's second expansion" },
  secret: {
    sentence: "receives the secret {}, which a replay never has",
    slot: "SECRET",
    none: "a secret",
    subject: (detail) => /receives (.+)$/.exec(detail)?.[1]
  },
  "secret-env": { sentence: "builds a variable from a secret, which a replay never has" },
  "secret-value": { sentence: "holds a value shaped like a secret" },
  "self-hosted": { sentence: "runs on a self-hosted runner, which has things this machine does not" },
  services: {
    sentence: "needs service containers, which only GitHub starts",
    next: "the job stays in your CI as it is"
  },
  setting: { sentence: "depends on a Justfile setting that changes how recipes run" },
  shell: { sentence: "runs in a shell other than bash or sh" },
  "smithers-build": { sentence: "already builds with Smithers build" },
  "subsequent-recipes": { sentence: "runs recipes after itself" },
  substitution: { sentence: "rewrites a value with a Make substitution" },
  "suffix-rule": { sentence: "relies on Make suffix rules" },
  syntax: { sentence: "uses Make syntax that cannot be read" },
  "target-variable": { sentence: "sets a Make variable for one rule" },
  "trigger-filter": { sentence: "runs only for some branches or paths" },
  "uncommitted-changes": { sentence: "differs from its commit", next: "commit the changes to replay them" },
  "unreadable-file": { sentence: "is in a file that could not be opened" },
  uses: {
    sentence: "uses the action {}, which Smithers CI does not run",
    slot: "ACTION",
    none: "with no command",
    subject: matched(/(?:^|[\s:])((?:\.{1,2}\/|docker:\/\/|[\w.-]+\/)[^\s:;,]*)/)
  },
  variable: { sentence: "reads a Make variable that has no value here" },
  vpath: { sentence: "uses Make's `vpath` search" },
  "working-directory": { sentence: "runs in a directory it cannot name inside the repository" },
  "workspace-pattern": { sentence: "is in a workspace pattern that was not read" },
  "write-permission": { sentence: "may write to the repository, so a replay never runs it" }
}

const nextFor = (feature: string, reason: Reason, subjects: ReadonlyArray<string>): string | undefined => {
  if (feature !== "other-system") return reason.next
  if (subjects.includes("macOS")) return "run smithers-ci on a Mac"
  if (subjects.includes("Linux")) return "run smithers-ci on Linux"
  return subjects.length === 0 ? reason.next : "smithers-ci runs on Linux and macOS"
}

/**
 * Why a job is left out, as one line: one sentence per feature, in the order
 * found, each with what the details name and its next step.
 *
 * @category formatting
 * @throws {never}
 * @since 0.1.0
 */
export const reasonsSentence = (
  entries: ReadonlyArray<{ readonly feature: string; readonly detail: string }>
): string =>
  [...new Set(entries.map((entry) => entry.feature))].map((feature) => {
    const reason = reasons[feature]
    if (reason === undefined) return `uses something Smithers CI cannot run (${feature})`
    const found = entries.flatMap((entry) =>
      entry.feature === feature && reason.subject !== undefined ? [reason.subject(entry.detail)] : []
    )
    const subjects = [...new Set(found.filter((subject) => subject !== undefined))]
    const text = reason.sentence.replace("{}", () => subjects.length > 0 ? subjects.join(", ") : reason.none as string)
    const next = nextFor(feature, reason, subjects)
    return next === undefined ? text : `${text}; ${next}`
  }).join("; ")

/**
 * The reasons as the command reference lists them: each feature with its
 * sentence and next step, a filled-in value shown by its name.
 *
 * @category formatting
 * @throws {never}
 * @since 0.1.0
 */
export const reasonRows = (): ReadonlyArray<readonly [feature: string, meaning: string]> =>
  Object.keys(reasons).sort().map((feature) => {
    const reason = reasons[feature] as Reason
    const text = reason.sentence.replace("{}", reason.slot ?? "")
    return [feature, reason.next === undefined ? text : `${text}; ${reason.next}`] as const
  })

/**
 * Why a step that runs a script made of several commands stays one step, by
 * the feature recorded in `Step.whole`. `{}` is filled with the entry's
 * detail. Each sentence follows "stays one step:".
 *
 * @category constants
 * @since 0.1.0
 */
export const wholeScript: Readonly<Record<string, string>> = {
  "script-arguments": "the step gives the script `{}`, which the package manager passes on or reads itself",
  "script-command":
    "the script runs `{}`, which is not another script of the same package.json, run by the same package manager with no option",
  "script-cycle": "the script `{}` runs itself",
  "script-first":
    "the step is the first of its job and others follow it, and what it leaves for them is kept for the whole script",
  "script-hook": "the script has the hook `{}`, which the package manager runs with it",
  "script-limit": "the step has a time limit, which is for the whole script",
  "script-release": "it runs under {}, where a script inside a script was not checked",
  "script-setting": "{} changes how the package manager runs a script",
  "script-syntax": "the script {}"
}

/**
 * Why a step stays one step (`Step.whole`), as one line.
 *
 * @category formatting
 * @throws {never}
 * @since 0.1.0
 */
export const wholeScriptSentence = (why: { readonly feature: string; readonly detail: string }): string =>
  `stays one step: ${
    (wholeScript[why.feature] ?? "its commands cannot be run one at a time").replace("{}", () => why.detail)
  }`
