/**
 * Which CI steps change the machine they run on, read from their commands.
 *
 * A replay runs a repository's past commits on a person's own computer. A step
 * that runs `sudo`, installs a system package, starts a service or installs a
 * program for every project changes that computer, so its job is not replayed.
 * Nothing here runs anything: `Machine.vibe` asks the package manager which
 * packages are already there, and `withInstalled` uses the answers.
 *
 * The reader errs toward finding a change. It sees through quotes, `$( )`,
 * subshells, `bash -c`, `eval`, `env`, `xargs` and `find -exec`, and reads the
 * text of a here-document as commands. What it cannot see, such as a script
 * that calls `sudo` inside, the replay's stand-ins for `sudo` stop at run time.
 *
 * @since 0.1.0
 */

import {
  blockers,
  changesMachine,
  ciJobs,
  hostAction,
  type Inventory,
  type Job,
  type Step,
  type Unsupported
} from "../contract/Inventory.ts"
import { type Command, commands, type Word } from "../decompose/Shell.ts"

/**
 * What one command does to the machine.
 *
 * - `install` puts named packages on it. `checkable` is false when the machine
 *   cannot be asked whether the install is already done.
 * - `refresh` updates a package manager's list of packages, and matters only
 *   when nothing else needs the machine changed.
 * - `other` is anything else, with what a person would call it.
 *
 * @category models
 * @since 0.1.0
 */
export type Change =
  | {
    readonly kind: "install"
    readonly manager: string
    readonly packages: ReadonlyArray<string>
    readonly checkable: boolean
  }
  | { readonly kind: "refresh"; readonly manager: string; readonly what: string }
  | { readonly kind: "other"; readonly what: string }

/**
 * Packages a step installs with one manager.
 *
 * @category models
 * @since 0.1.0
 */
export interface Install {
  readonly manager: string
  readonly packages: ReadonlyArray<string>
}

/**
 * How to ask the machine about one package: the command to run, and what its
 * output must hold when the command exits 0. An empty `holds` asks for any
 * output at all.
 *
 * @category models
 * @since 0.1.0
 */
export interface Question {
  readonly manager: string
  readonly name: string
  readonly argv: readonly [string, ...Array<string>]
  readonly holds: ReadonlyArray<string>
}

type Asker = "dpkg" | "rpm" | "brew" | "pacman" | "apk"

interface Family {
  readonly installs: ReadonlyArray<string>
  readonly refreshes: ReadonlyArray<string>
  readonly reads: ReadonlyArray<string>
  readonly valueFlags: ReadonlyArray<string>
  readonly asker?: Asker
}

const apt: Family = {
  installs: ["install"],
  refreshes: ["update"],
  reads: [
    ...["list", "show", "showsrc", "search", "policy", "depends", "rdepends", "changelog"],
    ...["download", "source", "check", "indextargets", "help", "moo"]
  ],
  valueFlags: ["-o", "--option", "-t", "--target-release", "--default-release", "-c", "--config-file", "-a"],
  asker: "dpkg"
}

const rpmBased: Family = {
  installs: ["install"],
  refreshes: ["makecache", "check-update"],
  reads: ["list", "info", "search", "provides", "whatprovides", "repolist", "repoquery", "deplist", "history", "help"],
  valueFlags: ["--repo", "--enablerepo", "--disablerepo", "--exclude", "-x", "--releasever", "--setopt", "-c"],
  asker: "rpm"
}

