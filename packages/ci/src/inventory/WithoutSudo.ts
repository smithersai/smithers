/**
 * What a script does on a machine where `sudo` refuses.
 *
 * A replay never runs `sudo`: every step finds a stand-in first that refuses.
 * A script written for machines with and without `sudo` asks before it uses
 * it, with `sudo -n true`, and does without when the answer is no:
 *
 *     if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true 2>/dev/null; then
 *       echo "no sudo here; skipping"
 *       exit 0
 *     fi
 *     sudo tee /etc/apt/apt.conf.d/99-lock-timeout
 *
 * In a replay the answer is always no, so the `sudo tee` never runs. This
 * module reads a script far enough to leave out what runs only after a yes:
 * the branch of an `if` whose test needs the answer to be yes, and what
 * follows an `if` that ends the script when the answer is no. The question
 * itself changes nothing and is left out too.
 *
 * What it cannot read it leaves as written, and the script's other uses of
 * `sudo` are then found as before. So is a script that could make `sudo` or
 * `exit` mean something else: one that sets `PATH`, defines an alias, or
 * defines a function of either name.
 *
 * @since 0.1.0
 */

interface Token {
  /** A word's text as written, or an operator: a line end, `;`, `;;`, `&`, `&&`, `|`, `||`, `(` or `)`. */
  readonly text: string
  readonly word: boolean
  /** True for a word written with no quote, escape or expansion: only such a word can be a keyword. */
  readonly plain: boolean
  readonly start: number
  readonly end: number
}

/** Where the bracket opened at `at` closes, quotes and nested brackets passed over; the end of the text when it never does. */
const closing = (text: string, at: number, open: string, close: string): number => {
  let depth = 0
  for (let index = at; index < text.length; index += 1) {
    const char = text[index] as string
    if (char === "\\") index += 1
    else if (char === "'") index = quoted(text, index, "'")
    else if (char === "\"") index = quoted(text, index, "\"")
    else if (char === open) depth += 1
    else if (char === close && --depth === 0) return index
  }
  return text.length
}

/** Where the quote opened at `at` closes. Inside double quotes a backslash keeps the next character. */
const quoted = (text: string, at: number, mark: string): number => {
  let index = at + 1
  while (index < text.length && text[index] !== mark) index += mark === "\"" && text[index] === "\\" ? 2 : 1
  return index
}

const wordEnd = /[\s;&|()<>]/

