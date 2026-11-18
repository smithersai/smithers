/**
 * Reads a CI step's shell text far enough to say which commands it can run.
 *
 * The splitter may only narrow a step when it knows every command in it, so
 * this reader understands a small part of the shell and refuses the rest:
 * words, quotes, `;`, `&&`, `||`, `|`, `&`, output redirections and
 * `if … then … else … fi`. Command substitution, globs, loops, functions,
 * subshells, here-documents and input redirections are refused. A refusal
 * leaves the step whole.
 *
 * @since 0.1.0
 */

/**
 * One word of a command, with its quotes removed. `literal` is false when
 * the word holds a variable, which this reader never expands.
 *
 * @category models
 * @since 0.1.0
 */
export interface Word {
  readonly text: string
  readonly literal: boolean
}

/**
 * What joins a command to the one before it in its list.
 *
 * @category models
 * @since 0.1.0
 */
export type Joint = "first" | ";" | "&&" | "||" | "|" | "&"

/**
 * One simple command a step can run: variable assignments, then words.
 *
 * - `start` and `end` bound the words in the source text, so the command can
 *   be replaced by another. They are `undefined` when a redirection sits
 *   between two of the words.
 * - `joint` is what joins it to the command before it.
 * - `piped` is true when its output feeds another command.
 * - `background` is true when it ends with `&`.
 * - `conditional` is true when an `if` decides whether it runs.
 *
 * @category models
 * @since 0.1.0
 */
export interface Command {
  readonly assignments: ReadonlyArray<readonly [name: string, value: Word]>
  readonly words: ReadonlyArray<Word>
  readonly start: number | undefined
  readonly end: number | undefined
  readonly joint: Joint
  readonly piped: boolean
  readonly background: boolean
  readonly conditional: boolean
}

interface WordToken {
  readonly kind: "word"
  readonly word: Word
  /** True when a keyword spelled like this word would not be a keyword. */
  readonly quoted: boolean
  /** The variable name when the word is `NAME=value`. */
  readonly assigns: string | undefined
  readonly start: number
  readonly end: number
}

type Token =
  | WordToken
  | { readonly kind: "operator"; readonly text: ";" | "&&" | "||" | "|" | "&" }
  | { readonly kind: "redirect" }

type Draft = { -readonly [Key in keyof Command]: Command[Key] }