/** The system package managers whose commands name what they do with a word. */
const families: ReadonlyMap<string, Family> = new Map<string, Family>([
  ["apt", apt],
  ["apt-get", apt],
  ["aptitude", apt],
  ["dnf", rpmBased],
  ["yum", rpmBased],
  ["microdnf", rpmBased],
  ["zypper", {
    installs: ["install", "in"],
    refreshes: ["refresh", "ref"],
    reads: [
      ...["search", "se", "info", "if", "packages", "pa", "patterns", "pt", "products", "pd"],
      ...["repos", "lr", "services", "ls", "list-updates", "lu", "what-provides", "wp"]
    ],
    valueFlags: ["-r", "--repo", "-t", "--type"],
    asker: "rpm"
  }],
  ["apk", {
    installs: ["add"],
    refreshes: ["update"],
    reads: ["info", "search", "list", "policy", "version", "dot", "stats"],
    valueFlags: ["-X", "--repository", "-p", "--root", "-t", "--virtual"],
    asker: "apk"
  }],
  ["brew", {
    installs: ["install"],
    refreshes: ["update"],
    reads: [
      ...["list", "ls", "info", "abv", "search", "config", "doctor", "dr", "deps", "uses", "leaves", "outdated"],
      ...["desc", "home", "homepage", "cat", "formula", "shellenv", "commands", "tap-info", "missing", "log", "fetch"]
    ],
    valueFlags: [],
    asker: "brew"
  }],
  ["port", {
    installs: ["install"],
    refreshes: ["sync"],
    reads: ["installed", "info", "list", "search", "contents", "deps", "rdeps", "outdated", "echo", "version"],
    valueFlags: []
  }],
  ["choco", {
    installs: ["install"],
    refreshes: [],
    reads: ["list", "search", "find", "info", "outdated", "help"],
    valueFlags: ["-s", "--source", "--version"]
  }],
  ["winget", {
    installs: ["install", "add"],
    refreshes: [],
    reads: ["list", "ls", "search", "find", "show", "view", "export", "hash", "validate"],
    valueFlags: ["--id", "-e", "--source", "-s", "--version", "-v"]
  }],
  ["scoop", {
    installs: ["install"],
    refreshes: ["update"],
    reads: ["list", "info", "search", "status", "which", "prefix", "cat", "home", "depends", "checkup", "export"],
    valueFlags: []
  }],
  ["snap", {
    installs: ["install"],
    refreshes: [],
    reads: ["list", "info", "find", "search", "version", "changes", "connections", "services", "get", "known", "help"],
    valueFlags: ["--channel"]
  }]
])

/** Package tools whose operation is a flag, each with the flags that only read. */
const flagTools: ReadonlyMap<string, RegExp> = new Map([
  [
    "dpkg",
    /^(?:-[sLlSpIcWf]|--(?:status|list|listfiles|search|print-avail|info|contents|field|show|print-architecture|print-foreign-architectures|compare-versions|get-selections|version|help|audit|verify))/
  ],
  ["rpm", /^(?:-[A-Za-z]*q|--query|-V|--verify|--version|--help|--eval|-E|--showrc|-K|--checksig)/]
])

/** The service managers, each with the words that only read. */
const services: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["systemctl", [
    ...["status", "is-active", "is-enabled", "is-failed", "is-system-running", "show", "cat", "help", "get-default"],
    ...["list-units", "list-unit-files", "list-sockets", "list-timers", "list-jobs", "list-dependencies"]
  ]],
  ["launchctl", [
    ...["list", "print", "print-cache", "print-disabled", "getenv", "version", "help", "managername"],
    ...["manageruid", "managerpid", "hostinfo", "blame", "error", "examine", "procinfo", "plist"]
  ]]
])

const privilege: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["sudo", [
    "-u",
    "--user",
    "-g",
    "--group",
    "-h",
    "--host",
    "-p",
    "--prompt",
    "-C",
    "-r",
    "-t",
    "-T",
    "-U",
    "-D",
    "-R"
  ]],
  ["doas", ["-u", "-C"]]
])

/** Programs that run the command they are given, and the flags of theirs that take a value. */
const runners: ReadonlySet<string> = new Set([
  ...["env", "command", "builtin", "exec", "nice", "ionice", "nohup", "timeout", "stdbuf", "setsid", "chronic", "xargs"]
])
const runnerValueFlags: ReadonlyArray<string> = ["-u", "-C", "-S", "-I", "-E", "-d", "-a", "-L", "-s", "-k", "-c", "-p"]
const shells: ReadonlySet<string> = new Set(["sh", "bash", "dash", "zsh", "ksh"])

