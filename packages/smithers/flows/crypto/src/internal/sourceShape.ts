/**
 * A function's source as a minifier leaves it: its tokens, with every binding
 * renamed by the order it is declared in.
 *
 * A production bundle is minified, and a minifier renames bindings by how
 * often the whole bundle uses each one, so unrelated code elsewhere in the
 * bundle renames an unchanged callback. Oxc and Terser also reuse one short
 * name for unrelated bindings in nested scopes, so no renaming by order of
 * appearance agrees between two builds. Renaming each binding by where it is
 * declared, and resolving every use through the scopes it is read in, does:
 * that is the callback up to the names a minifier chooses, and nothing less.
 *
 * - A binding is `$` and its number in declaration order: parameters, `var`,
 *   `let` and `const`, function and class names, and `catch` parameters, in
 *   function, block, `catch`, `for` and class-name scopes.
 * - A name the source reads but never declares is `$f` and its number in
 *   order of first use (except built-in and host names, kept by name),
 *   a label `$l` and its number, a private name `#` and its number.
 * - Literals, keywords and operators are kept verbatim, and so are a property
 *   name after `.` or `?.` and an object or class key. A shorthand member
 *   `{ value }` is written `value : $0`, the form a minifier gives it once it
 *   renames the binding.
 * - Comments and whitespace are dropped. A line break is kept only where it
 *   ends a statement: after `return`, `break`, `continue`, `throw`, `yield`
 *   or `async`, and before a `++` or `--` that follows an operand. A class
 *   member that follows a field at a line break gets the `;` a minifier
 *   writes there, so the next field's name stays a key.
 *
 * So swapping two parameters' or two locals' uses changes the shape. What it
 * cannot see is which outer binding a name reads, beyond the pattern of its
 * reads: `f(a, b)` and `f(b, a)` read the same when `a` and `b` are declared
 * outside the function, because a minifier may give them each other's names.
 *
 * This reads tokens, not a syntax tree, and decides the two ambiguities a
 * tokenizer must: `/` starts a regular expression where an operand cannot
 * end, including after a statement head's closing parenthesis, and `{` opens
 * an object where an expression can start. Source a function was parsed from
 * is valid; a misread of an unusual construct makes two builds of one
 * callback read differently, which a
 * resume refuses, rather than two different callbacks read alike.
 *
 * @since 1.0.0
 * @private
 */

/** Words that are never a binding's name. @private */
const reserved = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield"
])

/**
 * Built-in and host names, including implicit arguments, are semantic identities,
 * never minifier bindings.
 * Keep this explicit and host-independent: inspecting globalThis would make
 * the same callback's identity depend on the runtime building its plan.
 * Scope resolution runs first, so a local with any of these names still renames.
 * @private
 */
const builtinGlobals = new Set([
  "globalThis",
  "arguments",
  "undefined",
  "NaN",
  "Infinity",
  "eval",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "Object",
  "Function",
  "Boolean",
  "Symbol",
  "Number",
  "BigInt",
  "Math",
  "Date",
  "String",
  "RegExp",
  "Array",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Atomics",
  "JSON",
  "WeakRef",
  "FinalizationRegistry",
  "Iterator",
  "AsyncIterator",
  "Promise",
  "Reflect",
  "Proxy",
  "Intl",
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "WebAssembly",
  "fetch",
  "Request",
  "Response",
  "Headers",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "TextEncoderStream",
  "TextDecoderStream",
  "crypto",
  "Crypto",
  "CryptoKey",
  "SubtleCrypto",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "ByteLengthQueuingStrategy",
  "CountQueuingStrategy",
  "AbortController",
  "AbortSignal",
  "Event",
  "EventTarget",
  "CustomEvent",
  "DOMException",
  "Blob",
  "File",
  "FormData",
  "WebSocket",
  "process",
  "Buffer",
  "require",
  "window",
  "self",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "setImmediate",
  "XMLHttpRequest",
  "Worker",
  "MessageChannel",
  "BroadcastChannel",
  "console",
  "performance",
  "structuredClone",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  "atob",
  "btoa"
])

/** Reserved words that are operands, after which `/` divides. @private */
const operands = new Set(["false", "null", "super", "this", "true"])

