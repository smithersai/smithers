import { describe, expect, it } from "vitest"
import {
  type Context,
  evaluate,
  type Evaluated,
  fields,
  fill,
  finish,
  formatPieces,
  type Residual,
  type Scope,
  split,
  toNumber,
  toText,
  truthy,
  unknown,
  type Value,
  value,
  variable,
  variablesOf,
  whole
} from "../../src/inventory/Expression.ts"

const shared = [1, 2]
const out = variable("STEP_ID", "steps.build.outputs.id")
const outResidual = (out as { residual: Residual }).residual

const contexts: Record<string, Context> = {
  github: fields((name) =>
    ({
      event_name: value("push"),
      ref: value("refs/heads/main"),
      event: value({ Commits: [{ id: "a" }, { id: "b" }, { message: "no id" }] })
    })[name]
  ),
  env: fields((name) => ({ Path: value("/bin") })[name], true),
  matrix: value({ OS: "linux", list: [10, 20, 30], shared, other: shared, nested: { a: { b: 1 }, c: { b: 2 } } }),
  steps: fields((name) =>
    name === "build"
      ? fields((inner) => inner === "outputs" ? fields((key) => key === "id" ? out : undefined) : undefined)
      : undefined
  ),
  runner: unknown("runner is known only on the runner"),
  secrets: { kind: "secret", name: "TOKEN" },
  num: value(5),
  out,
  computed: { kind: "residual", residual: { kind: "literal", value: { a: 1 } } }
}

const scope: Scope = { context: (name) => contexts[name] }
const withStatus: Scope = {
  ...scope,
  status: { success: true, always: true, cancelled: false, failure: false },
  hashFiles: (patterns) => value(`hash:${patterns.join("|")}`)
}

const ok = (residual: Residual): Evaluated => ({ kind: "ok", residual })
const lit = (held: Value): Evaluated => ok({ kind: "literal", value: held })
const run = (text: string, where: Scope = scope): Evaluated => evaluate(text, where)
const why = (text: string, where: Scope = scope): string => {
  const result = run(text, where)
  return result.kind === "problem" ? result.why : `not a problem: ${JSON.stringify(result)}`
}

describe("constructors", () => {
  it("build contexts", () => {
    expect(value(1)).toEqual({ kind: "value", value: 1 })
    expect(variable("A", "a")).toEqual({
      kind: "residual",
      residual: { kind: "variable", variable: { id: "A", name: "a", nullable: false, typed: false } }
    })
    expect(variable("A", "a", true, true)).toEqual({
      kind: "residual",
      residual: { kind: "variable", variable: { id: "A", name: "a", nullable: true, typed: true } }
    })
    expect(unknown("why")).toEqual({ kind: "unknown", why: "why" })
  })
})

// "Evaluate expressions in workflows and actions", Literals.
describe("literals", () => {
  it("reads booleans, null, NaN and Infinity in any case", () => {
    expect(run("true")).toEqual(lit(true))
    expect(run("False")).toEqual(lit(false))
    expect(run("NULL")).toEqual(lit(null))
    expect(run("NaN")).toEqual(lit(Number.NaN))
    expect(run("Infinity")).toEqual(lit(Number.POSITIVE_INFINITY))
  })

  it("reads numbers: integers, decimals, exponents, hex, negative and a leading dot", () => {
    expect(run("711")).toEqual(lit(711))
    expect(run("9.2")).toEqual(lit(9.2))
    expect(run("-2.99e-2")).toEqual(lit(-0.0299))
    expect(run("1E3")).toEqual(lit(1000))
    expect(run("0x1F")).toEqual(lit(31))
    expect(run("-9")).toEqual(lit(-9))
    expect(run(".5")).toEqual(lit(0.5))
  })

  it("reads strings in single quotes with '' for a quote", () => {
    expect(run("'It''s open source!'")).toEqual(lit("It's open source!"))
    expect(run("''")).toEqual(lit(""))
  })
})