/** Words that may stand before a command. */
const leading: ReadonlySet<string> = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "time"])

/** How deep commands inside commands are followed. */
const maxDepth = 8

const isFlag = (word: string): boolean => word.startsWith("-")
const assignmentOf = (word: string): readonly [string, string] | undefined => {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word)
  return match === null ? undefined : [match[1] as string, match[2] as string]
}

/** The first word that is no flag, and the words after it. A flag in `valueFlags` takes the next word with it. */
const verbOf = (
  args: ReadonlyArray<string>,
  valueFlags: ReadonlyArray<string>
): { readonly verb: string; readonly rest: ReadonlyArray<string> } | undefined => {
  for (let at = 0; at < args.length; at++) {
    const word = args[at] as string
    if (!isFlag(word)) return { verb: word, rest: args.slice(at + 1) }
    if (valueFlags.includes(word)) at += 1
  }
  return undefined
}

/** The words that are no flags, without the values of flags that take one. */
const operands = (args: ReadonlyArray<string>, valueFlags: ReadonlyArray<string>): ReadonlyArray<string> => {
  const found = verbOf(args, valueFlags)
  return found === undefined ? [] : [found.verb, ...operands(found.rest, valueFlags)]
}

const run = (what: string): Change => ({ kind: "other", what })

const ofFamily = (name: string, family: Family, args: ReadonlyArray<string>): Change | undefined => {
  const found = verbOf(args, family.valueFlags)
  if (found === undefined || family.reads.includes(found.verb)) return undefined
  const what = `${name} ${found.verb}`
  const packages = operands(found.rest, family.valueFlags)
  if (family.refreshes.includes(found.verb) && packages.length === 0) return { kind: "refresh", manager: name, what }
  if (!family.installs.includes(found.verb) || packages.length === 0) return run(what)
  return { kind: "install", manager: name, packages, checkable: !found.rest.includes("--cask") }
}

const ofPacman = (args: ReadonlyArray<string>): Change | undefined => {
  const operation = args.find((word) => /^-[A-Za-z]/.test(word)) ?? (args.includes("--sync") ? "-S" : args[0] ?? "")
  if (!/^-[A-Za-z]*S/.test(operation)) {
    return operation === "" || /^(?:-[QFTVh]|--(?:query|files|version|help))/.test(operation)
      ? undefined
      : run("pacman")
  }
  if (/[sigpl]/.test(operation.slice(1))) return undefined
  const packages = operands(args, [])
  if (/[uc]/.test(operation.slice(1))) return run(`pacman ${operation}`)
  if (packages.length > 0) return { kind: "install", manager: "pacman", packages, checkable: true }
  return operation.includes("y") ? { kind: "refresh", manager: "pacman", what: "pacman -Sy" } : run("pacman -S")
}

const ofService = (name: string, reads: ReadonlyArray<string>, args: ReadonlyArray<string>): Change | undefined => {
  const verb = verbOf(args, [])?.verb
  return verb === undefined || reads.includes(verb) ? undefined : run(`${name} ${verb}`)
}

/** `service <name> <action>`: only `status` reads, as does `--status-all`. */
const ofServiceCommand = (args: ReadonlyArray<string>): Change | undefined =>
  args.length === 0 || args.includes("--status-all") || args[1] === "status" || isFlag(args[0] as string)
    ? undefined
    : run(`service ${args.slice(1, 2).join(" ")}`.trimEnd())

const isGlobal = (args: ReadonlyArray<string>): boolean =>
  args.some((word) => ["-g", "--global", "--global=true", "--location=global"].includes(word))

const installWords = ["install", "i", "in", "add", "uninstall", "un", "remove", "rm", "r", "update", "up", "upgrade"]

