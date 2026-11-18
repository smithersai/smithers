import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { Step } from "../../src/contract/Inventory.ts"
import { wholeScript, wholeScriptSentence } from "../../src/contract/Reasons.ts"
import * as Script from "../../src/decompose/Script.ts"

const step = (command: string, extra: Partial<Step> = {}): Step => ({
  id: "ci.yml:test:1",
  command,
  cwd: "",
  env: {},
  secrets: [],
  ...extra
})

/** A repository as the files it holds, by path from its root. */
const files = (held: Readonly<Record<string, string | null>>) => (path: string): string | null | undefined => held[path]

const manifest = (scripts: Readonly<Record<string, string>>, extra: Readonly<Record<string, unknown>> = {}): string =>
  JSON.stringify({ name: "example", version: "1.0.0", scripts, ...extra })

/** What a step that runs `command` becomes in a repository whose root `package.json` has these scripts. */
const decide = (
  command: string,
  scripts: Readonly<Record<string, string>>,
  held: Readonly<Record<string, string | null>> = {},
  extra: Partial<Step> = {}
): Script.Decision => Script.decide(step(command, extra), files({ "package.json": manifest(scripts), ...held }))

const commandsOf = (decision: Script.Decision): ReadonlyArray<string> =>
  decision.kind === "links" ? decision.links.map((link) => link.command) : []

const namesOf = (decision: Script.Decision): ReadonlyArray<string> =>
  decision.kind === "links" ? decision.links.map((link) => link.name) : []

const whyOf = (decision: Script.Decision): string =>
  decision.kind === "whole" ? `${decision.why.feature}: ${decision.why.detail}` : decision.kind

const chain = { check: "npm run lint && npm run types", lint: "eslint .", types: "tsc -p ." }

const npmPath = `PATH="$PWD/node_modules/.bin:$PATH" `

describe("Script.runOf", () => {
  it("reads the forms that run a script by name", () => {
    expect(Script.runOf(["npm", "run", "build"])).toEqual({ manager: "npm", script: "build", rest: [] })
    expect(Script.runOf(["npm", "run-script", "build"])?.script).toBe("build")
    expect(Script.runOf(["npm", "test"])).toEqual({ manager: "npm", script: "test", rest: [] })
    expect(Script.runOf(["pnpm", "run", "build"])?.manager).toBe("pnpm")
    expect(Script.runOf(["pnpm", "build"])?.script).toBe("build")
    expect(Script.runOf(["pnpm", "test"])?.script).toBe("test")
    expect(Script.runOf(["yarn", "run", "build"])?.manager).toBe("yarn")
    expect(Script.runOf(["yarn", "build"])?.script).toBe("build")
    expect(Script.runOf(["bun", "run", "build"])?.manager).toBe("bun")
  })

  it("keeps the words after the script's name", () => {
    expect(Script.runOf(["npm", "run", "build", "--silent"])?.rest).toEqual(["--silent"])
    expect(Script.runOf(["npm", "test", "--", "-t", "x"])?.rest).toEqual(["--", "-t", "x"])
    expect(Script.runOf(["yarn", "build", "--watch"])?.rest).toEqual(["--watch"])
  })

  it("reads nothing else", () => {
    expect(Script.runOf([])).toBeUndefined()
    expect(Script.runOf(["npm"])).toBeUndefined()
    expect(Script.runOf(["tsc", "run", "build"])).toBeUndefined()
    // An option before the script's name may change what runs.
    expect(Script.runOf(["npm", "run", "--silent", "build"])).toBeUndefined()
    expect(Script.runOf(["npm", "run"])).toBeUndefined()
    expect(Script.runOf(["pnpm", "--silent", "build"])).toBeUndefined()
    // npm runs a script without `run` only for a few names of its own; only `test` is read.
    expect(Script.runOf(["npm", "build"])).toBeUndefined()
    expect(Script.runOf(["npm", "ci"])).toBeUndefined()
    // `bun <name>` may run a file, and `bun test` is Bun's own test runner.
    expect(Script.runOf(["bun", "build"])).toBeUndefined()
    expect(Script.runOf(["bun", "test"])).toBeUndefined()
    // A package manager's own command is never a script.
    expect(Script.runOf(["pnpm", "install"])).toBeUndefined()
    expect(Script.runOf(["pnpm", "version"])).toBeUndefined()
    expect(Script.runOf(["yarn", "install"])).toBeUndefined()
    expect(Script.runOf(["yarn", "workspace"])).toBeUndefined()
    // `yarn check` checks the installed packages, whatever a script is called.
    expect(Script.runOf(["yarn", "check"])).toBeUndefined()
  })
})

