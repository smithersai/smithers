/**
 * The hermetic pre-check: a lexical scan of shell text for the paths it names,
 * and the refusal when one of them falls outside the declared envelope.
 *
 * The scan is fail-closed over explicit path tokens and nothing more. It
 * cannot prove confinement — a shell can name a path no lexer sees, through a
 * variable, a substitution, or a program that opens a file of its own — so a
 * kernel or host sandbox must eventually enforce and report the complete read
 * and write sets.
 *
 * It lives beside the flow rather than inside it because it is its own
 * concept, with its own vocabulary (Access, PathReference) and its own
 * security history: three independent bypasses, each sufficient on its own to
 * defeat it, are closed here.
 *
 * @since 1.0.0
 */

import type * as Path from "@smthrs/kernel/Path"
import * as StdError from "../StdError.ts"
import { withinEnvelope } from "./Paths.ts"

/**
 * The filesystem envelope one invocation declared.
 *
 * Structural rather than the hermetic `Bash.Input` itself: the scan needs the
 * three fields and none of the rest, and depending on the flow module would
 * make the flow and its pre-check import each other.
 *
 * @category models
 * @since 1.0.0
 */
export interface Envelope {
  readonly cwd?: string | undefined
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
}

/**
 * How a command touches a path it names.
 *
 * @category models
 * @since 1.0.0
 */
export type Access = "read" | "write"

/**
 * One path a command names, and how it touches it.
 *
 * @category models
 * @since 1.0.0
 */
export interface PathReference {
  readonly access: Access
  readonly value: string
}

const commandSeparators = new Set(["&&", "||", ";", ";;", ";&", ";;&", "|", "|&", "&", "\n", "(", ")"])
const writeRedirections = new Set([">", ">>", ">|", "&>", "&>>", ">&", "<>"])
const readRedirections = new Set(["<", "<&"])
// A here-document delimiter and a here-string are text, not file names.
const textRedirections = new Set(["<<", "<<-", "<<<"])
const isRedirection = (token: Token): boolean =>
  token.operator &&
  (writeRedirections.has(token.text) || readRedirections.has(token.text) || textRedirections.has(token.text))
// Longest first, so `&>>` is not read as `&` then `>>`.
const operators = [
  ";;&",
  "&>>",
  "<<<",
  "<<-",
  ";;",
  ";&",
  "&&",
  "||",
  "|&",
  "&>",
  ">>",
  ">|",
  ">&",
  "<>",
  "<<",
  "<&",
  "\n",
  ";",
  "|",
  "&",
  "(",
  ")",
  ">",
  "<"
]
// Reserved words and grouping braces open or close a compound command; the
// command they wrap stands after them.
const reservedWords = new Set([
  "!",
  "{",
  "}",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "until",
  "while"
])
const writeCommands = new Set(["chmod", "chown", "mkdir", "rm", "rmdir", "tee", "touch", "truncate", "unlink"])
const destinationCommands = new Set(["cp", "install", "mv"])
const prefixWrappers = new Set(["env", "nice", "time", "sudo", "nohup", "xargs", "command", "exec"])
// A shell runs the argument of its `-c` flag as shell text of its own.
const shells = new Set(["ash", "bash", "dash", "fish", "ksh", "mksh", "sh", "zsh"])
const commandFlag = /^-[A-Za-z]*c[A-Za-z]*$/

/**
 * One lexical unit of shell text: an operator, or a word with its quotes
 * removed. A command substitution inside a word stands as `$()` in the word;
 * its body is scanned as a command of its own.
 */
interface Token {
  readonly operator: boolean
  readonly text: string
}

interface Lexed {
  readonly tokens: ReadonlyArray<Token>
  readonly substitutions: ReadonlyArray<string>
}

// The end of a `$(` body that starts at `from`: the index of its closing
// parenthesis, skipping quoted spans and nested parentheses. An unclosed body
// runs to the end of the text, which is how a fail-closed scan must read it.
// Substitutions and quotes nest without limit in a shell, but each level
// costs this scan a pass over the rest of the text and a stack frame. Fifty
// thousand `$(` used to run for half a minute and then overflow the stack, so
// past this depth the text is refused rather than scanned.
const maxNesting = 32

const tooDeep = (): StdError.StdError =>
  new StdError.StdError({
    code: "invalid_input",
    message: `Command nests substitutions or quotes deeper than ${maxNesting} levels`
  })