/** A checkout-relative directory, or one built from the checkout's own path, keeps an install inside the checkout. */
const insideCheckout = (value: string): boolean =>
  /^(?:\.|\$PWD|\$\{PWD\}|\$\(pwd\)|\$\{\{\s*github\.workspace|[^/$~])/.test(value)

type Rule = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>>) => string | undefined

const globalWith = (name: string): Rule => (args) => {
  const verb = verbOf(args, [])?.verb
  return verb !== undefined && installWords.includes(verb) && isGlobal(args) ? `${name} ${verb} -g` : undefined
}

/** `pip install` writes outside a virtual environment only when told to pass the system's own protection. */
const ofPip = (
  name: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>
): string | undefined => {
  const verb = verbOf(args, [])?.verb
  const forced = args.includes("--break-system-packages") || env["PIP_BREAK_SYSTEM_PACKAGES"] === "1"
  return forced && (verb === "install" || verb === "uninstall") ? `${name} ${verb} --break-system-packages` : undefined
}

/**
 * What each language's tool writes outside the checkout.
 *
 * - `npm -g` writes beside Node. `pnpm -g`, `bun -g`, `deno -g` and `yarn
 *   global` write the tool's directory in the home directory. `npm link` with
 *   no package links the checkout into npm's global directory.
 * - `corepack enable` writes `pnpm` and `yarn` beside Node.
 * - `gem install` writes Ruby's own directory, unless `--user-install`,
 *   `--install-dir` or `GEM_HOME` says where.
 * - `cargo install` writes `~/.cargo/bin` unless `--root` or
 *   `CARGO_INSTALL_ROOT` says where.
 * - `go install` writes `~/go/bin` unless `GOBIN` or `GOPATH` points into the
 *   checkout.
 * - `uv pip --system` writes the system's Python.
 */
const languageRules: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  ["npm", (args, env) => args.length === 1 && args[0] === "link" ? "npm link" : globalWith("npm")(args, env)],
  ["pnpm", globalWith("pnpm")],
  ["bun", globalWith("bun")],
  ["deno", globalWith("deno")],
  ["yarn", (args) =>
    args[0] === "global" && ["add", "remove", "upgrade"].includes(args[1] as string)
      ? `yarn global ${args[1]}`
      : undefined],
  ["corepack", (args) => ["enable", "disable"].includes(args[0] as string) ? `corepack ${args[0]}` : undefined],
  ["gem", (args, env) => {
    const verb = verbOf(args, [])?.verb
    const elsewhere = ["--user-install", "--user", "-i", "--install-dir"].some((flag) => args.includes(flag))
    return ["install", "uninstall", "update"].includes(verb as string) && !elsewhere && env["GEM_HOME"] === undefined
      ? `gem ${verb}`
      : undefined
  }],
  ["cargo", (args, env) => {
    const verb = verbOf(args.filter((word) => !word.startsWith("+")), ["--config", "-Z", "-C"])?.verb
    const elsewhere = ["--list", "--root"].some((flag) => args.includes(flag)) ||
      env["CARGO_INSTALL_ROOT"] !== undefined
    return (verb === "install" || verb === "uninstall") && !elsewhere ? `cargo ${verb}` : undefined
  }],
  ["go", (args, env) => {
    const directory = env["GOBIN"] ?? env["GOPATH"]
    return args[0] === "install" && (directory === undefined || !insideCheckout(directory)) ? "go install" : undefined
  }],
  ["uv", (args) => args[0] === "pip" && args.includes("--system") ? "uv pip --system" : undefined]
])

/** The name of the program a word starts: an absolute path counts as its last part, a path in the checkout is no name. */
const programOf = (word: string): string | undefined =>
  !word.includes("/") ? word : word.startsWith("/") ? word.slice(word.lastIndexOf("/") + 1) : undefined

