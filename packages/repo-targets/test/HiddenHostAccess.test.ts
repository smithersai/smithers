import { describe, expect, it } from "vitest"
import { hiddenHostAccess } from "../src/HiddenHostAccess.ts"

/** Every module the platform rule governs here: a workspace package's. */
const workspace = (module: string): boolean => module.startsWith("packages/")

/** One line per finding: `<line> <kind> <module> <access>`. */
const findings = (code: string, governed: (module: string) => boolean = () => false): ReadonlyArray<string> =>
  hiddenHostAccess(code, governed).map((access) => `${access.line} ${access.kind} ${access.module} ${access.call}`)

/**
 * The shape esbuild emitted for `packages/smithers/flows/sandbox/src/internal/execHandles.ts`
 * when it loaded Node's collector through an optional `getBuiltinModule` call, out of the
 * bundler's sight and past the old gate.
 */
const execHandles = [
  "// packages/smithers/flows/sandbox/src/internal/execHandles.ts",
  "var exposeCollector = (runtime = globalThis, host = globalThis.process) => {",
  "  const bun = Reflect.get(runtime, \"Bun\");",
  "  const builtin = (id) => host?.getBuiltinModule?.(id);",
  "  const v8 = builtin(\"node:v8\");",
  "  if (v8 === void 0) return () => void 0;",
  "  v8.setFlagsFromString(\"--expose-gc\");",
  "  return builtin(\"node:vm\").runInNewContext(\"gc\");",
  "};"
].join("\n")

