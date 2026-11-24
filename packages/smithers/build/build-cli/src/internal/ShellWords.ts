/**
 * The programs a shell command names.
 *
 * A command-form target runs text, not an argv, so the planner reads the
 * text for the programs it starts by name: the first word of each simple
 * command, through `bash -c '...'`, `env`, `exec` and the words of `if` and
 * `for`. Each one found on `PATH` is keyed by its bytes.
 *
 * This is a reading, not a shell. A name built at run time (`$TOOL`), a
 * function, an alias and a program another program starts are not found, and
 * a word that is no program (a line of a here-document) may be. The caller
 * keeps only the names `PATH` resolves, so a wrong word costs nothing.
 *
 * @since 1.0.0
 */

/** One word of a command, and whether the shell computes part of it. */
interface Word {
  readonly text: string
  readonly dynamic: boolean
}

/** Splits shell text into simple commands. */
const simpleCommands = (text: string): ReadonlyArray<ReadonlyArray<Word>> => {
  const commands: Array<ReadonlyArray<Word>> = []
  let words: Array<Word> = []
  let current: string | undefined
  let dynamic = false
  const endWord = (): void => {
    if (current !== undefined) words.push({ text: current, dynamic })
    current = undefined
    dynamic = false
  }
  const endCommand = (): void => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === "'") {
      const close = text.indexOf("'", index + 1)
      const end = close === -1 ? text.length : close
      current = (current ?? "") + text.slice(index + 1, end)
      index = end
    } else if (char === "\"") {
      current ??= ""
      for (index++; index < text.length && text[index] !== "\""; index++) {
        if (text[index] === "\\") index++
        else if (text[index] === "$" || text[index] === "`") dynamic = true
        current += text[index] ?? ""
      }
    } else if (char === "\\") {
      index++
      if (text[index] !== "\n") current = (current ?? "") + (text[index] ?? "")
    } else if (char === "#" && current === undefined) {
      const newline = text.indexOf("\n", index)
      index = newline === -1 ? text.length : newline - 1
    } else if (char === "$" && text[index + 1] === "{") {
      const close = text.indexOf("}", index)
      const end = close === -1 ? text.length : close
      current = (current ?? "") + text.slice(index, end + 1)
      dynamic = true
      index = end
    } else if (char === "$" || char === "`") {
      // A substitution starts a command of its own; the word holding it is
      // computed, so it names no program.
      current = (current ?? "") + char
      dynamic = true
      if (char === "`" || text[index + 1] === "(") endCommand()
    } else if (char === " " || char === "\t") endWord()
    else if (";&|\n()".includes(char)) endCommand()
    else current = (current ?? "") + char
  }
  endCommand()
  return commands
}

/** Words a program follows: the command position continues after them. */
const leading: ReadonlySet<string> = new Set([
  "!",
  "{",
  "builtin",
  "command",
  "do",
  "elif",
  "else",
  "env",
  "exec",
  "if",
  "nohup",
  "then",
  "time",
  "until",
  "while"
])

const shells: ReadonlySet<string> = new Set(["sh", "bash", "dash", "zsh", "ksh"])

/**
 * The command string a shell argv passes with -c, if present.
 *
 * @category parsing
 * @since 1.0.0
 */
export const commandText = (argv: ReadonlyArray<string>): string | undefined => {
  const program = argv[0]?.split(/[/\\]/).at(-1)?.replace(/\.exe$/i, "")
  if (program === undefined || !shells.has(program)) return undefined
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index]!
    if (/^--[A-Za-z0-9-]+$/.test(flag)) continue
    if (!/^-[A-Za-z]+$/.test(flag)) return undefined
    if (flag.includes("c")) return argv[index + 1]
    if (flag.endsWith("o")) index++
  }
  return undefined
}

const programs = (text: string, depth: number): ReadonlyArray<string> => {
  const found: Array<string> = []
  for (const words of simpleCommands(text)) {
    let index = 0
    while (index < words.length) {
      const word = words[index]!
      if (leading.has(word.text)) {
        index++
        // The flags of `env -i` and `exec -a`, and what `env` assigns.
        while (index < words.length && words[index]!.text.startsWith("-")) index++
      } else if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word.text)) index++
      else break
    }
    const program = words[index]
    // A program's name holds a letter: the `1` of `2>&1` is no program.
    if (program === undefined || program.dynamic || !/^(?=.*[A-Za-z])[A-Za-z0-9_./+-]+$/.test(program.text)) continue
    found.push(program.text)
    if (depth === 4) continue
    const nested = commandText(words.slice(index).map((word) => word.text))
    if (nested !== undefined) found.push(...programs(nested, depth + 1))
  }
  return found
}

/**
 * The program names a shell command starts, each once, in the order the text
 * names them.
 *
 * @category parsing
 * @since 1.0.0
 */
export const commands = (text: string): ReadonlyArray<string> => [...new Set(programs(text, 0))]