describe("syntax errors", () => {
  it("rejects a string with no closing quote", () => {
    expect(why("'abc")).toBe("a string has no closing quote")
  })

  it("rejects a character that is not part of an expression", () => {
    expect(why("a # b")).toBe("\"#\" is not part of an expression")
  })

  it("rejects a missing )", () => {
    expect(why("(true")).toBe("\")\" is missing")
    expect(why("format('a', 1")).toBe("\")\" is missing")
  })

  it("rejects a missing ]", () => {
    expect(why("matrix['os'")).toBe("\"]\" is missing")
  })

  it("rejects an expression that ends early", () => {
    expect(why("1 ==")).toBe("the expression ends early")
    expect(why("")).toBe("the expression ends early")
  })

  it("rejects a symbol where a value is expected", () => {
    expect(why("== 1")).toBe("\"==\" is not expected here")
  })

  it("rejects trailing tokens", () => {
    expect(why("1 2")).toBe("\"2\" is not expected here")
  })

  it("rejects a dot with no property name", () => {
    expect(why("github.")).toBe("a property name is missing after a dot")
    expect(why("github.(")).toBe("a property name is missing after a dot")
  })
})

// Operators: ( ) grouping, [ ] index, . dereference, ! not, < <= > >= == != && ||, in that order.
describe("operators and their order", () => {
  it("groups with parentheses", () => {
    expect(run("(1 == 2) == false")).toEqual(lit(true))
  })

  it("binds && tighter than ||", () => {
    expect(run("true || false && false")).toEqual(lit(true))
    expect(run("(true || false) && false")).toEqual(lit(false))
  })

  it("binds comparison tighter than equality", () => {
    expect(run("1 < 2 == true")).toEqual(lit(true))
  })

  it("negates with !", () => {
    expect(run("!true")).toEqual(lit(false))
    expect(run("!!''")).toEqual(lit(false))
    expect(run("!0")).toEqual(lit(true))
  })
})

// "GitHub performs loose equality comparisons."
describe("loose equality", () => {
  it("converts null to 0, true to 1, false to 0", () => {
    expect(run("null == 0")).toEqual(lit(true))
    expect(run("true == 1")).toEqual(lit(true))
    expect(run("false == 0")).toEqual(lit(true))
  })

  it("converts a string to a number, with the empty string 0", () => {
    expect(run("'12' == 12")).toEqual(lit(true))
    expect(run("'' == 0")).toEqual(lit(true))
    expect(run("'abc' == 0")).toEqual(lit(false))
  })

  it("converts an array or object to NaN", () => {
    expect(run("matrix.list == 0")).toEqual(lit(false))
    expect(run("matrix == 0")).toEqual(lit(false))
  })

  // "GitHub ignores case when comparing strings."
  it("ignores case when comparing strings", () => {
    expect(run("'ABC' == 'abc'")).toEqual(lit(true))
    expect(run("'ABC' != 'abd'")).toEqual(lit(true))
  })

  // "A comparison of one NaN to another NaN does not result in true."
  it("is false for NaN", () => {
    expect(run("NaN == NaN")).toEqual(lit(false))
    expect(run("NaN != NaN")).toEqual(lit(true))
    expect(run("NaN < 1")).toEqual(lit(false))
  })

  // "Objects and arrays are only considered equal when they are the same instance."
  it("treats objects and arrays as equal only when they are the same instance", () => {
    expect(run("matrix.shared == matrix.other")).toEqual(lit(true))
    expect(run("fromJSON('[1]') == fromJSON('[1]')")).toEqual(lit(false))
  })
})

describe("ordering", () => {
  it("compares numbers", () => {
    expect(run("1 < 2")).toEqual(lit(true))
    expect(run("2 <= 2")).toEqual(lit(true))
    expect(run("1 > 2")).toEqual(lit(false))
    expect(run("2 >= 3")).toEqual(lit(false))
  })

  // "GitHub ignores case when comparing strings."
  it("compares strings without case", () => {
    expect(run("'a' < 'B'")).toEqual(lit(true))
    expect(run("'B' >= 'b'")).toEqual(lit(true))
  })

  // Values of different types are converted to numbers.
  it("compares mixed types as numbers", () => {
    expect(run("'10' > 9")).toEqual(lit(true))
    expect(run("null < true")).toEqual(lit(true))
    expect(run("matrix.list < 1")).toEqual(lit(false))
  })
})