const substitutionEnd = (text: string, from: number, nesting: number): number => {
  if (nesting > maxNesting) throw tooDeep()
  let depth = 1
  let index = from
  while (index < text.length) {
    const char = text[index]!
    if (char === "\\") {
      index += 2
    } else if (char === "'") {
      const close = text.indexOf("'", index + 1)
      index = close === -1 ? text.length : close + 1
    } else if (char === "\"") {
      index = doubleQuoteEnd(text, index + 1, nesting + 1) + 1
    } else if (char === "`") {
      index = backtickEnd(text, index + 1) + 1
    } else {
      if (char === "(") depth++
      if (char === ")" && --depth === 0) return index
      index++
    }
  }
  return text.length
}

const backtickEnd = (text: string, from: number): number => {
  let index = from
  while (index < text.length && text[index] !== "`") index += text[index] === "\\" ? 2 : 1
  return Math.min(index, text.length)
}

const doubleQuoteEnd = (text: string, from: number, nesting: number): number => {
  if (nesting > maxNesting) throw tooDeep()
  let index = from
  while (index < text.length && text[index] !== "\"") {
    const char = text[index]!
    if (char === "\\") index += 2
    else if (char === "`") index = backtickEnd(text, index + 1) + 1
    else if (char === "$" && text[index + 1] === "(") index = substitutionEnd(text, index + 2, nesting + 1) + 1
    else index++
  }
  return Math.min(index, text.length)
}

// A hand-rolled lexer rather than one regular expression: a word is any run
// of bare characters, quoted spans, and substitutions, and a substitution can
// hold quotes and operators of its own. Splitting on operator characters
// alone let `echo "$(rm /work/target)"` hide a delete inside one quoted word,
// read `>|` as a pipe that turned the target into the next command's name,
// and read `(rm /work/target)` as a command named `(rm`.
//
// Quotes are removed from a word's text, because `"/outs"ide/x` names
// `/outside/x`; keeping the quotes made it a relative path under the
// working directory.
// Sticky, so the match starts at `lastIndex` without copying the rest of the
// text for every word.
const descriptorPattern = /\d+(?=[<>])/y