const wordEnd = /[\s;&|<>]/
const variable = /^(?:[A-Za-z_][A-Za-z0-9_]*|[?!$#0-9]|\{[A-Za-z_][A-Za-z0-9_]*\})/
const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/
const redirection = /^[0-9]?>>?(?:&[0-9])?/
const refusedBare = new Set(["`", "(", ")", "{", "}", "*", "?", "~"])
const brackets = new Set(["[", "]", "[[", "]]"])
const branchKeywords = new Set(["then", "elif", "else", "fi"])
const refusedKeywords = new Set(["for", "while", "until", "do", "done", "case", "esac", "function", "select", "time"])

// The end of `$NAME`, `${NAME}` or a one-character parameter. Any other text
// after a dollar sign is an expansion this reader cannot follow.
const variableEnd = (text: string, at: number): number | undefined => {
  const match = variable.exec(text.slice(at + 1))
  return match === null ? undefined : at + 1 + match[0].length
}

const readWord = (text: string, start: number): WordToken | undefined => {
  let at = start
  let value = ""
  let literal = true
  let quoted = false
  let bracket = false
  while (at < text.length && !wordEnd.test(text[at] as string)) {
    const char = text[at] as string
    if (char === "'") {
      const close = text.indexOf("'", at + 1)
      if (close < 0) return undefined
      value += text.slice(at + 1, close)
      quoted = true
      at = close + 1
    } else if (char === "\"") {
      quoted = true
      at += 1
      while (text[at] !== "\"") {
        const inner = text[at]
        if (inner === undefined || inner === "`") return undefined
        if (inner === "\\" && /["\\$`]/.test(text[at + 1] ?? "")) {
          value += text[at + 1]
          at += 2
        } else if (inner === "$") {
          const end = variableEnd(text, at)
          if (end === undefined) return undefined
          value += text.slice(at, end)
          literal = false
          at = end
        } else {
          value += inner
          at += 1
        }
      }
      at += 1
    } else if (char === "\\") {
      const next = text[at + 1]
      if (next === undefined) return undefined
      value += next === "\n" ? "" : next
      quoted = true
      at += 2
    } else if (char === "$") {
      const end = variableEnd(text, at)
      if (end === undefined) return undefined
      value += text.slice(at, end)
      literal = false
      at = end
    } else if (refusedBare.has(char)) {
      return undefined
    } else {
      bracket = bracket || char === "[" || char === "]"
      value += char
      at += 1
    }
  }
  // `[` and `[[` are commands; inside any other word a bare bracket is a glob.
  if (bracket && !brackets.has(value)) return undefined
  return {
    kind: "word",
    word: { text: value, literal },
    quoted,
    assigns: assignment.exec(text.slice(start, at))?.[1],
    start,
    end: at
  }
}

const lex = (text: string): ReadonlyArray<Token> | undefined => {
  const tokens: Array<Token> = []
  let at = 0
  while (at < text.length) {
    const char = text[at] as string
    const next = text[at + 1]
    if (char === "\n" || char === ";") {
      if (next === ";") return undefined
      tokens.push({ kind: "operator", text: ";" })
      at += 1
    } else if (/\s/.test(char)) {
      at += 1
    } else if (char === "\\" && next === "\n") {
      at += 2
    } else if (char === "#") {
      while (at < text.length && text[at] !== "\n") at += 1
    } else if (char === "&") {
      if (next === ">") return undefined
      tokens.push({ kind: "operator", text: next === "&" ? "&&" : "&" })
      at += next === "&" ? 2 : 1
    } else if (char === "|") {
      if (next === "&") return undefined
      tokens.push({ kind: "operator", text: next === "|" ? "||" : "|" })
      at += next === "|" ? 2 : 1
    } else if (char === "<") {
      return undefined
    } else {
      const redirect = redirection.exec(text.slice(at))
      if (redirect === null) {
        const word = readWord(text, at)
        if (word === undefined) return undefined
        tokens.push(word)
        at = word.end
      } else {
        tokens.push({ kind: "redirect" })
        at += redirect[0].length
        // `2>&1` names its own target; any other redirection takes the next word.
        if (!redirect[0].includes("&")) {
          while (text[at] === " " || text[at] === "\t") at += 1
          const target = readWord(text, at)
          if (target === undefined || target.end === target.start) return undefined
          at = target.end
        }
      }
    }
  }
  return tokens
}

interface Reader {
  readonly tokens: ReadonlyArray<Token>
  at: number
}

// The word at the reader when it could be a shell keyword.
const bareWord = (reader: Reader): string | undefined => {
  const token = reader.tokens[reader.at]
  return token?.kind === "word" && !token.quoted && token.word.literal ? token.word.text : undefined
}

// The value of a test the shell computes from literal words alone, or
// `undefined` when it depends on anything else.
const staticTest = (condition: ReadonlyArray<Command>): boolean | undefined => {
  const command = condition[0] as Command
  if (condition.length !== 1 || command.assignments.length > 0 || command.piped || command.background) return undefined
  if (command.words.some((word) => !word.literal)) return undefined
  const words = command.words.map((word) => word.text)
  const operands = words[0] === "[" && words.at(-1) === "]"
    ? words.slice(1, -1)
    : words[0] === "test"
    ? words.slice(1)
    : undefined
  if (operands === undefined) return undefined
  const negated = operands[0] === "!"
  const [left, middle, right] = negated ? operands.slice(1) : operands
  const count = operands.length - (negated ? 1 : 0)
  const value = count === 2 && left === "-n"
    ? middle !== ""
    : count === 2 && left === "-z"
    ? middle === ""
    : count === 3 && (middle === "=" || middle === "==")
    ? left === right
    : count === 3 && middle === "!="
    ? left !== right
    : undefined
  return value === undefined ? undefined : value !== negated
}

const readSimple = (reader: Reader, joint: Joint, conditional: boolean): Draft | undefined => {
  const assignments: Array<readonly [string, Word]> = []
  const words: Array<Word> = []
  let start: number | undefined
  let end: number | undefined
  let replaceable = true
  let redirected = false
  for (;;) {
    const token = reader.tokens[reader.at]
    if (token === undefined || token.kind === "operator") break
    reader.at += 1
    if (token.kind === "redirect") {
      redirected = true
    } else if (words.length === 0 && token.assigns !== undefined) {
      const value = token.word.text.slice(token.assigns.length + 1)
      assignments.push([token.assigns, { text: value, literal: token.word.literal }])
    } else {
      if (words.length === 0) start = token.start
      else if (redirected) replaceable = false
      redirected = false
      end = token.end
      words.push(token.word)
    }
  }
  if (words.length === 0 && assignments.length === 0) return undefined
  return {
    assignments,
    words,
    start: replaceable ? start : undefined,
    end: replaceable ? end : undefined,
    joint,
    piped: false,
    background: false,
    conditional
  }
}

const uncertain = (list: ReadonlyArray<Command>): ReadonlyArray<Command> =>
  list.map((command) => ({ ...command, conditional: true }))

// Reads from `if` to `fi`. A branch whose test is computed false is dropped;
// one computed true ends the chain, and runs for certain when every test
// before it was computed false.
const readIf = (reader: Reader, conditional: boolean, out: Array<Command>): boolean => {
  let open = true
  let certain = true
  for (;;) {
    reader.at += 1
    const condition: Array<Command> = []
    if (!readList(reader, branchKeywords, conditional, condition) || bareWord(reader) !== "then") return false
    reader.at += 1
    const body: Array<Command> = []
    if (!readList(reader, branchKeywords, conditional, body)) return false
    const known = staticTest(condition)
    if (open && known === true) {
      out.push(...(certain ? body : uncertain(body)))
      open = false
    } else if (open && known === undefined) {
      out.push(...condition, ...uncertain(body))
      certain = false
    }
    if (bareWord(reader) !== "elif") break
  }
  if (bareWord(reader) === "else") {
    reader.at += 1
    const otherwise: Array<Command> = []
    if (!readList(reader, branchKeywords, conditional, otherwise)) return false
    if (open) out.push(...(certain ? otherwise : uncertain(otherwise)))
  }
  if (bareWord(reader) !== "fi") return false
  reader.at += 1
  return true
}

// Reads commands until the tokens end or a keyword in `stops` is next. With
// no `stops` the list must reach the end of the script.
const readList = (reader: Reader, stops: ReadonlySet<string>, conditional: boolean, out: Array<Command>): boolean => {
  let joint: Joint = "first"
  for (;;) {
    while (((token) => token?.kind === "operator" && token.text === ";")(reader.tokens[reader.at])) reader.at += 1
    if (reader.at >= reader.tokens.length) return stops.size === 0
    const keyword = bareWord(reader)
    if (keyword !== undefined && stops.has(keyword)) return true
    if (keyword !== undefined && (branchKeywords.has(keyword) || refusedKeywords.has(keyword))) return false
    if (keyword === "if") {
      // An `if` stands alone: nothing may join it to a neighbour but a separator.
      if (joint !== "first" && joint !== ";") return false
      if (!readIf(reader, conditional, out)) return false
      const after = reader.tokens[reader.at]
      if (after !== undefined && !(after.kind === "operator" && after.text === ";")) {
        const stop = bareWord(reader)
        if (stop === undefined || !stops.has(stop)) return false
      }
      joint = ";"
      continue
    }
    const command = readSimple(reader, joint, conditional)
    if (command === undefined) return false
    const operator = reader.tokens[reader.at]
    joint = ";"
    if (operator?.kind === "operator") {
      reader.at += 1
      command.piped = operator.text === "|"
      command.background = operator.text === "&"
      joint = operator.text
    }
    out.push(command)
  }
}

/**
 * The simple commands a script can run, in order, or `undefined` when the
 * script holds anything this reader does not understand.
 *
 * A test of literal words alone, such as `[ -n "" ]`, is computed: a branch
 * that cannot run is left out, and a branch that must run is not
 * `conditional`. Any other `if` gives its test and every branch.
 *
 * @throws {never}
 * @category reading
 * @since 0.1.0
 */
export const commands = (script: string): ReadonlyArray<Command> | undefined => {
  const tokens = lex(script)
  if (tokens === undefined) return undefined
  const out: Array<Command> = []
  return readList({ tokens, at: 0 }, new Set(), false, out) ? out : undefined
}

/**
 * Quotes one word for a POSIX shell. A word with nothing special stays bare.
 *
 * @throws {never}
 * @category writing
 * @since 0.1.0
 */
export const quote = (word: string): string =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