/** What a program that runs another one is given to run, past its flags, assignments, numbers and placeholders. */
const commandAfter = (args: ReadonlyArray<string>, valueFlags: ReadonlyArray<string>): ReadonlyArray<string> => {
  let at = 0
  while (at < args.length) {
    const word = args[at] as string
    if (valueFlags.includes(word)) at += 2
    else if (isFlag(word) || assignmentOf(word) !== undefined || /^\d+[smhd]?$/.test(word) || word === "{}") at += 1
    else break
  }
  return args.slice(at)
}

const textsOf = (words: ReadonlyArray<Word>): ReadonlyArray<string> => words.map((word) => word.text)

/** The commands `find` starts: what follows each `-exec` or `-ok`, up to its `;` or `+`. */
const findCommands = (args: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
  args.flatMap((word, at) => {
    if (!/^-(?:exec|ok)(?:dir)?$/.test(word)) return []
    const rest = args.slice(at + 1)
    const end = rest.findIndex((item) => item === ";" || item === "+")
    return [end < 0 ? rest : rest.slice(0, end)]
  })

/** What one command, given as its words, does to the machine. */
const classify = (
  words: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  depth: number
): ReadonlyArray<Change> => {
  let at = 0
  let scope = env
  for (; at < words.length; at++) {
    const word = words[at] as string
    const assigned = assignmentOf(word)
    if (assigned !== undefined) scope = { ...scope, [assigned[0]]: assigned[1] }
    // `$SUDO apt-get install x`: the variable is passed over, and what it runs is read.
    else if (!leading.has(word) && !word.startsWith("$")) break
  }
  const first = words[at]
  const name = first === undefined ? undefined : programOf(first)
  if (name === undefined || depth > maxDepth) return []
  const args = words.slice(at + 1)
  const inner = (next: ReadonlyArray<string>) => classify(next, scope, depth + 1)
  const options = privilege.get(name)
  if (options !== undefined) {
    const rest = commandAfter(args, options)
    if (rest.length === 0) return [run(name)]
    const within = inner(rest)
    return within.length > 0 ? within : [run(`${name} ${programOf(rest[0] as string) ?? rest[0]}`)]
  }
  if (name === "su") return [run("su")]
  if (name === "command" && args.some((word) => word === "-v" || word === "-V")) return []
  if (runners.has(name)) return inner(commandAfter(args, runnerValueFlags))
  if (name === "eval") return scan(args.join(" "), scope, depth + 1)
  if (shells.has(name)) {
    const flag = args.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word))
    return flag < 0 || args[flag + 1] === undefined ? [] : scan(args[flag + 1] as string, scope, depth + 1)
  }
  if (name === "find") return findCommands(args).flatMap(inner)
  if (/^python[\d.]*$/.test(name) && args[0] === "-m" && args[1] === "pip") {
    const what = ofPip("pip", args.slice(2), scope)
    return what === undefined ? [] : [run(what)]
  }
  const pip = /^pip[\d.]*$/.test(name) ? ofPip("pip", args, scope) : undefined
  if (pip !== undefined) return [run(pip)]
  const family = families.get(name)
  const flagged = flagTools.get(name)
  const service = services.get(name)
  const language = languageRules.get(name)?.(args, scope)
  const change = family !== undefined
    ? ofFamily(name, family, args)
    : flagged !== undefined
    ? args.length === 0 || args.some((word) => flagged.test(word)) ? undefined : run(name)
    : name === "pacman"
    ? ofPacman(args)
    : service !== undefined
    ? ofService(name, service, args)
    : name === "service"
    ? ofServiceCommand(args)
    : language === undefined
    ? undefined
    : run(language)
  return change === undefined ? [] : [change]
}

const closingOf = (text: string, start: number, open: string, close: string): number => {
  let depth = 0
  for (let at = start; at < text.length; at++) {
    const char = text[at]
    if (char === "\\") at += 1
    else if (char === open) depth += 1
    else if (char === close && --depth === 0) return at
  }
  return text.length
}