/** Words after which an expression starts, so `/` opens a regular expression. @private */
const beforeExpression = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield"
])

/** Words whose parenthesized heads are followed by a statement. @private */
const statementHeads = new Set(["if", "while", "for", "with"])

/** Words after which `{` opens an object literal or pattern rather than a block. @private */
const beforeObject = new Set([
  "await",
  "case",
  "const",
  "delete",
  "extends",
  "in",
  "instanceof",
  "let",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "var",
  "void",
  "yield"
])

/** Words whose following line break ends the statement. @private */
const restricted = new Set(["async", "break", "continue", "return", "throw", "yield"])

/** Words that modify the member key after them. @private */
const modifiers = new Set(["async", "get", "set", "static"])

/** Multi-character punctuators, longest first, so the first match is the longest. @private */
const multiCharacter = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>"
]

/** The multi-character punctuators by their first character, longest first. @private */
const punctuators = new Map<string, ReadonlyArray<string>>()
for (const punctuator of multiCharacter) {
  punctuators.set(punctuator[0]!, [...(punctuators.get(punctuator[0]!) ?? []), punctuator])
}

/** Punctuators that end an operand. @private */
const closers = new Set([")", "]", "}", "++", "--"])

/** Punctuators after which `{` opens a block. @private */
const beforeBlock = new Set([")", "=>", ";", "{", "}"])

/** @private */
type Kind = "name" | "private" | "literal" | "template" | "punctuator"

/** @private */
interface Token {
  readonly kind: Kind
  readonly text: string
  /** A line terminator comes between this token and the one before it. */
  readonly newline: boolean
  /** Closes a statement head rather than an operand. */
  readonly statementHead: boolean
}

const idStart = /[$_\p{ID_Start}]/u
const idPart = /[$\u200c\u200d\p{ID_Continue}]/u

/** Whether the code point at `index` can continue a name, and how many code units it spans. @private */
const namePart = (source: string, index: number): number => {
  const code = source.charCodeAt(index)
  if (code < 128) {
    return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) ||
        code === 36 || code === 95 || code === 92
      ? 1
      : 0
  }
  const point = source.codePointAt(index)!
  return idPart.test(String.fromCodePoint(point)) ? (point > 0xffff ? 2 : 1) : 0
}

/**
 * Whether a name starts at `index`. A digit passes here, but the tokenizer
 * reads a digit as a number before it asks. Past the end there is no code
 * point, and NUL starts no name.
 *
 * @private
 */
const nameStart = (source: string, index: number): boolean => {
  const code = source.charCodeAt(index)
  return code < 128 ? namePart(source, index) === 1 : idStart.test(String.fromCodePoint(source.codePointAt(index) ?? 0))
}

const isDigit = (code: number): boolean => code >= 48 && code <= 57
const isLineTerminator = (code: number): boolean => code === 10 || code === 13 || code === 0x2028 || code === 0x2029
/** Whitespace other than a line terminator. Only a non-ASCII character pays for the Unicode test. @private */
const isSpace = (code: number, character: string): boolean =>
  code === 32 || code === 9 || code === 11 || code === 12 || (code > 127 && /\s/.test(character))

/** Whether the token before `/` lets it open a regular expression. @private */
const regexAfter = (token: Token | undefined): boolean => {
  if (token === undefined) return true
  switch (token.kind) {
    case "punctuator":
      return token.text !== ")" && token.text !== "]" && token.text !== "++" && token.text !== "--"
    case "name":
      return beforeExpression.has(token.text)
    case "template":
      return token.text.endsWith("${")
    default:
      return false
  }
}

/** Whether the token ends an operand, so a line break before `++` or `--` ends the statement. @private */
const endsOperand = (token: Token): boolean => {
  switch (token.kind) {
    case "punctuator":
      return closers.has(token.text)
    case "name":
      return !reserved.has(token.text) || operands.has(token.text)
    case "template":
      return !token.text.endsWith("${")
    default:
      return true
  }
}

/**
 * Whether the token, after an operand and a line break, starts a new class
 * member: a key that cannot continue the field before it. `in` and
 * `instanceof` continue it, and so do `[`, `(`, `*` and a template.
 *
 * @private
 */