describe("hiddenHostAccess", () => {
  it("keeps the module boundary across ordinary column-zero comments", () => {
    const bundle = [
      "// packages/foo/src/bar.ts",
      "// TODO",
      "// @ts-expect-error",
      "// prettier-ignore",
      "// https://example.test/doc.js",
      "process.env.SECRET;",
      "const type = 'node:fs';",
      "// node_modules/third-party/index.js",
      "process?.getBuiltinModule?.('node:fs');"
    ].join("\n")
    expect(findings(bundle, workspace)).toEqual([
      "6 ambient-global packages/foo/src/bar.ts process",
      "7 host-module packages/foo/src/bar.ts 'node:fs'"
    ])
  })

  it("reports the dynamic import that let @smthrs/sandbox carry Node-only jj past the browser gate", () => {
    // The shape esbuild emitted for `packages/smithers/flows/sandbox/src/SandboxMerge/HostAdapter.ts`.
    const bundle = [
      "// packages/smithers/flows/sandbox/src/SandboxMerge/HostAdapter.ts",
      "var adapter = \"@smthrs/jj/node/NodeJj\";",
      "var loadHostAdapter = makeHostAdapterLoader(() => import(adapter));"
    ].join("\n")
    expect(findings(bundle)).toEqual([
      "3 dynamic-import packages/smithers/flows/sandbox/src/SandboxMerge/HostAdapter.ts import(adapter)"
    ])
  })

  it("reports require with an expression, under either name esbuild gives it", () => {
    const bundle = ["const a = require(name);", "const b = __require(`${name}`);"].join("\n")
    expect(findings(bundle)).toEqual(["1 require  require(name)", "2 require  __require(`${name}`)"])
  })

  it("passes imports and requires the bundler resolves", () => {
    const bundle = [
      "import(\"./chunk.js\");",
      "import(`./chunk.js`);",
      "require(\"./module.js\");",
      "__require(\"./module.js\");",
      "other(name);",
      "factory()(name);"
    ].join("\n")
    expect(findings(bundle, workspace)).toEqual([])
  })

  it("reports a getBuiltinModule call that needs the host, and names its module", () => {
    const bundle = [
      "// node_modules/one/a.js",
      "const gc = () => process.getBuiltinModule(\"node:v8\");",
      "// node_modules/two/b.js",
      "const fs = process?.getBuiltinModule(\"node:fs\");"
    ].join("\n")
    expect(findings(bundle)).toEqual([
      "2 builtin node_modules/one/a.js process.getBuiltinModule(\"node:v8\")",
      "4 builtin node_modules/two/b.js process?.getBuiltinModule(\"node:fs\")"
    ])
  })

  it("passes feature detection in a module the platform rule does not govern, such as a dependency's", () => {
    const bundle = [
      "// node_modules/effect/dist/internal/effect.js",
      "const util = globalThis.process?.getBuiltinModule?.(\"node:util\");",
      "function append(node) { try { node.getBuiltinModule(\"node:fs\").appendFileSync(f, v) } catch {} }",
      "function nested() { try { return 1 } finally { cleanup() } }",
      "const env = typeof process === \"undefined\" ? {} : process.env;"
    ].join("\n")
    expect(findings(bundle, workspace)).toEqual([])
  })

  it("does not count a try block outside the function that makes the call", () => {
    const bundle = [
      "try {",
      "  later = () => process.getBuiltinModule(\"node:vm\")",
      "} catch {}",
      "try { ok() } catch { process.getBuiltinModule(\"node:os\") }"
    ].join("\n")
    expect(findings(bundle)).toEqual([
      "2 builtin  process.getBuiltinModule(\"node:vm\")",
      "4 builtin  process.getBuiltinModule(\"node:os\")"
    ])
  })

  it("reports every host access the old gate let through in execHandles.ts, once the platform rule governs it", () => {
    const module = "packages/smithers/flows/sandbox/src/internal/execHandles.ts"
    expect(findings(execHandles)).toEqual([])
    expect(findings(execHandles, workspace)).toEqual([
      `2 ambient-global ${module} globalThis.process`,
      `4 builtin ${module} host?.getBuiltinModule?.(id)`,
      `5 host-module ${module} "node:v8"`,
      `8 host-module ${module} "node:vm"`
    ])
  })

  it("reports every getBuiltinModule call in a governed module, feature detection or not", () => {
    const bundle = [
      "// packages/lib/src/a.ts",
      "const util = globalThis.process?.getBuiltinModule?.(id);",
      "function append(node) { try { node.getBuiltinModule(id) } catch {} }"
    ].join("\n")
    expect(findings(bundle, workspace)).toEqual([
      "2 ambient-global packages/lib/src/a.ts globalThis.process",
      "2 builtin packages/lib/src/a.ts globalThis.process?.getBuiltinModule?.(id)",
      "3 builtin packages/lib/src/a.ts node.getBuiltinModule(id)"
    ])
  })

  it("reports a governed module's reads of the ambient process, Bun and Deno globals", () => {
    const bundle = [
      "// packages/lib/src/a.ts",
      "const home = process.env.HOME;",
      "const bun = typeof Bun !== \"undefined\";",
      "const deno = Deno.env;",
      "const pid = globalThis.process?.pid;",
      "const runtime = globalThis[\"Bun\"];",
      "const reflected = Reflect.get(globalThis, \"Deno\");",
      "const carried = { process };"
    ].join("\n")
    expect(findings(bundle, workspace)).toEqual([
      "2 ambient-global packages/lib/src/a.ts process",
      "3 ambient-global packages/lib/src/a.ts Bun",
      "4 ambient-global packages/lib/src/a.ts Deno",
      "5 ambient-global packages/lib/src/a.ts globalThis.process",
      "6 ambient-global packages/lib/src/a.ts globalThis[\"Bun\"]",
      "7 ambient-global packages/lib/src/a.ts Reflect.get(globalThis, \"Deno\")",
      "8 ambient-global packages/lib/src/a.ts process"
    ])
  })

  it("passes a governed module's own bindings and properties that share those names", () => {
    const bundle = [
      "// packages/lib/src/a.ts",
      "const process = spawn(); process.stdout;",
      "function exit(Bun) { return Bun.gc }",
      "const { process: child } = handle; child.pid;",
      "const record = { process: 1, Bun: 2, \"Deno\": 3 };",
      "class Runner { process() {} Bun = 1 }",
      "handle.process.kill(); handle[\"Bun\"]; Reflect.get(handle, \"process\");",
      "{ const Deno = 1; ({ Deno }); }",
      "import(\"./chunk.js\");"
    ].join("\n")
    expect(findings(bundle, workspace)).toEqual([])
  })

  it("reports node: and bun: module specifiers in a governed module only", () => {
    const bundle = [
      "// packages/lib/src/a.ts",
      "const fs = load(\"node:fs\"), sqlite = load(`bun:sqlite`), other = load(\"nodes:x\"), word = \"node\";",
      "// node_modules/dep/index.js",
      "const hooks = \"node:async_hooks\";"
    ].join("\n")
    expect(findings(bundle, workspace)).toEqual([
      "2 host-module packages/lib/src/a.ts \"node:fs\"",
      "2 host-module packages/lib/src/a.ts `bun:sqlite`"
    ])
  })

  it("cuts a long access to 80 characters", () => {
    const [access] = hiddenHostAccess(`import(${"x".repeat(100)})`, () => false)
    expect(access?.call).toHaveLength(80)
  })
})
