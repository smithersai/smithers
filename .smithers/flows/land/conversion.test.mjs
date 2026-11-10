import { strict as assert } from "node:assert"
import { test } from "node:test"
import { sameMigration } from "./conversion.mjs"

const published = [
  'import { Effect } from "effect"',
  'import { SqlClient } from "effect/sql"',
  'import { hash } from "@smthrs/crypto"',
  "",
  "// Adds the column.",
  "export default Effect.gen(function* () {",
  "  const sql = yield* SqlClient.SqlClient",
  "  const digest = hash('a')",
  "  yield* sql`ALTER TABLE m ADD COLUMN a integer`",
  "  yield* sql`UPDATE m SET a = ${digest}`",
  "})",
  "",
].join("\n")
const body = [
  "export default effect {",
  "  const sql = try SqlClient.SqlClient",
  "  const digest = hash('a')",
  "  try sql`ALTER TABLE m ADD COLUMN a integer`",
  "  try sql`UPDATE m SET a = ${digest}`",
  "}",
  "",
].join("\n")
const converted = `import { hash } from "@smthrs/crypto"\n\n// A comment may change.\n${body}`

test("a faithful conversion is the same migration, with or without the prelude's imports", () => {
  assert.equal(sameMigration(published, converted), true)
  assert.equal(sameMigration(published, `import { SqlClient } from "effect/sql"\n${converted}`), true)
})

test("a semicolon can't split a tagged statement into a client read and a dead template", () => {
  assert.equal(sameMigration(published, converted.replace("try sql`UPDATE", "try sql;\n  `UPDATE")), false)
})

for (const [name, text] of [
  ["changes a statement", converted.replace("integer", "text")],
  ["drops a statement", converted.replace("  try sql`UPDATE m SET a = ${digest}`\n", "")],
  ["adds a statement", converted.replace("  const digest", "  try sql`DROP TABLE m`\n  const digest")],
  ["reorders statements", converted.replace("try sql`ALTER TABLE m ADD COLUMN a integer`", "try sql`UPDATE m SET a = ${digest}`").replace("try sql`UPDATE m SET a = ${digest}`\n}", "try sql`ALTER TABLE m ADD COLUMN a integer`\n}")],
  ["adds a side-effect import", `import "../../src/evil.ts"\n${converted}`],
  ["adds a named import", `import { other } from "./other.ts"\n${converted}`],
  ["drops a non-prelude import", body],
  ["changes a non-prelude import's source", converted.replace("@smthrs/crypto", "@smthrs/other")],
  ["rebinds a non-prelude import", converted.replace("{ hash }", "{ other as hash }")],
  ["rebinds a prelude name to another module", `import { Random as SqlClient } from "effect"\n${converted}`],
  ["imports a namespace over a prelude name", `import * as SqlClient from "effect/unstable/foo"\n${converted}`],
  ["escapes the prelude with a relative segment", `import { SqlClient } from "effect/../../../src/evil.ts"\n${converted}`],
]) {
  test(`a conversion that ${name} is refused`, () => assert.equal(sameMigration(published, text), false))
}

for (const [name, generator] of [
  ["an async generator, which Effect.gen can't drive", "async function* ()"],
  ["a named generator, whose name binds in its body", "function* SqlClient()"],
  ["a generator with a parameter", "function* (x)"],
]) {
  test(`${name} is not the effect block it resembles`, () => {
    const text = published.replace("function* ()", generator)
    assert.equal(sameMigration(text, converted), false)
    assert.equal(sameMigration(published, text), false)
  })
}

test("a try added to a call runs what the published migration only built, and is refused", () => {
  assert.equal(sameMigration(published, converted.replace("const digest = hash('a')", "const digest = try hash('a')")), false)
})

test("yield* of a call and try of the same call are the same statement", () => {
  const before = published.replace("const digest = hash('a')", "const digest = yield* hash('a')")
  const after = converted.replace("const digest = hash('a')", "const digest = try hash('a')")
  assert.equal(sameMigration(before, after), true)
  const chained = published.replace("const digest = hash('a')", "const digest = yield* hash('a').pipe(wrap)")
  assert.equal(sameMigration(chained, converted.replace("const digest = hash('a')", "const digest = try hash('a').pipe(wrap)")), true)
  assert.equal(sameMigration(chained, converted.replace("const digest = hash('a')", "const digest = hash('a').pipe(wrap)")), false)
})

test("try as a property or a key is no try operand", () => {
  const text = "export default { a: Effect.try(() => f()), b: x.try(1), try: g }\n"
  assert.equal(sameMigration(text, text), true)
})

test("a parenthesized try operand the tree can't place is refused", () => {
  assert.equal(sameMigration(published, converted.replace("const digest = hash('a')", "const digest = try (hash('a'))")), false)
})

test("reordering imports is an edit, because imports run in order", () => {
  const ordered = 'import "./a.ts"\nimport "./b.ts"\nexport default 1\n'
  assert.equal(sameMigration(ordered, 'import "./b.ts"\nimport "./a.ts"\nexport default 1\n'), false)
})

test("two migrations that swap two import bindings are different", () => {
  const swapped = 'import a from "./a.ts"\nimport b from "./b.ts"\nexport default a(b)\n'
  assert.equal(sameMigration(swapped, 'import b from "./a.ts"\nimport a from "./b.ts"\nexport default a(b)\n'), false)
  assert.equal(sameMigration(swapped, swapped), true)
})

test("a side-effect import a migration already has is kept, not dropped", () => {
  const withEffect = 'import "./setup.ts"\nexport default 1\n'
  assert.equal(sameMigration(withEffect, withEffect), true)
  assert.equal(sameMigration(withEffect, "export default 1\n"), false)
})

test("a .vibe syntax error refuses rather than passes", () => {
  assert.throws(() => sameMigration(published, "export default effect {"))
})