describe("Script.filesOf", () => {
  it("names the manifest and the files that say how a script runs, in the step's directory and the root", () => {
    const root = Script.filesOf(step("npm run check"))
    expect(root).toContain("package.json")
    expect(root).toContain(".npmrc")
    expect(root).toContain("package-lock.json")
    expect(root.every((file) => !file.includes("/"))).toBe(true)
    const inner = Script.filesOf(step("npm run check", { cwd: "packages/app" }))
    expect(inner).toContain("packages/app/package.json")
    expect(inner).toContain("packages/app/.npmrc")
    expect(inner).toContain("package.json")
    expect(inner).toContain("pnpm-workspace.yaml")
  })

  it("names nothing for a step that is not one script run", () => {
    for (
      const command of [
        "npm ci",
        "npm run check && npm run build",
        "npm run check | tee log",
        "npm run check |",
        "npm run check &",
        "npm run > log check",
        "LEVEL=1",
        "CI=1 npm run check",
        "npm run $SCRIPT",
        "npm run check > log",
        "npm run check # then deploy",
        "if true; then npm run check; fi",
        "echo $(npm run check)",
        "bash -c 'npm run check'"
      ]
    ) expect(Script.filesOf(step(command)), command).toEqual([])
    expect(Script.filesOf(step("npm run check", { cwd: "/abs" }))).toEqual([])
    expect(Script.filesOf(step("npm run check", { cwd: "../outside" }))).toEqual([])
    expect(Script.filesOf(step("npm run check", { cwd: "${{ matrix.dir }}" }))).toEqual([])
  })
})