/** Every simple command of a script, as its words with quotes removed, and what the commands inside it do. */
const scan = (script: string, env: Readonly<Record<string, string>>, depth: number): ReadonlyArray<Change> => {
  const found: Array<Change> = []
  let words: Array<string> = []
  let word: string | undefined
  let redirected = false
  const add = (text: string) => {
    word = (word ?? "") + text
  }
  const endWord = () => {
    if (word !== undefined && !redirected) words.push(word)
    if (word !== undefined) redirected = false
    word = undefined
  }
  const endCommand = () => {
    endWord()
    redirected = false
    found.push(...classify(words, env, depth))
    words = []
  }
  const nested = (inner: string) => {
    if (depth < maxDepth) found.push(...scan(inner, env, depth + 1))
  }
  /** Reads what starts with `$` at `at` into the word and returns where it ends. */
  const dollar = (at: number): number => {
    const next = script[at + 1]
    if (next === "(") {
      const end = closingOf(script, at + 1, "(", ")")
      nested(script.slice(at + 2, end))
      add("$()")
      return end + 1
    }
    if (next === "{") {
      const end = closingOf(script, at + 1, "{", "}")
      add(script.slice(at, end + 1))
      return end + 1
    }
    const end = at + 1 + (/^[A-Za-z0-9_?!$#@*-]*/.exec(script.slice(at + 1)) as RegExpExecArray)[0].length
    add(script.slice(at, end))
    return end
  }
  const backtick = (at: number): number => {
    let end = at + 1
    while (end < script.length && script[end] !== "`") end += script[end] === "\\" ? 2 : 1
    nested(script.slice(at + 1, end))
    add("$()")
    return end + 1
  }
  let at = 0
  while (at < script.length) {
    const char = script[at] as string
    if (char === "\\") {
      if (script[at + 1] !== "\n") add(script[at + 1] ?? "")
      at += 2
    } else if (char === "'") {
      const close = script.indexOf("'", at + 1)
      const end = close < 0 ? script.length : close
      add(script.slice(at + 1, end))
      at = end + 1
    } else if (char === "\"") {
      add("")
      at += 1
      while (at < script.length && script[at] !== "\"") {
        const inner = script[at] as string
        if (inner === "\\") {
          add(script[at + 1] ?? "")
          at += 2
        } else if (inner === "$") at = dollar(at)
        else if (inner === "`") at = backtick(at)
        else {
          add(inner)
          at += 1
        }
      }
      at += 1
    } else if (char === "$") {
      at = dollar(at)
    } else if (char === "`") {
      at = backtick(at)
    } else if (char === "#" && word === undefined) {
      while (at < script.length && script[at] !== "\n") at += 1
    } else if (char === "<" || char === ">") {
      // A number right before it names a stream, and the word after it is where the stream goes.
      if (word !== undefined && /^\d+$/.test(word)) word = undefined
      endWord()
      redirected = true
      while (/[<>&|-]/.test(script[at] ?? "")) at += 1
      // `2>&1` has its target attached.
      if (/^\d+(?![^\s;|&()])/.test(script.slice(at))) {
        at += (/^\d+/.exec(script.slice(at)) as RegExpExecArray)[0].length
        redirected = false
      }
    } else if ("\n;&|()".includes(char)) {
      endCommand()
      at += 1
    } else if (/\s/.test(char)) {
      endWord()
      at += 1
    } else {
      add(char)
      at += 1
    }
  }
  endCommand()
  return found
}

/**
 * What a step's command does to the machine, in the order it does it.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const changesIn = (command: string, env: Readonly<Record<string, string>> = {}): ReadonlyArray<Change> =>
  scan(command, env, 0)

const listed = (names: ReadonlyArray<string>): string =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`

/** The lines that say what a job's changes are: what it runs, then what it installs with each manager. */
const linesFor = (changes: ReadonlyArray<Change>): ReadonlyArray<string> => {
  const installs = new Map<string, Array<string>>()
  for (const change of changes) {
    if (change.kind === "install") {
      installs.set(change.manager, [...installs.get(change.manager) ?? [], ...change.packages])
    }
  }
  const runs = changes.flatMap((change) =>
    change.kind === "other" || (change.kind === "refresh" && !installs.has(change.manager)) ? [change.what] : []
  )
  return [
    ...(runs.length === 0 ? [] : [`runs ${listed([...new Set(runs)])}`]),
    ...[...installs].map(([manager, packages]) => `installs ${listed([...new Set(packages)])} with ${manager}`)
  ]
}

const changesOfStep = (step: Step): ReadonlyArray<Change> => changesIn(step.command, step.env)

/**
 * A job with one `changes-machine` entry for each thing its steps do to the
 * machine. A job with no such step is returned as it is.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const markChanges = <J extends Job>(job: J): J => {
  const lines = linesFor(job.steps.flatMap(changesOfStep))
  return lines.length === 0
    ? job
    : { ...job, unsupported: [...job.unsupported, ...lines.map((detail) => ({ feature: changesMachine, detail }))] }
}

const askers: ReadonlyMap<string, Asker> = new Map<string, Asker>([
  ["pacman", "pacman"],
  ...[...families].flatMap(([name, family]): ReadonlyArray<readonly [string, Asker]> =>
    family.asker === undefined ? [] : [[name, family.asker]]
  )
])

const plainName = /^[A-Za-z0-9](?:[A-Za-z0-9+._@-]*[A-Za-z0-9+_@])?$/
const debianName = /^[A-Za-z0-9](?:[A-Za-z0-9+.:_-]*[A-Za-z0-9+_])?(?:=[A-Za-z0-9+.:~_-]+)?(?:\/[a-z0-9.-]+)?$/
const brewName = /^[A-Za-z0-9](?:[A-Za-z0-9+._@/-]*[A-Za-z0-9+_@])?$/

/**
 * How to ask `manager` whether `name` is installed, or `undefined` when it
 * cannot be asked: a manager with no way to ask, or a name that is a file, a
 * group or a pattern.
 *
 * `dpkg -s` also answers for a package that was removed and left its settings,
 * so its answer must say the package is installed, at the version when one is
 * named.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const questionFor = (manager: string, name: string): Question | undefined => {
  const asker = askers.get(manager)
  const shape = asker === "dpkg" ? debianName : asker === "brew" ? brewName : plainName
  if (asker === undefined || !shape.test(name)) return undefined
  const base = { manager, name }
  if (asker === "dpkg") {
    const [wanted, version] = (name.split("/")[0] as string).split("=") as [string, string | undefined]
    return {
      ...base,
      argv: ["dpkg", "-s", wanted],
      holds: ["Status: install ok installed", ...(version === undefined ? [] : [`Version: ${version}`])]
    }
  }
  const argv: Readonly<Record<Exclude<Asker, "dpkg">, readonly [string, ...Array<string>]>> = {
    rpm: ["rpm", "-q", name],
    brew: ["brew", "list", "--versions", name],
    pacman: ["pacman", "-Q", name],
    apk: ["apk", "info", "-e", name]
  }
  return { ...base, argv: argv[asker], holds: [] }
}

/**
 * True when a program's output answers a question with yes. A line of `holds`
 * must be a whole line of the output.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const answers = (question: Question, output: string): boolean => {
  const lines = output.split("\n").map((line) => line.trimEnd())
  return question.holds.length === 0
    ? output.trim() !== ""
    : question.holds.every((wanted) => lines.includes(wanted))
}

/** True for a command that always runs, alone, with every word known. */
const isBare = (item: Command): boolean =>
  !item.piped && !item.background && !item.conditional && ["first", ";", "&&"].includes(item.joint)
  && item.words.every((word) => word.literal) && item.assignments.every(([, value]) => value.literal)

/**
 * The packages a step does nothing but install, one entry per command, or
 * `undefined` when the step does anything else or a package cannot be asked
 * about. A step that only refreshes a package list installs nothing and gives
 * an empty list. `set` lines are allowed, as is one `sh -c` around the script.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const installsOf = (command: string): ReadonlyArray<Install> | undefined => {
  const list = commands(command)
  if (list === undefined || list.length === 0) return undefined
  const lone = list.length === 1 ? textsOf((list[0] as Command).words) : []
  if (shells.has(lone[0] as string) && /^-[A-Za-z]*c[A-Za-z]*$/.test(lone[1] ?? "") && lone.length === 3) {
    return installsOf(lone[2] as string)
  }
  const installs: Array<Install> = []
  for (const item of list) {
    const words = textsOf(item.words)
    if (!isBare(item)) return undefined
    if (words[0] === "set") continue
    const changes = classify(words, {}, 0)
    const change = changes[0]
    if (changes.length !== 1 || change === undefined || change.kind === "other") return undefined
    if (change.kind === "refresh") continue
    if (!change.checkable || change.packages.some((name) => questionFor(change.manager, name) === undefined)) {
      return undefined
    }
    installs.push({ manager: change.manager, packages: change.packages })
  }
  return installs
}

/** What `withInstalled` needs of a job: each step with what it installs, when installing is all the job's changes. */
const installSteps = (job: Job) => {
  const blocks = blockers(job)
  if (blocks.length === 0 || blocks.some((entry) => entry.feature !== changesMachine)) return undefined
  const steps = job.steps.map((step) => {
    const changes = changesOfStep(step).length > 0
    return { step, changes, installs: changes ? installsOf(step.command) : undefined }
  })
  return steps.some((entry) => entry.changes && entry.installs === undefined) ? undefined : steps
}

/**
 * Everything the machine must be asked before `withInstalled`: each package a
 * CI job for which `runs` is true does nothing but install, once.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const questionsFor = (inventory: Inventory, runs: (job: Job) => boolean): ReadonlyArray<Question> => {
  const found = new Map<string, Question>()
  for (const job of ciJobs(inventory).filter(runs)) {
    for (const { installs } of installSteps(job) ?? []) {
      for (const { manager, packages } of installs ?? []) {
        for (const name of packages) {
          found.set(`${manager}\n${name}`, questionFor(manager, name) as Question)
        }
      }
    }
  }
  return [...found.values()]
}

/**
 * The inventory on a machine that holds the packages `present` says it does.
 *
 * A CI job whose every change is an install, of packages all on the machine,
 * loses those steps and its `changes-machine` entries, so it runs without them
 * in the baseline and as targets. A job left with no step is listed as having
 * no command. With a package missing, the entries name what to install. Every
 * other job is as it was.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const withInstalled = (
  inventory: Inventory,
  runs: (job: Job) => boolean,
  present: (manager: string, name: string) => boolean
): Inventory => {
  const inCi = new Set(ciJobs(inventory).filter(runs).map((job) => job.id))
  const jobs = inventory.jobs.map((job): Job => {
    const steps = inCi.has(job.id) ? installSteps(job) : undefined
    if (steps === undefined) return job
    const kept = job.unsupported.filter((entry) => entry.feature !== changesMachine)
    const missing = new Map<string, Array<string>>()
    for (const { manager, packages } of steps.flatMap((entry) => entry.installs ?? [])) {
      const absent = packages.filter((name) => !present(manager, name))
      if (absent.length > 0) missing.set(manager, [...new Set([...missing.get(manager) ?? [], ...absent])])
    }
    if (missing.size > 0) {
      const lines = [...missing].map(([manager, names]): Unsupported => ({
        feature: changesMachine,
        detail: `install ${listed(names)} with ${manager} to replay this job`
      }))
      return { ...job, unsupported: [...kept, ...lines] }
    }
    const remaining = steps.filter((entry) => !entry.changes).map((entry) => entry.step)
    const noneLeft: ReadonlyArray<Unsupported> = remaining.length > 0
      ? []
      : [{ feature: hostAction, detail: `${job.file}: every step installs packages this machine already has` }]
    return { ...job, steps: remaining, unsupported: [...kept, ...noneLeft] }
  })
  return { ...inventory, jobs }
}
