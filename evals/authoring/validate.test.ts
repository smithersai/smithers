import { strict as assert } from "node:assert"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { validateDataset } from "./validate.ts"

const row = (value: unknown): string => JSON.stringify(value)

const good = {
  messages: [
    { role: "system", content: "cheatsheet" },
    { role: "user", content: "Build a flow." },
    { role: "assistant", content: "export default Flow.make(\"demo\", {})" }
  ]
}

const withAssistant = (content: string) => ({
  messages: [good.messages[0], good.messages[1], { role: "assistant", content }]
})

const rejects = (text: string, fragment: string) => {
  const problems = validateDataset(text)
  assert.ok(
    problems.some((problem) => problem.includes(fragment)),
    `expected a problem containing ${JSON.stringify(fragment)}, got ${JSON.stringify(problems)}`
  )
}

describe("validateDataset", () => {
  test("accepts a well-formed row", () => {
    assert.deepEqual(validateDataset(row(good)), [])
  })

  test("accepts the committed dataset", () => {
    const path = fileURLToPath(new URL("./data/pilot-sft.jsonl", import.meta.url))
    assert.deepEqual(validateDataset(readFileSync(path, "utf8")), [])
  })

  test("accepts current public workspace imports in assistant code", () => {
    assert.deepEqual(validateDataset(row(withAssistant([
      'import * as AgentAction from "@smthrs/agent/AgentAction"',
      'import * as AgentEvent from "@smthrs/harness/AgentEvent"',
      'import * as Command from "@smthrs/fs/Command"',
      'export { Flow } from "@smthrs/flow"'
    ].join("\n")))), [])
  })

  test("rejects removed workspace packages and unpublished subpaths", () => {
    rejects(
      row(withAssistant('import * as AgentAction from "@smthrs/engine-harness/AgentAction"')),
      'missing workspace package'
    )
    rejects(
      row(withAssistant('import * as CellHarness from "@smthrs/harness/CellHarness"')),
      'unpublished path'
    )
    rejects(
      row(withAssistant('import {\n  AgentAction\n} from "@smthrs/engine-harness"')),
      'missing workspace package'
    )
    rejects(row(withAssistant('import "@smthrs/engine-harness"')), 'missing workspace package')
    rejects(row(withAssistant('import\n  * as Old from "@smthrs/engine-harness"')), 'missing workspace package')
    rejects(row(withAssistant('import Old = require("@smthrs/engine-harness")')), 'missing workspace package')
    rejects(row(withAssistant('const Old = await import("@smthrs/engine-harness")')), 'missing workspace package')
    rejects(row(withAssistant('import * as Private from "@smthrs/fs/internal/Secret"')), 'unpublished path')
  })

  test("rejects nonexistent modules behind public wildcard exports", () => {
    rejects(
      row(withAssistant('import * as Missing from "@smthrs/fs/DefinitelyMissingModule"')),
      'unpublished path'
    )
  })

  test("rejects workspace roots without an entry point", () => {
    rejects(row(withAssistant('import * as Missing from "@smthrs/eval-authoring"')), 'unpublished path')
  })

  test("checks import types and typeof import types against workspace exports", () => {
    for (const expression of [
      'import("@smthrs/engine-harness").Old',
      'typeof import("@smthrs/engine-harness")',
      'import("@smthrs/agent/internal/Secret").Old',
      'typeof import("@smthrs/agent/internal/Secret")',
      'import("@smthrs/fs/DefinitelyMissingModule").Old',
      'typeof import("@smthrs/fs/DefinitelyMissingModule")'
    ]) {
      rejects(row(withAssistant(`type Old = ${expression}`)),
        expression.includes("engine-harness") ? 'missing workspace package' : 'unpublished path')
    }
    assert.deepEqual(validateDataset(row(withAssistant([
      'type Command = import("@smthrs/fs/Command").Command',
      'type Flow = typeof import("@smthrs/flow")'
    ].join("\n")))), [])
  })

  test("resolves real workspace entry points, export conditions, and pattern precedence", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "authoring-imports-"))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const write = (path: string, text: string) => {
      const file = join(root, path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
    }
    write("package.json", JSON.stringify({ type: "module", workspaces: ["packages/*"] }))
    mkdirSync(join(root, "evals/authoring"), { recursive: true })
    copyFileSync(fileURLToPath(new URL("./validate.ts", import.meta.url)), join(root, "evals/authoring/validate.ts"))
    mkdirSync(join(root, "node_modules"), { recursive: true })
    symlinkSync(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), join(root, "node_modules/typescript"))
    const pkg = (name: string, fields: Record<string, unknown>, files: ReadonlyArray<string>) => {
      write(`packages/${name}/package.json`, JSON.stringify({ name: `@smthrs/${name}`, ...fields }))
      for (const file of files) write(`packages/${name}/${file}`, "export {}")
    }
    pkg("mapped", {
      exports: {
        ".": { browser: "./missing.ts", node: { import: "./src/present.ts", require: "./src/require.cjs" } },
        "./conditional": { import: "./missing.ts", require: "./src/require.cjs", default: "./src/present.ts" },
        "./typed": { types: "./src/present.ts", default: "./missing.ts" },
        "./inactive": { browser: "./src/present.ts" },
        "./nested-fallback": { node: { browser: "./missing.ts" }, default: "./src/present.ts" },
        "./invalid": 42,
        "./invalid-active": { node: 42, default: "./src/present.ts" },
        "./empty-active": { node: [], default: "./src/present.ts" },
        "./inactive-array": { node: [{ browser: "./missing.ts" }], default: "./src/present.ts" },
        "./invalid-fallback": ["../invalid.ts", "./src/present.ts"],
        "./null-fallback": [null, "./src/present.ts"],
        "./empty-array": [],
        "./invalid-target": "../outside.ts",
        "./escape": "./../outside.ts",
        "./blocked": null,
        "./active-block": { import: null, default: "./src/present.ts" },
        "./array": ["./missing.ts", "./src/present.ts"],
        "./fallback": [{ browser: "./missing.ts" }, "./src/present.ts"],
        "./*": "./src/*.ts",
        "./f*": null,
        "./feature/*": "./src/present.ts",
        "./suffix/*.js": "./src/*.ts",
        "./private/*": null
      }
    }, ["src/present.ts", "src/$&.ts", "src/require.cjs", "src/blocked.ts", "src/private/Secret.ts", "src/folder/index.ts"])
    pkg("conditional", { exports: { browser: "./missing.ts", default: "./index.ts" } }, ["index.ts"])
    pkg("string", { exports: "./index.ts" }, ["index.ts"])
    pkg("legacy-main", { main: "./entry.js" }, ["entry.js"])
    pkg("legacy-index", {}, ["index.js"])
    pkg("legacy-missing", { main: "./missing.js" }, [])
    pkg("legacy-fallback", { main: "./missing.js" }, ["index.js"])
    const { validateDataset: validate } = await import(pathToFileURL(join(root, "evals/authoring/validate.ts")).href)
    const accepts = [
      'import "@smthrs/mapped/$&"',
      'import "@smthrs/mapped/invalid-fallback"',
      'import "@smthrs/mapped/null-fallback"',
      'import "@smthrs/mapped/inactive-array"',
      'import "@smthrs/mapped"',
      'import Value = require("@smthrs/mapped")',
      'const value = require("@smthrs/mapped/conditional")',
      'type Value = import("@smthrs/mapped/typed").Value',
      'import type { Value } from "@smthrs/mapped/typed"',
      'import { type Value } from "@smthrs/mapped/typed"',
      'import type Value = require("@smthrs/mapped/typed")',
      'export { type Value } from "@smthrs/mapped/typed"',
      'export type { Value } from "@smthrs/mapped/typed"',
      'import "@smthrs/mapped/present"',
      'import "@smthrs/mapped/feature/Example"',
      'import "@smthrs/mapped/suffix/present.js"',
      'import "@smthrs/mapped/fallback"',
      'import "@smthrs/mapped/nested-fallback"',
      'import "@smthrs/conditional"',
      'import "@smthrs/string"',
      'import "@smthrs/legacy-main"',
      'import "@smthrs/legacy-main/entry.js"',
      'import "@smthrs/legacy-index"',
      'import "@smthrs/legacy-fallback"'
    ]
    for (const code of accepts) assert.deepEqual(validate(row(withAssistant(code))), [], code)
    for (const code of [
      'import Value, { type T } from "@smthrs/mapped/typed"; void Value',
      'import "@smthrs/mapped/conditional"',
      'import "@smthrs/mapped/typed"',
      'import "@smthrs/mapped/inactive"',
      'import "@smthrs/mapped/invalid"',
      'import "@smthrs/mapped/invalid-active"',
      'import "@smthrs/mapped/empty-active"',
      'import "@smthrs/mapped/empty-array"',
      'import "@smthrs/mapped/invalid-target"',
      'import "@smthrs/mapped/escape"',
      'import "@smthrs/mapped/blocked"',
      'import "@smthrs/mapped/active-block"',
      'import "@smthrs/mapped/array"',
      'import "@smthrs/mapped/private/Secret"',
      'import "@smthrs/mapped/folder"',
      'import "@smthrs/mapped/missing"',
      'import "@smthrs/mapped/suffix/missing.js"',
      'import "@smthrs/legacy-missing"'
    ]) {
      assert.ok(validate(row(withAssistant(code))).some((problem: string) => problem.includes("unpublished path")), code)
    }
  })

  test("checks assistant code but does not treat quoted prompts or comments as imports", () => {
    const example = 'import * as Old from "@smthrs/engine-harness/AgentAction"'
    assert.deepEqual(validateDataset(row({
      messages: [
        good.messages[0],
        { role: "user", content: `Replace ${example}` },
        { role: "assistant", content: [
          `// ${example}`,
          `/*\n${example}\n*/`,
          `const prompt = \`\n${example}\n\``,
          'export default Flow.make("demo", {})'
        ].join("\n") }
      ]
    })), [])
  })

  test("rejects a non-object row instead of crashing", () => {
    rejects("null", "row 1: not a JSON object")
    rejects("[1]", "row 1: not a JSON object")
    rejects("\"text\"", "row 1: not a JSON object")
  })

  test("rejects a non-object message instead of crashing", () => {
    rejects(row({ messages: [null, { role: "assistant", content: "x" }] }), "message 1: not a JSON object")
    rejects(row({ messages: [{ role: "user", content: "hi" }, null] }), "last message is not an \"assistant\" turn")
  })

  test("rejects a row with no user turn before the final assistant turn", () => {
    rejects(
      row({ messages: [{ role: "system", content: "s" }, { role: "assistant", content: "a" }] }),
      "no \"user\" turn before the final assistant turn"
    )
  })

  test("rejects top-level metadata that firectl would upload", () => {
    rejects(
      row({ ...good, source_path: "port.ts", role: "backtranslation" }),
      "row 1: 2 unexpected top-level key(s); only \"messages\" is allowed"
    )
  })

  test("rejects extra message keys", () => {
    rejects(
      row({ messages: [good.messages[1], { role: "assistant", content: "a", name: "x" }] }),
      "message 2: 1 unexpected key(s); only \"role\" and \"content\" are allowed"
    )
  })

  test("rejects absolute host paths in content", () => {
    // Split so the repository's machine-path gate does not read these as real homes.
    rejects(row(withAssistant(`Port of /${"Users"}/alice/smithers/examples/gate.jsx`)), "absolute host path")
    rejects(row(withAssistant(`see /${"home"}/bob/work`)), "absolute host path")
    rejects(row(withAssistant("see ~/Desktop/work")), "absolute host path")
    rejects(row(withAssistant("~/Desktop/fireworks-smithers-finetune/work")), "absolute host path")
    rejects(row(withAssistant(`cd "~${"bob"}/src"`)), "absolute host path")
    rejects(row(withAssistant(`C:\\${"Users"}\\alice\\src`)), "absolute host path")
  })

  test("rejects credential shapes in content", () => {
    rejects(row(withAssistant(`key = "fw_${"a".repeat(24)}"`)), "Fireworks API key")
    rejects(row(withAssistant(`sk-${"a".repeat(32)}`)), "OpenAI-style API key")
    rejects(row(withAssistant(`ghp_${"a".repeat(36)}`)), "GitHub token")
    rejects(row(withAssistant("AKIAABCDEFGHIJKLMNOP")), "AWS access key")
    rejects(row(withAssistant("-----BEGIN OPENSSH PRIVATE KEY-----")), "private key")
    rejects(row(withAssistant(`Bearer ${"eyJ"}hbGciOiJIUzI1NiJ9.${"eyJ"}zdWIiOiIxMjM0In0.${"s".repeat(22)}`)), "JSON Web Token")
  })

  test("rejects an empty dataset and unparsable rows", () => {
    rejects("\n\n", "dataset is empty")
    rejects("{", "row 1: not valid JSON")
  })

  test("never quotes row text, keys, or values in a problem", () => {
    const key = `fw_${"a".repeat(24)}`
    const leaks = (text: string, fragment: string) => {
      const problems = validateDataset(text)
      assert.ok(problems.length > 0, `expected a problem for ${fragment}`)
      for (const problem of problems) {
        assert.ok(!problem.includes(key), `${fragment} leaked the credential: ${JSON.stringify(problem)}`)
      }
      rejects(text, fragment)
    }
    leaks(`{"messages": [{"role": "user", "content": ${key}}]}`, "row 1: not valid JSON")
    leaks(row({ messages: [{ role: key, content: "hi" }, good.messages[2]] }), "message 1: role is not one of")
    leaks(row({ ...good, [key]: "x" }), "row 1: 1 unexpected top-level key(s)")
    leaks(row({ messages: [{ ...good.messages[1], [key]: "x" }, good.messages[2]] }), "message 1: 1 unexpected key(s)")
  })
})