describe("Script.decide", () => {
  it("makes one step per link, each run as its script wrote it, found where the script found it", () => {
    const decision = decide("npm run check", chain)
    expect(namesOf(decision)).toEqual(["lint", "types"])
    expect(commandsOf(decision)).toEqual([
      `${npmPath}npm run lint`,
      `${npmPath}npm run types`
    ])
  })

  it("reads the step's command through quotes, blank lines and `npm test`", () => {
    expect(namesOf(decide("\nnpm run 'check'\n", chain))).toEqual(["lint", "types"])
    expect(namesOf(decide("npm test", { ...chain, test: chain.check }))).toEqual(["lint", "types"])
    expect(namesOf(decide("npm run-script check", chain))).toEqual(["lint", "types"])
  })

  it("splits a link that is itself a chain, to any depth", () => {
    const decision = decide("npm run check", {
      check: "npm run types && npm run lint",
      types: "npm run types:js && npm run types:ts",
      "types:js": "tsc -p js.json",
      "types:ts": "npm run types:ts:a && npm run-script types:ts:b",
      "types:ts:a": "tsd",
      "types:ts:b": "tsc -p ts.json",
      lint: "eslint ."
    })
    expect(namesOf(decision)).toEqual(["types:js", "types:ts:a", "types:ts:b", "lint"])
    // Each link is the words the script nearest to it wrote.
    expect(commandsOf(decision)).toEqual([
      `${npmPath}npm run types:js`,
      `${npmPath}npm run types:ts:a`,
      `${npmPath}npm run-script types:ts:b`,
      `${npmPath}npm run lint`
    ])
  })

  it("runs a link whose script cannot be split as the link wrote it", () => {
    const decision = decide("npm run check", {
      check: "npm run hooked && npm run piped && npm run mixed && npm run one",
      // A script with a hook: the package manager runs the hook when it runs the link.
      prehooked: "echo before",
      hooked: "npm run one && npm run two",
      piped: "npm run one | tee log",
      mixed: "npm run one && tsc",
      one: "true",
      two: "true"
    })
    expect(namesOf(decision)).toEqual(["hooked", "piped", "mixed", "one"])
  })

  it("follows a script that only names another", () => {
    const decision = decide("npm run ci", { ci: "npm run check", ...chain })
    expect(namesOf(decision)).toEqual(["lint", "types"])
    expect(commandsOf(decision)[0]).toBe(`${npmPath}npm run lint`)
  })

  it("numbers a script the chain runs more than once", () => {
    const decision = decide("npm run check", { ...chain, check: "npm run lint && npm run types && npm run lint" })
    expect(namesOf(decision)).toEqual(["lint", "types", "lint#2"])
  })

  it("says nothing about a step that runs no script of several commands", () => {
    expect(decide("npm ci", chain).kind).toBe("none")
    expect(decide("npm run missing", chain).kind).toBe("none")
    expect(decide("npm run lint", chain).kind).toBe("none")
    // One command with shell syntax of its own is still one command.
    expect(decide("npm run lint", { lint: "eslint \"src/**\"" }).kind).toBe("none")
    expect(decide("npm run lint", { lint: "echo $HOME" }).kind).toBe("none")
    // A script that names one other script, down to one command, is that command.
    expect(decide("npm run ci", { ci: "npm run lint", lint: "eslint ." }).kind).toBe("none")
    expect(decide("npm run ci", { ci: "yarn run lint", lint: "eslint ." }).kind).toBe("none")
    // No manifest where the step starts, or one that is not an object, or scripts that are not text.
    expect(Script.decide(step("npm run check"), files({})).kind).toBe("none")
    expect(Script.decide(step("npm run check"), files({ "package.json": "[]" })).kind).toBe("none")
    expect(Script.decide(step("npm run check"), files({ "package.json": "{\"scripts\":[]}" })).kind).toBe("none")
    expect(Script.decide(step("npm run check"), files({ "package.json": "{\"scripts\":null}" })).kind).toBe("none")
    expect(Script.decide(step("npm run check"), files({ "package.json": "{\"scripts\":{\"check\":7}}" })).kind).toBe(
      "none"
    )
    expect(Script.decide(step("npm run check", { cwd: "app" }), files({ "package.json": manifest(chain) })).kind)
      .toBe("none")
  })

  it("leaves a script whole for every operator but `&&`, and says which", () => {
    const why = (check: string): string => whyOf(decide("npm run check", { ...chain, check }))
    expect(why("npm run lint || npm run types")).toBe("script-syntax: joins commands with `||`")
    expect(why("npm run lint; npm run types")).toBe("script-syntax: joins commands with `;` or a line break")
    expect(why("npm run lint\nnpm run types")).toBe("script-syntax: joins commands with `;` or a line break")
    expect(why("npm run lint | tee log")).toBe("script-syntax: pipes one command into another")
    expect(why("npm run lint & npm run types")).toBe("script-syntax: runs a command in the background")
    expect(why("npm run lint &&& npm run types")).toBe("script-syntax: runs a command in the background")
    expect(why("npm run lint > log && npm run types")).toBe("script-syntax: redirects input or output")
    expect(why("npm run lint < in && npm run types")).toBe("script-syntax: redirects input or output")
    expect(why("(npm run lint && npm run types)")).toBe("script-syntax: runs commands in a subshell")
    expect(why("npm run $LINT && npm run types")).toBe("script-syntax: reads a variable or the output of a command")
    expect(why("npm run `echo lint` && npm run types")).toBe(
      "script-syntax: reads a variable or the output of a command"
    )
    expect(why("npm run 'lint' && npm run types")).toBe("script-syntax: quotes a word")
    expect(why("npm run lint && npm run \"types\"")).toBe("script-syntax: quotes a word")
    expect(why("npm run lint\\ && npm run types")).toBe("script-syntax: quotes a word")
    expect(why("npm run lint && npm run type*")).toBe("script-syntax: has a character the shell reads in its own way")
    expect(why("npm run lint && npm run ~types")).toBe("script-syntax: has a character the shell reads in its own way")
    expect(why("npm run lint && npm run types #x")).toBe(
      "script-syntax: has a character the shell reads in its own way"
    )
    expect(why("npm run lint &&")).toBe("script-syntax: has `&&` with no command beside it")
    expect(why("&& npm run lint")).toBe("script-syntax: has `&&` with no command beside it")
  })

  it("leaves a script whole when a link is anything but a plain run of a script beside it", () => {
    const why = (check: string, scripts = chain): string => whyOf(decide("npm run check", { ...scripts, check }))
    // A command of its own would lose the path and the variables the package manager gives it inside the script.
    expect(why("npm run lint && tsc -p .")).toBe("script-command: tsc -p .")
    expect(why("FORCE_COLOR=1 npm run lint && npm run types")).toBe("script-command: FORCE_COLOR=1 npm run lint")
    expect(why("cd app && npm run lint")).toBe("script-command: cd app")
    expect(why("npm run lint && npm run types --silent")).toBe("script-command: npm run types --silent")
    expect(why("npm run lint && npm run types -- --watch")).toBe("script-command: npm run types -- --watch")
    expect(why("npm run lint && npm run absent")).toBe("script-command: npm run absent")
    // Another package manager is another program, and Bun turns `npm run` into `bun run` inside a script.
    expect(why("npm run lint && pnpm run types")).toBe("script-command: pnpm run types")
    expect(why("npm run lint && npm --prefix app run types")).toBe("script-command: npm --prefix app run types")
  })

  it("leaves a script with a hook whole", () => {
    expect(whyOf(decide("npm run check", { ...chain, precheck: "echo before" }))).toBe("script-hook: precheck")
    expect(whyOf(decide("npm run check", { ...chain, postcheck: "echo after" }))).toBe("script-hook: postcheck")
    // A hook around a script of one command is nothing a split would lose.
    expect(decide("npm run lint", { ...chain, prelint: "echo before" }).kind).toBe("none")
  })

  it("refuses a script that reaches itself", () => {
    expect(whyOf(decide("npm run a", { a: "npm run b && npm run c", b: "npm run a", c: "true" }))).toBe(
      "script-cycle: a"
    )
    expect(whyOf(decide("npm run a", { a: "npm run b && npm run c", b: "npm run c && npm run b", c: "true" }))).toBe(
      "script-cycle: b"
    )
    expect(whyOf(decide("npm run a", { a: "npm run a && npm run c", c: "true" }))).toBe("script-cycle: a")
  })

  it("leaves a step whole when it passes an option or an argument", () => {
    expect(whyOf(decide("npm run check --silent", chain))).toBe("script-arguments: --silent")
    expect(whyOf(decide("npm run check -- --fix", chain))).toBe("script-arguments: -- --fix")
    expect(whyOf(decide("npm run check --if-present", chain))).toBe("script-arguments: --if-present")
  })

  it("leaves a step with a time limit whole: the limit is for the whole script", () => {
    const runner = "__smithers_ci_step() {\n__limit=600; __allowed='10 minutes'\n}"
    expect(whyOf(decide("npm run check", chain, {}, { runner }))).toBe("script-limit: ")
    expect(namesOf(decide("npm run check", chain, {}, { runner: "__smithers_ci_step() {\n:\n}" }))).toEqual([
      "lint",
      "types"
    ])
  })

  it("leaves the first step of a job whole when others follow it and its runner keeps what it leaves", () => {
    const runner = "__smithers_ci_step() {\n:\n}"
    const first = (extra: Partial<Step>, leads: boolean): Script.Decision =>
      Script.decide(step("npm run check", extra), files({ "package.json": manifest(chain) }), leads)
    expect(whyOf(first({ runner }, true))).toBe("script-first: ")
    // A step run as plain shell text keeps nothing for later steps, and neither does a step with none after it.
    expect(namesOf(first({}, true))).toEqual(["lint", "types"])
    expect(namesOf(first({ runner }, false))).toEqual(["lint", "types"])
  })

  it("leaves a step whole when it or the repository sets how the package manager runs a script", () => {
    expect(whyOf(decide("npm run check", chain, {}, { env: { npm_config_script_shell: "zsh" } }))).toBe(
      "script-setting: the step's variable `npm_config_script_shell`"
    )
    expect(
      whyOf(
        decide("yarn verify", { verify: "yarn lint && yarn types", lint: "eslint .", types: "tsc" }, {}, {
          env: { YARN_SILENT: "1" }
        })
      )
    )
      .toBe("script-setting: the step's variable `YARN_SILENT`")
    expect(namesOf(decide("npm run check", chain, {}, { env: { NODE_ENV: "test" } }))).toEqual(["lint", "types"])
    expect(whyOf(decide("npm run check", chain, { ".npmrc": "audit=false\nscript-shell = /bin/zsh\n" }))).toBe(
      "script-setting: `script-shell` in `.npmrc`"
    )
    expect(namesOf(decide("npm run check", chain, { ".npmrc": "audit=false\n" }))).toEqual(["lint", "types"])
    const pnpm = { check: "pnpm lint && pnpm types", lint: "eslint .", types: "tsc" }
    expect(whyOf(decide("pnpm check", pnpm, { ".npmrc": "shell-emulator=true\n" }))).toBe(
      "script-setting: `shell-emulator` in `.npmrc`"
    )
    expect(whyOf(decide("pnpm check", pnpm, { "pnpm-workspace.yaml": "packages: []\nshellEmulator: true\n" })))
      .toBe("script-setting: `shellEmulator` in `pnpm-workspace.yaml`")
    // Another package manager's file says nothing about this one.
    expect(namesOf(decide("npm run check", chain, { "bunfig.toml": "[run]\nshell = \"bun\"\n" }))).toEqual([
      "lint",
      "types"
    ])
    const bun = { check: "bun run lint && bun run types", lint: "eslint .", types: "tsc" }
    expect(whyOf(decide("bun run check", bun, { "bunfig.toml": "[run]\nshell = \"bun\"\n" }))).toBe(
      "script-setting: `shell` in `bunfig.toml`"
    )
    const yarn = { verify: "yarn lint && yarn types", lint: "eslint .", types: "tsc" }
    expect(whyOf(decide("yarn verify", yarn, { ".yarnrc": "script-shell \"/bin/zsh\"\n" }))).toBe(
      "script-setting: `script-shell` in `.yarnrc`"
    )
    // A settings file that cannot be read may set anything.
    expect(whyOf(decide("npm run check", chain, { ".npmrc": null }))).toBe(
      "script-setting: what `.npmrc` sets, which cannot be read,"
    )
    expect(whyOf(decide("npm run check", chain, { "package-lock.json": null }))).toBe(
      "script-setting: what `package-lock.json` sets, which cannot be read,"
    )
    // A manifest that cannot be read names no script.
    expect(Script.decide(step("npm run check"), files({ "package.json": null })).kind).toBe("none")
    // The setting may sit beside the package or at the root.
    const inner = Script.decide(
      step("npm run check", { cwd: "app" }),
      files({ "app/package.json": manifest(chain), "app/.npmrc": "script-shell=zsh\n" })
    )
    expect(whyOf(inner)).toBe("script-setting: `script-shell` in `app/.npmrc`")
  })

  it("leaves a step whole under a package manager release a script inside a script was not checked under", () => {
    const yarn = { verify: "yarn lint && yarn types", lint: "eslint .", types: "tsc" }
    const yarnDecision = (held: Readonly<Record<string, string>>, extra: Readonly<Record<string, unknown>> = {}) =>
      Script.decide(step("yarn verify"), files({ "package.json": manifest(yarn, extra), ...held }))
    expect(whyOf(yarnDecision({}, { packageManager: "yarn@4.9.2" }))).toBe("script-release: Yarn 2 or later")
    expect(whyOf(yarnDecision({ ".yarnrc.yml": "nodeLinker: node-modules\n" }))).toBe(
      "script-release: Yarn 2 or later"
    )
    expect(whyOf(yarnDecision({ "yarn.lock": "__metadata:\n  version: 8\n" }))).toBe("script-release: Yarn 2 or later")
    expect(namesOf(yarnDecision({ "yarn.lock": "# yarn lockfile v1\n" }, { packageManager: "yarn@1.22.22" })))
      .toEqual(["lint", "types"])
    // A `packageManager` that names another program says nothing about Yarn.
    expect(namesOf(yarnDecision({}, { packageManager: "pnpm@9.0.0" }))).toEqual(["lint", "types"])
    expect(namesOf(yarnDecision({}, { packageManager: 4 }))).toEqual(["lint", "types"])

    const npmDecision = (held: Readonly<Record<string, string>>, extra: Readonly<Record<string, unknown>> = {}) =>
      Script.decide(step("npm run check"), files({ "package.json": manifest(chain, extra), ...held }))
    expect(whyOf(npmDecision({}, { packageManager: "npm@6.14.18" }))).toBe("script-release: npm 6 or earlier")
    expect(whyOf(npmDecision({ "package-lock.json": "{\n  \"lockfileVersion\": 1\n}" }))).toBe(
      "script-release: npm 6 or earlier"
    )
    expect(whyOf(npmDecision({ "npm-shrinkwrap.json": "{}" }))).toBe("script-release: npm 6 or earlier")
    expect(namesOf(npmDecision({ "package-lock.json": "{\n  \"lockfileVersion\": 3\n}" }, {
      packageManager: "npm@11.17.0"
    }))).toEqual(["lint", "types"])

    const pnpm = { check: "pnpm lint && pnpm types", lint: "eslint .", types: "tsc" }
    const pnpmDecision = (held: Readonly<Record<string, string>>, extra: Readonly<Record<string, unknown>> = {}) =>
      Script.decide(step("pnpm check"), files({ "package.json": manifest(pnpm, extra), ...held }))
    expect(whyOf(pnpmDecision({}, { packageManager: "pnpm@7.33.7" }))).toBe("script-release: pnpm 7 or earlier")
    expect(whyOf(pnpmDecision({ "pnpm-lock.yaml": "lockfileVersion: 5.4\n" }))).toBe(
      "script-release: pnpm 7 or earlier"
    )
    expect(whyOf(pnpmDecision({ "pnpm-lock.yaml": "packages: {}\n" }))).toBe("script-release: pnpm 7 or earlier")
    expect(namesOf(pnpmDecision({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }, { packageManager: "pnpm@10.20.0" })))
      .toEqual(["lint", "types"])

    // The package's own `packageManager` is nearer than the root's.
    const nearer = Script.decide(
      step("yarn verify", { cwd: "app" }),
      files({
        "app/package.json": manifest(yarn, { packageManager: "yarn@1.22.22" }),
        "package.json": manifest({}, { packageManager: "yarn@4.9.2" })
      })
    )
    expect(namesOf(nearer)).toEqual(["lint", "types"])
  })

  it("finds each package manager's command where its script would", () => {
    const scripts = (run: string) => ({
      check: `${run} lint && ${run} types`,
      verify: `${run} lint && ${run} types`,
      lint: "eslint .",
      types: "tsc"
    })
    const at = (command: string, run: string, cwd: string, held: Readonly<Record<string, string>> = {}) =>
      commandsOf(Script.decide(
        step(command, { cwd }),
        files({ [cwd === "" ? "package.json" : `${cwd}/package.json`]: manifest(scripts(run)), ...held })
      ))[0]
    // npm and Bun search the script's directory and every directory above it.
    expect(at("npm run check", "npm run", "packages/app")).toBe(
      `PATH="$PWD/node_modules/.bin:$PWD/../node_modules/.bin:$PWD/../../node_modules/.bin:$PATH" npm run lint`
    )
    expect(at("bun run check", "bun run", "app")).toBe(
      `PATH="$PWD/node_modules/.bin:$PWD/../node_modules/.bin:$PATH" bun run lint`
    )
    // pnpm searches the package and the workspace root.
    expect(at("pnpm check", "pnpm", "")).toBe(`PATH="$PWD/node_modules/.bin:$PATH" pnpm lint`)
    expect(at("pnpm check", "pnpm", "packages/app")).toBe(`PATH="$PWD/node_modules/.bin:$PATH" pnpm lint`)
    expect(at("pnpm check", "pnpm run", "packages/app", { "pnpm-workspace.yaml": "packages: ['packages/*']\n" }))
      .toBe(`PATH="$PWD/node_modules/.bin:$PWD/../../node_modules/.bin:$PATH" pnpm run lint`)
    // Yarn 1 puts itself first on the path, and leaves two variables set for the runs inside a script.
    expect(at("yarn verify", "yarn", "")).toBe(
      `YARN_WRAP_OUTPUT=false npm_config_argv='{"remain":[],"cooked":["run","verify"],"original":["verify"]}' ` +
        `yarn lint`
    )
    expect(at("yarn run verify", "yarn run", "")).toBe(
      `YARN_WRAP_OUTPUT=false npm_config_argv='{"remain":[],"cooked":["run","verify"],"original":["run","verify"]}' ` +
        `yarn run lint`
    )
  })
})