/** The tokens of a script. Comments, redirections with their targets, and here-documents are passed over. */
const lex = (text: string): ReadonlyArray<Token> => {
  const tokens: Array<Token> = []
  /** Here-documents that start on this line: each ends at a line that is its tag. */
  const pending: Array<{ readonly tag: string; readonly tabs: boolean }> = []
  /** True after a redirection: the next word is where the stream goes. */
  let target = false
  /** Set after `<<`: the next word is a here-document's tag. */
  let tag: { readonly tabs: boolean } | undefined
  let at = 0
  const operator = (length: number): void => {
    tokens.push({ text: text.slice(at, at + length), word: false, plain: false, start: at, end: at + length })
    at += length
  }
  while (at < text.length) {
    const char = text[at] as string
    const two = text.slice(at, at + 2)
    if (two === "\\\n") at += 2
    else if (char === "\n") {
      operator(1)
      for (const doc of pending.splice(0)) {
        for (;;) {
          const end = text.indexOf("\n", at)
          const line = text.slice(at, end < 0 ? text.length : end)
          at = end < 0 ? text.length : end + 1
          if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.tag || end < 0) break
        }
      }
    } else if (/\s/.test(char)) at += 1
    else if (char === "#") { while (at < text.length && text[at] !== "\n") at += 1 }
    else if (two === ";;" || two === "&&" || two === "||") operator(2)
    else if (two === "&>") {
      at += text[at + 2] === ">" ? 3 : 2
      target = true
    } else if (two === "|&") {
      tokens.push({ text: "|", word: false, plain: false, start: at, end: at + 2 })
      at += 2
    } else if (";&|()".includes(char)) operator(1)
    else if ((char === "<" || char === ">") && text[at + 1] !== "(") {
      if (text.startsWith("<<<", at)) at += 3
      else if (two === "<<") {
        tag = { tabs: text[at + 2] === "-" }
        at += tag.tabs ? 3 : 2
        continue
      } else {
        while (text[at] === "<" || text[at] === ">") at += 1
        if (text[at] === "&" || text[at] === "|") at += 1
        // `2>&1` and `>&-` name their stream in place.
        const stream = /^(?:\d+|-)(?![^\s;&|()<>])/.exec(text.slice(at))
        if (stream !== null) {
          at += stream[0].length
          continue
        }
      }
      target = true
    } else {
      const start = at
      let plain = true
      let value = ""
      while (
        at < text.length &&
        (!wordEnd.test(text[at] as string) || text.startsWith("<(", at) || text.startsWith(">(", at))
      ) {
        const inner = text[at] as string
        const from = at
        if (inner === "\\") at += 2
        else if (inner === "'" || inner === "\"") at = quoted(text, at, inner) + 1
        else if (inner === "`") at = quoted(text, at, "`") + 1
        else if (inner === "$" && text[at + 1] === "(") at = closing(text, at + 1, "(", ")") + 1
        else if (inner === "$" && text[at + 1] === "{") at = closing(text, at + 1, "{", "}") + 1
        else if (inner === "<" || inner === ">") at = closing(text, at + 1, "(", ")") + 1
        else {
          at += 1
          // `NAME=(a b)` is one word.
          if (inner === "=" && text[at] === "(") at = closing(text, at, "(", ")") + 1
          else if (inner !== "$") {
            value += inner
            continue
          }
        }
        plain = false
        value += text.slice(from, at)
      }
      at = Math.min(at, text.length)
      // A number right before a redirection names a stream.
      if (/^\d+$/.test(value) && (text[at] === "<" || text[at] === ">") && text[at + 1] !== "(") continue
      if (tag !== undefined) {
        pending.push({ tag: value.replace(/['"\\]/g, ""), tabs: tag.tabs })
        tag = undefined
      } else if (target) target = false
      else tokens.push({ text: value, word: true, plain, start, end: at })
    }
  }
  return tokens
}

type Command =
  | { readonly kind: "simple"; readonly words: ReadonlyArray<Token> }
  | {
    readonly kind: "if"
    readonly branches: ReadonlyArray<Branch>
    readonly otherwise: Otherwise | undefined
    readonly fi: Token
  }
  | { readonly kind: "block"; readonly body: ReadonlyArray<Statement> }

/** One `if` or `elif`: its test and what runs when the test is true. */
interface Branch {
  readonly start: number
  readonly test: ReadonlyArray<Statement>
  readonly then: Token
  readonly body: ReadonlyArray<Statement>
}

interface Otherwise {
  readonly start: number
  readonly body: ReadonlyArray<Statement>
}

interface Pipeline {
  readonly negated: boolean
  readonly commands: ReadonlyArray<Command>
}

/** Pipelines joined by `&&` and `||`. */
interface Statement {
  readonly first: Pipeline
  readonly rest: ReadonlyArray<readonly [joint: "&&" | "||", pipeline: Pipeline]>
  readonly background: boolean
}

/** Ends the reading of a script whose structure this reader does not follow. Caught where the reading started. */
class Unread extends Error {}

const parse = (tokens: ReadonlyArray<Token>): ReadonlyArray<Statement> => {
  let at = 0
  const peek = (): Token | undefined => tokens[at]
  const isOperator = (text: string): boolean => peek()?.word === false && peek()?.text === text
  const keyword = (): string | undefined => {
    const token = peek()
    return token?.word === true && token.plain ? token.text : undefined
  }
  /** True where a command may start: at the first token, or after an operator. */
  const starts = (index: number): boolean => index === 0 || tokens[index - 1]?.word === false
  const expect = (text: string): Token => {
    const token = peek()
    if (keyword() !== text || token === undefined) throw new Unread()
    at += 1
    return token
  }
  const lines = (): void => {
    while (isOperator("\n")) at += 1
  }

  /** The statements up to a keyword of `stops`, a `)`, or the end. */
  const list = (stops: ReadonlyArray<string>): ReadonlyArray<Statement> => {
    const statements: Array<Statement> = []
    for (;;) {
      while (isOperator("\n") || isOperator(";") || isOperator(";;")) at += 1
      if (peek() === undefined || isOperator(")") || stops.includes(keyword() ?? "")) return statements
      const first = pipeline()
      const rest: Array<readonly ["&&" | "||", Pipeline]> = []
      while (isOperator("&&") || isOperator("||")) {
        const joint = (peek() as Token).text as "&&" | "||"
        at += 1
        lines()
        rest.push([joint, pipeline()])
      }
      const background = isOperator("&")
      if (background) at += 1
      statements.push({ first, rest, background })
    }
  }

  const pipeline = (): Pipeline => {
    let negated = false
    while (keyword() === "!") {
      negated = !negated
      at += 1
    }
    const commands = [command()]
    while (isOperator("|")) {
      at += 1
      lines()
      commands.push(command())
    }
    return { negated, commands }
  }

  /** Stops at a function named as one of the two commands this reader gives a meaning to. */
  const redefines = (name: Token | undefined): void => {
    if (name?.text === "sudo" || name?.text === "exit") throw new Unread()
  }

  /** A function's body: it runs when the function is called, so it is never the script's own last word. */
  const inBlock = (body: Command): Command => ({
    kind: "block",
    body: [{ first: { negated: false, commands: [body] }, rest: [], background: false }]
  })

  /** A body between `open`, already read, and `close`. */
  const block = (close: string): Command => {
    const body = list([close])
    expect(close)
    return { kind: "block", body }
  }

  const command = (): Command => {
    const word = keyword()
    if (word === "if") return conditional()
    if (word === "while" || word === "until") {
      at += 1
      const test = list(["do"])
      expect("do")
      const body = list(["done"])
      expect("done")
      return { kind: "block", body: [...test, ...body] }
    }
    if (word === "for" || word === "select") {
      // The words a loop goes over are no commands: its body starts at the `do` that starts a command.
      while (peek() !== undefined && !(keyword() === "do" && starts(at))) at += 1
      expect("do")
      return block("done")
    }
    if (word === "case") {
      // A `case` is passed over whole: its patterns are no commands.
      let depth = 0
      for (; peek() !== undefined; at += 1) {
        if (keyword() === "case" && starts(at)) depth += 1
        else if (keyword() === "esac" && starts(at) && --depth === 0) break
      }
      expect("esac")
      return { kind: "block", body: [] }
    }
    if (word === "[[") {
      while (peek() !== undefined && keyword() !== "]]") at += 1
      expect("]]")
      return { kind: "block", body: [] }
    }
    if (word === "{") {
      at += 1
      return block("}")
    }
    if (word === "function") {
      // `function name { … }`, with or without `()` after the name.
      redefines(tokens[at + 1])
      at += 2
      if (isOperator("(")) at += 2
      lines()
      return inBlock(command())
    }
    if (isOperator("(")) {
      at += 1
      const body = list([])
      if (!isOperator(")")) throw new Unread()
      at += 1
      return { kind: "block", body }
    }
    const words: Array<Token> = []
    while (peek()?.word === true) {
      words.push(peek() as Token)
      at += 1
    }
    if (words.length === 0 || words[0]?.text === "alias") throw new Unread()
    // `name() { … }` defines a function: its body is read as any other.
    if (words.length === 1 && isOperator("(") && tokens[at + 1]?.text === ")" && tokens[at + 1]?.word === false) {
      redefines(words[0])
      at += 2
      lines()
      return inBlock(command())
    }
    return { kind: "simple", words }
  }

  const conditional = (): Command => {
    const branches: Array<Branch> = []
    for (;;) {
      const start = (peek() as Token).start
      at += 1
      const test = list(["then"])
      const then = expect("then")
      const body = list(["elif", "else", "fi"])
      branches.push({ start, test, then, body })
      if (keyword() !== "elif") break
    }
    if (keyword() !== "else") return { kind: "if", branches, otherwise: undefined, fi: expect("fi") }
    const start = (peek() as Token).start
    at += 1
    const body = list(["fi"])
    return { kind: "if", branches, otherwise: { start, body }, fi: expect("fi") }
  }

  const statements = list([])
  // A `)` or a keyword with nothing to close is a script this reader does not follow.
  if (peek() !== undefined) throw new Unread()
  return statements
}

/** The ways a script asks whether `sudo` works without a password: the words after `sudo`. */
const questions: ReadonlyArray<string> = [
  "-n true",
  "-n -v",
  "-nv",
  "-v -n",
  "-n /bin/true",
  "-n /usr/bin/true",
  "-n --validate",
  "--non-interactive true",
  "--non-interactive -v",
  "--non-interactive --validate"
]

/** True for a command that asks whether `sudo` works without a password, and does nothing else. */
const asks = (command: Command): boolean =>
  command.kind === "simple" && command.words.every((word) => word.plain) && command.words[0]?.text === "sudo"
  && questions.includes(command.words.slice(1).map((word) => word.text).join(" "))

/** What a test gives where `sudo` refuses: `true`, `false`, or `undefined` when something else decides. */
type Answer = boolean | undefined

const answerOf = (pipeline: Pipeline): Answer => {
  const [only] = pipeline.commands
  const answer = pipeline.commands.length === 1 && only !== undefined && asks(only) ? false : undefined
  return answer === undefined || !pipeline.negated ? answer : !answer
}

/** The answer of a test that is one statement. `a && b` is false when either is; `a || b` is true when either is. */
const answerOfTest = (test: ReadonlyArray<Statement>): Answer => {
  const [only] = test
  if (test.length !== 1 || only === undefined || only.background) return undefined
  let answer = answerOf(only.first)
  for (const [joint, pipeline] of only.rest) {
    const next = answerOf(pipeline)
    const decides = joint === "||"
    answer = answer === decides ? decides : answer === !decides ? next : next === decides ? decides : undefined
  }
  return answer
}

/** True for a body whose last statement ends the script. */
const exits = (body: ReadonlyArray<Statement>): boolean => {
  const last = body.at(-1)
  const [only] = last?.first.commands ?? []
  return last !== undefined && last.rest.length === 0 && !last.background && !last.first.negated
    && last.first.commands.length === 1 && only?.kind === "simple" && only.words[0]?.plain === true
    && only.words[0].text === "exit"
}

/**
 * A script as it runs where `sudo` refuses: without the question `sudo -n
 * true`, without the branches that run only when its answer is yes, and
 * without what follows an `if` that ends the script when the answer is no.
 * A script this cannot read is returned as written.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const withoutSudo = (script: string): string => {
  const edits: Array<readonly [start: number, end: number, text: string]> = []
  const leaveOut = (start: number, end: number): void => {
    if (start < end) edits.push([start, end, "\n"])
  }

  /** Reads statements that run. Returns true when the rest of the script never runs after them. */
  const walk = (statements: ReadonlyArray<Statement>, top: boolean): boolean => {
    for (const statement of statements) {
      const pipelines = [statement.first, ...statement.rest.map(([, pipeline]) => pipeline)]
      const alone = top && pipelines.length === 1 && statement.first.commands.length === 1 && !statement.background
      for (const command of pipelines.flatMap((pipeline) => pipeline.commands)) {
        if (command.kind === "block") walk(command.body, false)
        else if (command.kind === "if") {
          if (conditional(command) && alone) return true
        } else if (asks(command)) {
          // The question changes nothing, and in a replay its answer is no.
          edits.push([(command.words[0] as Token).start, (command.words.at(-1) as Token).end, "false"])
        }
      }
    }
    return false
  }

  /** Reads an `if`. Returns true when its first branch always runs and ends the script. */
  const conditional = (command: Command & { readonly kind: "if" }): boolean => {
    const { branches, fi, otherwise } = command
    for (const [index, branch] of branches.entries()) {
      walk(branch.test, false)
      const answer = answerOfTest(branch.test)
      const next = branches[index + 1]?.start ?? otherwise?.start ?? fi.start
      if (answer === false) {
        leaveOut(branch.then.end, next)
        continue
      }
      walk(branch.body, false)
      if (answer === true) {
        // Nothing after a branch that always runs is reached.
        leaveOut(next, fi.start)
        return index === 0 && exits(branch.body)
      }
    }
    if (otherwise !== undefined) walk(otherwise.body, false)
    return false
  }

  try {
    const tokens = lex(script)
    // A script that sets PATH may find another `sudo` than the stand-in a replay puts first.
    if (tokens.some((token) => token.word && /^PATH\+?=/.test(token.text))) return script
    const statements = parse(tokens)
    for (const statement of statements) {
      if (!walk([statement], true)) continue
      const [only] = statement.first.commands as [Command & { readonly kind: "if" }]
      leaveOut(only.fi.end, script.length)
      break
    }
  } catch {
    // Not followed: its structure is none this reader knows, or it nests deeper than the reader goes.
    return script
  }
  let text = script
  for (const [start, end, replacement] of edits.sort((left, right) => right[0] - left[0])) {
    text = text.slice(0, start) + replacement + text.slice(end)
  }
  return text
}