const lex = (command: string, nesting: number): Lexed => {
  const tokens: Array<Token> = []
  const substitutions: Array<string> = []
  let index = 0
  const substitution = (from: number, to: number): string => {
    substitutions.push(command.slice(from, to))
    return "$()"
  }
  while (index < command.length) {
    const char = command[index]!
    // Every blank the word loop stops at must be skipped here, or the lexer
    // would push an empty word without advancing.
    if (char !== "\n" && /\s/.test(char)) {
      index++
      continue
    }
    if (char === "\\" && command[index + 1] === "\n") {
      index += 2
      continue
    }
    if (char === "#") {
      while (index < command.length && command[index] !== "\n") index++
      continue
    }
    // A file-descriptor number belongs to the redirection after it: in
    // `2>/dev/null rm /work/target` the command is `rm`, not `2`.
    descriptorPattern.lastIndex = index
    const descriptor = descriptorPattern.exec(command)
    if (descriptor !== null) {
      index += descriptor[0].length
      continue
    }
    const operator = operators.find((candidate) => command.startsWith(candidate, index))
    if (operator !== undefined) {
      tokens.push({ operator: true, text: operator })
      index += operator.length
      continue
    }
    let text = ""
    while (index < command.length) {
      const next = command[index]!
      if (/[\s<>;|&()]/.test(next)) break
      if (next === "\\") {
        // A backslash escapes shell syntax. Before any other character it is
        // kept, so `C:\work\input` stays the path it names on Windows rather
        // than collapsing to a word the scan cannot see as a path.
        const escaped = command[index + 1] ?? ""
        if (escaped !== "\n") text += /[\s<>;|&()'"`$\\#]/.test(escaped) ? escaped : `\\${escaped}`
        index += 2
      } else if (next === "'") {
        const close = command.indexOf("'", index + 1)
        const end = close === -1 ? command.length : close
        text += command.slice(index + 1, end)
        index = end + 1
      } else if (next === "\"") {
        const end = doubleQuoteEnd(command, index + 1, nesting + 1)
        let inner = index + 1
        while (inner < end) {
          const quoted = command[inner]!
          if (quoted === "\\" && /[$`"\\\n]/.test(command[inner + 1] ?? "")) {
            if (command[inner + 1] !== "\n") text += command[inner + 1]
            inner += 2
          } else if (quoted === "`") {
            const close = backtickEnd(command, inner + 1)
            text += substitution(inner + 1, close)
            inner = close + 1
          } else if (quoted === "$" && command[inner + 1] === "(") {
            const close = substitutionEnd(command, inner + 2, nesting + 2)
            text += substitution(inner + 2, close)
            inner = close + 1
          } else {
            text += quoted
            inner++
          }
        }
        index = end + 1
      } else if (next === "`") {
        const close = backtickEnd(command, index + 1)
        text += substitution(index + 1, close)
        index = close + 1
      } else if (next === "$" && command[index + 1] === "(") {
        const close = substitutionEnd(command, index + 2, nesting + 1)
        text += substitution(index + 2, close)
        index = close + 1
      } else {
        text += next
        index++
      }
    }
    tokens.push({ operator: false, text })
  }
  return { tokens, substitutions }
}

// A parenthesis is an operator to the lexer, so one left in a word was quoted
// and is part of the name; only a trailing comma is punctuation.
const pathValue = (token: string): string => token.replace(/,+$/, "")

const isPathToken = (path: Path.Path, token: string): boolean =>
  token === "." ||
  token === ".." ||
  token.startsWith("./") ||
  token.startsWith("../") ||
  path.isAbsolute(token) ||
  /^[A-Za-z]:[\\/]/.test(token) ||
  token.includes("/")

const segmentReferences = (
  path: Path.Path,
  tokens: ReadonlyArray<Token>,
  nesting: number
): ReadonlyArray<PathReference> => {
  // The word after a redirection operator is its target, never the command.
  const isTarget = (index: number): boolean => index > 0 && isRedirection(tokens[index - 1]!)
  const isWord = (index: number): boolean => !tokens[index]!.operator && !isTarget(index)
  const name = (index: number): string => path.basename(pathValue(tokens[index]!.text))
  const hasWrapper = tokens.some((_, index) => isWord(index) && prefixWrappers.has(name(index)))
  let commandIndex = tokens.findIndex((token, index) =>
    isWord(index) &&
    !token.text.includes("=") &&
    !prefixWrappers.has(name(index)) &&
    !reservedWords.has(token.text) &&
    !token.text.startsWith("-") &&
    token.text !== ""
  )
  if (hasWrapper) {
    // Wrapper options can carry their own values. Prefer a later known
    // mutating command so an option value cannot lend it a read classification.
    const mutatingIndex = tokens.findIndex((_, index) =>
      isWord(index) && (writeCommands.has(name(index)) || destinationCommands.has(name(index)))
    )
    if (mutatingIndex !== -1) commandIndex = mutatingIndex
  }

  const command = commandIndex === -1 ? "" : name(commandIndex)
  // Shell text handed to `eval` or to a shell's `-c` flag is a command, not a
  // path: reading `sh -c 'rm /work/target'` as one quoted word let a delete
  // pass as a read of a file named `rm /work/target`.
  const scripts = new Set<number>()
  if (command === "eval") {
    for (let index = commandIndex + 1; index < tokens.length; index++) if (isWord(index)) scripts.add(index)
  } else if (shells.has(command)) {
    const flag = tokens.findIndex((token, index) =>
      index > commandIndex && isWord(index) && commandFlag.test(token.text)
    )
    if (flag !== -1 && flag + 1 < tokens.length && isWord(flag + 1)) scripts.add(flag + 1)
  }
  const candidates: Array<{ readonly index: number; readonly value: string }> = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (index === commandIndex || scripts.has(index) || token.operator) continue
    if (!isTarget(index) && token.text.startsWith("-")) continue
    if (isTarget(index) && textRedirections.has(tokens[index - 1]!.text)) continue
    const value = pathValue(token.text)
    if (value !== "" && isPathToken(path, value)) candidates.push({ index, value })
  }

  const destinationIndex = destinationCommands.has(command)
    ? candidates.filter(({ index }) => !isTarget(index)).at(-1)?.index
    : undefined

  const script = [...scripts].map((index) => tokens[index]!.text).join(" ")
  const nested = script === "" ? [] : references(path, script, nesting + 1)
  const named = candidates.map(({ index, value }): PathReference => {
    const access: Access = isTarget(index)
      ? writeRedirections.has(tokens[index - 1]!.text) ? "write" : "read"
      : writeCommands.has(command) || destinationIndex === index
      ? "write"
      : "read"
    return { access, value }
  })
  return [...named, ...nested]
}

const references = (path: Path.Path, command: string, nesting: number): ReadonlyArray<PathReference> => {
  if (nesting > maxNesting) throw tooDeep()
  const { substitutions, tokens } = lex(command, nesting)
  const found: Array<PathReference> = []
  let segment: Array<Token> = []
  for (const token of tokens) {
    if (token.operator && commandSeparators.has(token.text)) {
      found.push(...segmentReferences(path, segment, nesting))
      segment = []
    } else {
      segment.push(token)
    }
  }
  found.push(...segmentReferences(path, segment, nesting))
  // A substitution runs its body as a command; its paths count like any other.
  for (const body of substitutions) found.push(...references(path, body, nesting + 1))
  return found
}

/**
 * Every path token the shell text names, one segment at a time.
 *
 * @throws {StdError.StdError} `invalid_input` when substitutions or quotes nest
 * deeper than the scan reads.
 * @category pre-check
 * @since 1.0.0
 */
export const commandReferences = (path: Path.Path, command: string): ReadonlyArray<PathReference> =>
  references(path, command, 0)

const resolvePath = (
  path: Path.Path,
  cwd: string,
  value: string
): string => path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value)