describe("the sentences for a step left whole", () => {
  const packageDir = join(dirname(fileURLToPath(import.meta.url)), "../..")

  it("has one for every reason the splitter records", () => {
    const source = readFileSync(join(packageDir, "src/decompose/Script.ts"), "utf8")
    const recorded = [...source.matchAll(/whole\("([a-z-]+)"/g)].map((match) => match[1] as string)
    expect(recorded.length).toBeGreaterThan(6)
    expect([...new Set(recorded)].sort()).toEqual(Object.keys(wholeScript).sort())
  })

  it("fills in what the reason names", () => {
    expect(wholeScriptSentence({ feature: "script-hook", detail: "precheck" })).toBe(
      "stays one step: the script has the hook `precheck`, which the package manager runs with it"
    )
    expect(wholeScriptSentence({ feature: "script-syntax", detail: "joins commands with `||`" })).toBe(
      "stays one step: the script joins commands with `||`"
    )
    expect(wholeScriptSentence({ feature: "script-limit", detail: "" })).toBe(
      "stays one step: the step has a time limit, which is for the whole script"
    )
    // A detail is text from the repository: `$&` in it is not a pattern.
    expect(wholeScriptSentence({ feature: "script-command", detail: "echo $& x" })).toContain("`echo $& x`")
    expect(wholeScriptSentence({ feature: "unknown", detail: "x" })).toBe(
      "stays one step: its commands cannot be run one at a time"
    )
  })

  it("is the table in the splitting page, word for word", () => {
    const page = readFileSync(join(packageDir, "docs/concepts/splitting.md"), "utf8")
    const section = page.slice(page.indexOf("### Why a script stays one step"))
    const rows = section.slice(0, section.indexOf("\n## ")).split("\n").filter((line) => line.startsWith("| `"))
      .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()))
      .map(([feature, meaning]) => [(feature as string).replaceAll("`", ""), meaning])
    // `script-first` and `script-limit` name nothing.
    const slots: Readonly<Record<string, string>> = {
      "script-arguments": "WORDS",
      "script-command": "COMMAND",
      "script-cycle": "SCRIPT",
      "script-hook": "HOOK",
      "script-release": "RELEASE",
      "script-setting": "SETTING",
      "script-syntax": "WHAT"
    }
    expect(rows).toEqual(
      Object.keys(wholeScript).sort().map((feature) => [
        feature,
        (wholeScript[feature] as string).replace("{}", slots[feature] ?? "")
      ])
    )
  })

  it("uses no word only this project uses", () => {
    for (const sentence of Object.values(wholeScript)) {
      expect(sentence).not.toMatch(/\b(inventory|target|scorer|contract)\b/i)
    }
  })
})