const startsMember = (token: Token): boolean =>
  token.kind === "name" ? token.text !== "in" && token.text !== "instanceof" : token.kind === "private" ||
    token.kind === "literal"

/** The end of the template chunk that starts at `start`, after its `` ` `` or `}`. @private */
const templateEnd = (source: string, start: number): number => {
  let index = start + 1
  while (index < source.length) {
    const code = source.charCodeAt(index)
    if (code === 92) index += 2
    else if (code === 96) return index + 1
    else if (code === 36 && source.charCodeAt(index + 1) === 123) return index + 2
    else index++
  }
  return source.length
}

/** The end of the regular expression that starts at `start`, or `-1` when none does. @private */
const regexEnd = (source: string, start: number): number => {
  let index = start + 1
  let inClass = false
  while (index < source.length) {
    const code = source.charCodeAt(index)
    if (isLineTerminator(code)) return -1
    if (code === 92) index += 2
    else {
      if (code === 91) inClass = true
      else if (code === 93) inClass = false
      else if (code === 47 && !inClass) {
        index++
        while (index < source.length && namePart(source, index) > 0) index += namePart(source, index)
        return index
      }
      index++
    }
  }
  return -1
}

/** The end of the number that starts at `start`. @private */
const numberEnd = (source: string, start: number): number => {
  let index = start
  const digits = () => {
    while (index < source.length && (isDigit(source.charCodeAt(index)) || source[index] === "_")) index++
  }
  if (source[index] === "0" && /[box]/i.test(source[index + 1] ?? "")) {
    index += 2
    while (index < source.length && namePart(source, index) === 1) index++
    return index
  }
  digits()
  if (source[index] === ".") {
    index++
    digits()
  }
  if (source[index] === "e" || source[index] === "E") {
    index++
    if (source[index] === "+" || source[index] === "-") index++
    digits()
  }
  return source[index] === "n" ? index + 1 : index
}

/** The source's tokens, without comments or whitespace. @private */
const tokenize = (source: string): ReadonlyArray<Token> => {
  const tokens: Array<Token> = []
  // Which open brace a `}` closes: a block or object, or a template substitution.
  const braces: Array<"{" | "${"> = []
  // A statement head's closing parenthesis admits a regex; an operand's does not.
  const parentheses: Array<boolean> = []
  let afterStatementHead = false
  let newline = false
  let index = 0
  const push = (kind: Kind, end: number): void => {
    const text = source.slice(index, end)
    if (kind === "punctuator" && text === "(") {
      const previous = tokens.length - 1
      const head = tokens[previous]?.text === "await" && tokens[previous - 1]?.text === "for"
        ? previous - 1
        : previous
      parentheses.push(
        tokens[head]?.kind === "name" && statementHeads.has(tokens[head].text) &&
          tokens[head - 1]?.text !== "." && tokens[head - 1]?.text !== "?."
      )
    }
    afterStatementHead = kind === "punctuator" && text === ")" && parentheses.pop() === true
    tokens.push({ kind, text, newline, statementHead: afterStatementHead })
    newline = false
    index = end
  }
  while (index < source.length) {
    const code = source.charCodeAt(index)
    const next = source.charCodeAt(index + 1)
    if (isLineTerminator(code)) {
      newline = true
      index++
    } else if (isSpace(code, source[index]!)) {
      index++
    } else if (code === 47 && next === 47) {
      while (index < source.length && !isLineTerminator(source.charCodeAt(index))) index++
    } else if (code === 47 && next === 42) {
      const close = source.indexOf("*/", index + 2)
      const end = close === -1 ? source.length : close + 2
      if (/[\n\r\u2028\u2029]/.test(source.slice(index, end))) newline = true
      index = end
    } else if (code === 96 || (code === 125 && braces[braces.length - 1] === "${")) {
      if (code === 125) braces.pop()
      const end = templateEnd(source, index)
      if (source.endsWith("${", end)) braces.push("${")
      push("template", end)
    } else if (code === 34 || code === 39) {
      let end = index + 1
      while (end < source.length && source.charCodeAt(end) !== code) end += source.charCodeAt(end) === 92 ? 2 : 1
      push("literal", Math.min(end + 1, source.length))
    } else if (
      code === 47 && (afterStatementHead || regexAfter(tokens[tokens.length - 1])) && regexEnd(source, index) !== -1
    ) {
      push("literal", regexEnd(source, index))
    } else if (isDigit(code) || (code === 46 && isDigit(next))) {
      push("literal", numberEnd(source, index))
    } else if (code === 35 && nameStart(source, index + 1)) {
      let end = index + 1
      while (end < source.length && namePart(source, end) > 0) end += namePart(source, end)
      push("private", end)
    } else if (nameStart(source, index)) {
      let end = index
      while (end < source.length && namePart(source, end) > 0) end += namePart(source, end)
      push("name", end)
    } else {
      const text = punctuators.get(source[index]!)?.find((candidate) =>
        source.startsWith(candidate, index) && !(candidate === "?." && isDigit(source.charCodeAt(index + 2)))
      ) ?? source[index]!
      if (text === "{") {
        braces.push("{")
      } else if (text === "}") {
        braces.pop()
      }
      push("punctuator", index + text.length)
    }
  }
  return tokens
}

