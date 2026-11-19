/**
 * The one writer of generated YAML: each kind of string comes out in the form
 * every common YAML linter and formatter accepts as written, and reads back
 * as the same string under YAML 1.2 and 1.1.
 */

import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import * as Yaml from "../src/generate/Yaml.ts"

const one = (value: Yaml.Value, key = "key"): string => Yaml.document(Yaml.mapping([Yaml.entry(key, value)]))

// The text of `value` under `key:`, without the document marker and the final newline.
const written = (value: Yaml.Value): string => one(value).slice("---\n".length, -1)

const readBack = (text: string): unknown => ({
  "1.2": parse(text, { version: "1.2" }),
  "1.1": parse(text, { version: "1.1" })
})

const control = String.fromCharCode(7)
const tab = String.fromCharCode(9)
const nonBreakingSpace = String.fromCharCode(0xa0)
const enSpace = String.fromCharCode(0x2002)
const ideographicSpace = String.fromCharCode(0x3000)
const hyphen = String.fromCharCode(0x2010)

describe("a string", () => {
  it.each([
    ["plain text", "ubuntu-latest", "key: ubuntu-latest"],
    ["a version that is no number", "11.20.0", "key: 11.20.0"],
    ["a path with a star", "lts/*", "key: lts/*"],
    ["a GitHub expression", "${{ matrix.os }}", "key: ${{ matrix.os }}"],
    ["an expression with a quoted string", "${{ vars.URL == '' }}", "key: ${{ vars.URL == '' }}"],
    ["a single quote inside", "it's", "key: it's"],
    ["a colon with no space after it", "a:b", "key: a:b"],
    ["a hash with no space before it", "a#b", "key: a#b"],
    ["a dash before a word", "-x", "key: -x"],
    ["a looks-like-a-number", "3.10", "key: >-\n  3.10"],
    ["a whole number", "24", "key: >-\n  24"],
    ["a YAML 1.2 boolean", "true", "key: >-\n  true"],
    ["a YAML 1.1 boolean", "yes", "key: >-\n  yes"],
    ["on", "on", "key: >-\n  on"],
    ["null", "null", "key: >-\n  null"],
    ["a tilde", "~", "key: >-\n  ~"],
    ["a leading comparison", ">=20.19.0", "key: >-\n  >=20.19.0"],
    ["a leading star", "*", "key: >-\n  *"],
    ["a leading ampersand", "&a", "key: >-\n  &a"],
    ["a leading exclamation mark", "!x", "key: >-\n  !x"],
    ["a leading at sign", "@scope/name", "key: >-\n  @scope/name"],
    ["a leading percent sign", "%x", "key: >-\n  %x"],
    ["a leading bracket", "[a]", "key: >-\n  [a]"],
    ["a leading dash and space", "- x", "key: >-\n  - x"],
    ["a lone dash", "-", "key: >-\n  -"],
    ["a colon and space inside", "a: b", "key: >-\n  a: b"],
    ["a space and hash inside", "a #b", "key: >-\n  a #b"],
    ["a trailing colon", "a:", "key: >-\n  a:"],
    ["a leading double quote", "\"x\" y", "key: >-\n  \"x\" y"],
    ["a document marker", "---", "key: >-\n  ---"],
    ["the empty string", "", "key: ''"],
    ["a leading space", " x", "key: ' x'"],
    ["a trailing space with a single quote", "it's ", "key: \"it's \""],
    ["a tab", `a${tab}b`, "key: \"a\\tb\""],
    ["a control character", `a${control}`, "key: \"a\\u0007\""],
    ["a non-breaking space", `a${nonBreakingSpace}b`, "key: \"a\\u00a0b\""],
    ["an en space", `a${enSpace}b`, "key: \"a\\u2002b\""],
    ["an ideographic space", `a${ideographicSpace}b`, "key: \"a\\u3000b\""],
    ["a hyphen, which is no space", `a${hyphen}b`, `key: a${hyphen}b`],
    ["a backslash and a double quote that need quotes", " \\\"", "key: ' \\\"'"],
    ["two lines", "a\nb\n", "key: |\n  a\n  b"],
    ["two lines and no final line feed", "a\nb", "key: |-\n  a\n  b"],
    ["an empty line inside and two at the end", "a\n\nb\n\n", "key: |+\n  a\n\n  b\n"],
    ["a first empty line", "\na\n", "key: |\n\n  a"],
    ["lines with a hash and a quote", "# x\n  'y'\n", "key: |\n  # x\n    'y'"],
    ["a line feed alone", "\n", "key: \"\\n\""],
    ["a first line with a space", " a\nb\n", "key: \" a\\nb\\n\""],
    ["a line with a trailing space", "a \nb\n", "key: \"a \\nb\\n\""],
    ["lines with a tab", `a${tab}\nb\n`, "key: \"a\\t\\nb\\n\""],
    ["lines with a single quote and a trailing space", "it's \nb", "key: \"it's \\nb\""]
  ])("%s", (_, value, text) => {
    expect(written(value)).toBe(text)
    expect(readBack(one(value))).toEqual({ "1.2": { key: value }, "1.1": { key: value } })
  })

  it("is folded at spaces to the width, and an expression stays on one line where it fits", () => {
    const command =
      "npx --yes --package=@smthrs/cli@1.0.0 smthrs ci $(sed -n 's/^${{ matrix.leg }} //p' legs.txt) --cache-dir \"${{ runner.temp }}/x\""
    const text = one(Yaml.mapping([Yaml.entry("run", command)]))
    expect(text).toBe(
      [
        "---",
        "key:",
        "  run: >-",
        "    npx --yes --package=@smthrs/cli@1.0.0 smthrs ci $(sed -n",
        "    's/^${{ matrix.leg }} //p' legs.txt) --cache-dir \"${{ runner.temp }}/x\"",
        ""
      ].join("\n")
    )
    expect(parse(text)).toEqual({ key: { run: command } })
  })

  it("folds inside an expression too long for a line, and keeps a run of spaces whole", () => {
    const expression = `\${{ ${"a".repeat(40)} == 'pull_request' && ${"b".repeat(40)} }}  two  spaces`
    const text = one(expression)
    expect(text.split("\n").every((line) => line.length <= Yaml.width)).toBe(true)
    expect(text).toBe(
      `---\nkey: >-\n  \${{ ${"a".repeat(40)} == 'pull_request' &&\n  ${"b".repeat(40)} }}  two  spaces\n`
    )
    expect(parse(text)).toEqual({ key: expression })
  })

  it("overflows the width with a word longer than a line", () => {
    const word = "x".repeat(100)
    expect(one(word)).toBe(`---\nkey: >-\n  ${word}\n`)
    expect(parse(one(word))).toEqual({ key: word })
  })

  it("is plain up to the width exactly", () => {
    const fits = "x".repeat(Yaml.width - "key: ".length)
    expect(one(fits)).toBe(`---\nkey: ${fits}\n`)
    expect(one(`${fits}x`)).toBe(`---\nkey: >-\n  ${fits}x\n`)
  })
})