// "Falsy: false, 0, -0, "", '', null"; && and || return an operand.
describe("logical operators", () => {
  it("returns an operand", () => {
    expect(run("'a' && 'b'")).toEqual(lit("b"))
    expect(run("'' || 'b'")).toEqual(lit("b"))
    expect(run("'a' || 'b'")).toEqual(lit("a"))
    expect(run("0 && 'b'")).toEqual(lit(0))
  })

  it("never reads the right side once the left side decides", () => {
    expect(run("false && runner.os")).toEqual(lit(false))
    expect(run("true || runner.os")).toEqual(lit(true))
    expect(run("true && runner.os")).toEqual({ kind: "problem", why: "runner is known only on the runner" })
  })

  it("keeps a run-time left side as a binary node", () => {
    expect(run("out && 'x'")).toEqual(
      ok({ kind: "binary", operator: "&&", left: outResidual, right: { kind: "literal", value: "x" } })
    )
  })
})

describe("residuals", () => {
  it("keeps a comparison with a run-time value as a binary node", () => {
    expect(run("out == 'x'")).toEqual(
      ok({ kind: "binary", operator: "==", left: outResidual, right: { kind: "literal", value: "x" } })
    )
  })

  it("keeps a negated run-time value as a not node", () => {
    expect(run("!out")).toEqual(ok({ kind: "not", operand: outResidual }))
  })

  it("keeps a call with a run-time value as a call node", () => {
    expect(run("format('{0}', out)")).toEqual(
      ok({ kind: "call", name: "format", args: [{ kind: "literal", value: "{0}" }, outResidual] })
    )
  })

  it("cannot read a property of a run-time value", () => {
    expect(why("out.x")).toBe("a property of a value decided while the job runs")
    expect(why("format('{0}', out).x")).toBe("a property of a value decided while the job runs")
  })

  it("cannot index with a run-time value", () => {
    expect(why("matrix[out]")).toBe("a property name is decided while the job runs")
  })

  it("returns a run-time value read through fields", () => {
    expect(run("steps.build.outputs.id")).toEqual(ok(outResidual))
  })
})

// Property dereference: names read without case; a missing property is null.
describe("finishing an expression once its variables are known", () => {
  const scope: Scope = { context: (name) => variable(name, name) }
  const residualOf = (text: string): Residual => {
    const evaluated = evaluate(text, scope)
    if (evaluated.kind !== "ok") throw new Error(text)
    return evaluated.residual
  }
  const finished = (text: string, known: Readonly<Record<string, Value>>) =>
    finish(residualOf(text), (found) => known[found.id] as Value)

  it("lists every variable it reads", () => {
    expect(variablesOf(residualOf("!a && (b < 2) || format('{0}', c)")).map((found) => found.id)).toEqual([
      "a",
      "b",
      "c"
    ])
    expect(variablesOf(residualOf("1"))).toEqual([])
  })

  it.each<[string, Readonly<Record<string, Value>>, Value]>([
    ["a", { a: 1 }, 1],
    ["!a", { a: 0 }, true],
    ["a < 2", { a: 1 }, true],
    ["a == 'X'", { a: "x" }, true],
    ["format('{0}-{1}', a, 2)", { a: "v" }, "v-2"],
    ["a && 'yes'", { a: 1 }, "yes"],
    ["a && 'yes'", { a: 0 }, 0],
    ["a || 'no'", { a: 0 }, "no"],
    ["a || 'no'", { a: 1 }, 1]
  ])("%s with %j", (text, known, expected) => {
    expect(finished(text, known)).toEqual({ kind: "ok", value: expected })
  })

  it("says why when a function cannot take the value", () => {
    expect(finished("fromJSON(a)", { a: "{" })).toEqual({
      kind: "problem",
      why: "fromJSON was given text that is not JSON"
    })
  })
})

