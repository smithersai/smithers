/**
 * A lone read of the engine's tables, with their schema named in its text.
 *
 * The client's search path is set per transaction, because a pooler hands each
 * transaction another server connection, so a lone statement costs four round
 * trips: `BEGIN`, the schema, the statement and `COMMIT`. A read that names its
 * tables' schema needs none of the other three. One TODO alarm made 31 such
 * reads, 93 of its 276 round trips, each holding a pooled connection throughout
 * (2026-11-03, `platform-cloudflare/test/Routing.test.ts`).
 *
 * Every engine table is named `flows_*`. `qualify` rewrites a statement only
 * when it can prove the statement is one plain `SELECT` over those tables, and
 * answers undefined for everything else, which stays framed. A name the rewrite
 * misses fails loudly: outside the search path it resolves nowhere, unless
 * `public` holds a table of that name. Each table position is checked, a
 * `FROM` clause may not list a second relation after a comma, and a `flows_*`
 * name anywhere but a table position or a table's column qualifier refuses the
 * rewrite, so no name is missed and no other name is prefixed.
 *
 * @since 1.0.0-rc.17
 */

const REFUSED =
  /\b(for\s+(no\s+key\s+)?update|for\s+(key\s+)?share|current_schema|current_schemas|set_config|nextval|setval|currval|to_regclass|into|table)\b|\bpg_\w+|::\s*regclass/i

/** The code of `sql` between its literals and quoted identifiers, or undefined if it can't be split with certainty. */
const segments = (sql: string): ReadonlyArray<{ readonly code: boolean; readonly text: string }> | undefined => {
  const parts: Array<{ readonly code: boolean; readonly text: string }> = []
  let start = 0
  for (let at = 0; at < sql.length; at++) {
    const char = sql[at]!
    if (
      // `$1` is a parameter; `$$` and `$tag$` open a dollar-quoted literal.
      char === ";" || (char === "$" && !/\d/.test(sql.charAt(at + 1))) || (char === "-" && sql[at + 1] === "-") ||
      (char === "/" && sql[at + 1] === "*")
    ) {
      return undefined
    }
    if (char !== "'" && char !== "\"") continue
    parts.push({ code: true, text: sql.slice(start, at) })
    let end = at + 1
    for (;;) {
      const next = sql.indexOf(char, end)
      if (next < 0) return undefined
      if (sql[next + 1] !== char) {
        end = next + 1
        break
      }
      end = next + 2
    }
    const quoted = sql.slice(at, end)
    // A quoted name could be a table's: the rewrite doesn't look inside it.
    if (char === "\"" && /^"flows_/i.test(quoted)) {
      const before = sql.slice(0, at).trimEnd()
      if (/\b(from|join)$/i.test(before)) return undefined
    }
    parts.push({ code: false, text: quoted })
    start = end
    at = end - 1
  }
  parts.push({ code: true, text: sql.slice(start) })
  return parts
}

/** A clause that ends a `FROM` clause at its own parenthesis depth. */
const AFTER_FROM = /^(?:where|group|having|window|order|limit|offset|fetch|union|intersect|except|for)$/i

/**
 * Whether a `FROM` clause of `code`, at any parenthesis depth, lists relations
 * separated by a comma. A comma join's later relations follow `ON` clauses,
 * aliases and subqueries, where no table position is read.
 */
const commaJoin = (code: string): boolean => {
  // One entry per open parenthesis: whether that depth is inside a FROM clause.
  const inFrom = [false]
  for (const [token] of code.matchAll(/[(),]|[a-z_]\w*/gi)) {
    if (token === "(") inFrom.push(false)
    else if (token === ")") {
      // A parenthesis closed before it opened: the depths can't be read.
      if (inFrom.length === 1) return true
      inFrom.pop()
    } else if (token === ",") {
      if (inFrom.at(-1)) return true
    } else if (/^from$/i.test(token)) inFrom[inFrom.length - 1] = true
    else if (AFTER_FROM.test(token)) inFrom[inFrom.length - 1] = false
  }
  return false
}

/**
 * `sql` with `schema` named on each `flows_*` table, when it is one plain read
 * of only those tables; undefined when it isn't, or when that can't be proved.
 *
 * @category internals
 * @since 1.0.0-rc.17
 */
export const qualify = (sql: string, schema: string): string | undefined => {
  if (!/^\s*select\b/i.test(sql)) return undefined
  const parts = segments(sql)
  if (parts === undefined) return undefined
  const code = parts.filter((part) => part.code).map((part) => part.text).join(" \u0000 ")
  if (REFUSED.test(code)) return undefined
  // Each name in a table position must be an engine table, or a subquery's parenthesis.
  // A parenthesized join's first relation follows the parenthesis, where no name is read.
  const tables = new Set<string>()
  for (const match of code.matchAll(/\b(?:from|join)\s+([^\s(),]+|\(\s*\w*)/gi)) {
    if (match[1]!.startsWith("(")) {
      if (/^\(\s*select$/i.test(match[1]!)) continue
      return undefined
    }
    if (!/^flows_\w+$/i.test(match[1]!)) return undefined
    tables.add(match[1]!.toLowerCase())
  }
  if (tables.size === 0) return undefined
  if (commaJoin(code)) return undefined
  const name = `"${schema.replaceAll("\"", "\"\"")}"`
  let stray = false
  const qualified = parts
    .map((part) =>
      part.code
        ? part.text.replace(/(?<![\w.])flows_\w+/gi, (table, at: number) => {
          const placed = /\b(?:from|join)\s+$/i.test(part.text.slice(0, at)) ||
            (part.text[at + table.length] === "." && tables.has(table.toLowerCase()))
          if (!placed) stray = true
          return `${name}.${table}`
        })
        : part.text
    )
    .join("")
  return stray ? undefined : qualified
}
