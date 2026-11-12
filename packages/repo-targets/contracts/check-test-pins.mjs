/**
 * Fails when a test pin in any package group is not written down in
 * test-pins.md beside it.
 *
 * A pin is a test the default gate never runs to a pass. Three forms count:
 * `it.fails`/`test.fails` (an assertion that current behavior is wrong),
 * `.skip`/`.todo` (disabled outright), and a `.skipIf`/`.runIf` gated on an
 * environment variable nothing in the repo sets. Each has other spellings that
 * count the same: `.each(...)` after the modifier, a title that is not a
 * literal, a `{ skip: true }` (or `todo`, `fails`) options object, a literal
 * `skipIf(true)`/`runIf(false)`, and a `ctx.skip()` inside the test body under
 * an opt-in environment condition. All three are legitimate
 * occasionally and all three rot silently, so the rule is not "no pins" — it is
 * "no pin the docs do not explain". The 2026-08-16 readiness audit's F4 line
 * item existed because nothing enforced that.
 *
 * A `.skipIf`/`.runIf` on `process.platform`, on an installed binary, or on a
 * built artifact is a capability gate, not a pin: it runs on the supported
 * configuration. So is one on a variable the package's own `test` target
 * supplies: `flows/database` declares a `testProgram` that starts PostgreSQL
 * and sets `SMITHERS_TEST_PG_URL`, so its PostgreSQL suite runs in that target,
 * and the `smithers` test target's `env` sets `SMITHERS_HISTORY_TEST_PG_URL`
 * beside its declared PostgreSQL service.
 *
 * Group membership comes from `smthrs.group`, the same authority the release
 * train uses, so a new package is covered without being listed here. The 1.0
 * release train packs the engine and agent groups together, so the register
 * covers every group: an unexplained pin in a package a user installs is the
 * case this guard exists for.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { libraryPackages, isMain, repoRoot } from "../scripts/workspace-packages.mjs"

/** The package groups whose pins this register covers. */
export const guardedGroups = new Set(["engine", "agent", "tooling"])

export const notesPath = join(repoRoot, "packages/repo-targets/contracts", "test-pins.md")

/** This guard's own suite, which lives in a guarded package and spells every pin form as a fixture. */
const ownSuite = fileURLToPath(new URL("./check-test-pins.test.mjs", import.meta.url))

/**
 * Matches an outright pin's modifier, and a `.each(` table call after it.
 *
 * The prefix is deliberately loose — `it`, `test`, `describe`, `it.effect`,
 * `it.live`, `it.scoped` all appear in this repo — but the modifier is anchored
 * to the exact pin forms. `it.fails.each([...])("title")` pins every row.
 */
