/**
 * A small, dependency-free coloring of TypeScript, JavaScript and VibeLang for
 * a home's `code` block: comments, strings, numbers, keywords, types and
 * calls. Any other language, or text this doesn't recognize, stays plain. It
 * only ever splits the text into spans; joined back, the tokens are the
 * source.
 */

/** What a token is, for its color; none for plain text. */
export type TokenKind = "comment" | "string" | "number" | "keyword" | "type" | "call";

export type Token = { readonly text: string; readonly kind?: TokenKind };

/** The languages this colors. */
export const colored: ReadonlySet<string> = new Set(["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs", "vibe", "sh", "bash", "shell", "zsh"]);

/** VibeLang's own keywords, beside TypeScript's. */
const VIBE_KEYWORDS = new Set(["catch", "control", "do", "error", "fork", "handle", "join", "match", "provide", "resume", "schema", "service", "throw", "when"]);

const KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete", "do", "else",
  "export", "extends", "false", "finally", "for", "from", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "of", "readonly", "return", "satisfies", "static", "super", "switch", "this",
  "throw", "true", "try", "type", "typeof", "undefined", "var", "void", "while", "yield",
]);

const TYPES = new Set(["string", "number", "boolean", "bigint", "symbol", "unknown", "never", "any", "object"]);

// One alternative per kind, in priority order: comments, strings, numbers, words. Anything else is one plain char.
const PATTERN =
  /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/y;

/**
 * The kind of a word that ends at `end` in `code`: a keyword; a call, before `(`; a type, a built-in one or a
 * capitalized word that isn't a namespace (`Effect.` stays plain); else plain.
 */
const wordKind = (word: string, code: string, end: number, vibe: boolean): TokenKind | undefined => {
  if (KEYWORDS.has(word) || vibe && VIBE_KEYWORDS.has(word)) return "keyword";
  if (/^\s*\(/.test(code.slice(end, end + 8))) return "call";
  return TYPES.has(word) || /^[A-Z]/.test(word) && code[end] !== "." ? "type" : undefined;
};

/** `code`'s tokens, in order. */
const SHELL_PATTERN = /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/y;
const SHELL_KEYWORDS = new Set("if then else elif fi for in do done case esac while until function export source return exit echo cd npm pnpm npx bun node cargo curl git jj".split(" "));

const tokensOf = (code: string, vibe: boolean, shell: boolean): ReadonlyArray<Token> => {
  const tokens: Array<Token> = [];
  let plain = "";
  const flush = () => {
    if (plain !== "") tokens.push({ text: plain });
    plain = "";
  };
  for (let index = 0; index < code.length;) {
    const pattern = shell ? SHELL_PATTERN : PATTERN;
    pattern.lastIndex = index;
    const match = pattern.exec(code);
    if (match === null) {
      plain += code[index];
      index += 1;
      continue;
    }
    const [text, comment, string, number, word] = match;
    const end = index + text.length;
    const kind: TokenKind | undefined = comment !== undefined
      ? "comment"
      : string !== undefined
      ? "string"
      : number !== undefined
      ? "number"
      : shell ? (SHELL_KEYWORDS.has(word!) ? "keyword" : undefined) : wordKind(word!, code, end, vibe);
    if (kind === undefined) plain += text;
    else {
      flush();
      tokens.push({ text, kind });
    }
    index = end;
  }
  flush();
  return tokens;
};

/**
 * `code` as lines of tokens: colored for a language in {@link colored}, else
 * each line one plain token. A token that spans lines (a block comment, a
 * template string) is split at each line break, keeping its kind.
 */
export const highlight = (code: string, language: string | undefined): ReadonlyArray<ReadonlyArray<Token>> => {
  if (language === undefined || !colored.has(language)) return code.split("\n").map((line) => [{ text: line }]);
  const lines: Array<Array<Token>> = [[]];
  for (const token of tokensOf(code, language === "vibe", ["sh", "bash", "shell", "zsh"].includes(language))) {
    token.text.split("\n").forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== "") lines[lines.length - 1]!.push(token.kind === undefined ? { text: part } : { text: part, kind: token.kind });
    });
  }
  return lines;
};