describe("contexts and properties", () => {
  it("asks a fields context in lower case", () => {
    expect(run("GitHub.Event_Name")).toEqual(lit("push"))
    expect(run("github['REF']")).toEqual(lit("refs/heads/main"))
  })

  it("asks an exact fields context as written", () => {
    expect(run("env.Path")).toEqual(lit("/bin"))
    expect(run("env.PATH")).toEqual(lit(null))
  })

  it("reads a property of a value without case, and null when missing", () => {
    expect(run("matrix.os")).toEqual(lit("linux"))
    expect(run("matrix.missing")).toEqual(lit(null))
    expect(run("num.x")).toEqual(lit(null))
    expect(run("'abc'.length")).toEqual(lit(null))
    expect(run("fromJSON('{\"A\":1}').a")).toEqual(lit(1))
    expect(run("computed.A")).toEqual(lit(1))
  })

  it("indexes a list by number", () => {
    expect(run("matrix.list[1]")).toEqual(lit(20))
    expect(run("matrix.list[9]")).toEqual(lit(null))
    expect(run("matrix.list['a']")).toEqual(lit(null))
  })

  it("is a problem for a fields context read as one value", () => {
    expect(why("github")).toBe("this context is not one value")
  })

  it("is a problem for an unknown context, directly and through a member", () => {
    expect(why("runner")).toBe("runner is known only on the runner")
    expect(why("runner.os.name")).toBe("runner is known only on the runner")
  })

  it("is a secret for a secret context, directly and through a member", () => {
    expect(run("secrets")).toEqual({ kind: "secret", name: "TOKEN" })
    expect(run("secrets.token")).toEqual({ kind: "secret", name: "TOKEN" })
  })

  it("is a problem for a name that is no context", () => {
    expect(why("Nothing.x")).toBe("Nothing is not a context an expression can read")
  })
})

// Object filters: `.*` reads a property of each element.
describe("object filter", () => {
  it("lists the entries of a list", () => {
    expect(run("matrix.list.*")).toEqual(lit([10, 20, 30]))
  })

  it("lists the values of a mapping and filters by property", () => {
    expect(run("matrix.nested.*.b")).toEqual(lit([1, 2]))
    expect(run("github.event.commits.*.id")).toEqual(lit(["a", "b"]))
  })

  it("is empty on a scalar", () => {
    expect(run("num.*")).toEqual(lit([]))
  })

  it("filters twice", () => {
    expect(run("matrix.nested.*.*")).toEqual(lit([{ b: 1 }, { b: 2 }]))
  })

  it("is a problem on a run-time value, a fields context or an unknown context", () => {
    expect(why("out.*")).toBe("the value before .* is decided while the job runs")
    expect(why("github.*")).toBe("the value before .* is not one value")
    expect(why("runner.*")).toBe("runner is known only on the runner")
  })
})

describe("functions", () => {
  it("contains: a string without case, an array element by loose equality", () => {
    expect(run("contains('Hello world', 'LLO')")).toEqual(lit(true))
    expect(run("contains(fromJSON('[\"push\", 1]'), 'PUSH')")).toEqual(lit(true))
    expect(run("contains(fromJSON('[2]'), '1')")).toEqual(lit(false))
    expect(run("contains('abc', matrix)")).toEqual(lit(false))
  })

  it("startsWith and endsWith ignore case", () => {
    expect(run("startsWith('Hello world', 'he')")).toEqual(lit(true))
    expect(run("endsWith('Hello world', 'LD')")).toEqual(lit(true))
    expect(run("startsWith(matrix, 'a')")).toEqual(lit(false))
    expect(run("endsWith(matrix, 'a')")).toEqual(lit(false))
  })

  // "Use {{ and }} to escape curly braces."
  it("format replaces {N} and writes {{ and }} as braces", () => {
    expect(run("format('Hello {0} {1} {2}', 'Mona', 'the', 'Octocat')")).toEqual(lit("Hello Mona the Octocat"))
    expect(run("format('{{Hello {0}}}', 'Mona')")).toEqual(lit("{Hello Mona}"))
    expect(why("format('{1}', 'a')")).toBe("format has no value for {1}")
    expect(why("format('{a}')")).toBe("format was given a template with a brace that names no value")
  })

  it("join uses , by default", () => {
    expect(run("join(matrix.list)")).toEqual(lit("10,20,30"))
    expect(run("join(matrix.list, ' | ')")).toEqual(lit("10 | 20 | 30"))
    expect(run("join('abc', ',')")).toEqual(lit("abc"))
  })

  it("toJSON pretty-prints and fromJSON parses", () => {
    expect(run("toJSON(matrix.list)")).toEqual(lit("[\n  10,\n  20,\n  30\n]"))
    expect(run("fromJSON('{\"a\": [true]}')")).toEqual(lit({ a: [true] }))
    expect(why("fromJSON('{')")).toBe("fromJSON was given text that is not JSON")
  })

  it("is a problem for too few or too many values", () => {
    expect(why("contains('a')")).toBe("contains was given 1 values")
    expect(why("join('a', 'b', 'c')")).toBe("join was given 3 values")
    expect(why("format()")).toBe("format was given 0 values")
  })

  it("is a problem for an unknown function", () => {
    expect(why("nope(1)")).toBe("nope is not a function an expression can call")
  })

  it("names functions without case", () => {
    expect(run("CONTAINS('ab', 'B')")).toEqual(lit(true))
  })
})