const pinPattern = /\b(?:it|test|describe)(?:\.[a-zA-Z]+)*\.(fails|skip|todo)\b(\.each\s*\()?/g

/** Matches a test call with a literal title and an options object, as in `it("title", { skip: true }, ...)`. */
const optionsPinPattern =
  /\b(?:it|test|describe)(?:\.[a-zA-Z]+)*\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*\{[^{}]*?\b(fails|skip|todo)\s*:\s*(?:true|(["'`])(?:\\.|(?!\4)[^\\])*\4)\s*[,}]/g

/** Matches the beginning of a conditional suite's condition. */
const conditionalStartPattern =
  /\b(?:it|test|describe)(?:\.[a-zA-Z]+)*\.(skipIf|runIf)\s*\(/g

/** Matches a skip made inside a test body, on the test context: `ctx.skip(`, `context.skip(`, `t.skip(`. */
const contextSkipPattern = /\b(ctx|context|t)\.skip\s*\(/g

/** Matches a test call with a literal title, so a context skip is named by its enclosing test. */
const testTitlePattern = /\b(?:it|test)(?:\.[a-zA-Z]+)*\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g

/**
 * Matches a function declaration at any depth, so a context skip in a shared
 * helper (`const requireKey = (ctx) => { ... }`) is named by that helper.
 */
const helperPattern =
  /^[ \t]*(?:export\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\b[^=\n]*=\s*(?:async\s+)?(?:function\b|\([^)\n]*\)[^=\n]*=>|[A-Za-z_$][\w$]*\s*=>))/gm

/** Matches an `if (` whose condition may guard a context skip. */
const ifPattern = /\bif\s*\(/g

/** Reads the closing parenthesis paired with the one at `openIndex`. */
const readParenthesized = (source, openIndex) => {
  let depth = 0
  let quote
  for (let index = openIndex; index < source.length; index++) {
    const character = source[index]
    if (quote !== undefined) {
      if (character === "\\") index++
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (character === "(") depth++
    else if (character === ")" && --depth === 0) {
      return { text: source.slice(openIndex + 1, index), closeIndex: index }
    }
  }
  return undefined
}

/** Matches the opening parenthesis of the call that follows a condition or an `.each(...)` table. */
const nextCallPattern = /\s*\(/y

/** Reads a literal title at the start of a call's arguments. */
const literalTitlePattern = /\s*(["'`])((?:[^\\]|\\.)*?)\1/y

/** The text of the first argument in a call's argument text, up to its first top-level comma. */
const firstArgument = (text) => {
  let depth = 0
  let quote
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quote !== undefined) {
      if (character === "\\") index++
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === "`") quote = character
    else if ("([{".includes(character)) depth++
    else if (")]}".includes(character)) depth--
    else if (character === "," && depth === 0) return text.slice(0, index).trim()
  }
  return text.trim()
}

/**
 * The title of the call whose opening parenthesis is at `openIndex`.
 *
 * A literal title reads as its text. Any other first argument reads as its
 * source, so `it.skip(titleVariable, ...)` is still a pin the register must
 * name, by that spelling. A call with no argument has no title.
 */
const readTitle = (source, openIndex) => {
  literalTitlePattern.lastIndex = openIndex + 1
  const literal = literalTitlePattern.exec(source)
  if (literal !== null) return literal[2]
  const call = readParenthesized(source, openIndex)
  if (call === undefined) return undefined
  const title = firstArgument(call.text)
  return title === "" ? undefined : title
}

/** The opening parenthesis of the call written right after `index`, or undefined. */
const nextCall = (source, index) => {
  nextCallPattern.lastIndex = index
  const open = nextCallPattern.exec(source)
  return open === null ? undefined : open.index + open[0].length - 1
}

/**
 * Whether a `skipIf`/`runIf` condition leaves the suite off in a default run.
 *
 * A condition that reads an environment variable is opt-in: nothing sets it, so
 * the suite does not execute unless someone remembers it exists. A condition on
 * `process.platform`, on an installed binary, or on a built artifact is a
 * capability gate — it runs on the supported configuration. `CI` is excluded
 * because CI is a configuration the repo actually runs.
 *
 * Both spellings of the read count: `process.env.NAME` and
 * `process.env["NAME"]`. The check is textual, so a condition that reaches an
 * environment variable through a helper defined elsewhere reads as a
 * capability gate. That is a deliberate floor, not a claim of completeness.
 */
const envReads = (text) =>
  Array.from(text.matchAll(/process\.env(?:\.([A-Za-z_]\w*)|\[["']([A-Za-z_]\w*)["']\])/g), (read) => read[1] ?? read[2])

const readsOptInEnv = (text, supplied) =>
  envReads(text).some((name) => name !== "CI" && !supplied.has(name))

/**
 * Resolves every identifier in a condition against a `const` in the same file,
 * so the readable idiom — naming the flag once, using it on several suites —
 * is not a way around the guard. The identifier does not have to be the whole
 * condition: `skipIf(token === undefined)` gates on `token` just as
 * `skipIf(!slowTests)` gates on `slowTests`.
 */
const isOptIn = (condition, source, supplied) => {
  if (readsOptInEnv(condition, supplied)) return true
  for (const identifier of condition.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const binding = source.match(new RegExp(`\\bconst\\s+${identifier[0]}\\s*=([^\\n]*)`))
    if (binding !== null && readsOptInEnv(binding[1], supplied)) return true
  }
  return false
}

/**
 * The environment variables a package's `test` target sets for its tests.
 *
 * Two declarations in PACKAGE.ts supply one. A target's `env` object sets each
 * key it names in the test process; a `Docker.Service` call's `env` configures
 * the service container instead, so its keys supply nothing to a test. A
 * `testProgram` supplies a name when the program writes it as an object key.
 * Destructuring patterns are removed from the program first, because
 * `const { NAME: ignored, ...rest } = process.env` is how such a program drops
 * an inherited value, not how it supplies one.
 */
export const suppliedEnv = (packageDirectory, root = repoRoot) => {
  const manifest = join(packageDirectory, "PACKAGE.ts")
  if (!existsSync(manifest)) return new Set()
  const declaration = readFileSync(manifest, "utf8")
  const supplied = new Set(targetEnvKeys(declaration))
  const program = declaration.match(/\btestProgram:\s*Smithers\.file\(\s*["']\/\/([^"']+)["']/)
  if (program === null) return supplied
  const text = readFileSync(join(root, program[1]), "utf8").replace(/\{[^{}]*\}\s*=(?![=>])/g, "")
  for (const key of text.matchAll(/\b([A-Z][A-Z0-9_]*)\s*:/g)) supplied.add(key[1])
  return supplied
}

/**
 * Reads the bracket paired with the one at `openIndex` in declaration source.
 *
 * Quoted text and comments are skipped, so a URL value or an apostrophe in a
 * comment cannot pair a bracket. An unpaired bracket reads as `undefined`.
 */
const readBracketed = (source, openIndex) => {
  const open = source[openIndex]
  const close = open === "(" ? ")" : "}"
  let depth = 0
  for (let index = openIndex; index < source.length; index++) {
    const character = source[index]
    if (character === '"' || character === "'" || character === "`") {
      for (index++; index < source.length && source[index] !== character; index++) {
        if (source[index] === "\\") index++
      }
      continue
    }
    if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index)
      if (index === -1) return undefined
      continue
    }
    if (source.startsWith("/*", index)) {
      index = source.indexOf("*/", index + 2)
      if (index === -1) return undefined
      index++
      continue
    }
    if (character === open) depth++
    else if (character === close && --depth === 0) return source.slice(openIndex + 1, index)
  }
  return undefined
}

/**
 * The keys of every `env` object a PACKAGE.ts target declares.
 *
 * A `Docker.Service` call's `env` is skipped, and so is everything after an
 * unpaired service call, so a declaration this reader cannot pair supplies
 * less rather than more. Only environment-variable names count as keys, bare
 * or quoted; string values are consumed whole, so `postgres://` is not a key.
 */
const targetEnvKeys = (declaration) => {
  const services = Array.from(declaration.matchAll(/\bDocker\.Service\s*\(/g), (call) => {
    const open = call.index + call[0].length - 1
    const body = readBracketed(declaration, open)
    return [open, body === undefined ? declaration.length : open + body.length + 1]
  })
  const keys = []
  for (const block of declaration.matchAll(/\benv\s*:\s*\{/g)) {
    const open = block.index + block[0].length - 1
    if (services.some(([start, end]) => start < open && open < end)) continue
    const body = readBracketed(declaration, open)
    if (body === undefined) continue
    for (const token of body.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1(\s*:)?|\b([A-Za-z_]\w*)(\s*:)?/g)) {
      const key = token[3] === undefined ? token[5] === undefined ? undefined : token[4] : token[2]
      if (key !== undefined && /^[A-Z][A-Z0-9_]*$/.test(key)) keys.push(key)
    }
  }
  return keys
}

/** Directory names never worth walking for tests. */
const ignoredDirectories = new Set(["node_modules", "dist", "build", "coverage", ".git", "target"])

// VibeLang test files (`.test.vibe`) pin with the same runner calls.
const isTestFile = (name) => /\.(test|spec)\.(ts|tsx|mts|cts|js|mjs|cjs|vibe)$/.test(name)

/**
 * Every package directory whose manifest declares one of the guarded groups.
 *
 * The candidates come from `pnpm-workspace.yaml` through the shared reader, so
 * a package nested inside the product package it belongs to keeps its own row
 * instead of having its pins counted against its parent.
 */
export const guardedPackages = (root = repoRoot) =>
  libraryPackages(root)
    .filter((entry) => guardedGroups.has(entry.manifest.smthrs?.group))
    .map((entry) => join(root, entry.dir.split("/").join(sep)))

/**
 * Every test file a package owns.
 *
 * The walk stops at a nested package: a directory holding its own
 * `package.json` is another package's tree, and its pins belong to that
 * package's row in the register, not to the enclosing one.
 */
const testFilesUnder = (directory, collected = [], root = directory) => {
  if (!existsSync(directory)) return collected
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (existsSync(join(path, "package.json"))) continue
      testFilesUnder(path, collected, root)
    } else if (entry.isFile() && isTestFile(entry.name)) collected.push(path)
  }
  return collected
}

/**
 * Every pin in `source`, as `{ form, title, line }`.
 *
 * Exported so the unit test can drive it against fixtures rather than against
 * whatever the tree happens to contain.
 */
export const findPins = (source, supplied = new Set()) => {
  const lineOf = (index) => source.slice(0, index).split("\n").length
  const pins = []
  for (const match of source.matchAll(pinPattern)) {
    let open = nextCall(source, match.index + match[0].length - (match[2] === undefined ? 0 : 1))
    if (open !== undefined && match[2] !== undefined) {
      const table = readParenthesized(source, open)
      open = table === undefined ? undefined : nextCall(source, table.closeIndex + 1)
    }
    const title = open === undefined ? undefined : readTitle(source, open)
    if (title === undefined) continue
    pins.push({ form: match[2] === undefined ? match[1] : `${match[1]}.each`, title, line: lineOf(match.index) })
  }
  for (const match of source.matchAll(optionsPinPattern)) {
    pins.push({ form: `{ ${match[3]} }`, title: match[2], line: lineOf(match.index) })
  }
  for (const match of source.matchAll(conditionalStartPattern)) {
    const openIndex = match.index + match[0].length - 1
    const condition = readParenthesized(source, openIndex)
    if (condition === undefined) continue
    // A literal condition is no condition: `skipIf(true)` is `skip`.
    const literallyOff = condition.text.trim() === (match[1] === "skipIf" ? "true" : "false")
    if (!literallyOff && !isOptIn(condition.text, source, supplied)) continue
    const open = nextCall(source, condition.closeIndex + 1)
    const title = open === undefined ? undefined : readTitle(source, open)
    if (title === undefined) continue
    pins.push({
      form: `${match[1]}(${condition.text.trim()})`,
      title,
      line: lineOf(match.index)
    })
  }
  for (const match of source.matchAll(contextSkipPattern)) {
    const guard = optInGuard(source, match.index, supplied)
    if (guard === undefined) continue
    // The enclosing test is the last one opened before the skip, unless a
    // function declaration starts after it: then the skip is in that shared
    // helper, and every test that calls it is off.
    const before = source.slice(0, match.index)
    const opened = [...before.matchAll(testTitlePattern)].at(-1)
    const helper = [...before.matchAll(helperPattern)].at(-1)
    const title = helper !== undefined && (opened === undefined || helper.index > opened.index) ? helper[1] ?? helper[2] : opened?.[2]
    if (title === undefined) continue
    pins.push({ form: `${match[1]}.skip under if (${guard})`, title, line: lineOf(match.index) })
  }
  return pins.sort((a, b) => a.line - b.line)
}

/**
 * The opt-in condition that guards the context skip at `skipIndex`, or undefined.
 *
 * A skip inside a test body is the environment-gated pin in another spelling:
 * `if (process.env.X !== "1") ctx.skip()` leaves the test off in a default run
 * just as `it.skipIf(process.env.X !== "1")` does. The guard is an enclosing
 * `if` (its braced block, or its one-line statement) whose condition
 * {@link isOptIn}, or the skip's own condition argument. A skip under a
 * capability condition (`if (!loggedIn) ctx.skip()`) is not a pin.
 */
const optInGuard = (source, skipIndex, supplied) => {
  const call = readParenthesized(source, source.indexOf("(", skipIndex))
  if (call !== undefined) {
    const argument = firstArgument(call.text)
    if (!/^(["'`])/.test(argument) && isOptIn(argument, source, supplied)) return argument
  }
  for (const match of source.slice(0, skipIndex).matchAll(ifPattern)) {
    const condition = readParenthesized(source, match.index + match[0].length - 1)
    if (condition === undefined || !isOptIn(condition.text, source, supplied)) continue
    const bodyStart = source.slice(condition.closeIndex + 1).search(/\S/) + condition.closeIndex + 1
    const body = source[bodyStart] === "{"
      ? readBracketed(source, bodyStart)
      : source.slice(bodyStart, source.indexOf("\n", bodyStart) === -1 ? undefined : source.indexOf("\n", bodyStart))
    if (body !== undefined && skipIndex < bodyStart + 1 + body.length) return condition.text.trim()
  }
  return undefined
}

/** The documented `{ package, title }` pairs in the Surviving pins table. */
const survivingPins = (notes) => {
  // `(?![\s\S])` is a real end-of-input assertion in ECMAScript. Unlike
  // `\z` (which JavaScript treats as a literal `z`), it cannot stop a table
  // at ordinary prose before its documented rows.
  const section = notes.match(/^### Surviving pins\s*$([\s\S]*?)(?=^### |(?![\s\S]))/m)
  if (section === null) return new Set()
  const documented = new Set()
  const rowPattern = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm
  for (const row of section[1].matchAll(rowPattern)) documented.add(`${row[1]}\u0000${row[2]}`)
  return documented
}

/**
 * Pins across the guarded packages that the Surviving pins table does not list.
 *
 * A pin counts as documented only when that table pairs its package and exact
 * title. Resolved-pin history can quote the same title, but must not authorize
 * re-pinning the test.
 */
export const undocumentedPins = (notes = readFileSync(notesPath, "utf8"), packages = guardedPackages()) => {
  const unexplained = []
  const documented = survivingPins(notes)
  for (const packageDirectory of packages) {
    const packageName = relative(join(repoRoot, "packages"), packageDirectory)
    const supplied = suppliedEnv(packageDirectory)
    for (const file of testFilesUnder(packageDirectory)) {
      if (file === ownSuite) continue
      for (const pin of findPins(readFileSync(file, "utf8"), supplied)) {
        if (documented.has(`${packageName}\u0000${pin.title}`)) continue
        unexplained.push({ ...pin, file: relative(repoRoot, file) })
      }
    }
  }
  return unexplained
}

const main = () => {
  if (!existsSync(notesPath) || !statSync(notesPath).isFile()) {
    console.error(`${relative(repoRoot, notesPath)} is missing: it is the register every pin must appear in.`)
    process.exit(1)
  }
  const unexplained = undocumentedPins()
  if (unexplained.length === 0) {
    console.log("No undocumented test pins in any package group.")
    return
  }
  console.error(`${unexplained.length} test pin(s) are not documented in packages/repo-targets/contracts/test-pins.md:`)
  for (const pin of unexplained) {
    console.error(`  ${pin.file}:${pin.line}  .${pin.form}  ${JSON.stringify(pin.title)}`)
  }
  console.error("")
  console.error("Fix the defect and unpin it, or add the pin to the \"Known test pins\" section")
  console.error("of packages/repo-targets/contracts/test-pins.md with a rationale. See that file's \"Adding a pin\".")
  process.exit(1)
}

if (isMain(import.meta)) main()