/** @private */
interface Context {
  /** What the innermost open bracket is. */
  readonly kind: "block" | "object" | "class" | "group" | "template"
  /** `?` seen at this level whose `:` has not come yet. */
  conditionals: number
  /** The next name is a member key rather than an expression. */
  key: boolean
  /** A class body's scope, where each member's expression starts. */
  readonly scope?: Scope
}

/**
 * Where bindings are declared: a function's parameters and body, a block, a
 * `catch` clause, a `for` head with its body, or a class expression's name.
 *
 * @private
 */
interface Scope {
  readonly parent: Scope | undefined
  /** Each name declared here, and the number of the binding it names; made on the first. */
  names: Map<string, number> | undefined
  /** The last token inside the scope. */
  readonly end: number
  /** A function's scope, where `var` declares. */
  readonly function: boolean
}

/** A name read in `scope`, resolved once every declaration is known. @private */
interface Use {
  readonly name: string
  readonly scope: Scope
}

/** Punctuators that open a bracketed group. @private */
const openers = new Set(["(", "[", "{"])

/** Punctuators that close one. @private */
const closing = new Set([")", "]", "}"])

/** Where a default value, an initializer or a declarator ends. @private */
const commaStops = new Set([",", ";"])

/** Where an arrow function's expression body ends. @private */
const arrowStops = new Set([",", ";", ":"])

/** Where an expression statement ends. @private */
const statementStops = new Set([";"])

/** What an opening `{` starts, given the token before it. @private */
const braceKind = (previous: Token | undefined, statementColon: boolean): "block" | "object" => {
  if (previous === undefined) return "block"
  switch (previous.kind) {
    case "punctuator":
      if (beforeBlock.has(previous.text)) return "block"
      return previous.text === ":" && statementColon ? "block" : "object"
    case "name":
      return beforeObject.has(previous.text) ? "object" : "block"
    case "template":
      return previous.text.endsWith("${") ? "object" : "block"
    default:
      return "block"
  }
}

/** Whether a token opens a group: a bracket, or a template's first substitution. @private */
const opensGroup = (token: Token): boolean =>
  token.kind === "punctuator"
    ? openers.has(token.text)
    : token.kind === "template" && token.text.startsWith("`") && token.text.endsWith("${")

/**
 * The shape of a function's source: its tokens joined by single spaces, with
 * every binding renamed by the order it is declared in.
 *
 * A binding is `$` and its number: parameters, `var`, `let`, `const`,
 * function and class names, and `catch` parameters, numbered as they are
 * declared. Every use is resolved through the scopes it is read in, so
 * shadowing reads the same whichever names a minifier chose. A name the
 * source never declares is `$f` and its number, in order of first use, except
 * standard built-in globals, which retain their names; a
 * label is `$l` and its number; a private name `#` and its number.
 *
 * @since 1.0.0
 * @private
 */