// Status check functions: success(), always(), cancelled(), failure().
describe("status functions", () => {
  it("reads the status of the scope", () => {
    expect(run("success()", withStatus)).toEqual(lit(true))
    expect(run("always()", withStatus)).toEqual(lit(true))
    expect(run("cancelled()", withStatus)).toEqual(lit(false))
    expect(run("Failure()", withStatus)).toEqual(lit(false))
  })

  it("is a problem where the scope has no status", () => {
    expect(why("success()")).toBe("success() has no meaning here")
  })
})

describe("hashFiles", () => {
  it("passes the patterns to the scope", () => {
    expect(run("hashFiles('**/a', 'b')", withStatus)).toEqual(lit("hash:**/a|b"))
  })

  it("is a problem without scope.hashFiles", () => {
    expect(why("hashFiles('a')")).toBe("hashFiles has no meaning here")
  })

  it("is a problem with a pattern decided while the job runs", () => {
    expect(why("hashFiles(out)", withStatus)).toBe("a hashFiles pattern is decided while the job runs")
  })
})

// Conversion to number for loose comparison.
describe("toNumber", () => {
  it("converts each type", () => {
    expect(toNumber(null)).toBe(0)
    expect(toNumber(7)).toBe(7)
    expect(toNumber(true)).toBe(1)
    expect(toNumber(false)).toBe(0)
    expect(toNumber([1])).toBeNaN()
    expect(toNumber({ a: 1 })).toBeNaN()
  })

  it("converts strings", () => {
    expect(toNumber("")).toBe(0)
    expect(toNumber(" 12 ")).toBe(12)
    expect(toNumber("0x10")).toBe(16)
    expect(toNumber("0o17")).toBe(15)
    expect(toNumber("1e3")).toBe(1000)
    expect(toNumber("abc")).toBeNaN()
  })
})

describe("toText", () => {
  it("writes each type", () => {
    expect(toText(null)).toBe("")
    expect(toText("s")).toBe("s")
    expect(toText(3)).toBe("3")
    expect(toText(0.1 + 0.2)).toBe("0.3")
    expect(toText(true)).toBe("true")
    expect(toText([1])).toBe("Array")
    expect(toText({ a: 1 })).toBe("Object")
  })
})

// "Falsy: false, 0, -0, "", '', null".
describe("truthy", () => {
  it("is false only for the falsy values", () => {
    for (const held of [false, 0, -0, "", null, Number.NaN]) expect(truthy(held)).toBe(false)
    for (const held of [true, 1, "0", "false", [], {}]) expect(truthy(held)).toBe(true)
  })
})

describe("formatPieces", () => {
  it("splits a template", () => {
    expect(formatPieces("a{0}b{{c}}")).toEqual(["a", 0, "b", "{", "c", "}", ""])
    expect(formatPieces("}")).toBeUndefined()
  })
})