describe("a value", () => {
  it("writes numbers and booleans as they are", () => {
    expect(written(24)).toBe("key: 24")
    expect(written(false)).toBe("key: false")
  })

  it("writes an empty mapping and an empty sequence in flow style", () => {
    expect(written(Yaml.mapping([]))).toBe("key: {}")
    expect(written(Yaml.list([]))).toBe("key: []")
  })

  it("writes a list of plain values", () => {
    expect(written(Yaml.list(["push", 1, true]))).toBe("key:\n  - push\n  - 1\n  - true")
  })

  it("indents a sequence under its key, and a collection in a sequence starts on its dash's line", () => {
    const value = Yaml.sequence([
      Yaml.item("a", ["the first"]),
      Yaml.item(Yaml.mapping([Yaml.entry("os", "linux", ["its machine"]), Yaml.entry("leg", 1)]), ["the second"]),
      Yaml.item(Yaml.sequence([Yaml.item("self-hosted", ["labels"]), Yaml.item("gpu")])),
      Yaml.item(Yaml.list([])),
      Yaml.item(Yaml.mapping([Yaml.entry("run", "a\nb\n")]))
    ])
    const text = one(value)
    expect(text).toBe(
      [
        "---",
        "key:",
        "  # the first",
        "  - a",
        "  # the second",
        "  # its machine",
        "  - os: linux",
        "    leg: 1",
        "  # labels",
        "  - - self-hosted",
        "    - gpu",
        "  - []",
        "  - run: |",
        "      a",
        "      b",
        ""
      ].join("\n")
    )
    expect(parse(text)).toEqual({ key: ["a", { os: "linux", leg: 1 }, ["self-hosted", "gpu"], [], { run: "a\nb\n" }] })
  })
})

describe("a document", () => {
  it("writes the header, the document marker, comments wrapped to the width and a final newline", () => {
    const long = "word ".repeat(30)
    const text = Yaml.document(
      Yaml.mapping([
        Yaml.entry("name", "x", ["prettier-ignore"]),
        Yaml.entry("jobs", Yaml.mapping([Yaml.entry("a", "b", [long, " "])]))
      ]),
      ["Generated. Do not edit."]
    )
    expect(text).toBe(
      [
        "# Generated. Do not edit.",
        "---",
        "# prettier-ignore",
        "name: x",
        "jobs:",
        `  # ${"word ".repeat(15).trim()}`,
        `  # ${"word ".repeat(15).trim()}`,
        "  #",
        "  a: b",
        ""
      ].join("\n")
    )
    expect(text.split("\n").every((line) => line.length <= Yaml.width && line.trimEnd() === line)).toBe(true)
  })
})