const isDeclared = (
  path: Path.Path,
  cwd: string,
  declared: ReadonlyArray<string>,
  source: string
): boolean =>
  withinEnvelope(
    declared.map((entry) => resolvePath(path, cwd, entry)),
    resolvePath(path, cwd, source)
  )

/**
 * The refusal shell text earns by naming a path outside its declared
 * envelope, or `undefined` when every path it names is declared.
 *
 * @category pre-check
 * @since 1.0.0
 */
export const outsideEnvelope = (
  input: Envelope,
  text: string,
  path: Path.Path
): StdError.StdError | undefined => {
  const base = path.resolve(".")
  const cwd = path.resolve(input.cwd ?? ".")
  // Passing the default explicitly is not a declaration the caller owes. A
  // working directory is where the command runs, not a file it reads, and
  // `cwd: "."` names exactly what omitting `cwd` names — so refusing it asked
  // the caller to list the workspace root among its reads to say nothing at
  // all. Agents hit this constantly: one SWE-bench run spent ten of its
  // forty-eight tool calls re-issuing the same command after
  // "Working directory is outside declared reads: <the workspace root>". A
  // cwd that points somewhere else is still declared or refused.
  if (input.cwd !== undefined && cwd !== base && !isDeclared(path, cwd, input.reads, cwd)) {
    return new StdError.StdError({
      code: "outside_declared_reads",
      message: `Working directory is outside declared reads: ${cwd}`,
      path: cwd
    })
  }

  // The Shell contract currently has no sandbox or access-reporting surface.
  // This lexical scan is intentionally only a fail-closed pre-check for
  // explicit path tokens. It cannot prove confinement; a kernel/host sandbox
  // must eventually enforce and report the complete read and write sets.
  let named: ReadonlyArray<PathReference>
  try {
    named = commandReferences(path, text)
  } catch {
    // The depth bound is the one failure the scan raises, and a text the scan
    // cannot read is refused whatever the reason, never run unchecked.
    return tooDeep()
  }
  for (const reference of named) {
    const resolved = resolvePath(path, cwd, reference.value)
    // /dev/* is the process plumbing every shell one-liner leans on:
    // `2>/dev/null`, `cat /dev/stdin`. Normalize first so a dot-dot segment
    // cannot disguise an ordinary filesystem path as process plumbing.
    if (resolved.startsWith("/dev/")) continue
    const declared = reference.access === "write" ? input.writes : input.reads
    if (!isDeclared(path, cwd, declared, resolved)) {
      const code = reference.access === "write" ? "outside_declared_writes" : "outside_declared_reads"
      return new StdError.StdError({
        code,
        message: `Command path is outside declared ${reference.access}s: ${resolved}`,
        path: resolved
      })
    }
  }
  return undefined
}