describe("split", () => {
  it("does not end an expression at }} inside a quoted string", () => {
    expect(split("a ${{ format('}}', 1) }} b")).toEqual({
      pieces: [["a ", "format('}}', 1)", "${{ format('}}', 1) }}"]],
      rest: " b"
    })
  })

  it("keeps an unclosed ${{ as text", () => {
    expect(split("x ${{ 1 }} y ${{ 2")).toEqual({ pieces: [["x ", "1", "${{ 1 }}"]], rest: " y ${{ 2" })
  })
})

describe("fill", () => {
  it("joins text and known values", () => {
    expect(fill("on ${{ github.event_name }} at ${{ matrix.OS }}!", scope)).toEqual({
      kind: "ok",
      parts: ["on push at linux!"]
    })
    expect(fill("${{ '' }}", scope)).toEqual({ kind: "ok", parts: [] })
  })

  it("keeps a run-time expression as its own part with the text as written", () => {
    expect(fill("id=${{  steps.build.outputs.id}};", scope)).toEqual({
      kind: "ok",
      parts: ["id=", { residual: outResidual, written: "${{  steps.build.outputs.id}}" }, ";"]
    })
  })

  it("returns the problem prefixed with the expression", () => {
    expect(fill("a ${{ runner.os }}", scope)).toEqual({
      kind: "problem",
      why: "runner.os: runner is known only on the runner"
    })
  })

  it("returns a secret", () => {
    expect(fill("${{ secrets.token }}", scope)).toEqual({ kind: "secret", name: "TOKEN" })
  })
})

describe("whole", () => {
  it("is the expression of a text that is one expression", () => {
    expect(whole("${{ a == 1 }}")).toBe("a == 1")
  })

  // On GitHub `${{ x }}` with anything around it, a space or a line end too, is text holding x, not x.
  it("is undefined for text around an expression, even white space, or for two expressions", () => {
    expect(whole("x ${{ a }}")).toBeUndefined()
    expect(whole("${{ a }} x")).toBeUndefined()
    expect(whole("${{ a }}${{ b }}")).toBeUndefined()
    expect(whole("${{ a }} ")).toBeUndefined()
    expect(whole("${{ a }}\n")).toBeUndefined()
    expect(whole(" ${{ a }}", true)).toBeUndefined()
  })

  it("treats text with no expression as one only when bare", () => {
    expect(whole("a == 1")).toBeUndefined()
    expect(whole(" a == 1 ", true)).toBe(" a == 1 ")
  })
})

describe("what the review found", () => {
  const literal = (held: Value): Residual => ({ kind: "literal", value: held })

  // "GitHub ignores case when comparing strings": one character at a time, so é is É and ß is not SS.
  it("compares text without case one character at a time", () => {
    expect(evaluate("'é' == 'É'", { context: () => undefined })).toEqual({ kind: "ok", residual: literal(true) })
    expect(evaluate("'ß' == 'SS'", { context: () => undefined })).toEqual({ kind: "ok", residual: literal(false) })
    expect(evaluate("contains('Straße', 'SSE')", { context: () => undefined })).toEqual({
      kind: "ok",
      residual: literal(false)
    })
  })

  // The runner writes a number with 15 significant digits, and beyond them with an exponent.
  it("writes a number as the runner does", () => {
    expect(toText(123456789012345678)).toBe("1.23456789012346E+17")
    expect(toText(1e21)).toBe("1E+21")
    expect(toText(0.000001234)).toBe("1.234E-06")
    expect(toText(999999999999999)).toBe("999999999999999")
    expect(toText(1.5)).toBe("1.5")
    expect(toText(0.1 + 0.2)).toBe("0.3")
    expect(toText(Number.POSITIVE_INFINITY)).toBe("Infinity")
    expect(toText(Number.NaN)).toBe("NaN")
  })

  it("reports an expression nested too deep to read, and never throws", () => {
    const deep = `${"(".repeat(20_000)}1${")".repeat(20_000)}`
    expect(evaluate(deep, { context: () => undefined })).toEqual({ kind: "problem", why: "it nests too deep to read" })
  })
})