export const sourceShape = (source: string): string => {
  const tokens = tokenize(source)
  const count = tokens.length
  const last = count - 1
  const is = (index: number, text: string): boolean =>
    tokens[index]?.kind === "punctuator" && tokens[index].text === text
  const word = (index: number, text: string): boolean => tokens[index]?.kind === "name" && tokens[index].text === text

  // The token that closes each group's opener, and the opener of each bracket that closes one.
  // Typed and filled with -1 for none, so a sparse write never turns them into dictionaries.
  const pair = new Int32Array(count).fill(-1)
  const opener = new Int32Array(count).fill(-1)
  const open: Array<number> = []
  for (let index = 0; index < count; index++) {
    const token = tokens[index]!
    if (token.kind === "template") {
      if (token.text.startsWith("}") && open.length > 0) pair[open.pop()!] = index
      if (token.text.endsWith("${")) open.push(index)
    } else if (token.kind === "punctuator") {
      if (openers.has(token.text)) open.push(index)
      else if (closing.has(token.text) && open.length > 0) {
        const start = open.pop()!
        pair[start] = index
        opener[index] = start
      }
    }
  }

  /** The index after the group that opens at `index`, or the end when it never closes. */
  const after = (index: number): number => {
    // Past the end a typed array reads `undefined`, which is no index either.
    let close = pair[index]!
    while (close >= 0 && tokens[close]!.text.endsWith("${")) close = pair[close]!
    return close >= 0 ? close + 1 : count
  }

  /**
   * The first token from `start` that ends the expression there: one of
   * `stops` (a `:` only past every `?`), or a closer of an enclosing group.
   * Groups inside are skipped whole.
   */
  const until = (start: number, stops: ReadonlySet<string>, limit = count, doBody = false): number => {
    let index = start
    let conditionals = 0
    while (index < limit) {
      const token = tokens[index]!
      if (opensGroup(token)) {
        index = after(index)
        continue
      }
      if (
        token.kind === "template"
          ? token.text.startsWith("}")
          : closing.has(token.text) && token.kind === "punctuator"
      ) {
        return index
      }
      if (
        doBody && (word(index, "while") || word(index, "else")) &&
        !is(index - 1, ".") && !is(index - 1, "?.")
      ) return index
      if (is(index, "?")) conditionals++
      else if (is(index, ":") && conditionals > 0) conditionals--
      else if (token.kind === "punctuator" && stops.has(token.text)) return index
      index++
    }
    return Math.min(index, limit)
  }

  /** The last token of a statement; a do body also ends before its tail or an enclosing else. */
  const statementEnd = (start: number, depth: number, doBody = false): number => {
    // Continuations avoid recursive stack limits when recognizing a do-while tail.
    const pending: Array<{ kind: "if" | "do"; depth: number; doBody: boolean }> = []
    statement: while (true) {
      const token = tokens[start]
      let end: number
      if (token === undefined || (!doBody && depth > 256)) end = last
      else if (is(start, "{")) end = after(start) - 1
      else {
        switch (token.kind === "name" ? token.text : "") {
          case "if":
            pending.push({ kind: "if", depth, doBody })
            start = after(start + 1)
            depth++
            continue
          case "for":
          case "while":
          case "with":
            start = after(word(start + 1, "await") ? start + 2 : start + 1)
            depth++
            continue
          case "do":
            pending.push({ kind: "do", depth, doBody })
            start++
            depth++
            continue
          case "try":
            end = after(start + 1) - 1
            if (word(end + 1, "catch")) end = after(is(end + 2, "(") ? after(end + 2) : end + 2) - 1
            if (word(end + 1, "finally")) end = after(end + 2) - 1
            break
          case "switch":
            end = after(after(start + 1)) - 1
            break
          default:
            if (token.kind === "name" && is(start + 1, ":")) {
              start += 2
              depth++
              continue
            }
            end = until(start, statementStops, count, doBody)
            if (!is(end, ";")) end--
        }
      }
      while (pending.length > 0) {
        const parent = pending.pop()!
        depth = parent.depth
        doBody = parent.doBody
        if (parent.kind === "do") {
          const close = after(end + 2) - 1
          end = is(close + 1, ";") ? close + 1 : close
        } else if (word(end + 1, "else")) {
          start = end + 2
          depth++
          continue statement
        }
      }
      return end
    }
  }

  const root: Scope = { parent: undefined, names: undefined, end: last, function: true }
  let scope = root
  let declared = 0
  // The binding each declaring token declares, or -1.
  const binding = new Int32Array(count).fill(-1)
  // Contextual words read as keywords: `async` before a function, `of` in a `for` head.
  const kept = new Set<number>()
  // Labels, defined or read.
  const labelled = new Set<number>()
  // The `{` of a function or `catch` body, which opens no scope of its own.
  const bodies = new Set<number>()
  // The `[` of a computed member key.
  const computed = new Set<number>()
  // A do-while tail ends a statement even when its semicolon is omitted.
  const doWhileEnds = new Set<number>()

  const declare = (index: number, target: Scope): void => {
    const name = tokens[index]!.text
    target.names ??= new Map()
    let id = target.names.get(name)
    if (id === undefined) {
      id = declared++
      target.names.set(name, id)
    }
    binding[index] = id
  }
  const enter = (end: number, isFunction: boolean): Scope => {
    scope = { parent: scope, names: undefined, end: Math.min(end, scope.end), function: isFunction }
    return scope
  }

  /** Declares a binding pattern's names in `target`; the index after the pattern. */
  const pattern = (start: number, target: Scope, limit: number): number => {
    const token = tokens[start]
    if (token === undefined || start >= limit) return start + 1
    if (token.kind === "name") {
      if (!reserved.has(token.text)) declare(start, target)
      return start + 1
    }
    if (!is(start, "[") && !is(start, "{")) return start + 1
    const close = Math.min(after(start) - 1, limit)
    let index = start + 1
    while (index < close) {
      if (is(index, ",")) {
        index++
        continue
      }
      if (is(index, "...")) index = pattern(index + 1, target, close)
      else if (is(start, "[")) index = pattern(index, target, close)
      else if (is(index, "[")) index = is(after(index), ":") ? pattern(after(index) + 1, target, close) : after(index)
      else if (is(index + 1, ":")) index = pattern(index + 2, target, close)
      else index = pattern(index, target, close)
      if (is(index, "=")) index = until(index + 1, commaStops, close)
    }
    return close + 1
  }

  /** Declares the parameters of the list that opens at `start`. */
  const parameters = (start: number, target: Scope): void => {
    const close = after(start) - 1
    let index = start + 1
    while (index < close) {
      if (is(index, ",")) {
        index++
        continue
      }
      index = pattern(is(index, "...") ? index + 1 : index, target, close)
      if (is(index, "=")) index = until(index + 1, commaStops, close)
    }
  }

  /** A function whose parameter list opens at `start`; its body follows the list. */
  const method = (start: number): Scope => {
    const body = after(start)
    const inner = enter(after(body) - 1, true)
    parameters(start, inner)
    bodies.add(body)
    return inner
  }

  /** An arrow function whose parameters start at `start`: a name, or a list. */
  const arrow = (start: number): void => {
    const name = tokens[start]!.kind === "name"
    const body = (name ? start + 1 : after(start)) + 1
    const inner = enter(is(body, "{") ? after(body) - 1 : until(body, arrowStops) - 1, true)
    if (name) declare(start, inner)
    else parameters(start, inner)
    if (is(body, "{")) bodies.add(body)
  }

  const stack: Array<Context> = [{ kind: "block", conditionals: 0, key: false }]
  // The depth at which `class` was read, so the next `{` there opens its body.
  let classAt = -1
  // Whether the last `:` ended a `case` or a label rather than a key or a conditional.
  let statementColon = false

  /** Whether a statement may start after the token at `index`. */
  const statementAfter = (index: number): boolean => {
    const token = tokens[index]
    if (token === undefined) return true
    if (token.kind === "punctuator") {
      return [";", "{", "}", ")"].includes(token.text) || (token.text === ":" && statementColon)
    }
    return token.kind === "name" && (token.text === "else" || token.text === "do")
  }

  /** Whether `async` at `index` makes the function after it asynchronous. */
  const asyncFunction = (index: number): boolean =>
    (word(index + 1, "function") && !tokens[index + 1]!.newline) ||
    (tokens[index + 1]?.kind === "name" && is(index + 2, "=>")) ||
    (is(index + 1, "(") && is(after(index + 1), "=>"))

  /** What a keyword at `index` declares or opens. */
  const keyword = (index: number): void => {
    const text = tokens[index]!.text
    // A declaration's statement position is before `async function`, not between.
    const before = kept.has(index - 1) ? index - 2 : index - 1
    switch (text) {
      case "function": {
        let cursor = index + 1
        if (is(cursor, "*")) cursor++
        const name = tokens[cursor]?.kind === "name" ? cursor++ : undefined
        if (!is(cursor, "(")) return
        if (name !== undefined && statementAfter(before)) {
          declare(name, scope)
          method(cursor)
        } else {
          const inner = method(cursor)
          if (name !== undefined) declare(name, inner)
        }
        return
      }
      case "class": {
        classAt = stack.length
        const name = tokens[index + 1]?.kind === "name" && !word(index + 1, "extends") ? index + 1 : undefined
        if (name === undefined) return
        let body = name + 1
        while (body < count && !is(body, "{")) body = opensGroup(tokens[body]!) ? after(body) : body + 1
        declare(name, statementAfter(before) ? scope : enter(after(body) - 1, false))
        return
      }
      case "catch":
        if (is(index + 1, "(")) {
          const body = after(index + 1)
          pattern(index + 2, enter(after(body) - 1, false), after(index + 1) - 1)
          bodies.add(body)
        }
        return
      case "do": {
        const tail = statementEnd(index + 1, 0, true) + 1
        const close = pair[tail + 1]!
        if (word(tail, "while") && is(tail + 1, "(") && close >= 0 && is(close, ")")) doWhileEnds.add(close)
        return
      }
      case "for": {
        const start = word(index + 1, "await") ? index + 2 : index + 1
        if (!is(start, "(")) return
        const close = after(start) - 1
        if (word(start + 1, "let") || word(start + 1, "const")) enter(statementEnd(close + 1, 0), false)
        for (let cursor = start + 2; cursor < close;) {
          if (word(cursor, "of") && endsOperand(tokens[cursor - 1]!)) {
            kept.add(cursor)
            return
          }
          cursor = opensGroup(tokens[cursor]!) ? after(cursor) : cursor + 1
        }
        return
      }
      case "var":
      case "let":
      case "const": {
        let target = scope
        while (text === "var" && !target.function) target = target.parent!
        let cursor = index + 1
        while (true) {
          cursor = pattern(cursor, target, count)
          if (is(cursor, "=")) cursor = until(cursor + 1, commaStops)
          if (!is(cursor, ",")) return
          cursor++
        }
      }
      case "break":
      case "continue": {
        const label = tokens[index + 1]
        if (label?.kind === "name" && !label.newline && !reserved.has(label.text)) labelled.add(index + 1)
      }
    }
  }

  const shape: Array<string | Use> = []
  const labels = new Map<string, number>()
  const privates = new Map<string, number>()
  const numbered = (names: Map<string, number>, name: string, prefix: string): string => {
    let id = names.get(name)
    if (id === undefined) {
      id = names.size
      names.set(name, id)
    }
    return `${prefix}${id}`
  }
  /** What the name at `index` reads: the binding it declares, or a use resolved at the end. */
  const read = (index: number): string | Use => {
    const own = binding[index]!
    return own < 0 ? { name: tokens[index]!.text, scope } : `$${own}`
  }

  let previous: Token | undefined
  // Whether the previous token ends an operand or a member key, so a member may follow a line break.
  let ended = false
  for (let index = 0; index < count; index++) {
    while (index > scope.end) scope = scope.parent!
    const token = tokens[index]!
    const following = tokens[index + 1]
    const top = stack[stack.length - 1]!
    const member = top.kind === "object" || top.kind === "class"
    if (
      token.newline && previous !== undefined &&
      ((previous.kind === "name" && restricted.has(previous.text)) ||
        ((token.text === "++" || token.text === "--") && endsOperand(previous) &&
          (!previous.statementHead || doWhileEnds.has(index - 1))))
    ) shape.push(";")
    if (
      top.kind === "class" && !top.key && top.conditionals === 0 && token.newline && ended && startsMember(token) &&
      classAt !== stack.length
    ) {
      // A class member after a field that ends at a line break, as a minifier writes it, unless
      // a class head at this depth is still open. The field's arrow functions end with it.
      if (shape[shape.length - 1] !== ";") shape.push(";")
      top.key = true
      scope = top.scope!
    }
    let ends = endsOperand(token)
    let text: string | Use = token.text
    if (token.kind === "template") {
      if (token.text.startsWith("}") && stack.length > 1) stack.pop()
      if (token.text.endsWith("${")) stack.push({ kind: "template", conditionals: 0, key: false })
    } else if (token.kind === "private") {
      text = numbered(privates, token.text, "#")
      if (member && top.key && is(index + 1, "(")) method(index + 1)
    } else if (token.kind === "punctuator") {
      switch (token.text) {
        case "{": {
          const kind = classAt === stack.length ? "class" : braceKind(previous, statementColon)
          if (kind === "class") classAt = -1
          if (kind === "block" && !bodies.has(index)) enter(after(index) - 1, false)
          stack.push({ kind, conditionals: 0, key: kind !== "block", scope })
          break
        }
        case "}": {
          const closed = stack.length > 1 ? stack.pop()! : top
          const parent = stack[stack.length - 1]!
          if (closed.kind === "block" && parent.kind === "class") parent.key = true
          break
        }
        case "(":
          if (is(after(index), "=>")) arrow(index)
          else if (computed.has(opener[index - 1]!)) method(index)
          top.key = false
          stack.push({ kind: "group", conditionals: 0, key: false })
          break
        case "[":
          if (member && top.key) computed.add(index)
          top.key = false
          stack.push({ kind: "group", conditionals: 0, key: false })
          break
        case ")":
        case "]":
          if (stack.length > 1) stack.pop()
          break
        case "?":
          top.conditionals++
          break
        case ":":
          statementColon = top.conditionals === 0 && top.kind === "block"
          if (top.conditionals > 0) top.conditionals--
          break
        case ",":
          top.key = top.kind === "object" && top.conditionals === 0
          break
        case ";":
          top.key = top.kind === "class"
          break
        case "*":
          break
        default:
          top.key = false
      }
    } else if (token.kind === "name") {
      if (previous?.kind === "punctuator" && (previous.text === "." || previous.text === "?.")) {
        // A property name.
        ends = true
      } else if (member && top.key) {
        const modifier = modifiers.has(token.text) && following !== undefined &&
          (following.kind !== "punctuator" || following.text === "[" || following.text === "*")
        if (!modifier) {
          top.key = false
          ends = true
          const next = following?.text
          if (is(index + 1, "(")) method(index + 1)
          else if (top.kind === "object" && (next === "," || next === "}" || next === "=")) {
            shape.push(`${token.text} :`)
            text = read(index)
          }
        }
      } else if (binding[index]! >= 0) {
        text = `$${binding[index]}`
      } else if (labelled.has(index)) {
        text = numbered(labels, token.text, "$l")
      } else if (kept.has(index)) {
        // A contextual keyword.
      } else if (reserved.has(token.text)) {
        keyword(index)
      } else if (token.text === "async" && asyncFunction(index)) {
        kept.add(index)
      } else if (is(index + 1, "=>")) {
        arrow(index)
        text = `$${binding[index]}`
      } else if (is(index + 1, ":") && top.kind === "block" && top.conditionals === 0 && statementAfter(index - 1)) {
        labelled.add(index)
        text = numbered(labels, token.text, "$l")
      } else {
        text = read(index)
      }
    } else {
      // A literal: a string or number key opens a method like a name does.
      if (member && top.key && is(index + 1, "(")) method(index + 1)
      top.key = false
    }
    shape.push(text)
    previous = token
    ended = ends
  }

  const free = new Map<string, number>()
  return shape.map((piece) => {
    if (typeof piece === "string") return piece
    for (let current: Scope | undefined = piece.scope; current !== undefined; current = current.parent) {
      const id = current.names?.get(piece.name)
      if (id !== undefined) return `$${id}`
    }
    if (builtinGlobals.has(piece.name)) return piece.name
    return numbered(free, piece.name, "$f")
  }).join(" ")
}
