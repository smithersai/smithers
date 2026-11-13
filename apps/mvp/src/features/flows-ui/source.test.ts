// A person's flow as flow source (src/features/flows-ui/source.ts): the module drafting writes, a real typed `Flow.make`
// module, and where a revision runs: on the device in the QuickJS realm, drafted or edited, unless it needs a machine.
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import { build } from "esbuild"
import ts from "typescript"
import fc from "fast-check"
import { describe, expect, test } from "vitest"
import {
  capabilitiesOf,
  type Generated,
  importsOf,
  needsMachine,
  placementOf,
  renderSource,
  SOURCE_PATH,
  stepName,
} from "./source"

const notes: Generated = {
  name: "release-notes",
  description: "Summarize merged pull requests: since \"the\" last tag.",
  instructions: "Read the repository.\n\n  Then summarize what merged.\r\nTabs\there, and `ticks` with ${braces}.",
  flows: ["repo/read", "repo/tree"],
}

describe("renderSource", () => {
  test("a drafted flow is a Flow.make module named for it, with one agent step that renders its prompt", () => {
    const source = renderSource(notes)
    expect(source.startsWith("// Drafted by Smithers from a prompt.\n")).toBe(true)
    expect(source).toContain(`export default Flow.make("release-notes", {`)
    expect(source).toContain(`const Agent = AgentAction.make("release-notes/agent", {`)
    expect(source).toContain(`  flows: ["repo/read", "repo/tree"],`)
    expect(source).toContain("  capabilities: [],")
    expect(source.endsWith("})\n")).toBe(true)
    expect(SOURCE_PATH).toBe("flow.ts")
    expect(stepName("release-notes")).toBe("release-notes/agent")
    expect(renderSource({ ...notes, flows: [] })).toContain("  flows: [],")
  })
})

describe("placementOf", () => {
  const source = renderSource(notes)

  test("a drafted flow, as drafted or edited anywhere, runs on the device in the realm", () => {
    for (
      const code of [
        source,
        source.replace(`"release-notes/agent"`, `"release-notes/answer"`),
        source.replace("// Drafted by Smithers", "// Mine now"),
        source.replace("Agent.call({ input })", "Agent.call({ input: input.toUpperCase() })"),
        // A module the realm doesn't provide but no machine does either: the realm refuses it when it runs.
        `import { pipe } from "effect/Function"\n${source}`,
        source.replace("  capabilities: [],", `  capabilities: ["model:call", "memory:read"],`),
      ]
    ) {
      expect([needsMachine(code), placementOf(code)]).toEqual([false, "client"])
    }
    expect(importsOf(source)).toEqual(["@smthrs/agent", "@smthrs/flow", "effect"])
    expect(capabilitiesOf(source)).toEqual([])
  })

  test("code that imports a module only a machine provides, or declares a capability only a machine grants, needs a sandbox", () => {
    for (
      const code of [
        `import { readFile } from "node:fs/promises"\n${source}`,
        `import "bun:sqlite"\n${source}`,
        `import { $ } from 'bun'\n${source}`,
        `import {\n  Runtime,\n} from "@smthrs/platform-node"\n${source}`,
        `export { CiJob } from "@smthrs/sandbox"\n${source}`,
        `import { Sandbox } from "@smthrs/sandbox/Sandbox"\n${source}`,
        source.replace("  capabilities: [],", `  capabilities: ["proc:spawn"],`),
        source.replace("  capabilities: [],", "  capabilities: ['fs:read', 'model:call'],"),
        source.replace("  capabilities: [],", "  capabilities: [`net:get`],"),
        source.replace("  capabilities: [],", `  capabilities: ["jj:status"],`),
        source.replace("  capabilities: [],", `  capabilities: ["*"],`),
      ]
    ) {
      expect([code, needsMachine(code), placementOf(code)]).toEqual([code, true, "sandbox"])
    }
    expect(importsOf(`import "bun:sqlite"\nimport { a } from "x"`)).toEqual(["bun:sqlite", "x"])
    expect(capabilitiesOf(`const options = { capabilities: ["fs:read", 'net:get'] };`)).toEqual(["fs:read", "net:get"])
  })

  test.each([
    '/* Example only:\nimport fs from "node:fs"\ncapabilities: ["fs:read"]\n*/',
    '// import fs from "node:fs"\n// capabilities: ["fs:read"]',
    'const example = `\nimport fs from "node:fs"\ncapabilities: ["fs:read"]\n`;',
    'const example = "import fs from \\"node:fs\\"; capabilities: [\\"fs:read\\"]";',
    'const example = /capabilities: ["fs:read"]/;',
    'type Example = { capabilities: ["fs:read"] };',
  ])("examples in comments, strings, regular expressions and types stay client: %s", (example) => {
    const code = example + "\n" + source
    expect(importsOf(code)).toEqual(["@smthrs/agent", "@smthrs/flow", "effect"])
    expect(capabilitiesOf(code)).toEqual([])
    expect(placementOf(code)).toBe("client")
  })

  test.each([
    ['export const value = 1; export { value }; import "node:fs";', ["node:fs"]],
    ['/* comment */ import { readFile } /* comment */ from /* comment */ "node:fs";', ["node:fs"]],
    ['export * from "bun:sqlite"; export { readFile } from "node:fs";', ["bun:sqlite", "node:fs"]],
    ['import { Flow } from "@smthrs/flow"; import "node:fs";', ["@smthrs/flow", "node:fs"]],
    [String.raw`import "node:\u0066s";`, ["node:fs"]],
  ] as const)("static imports are read from syntax regardless of layout: %s", (code, modules) => {
    expect(importsOf(code)).toEqual(modules)
    expect(placementOf(code + "\n" + source)).toBe("sandbox")
  })

  test.each([
    'const options = { capabilities: ["fs:read", "model:call"] };',
    'const options = { "capabilities": ["fs:read", "model:call"] };',
    'const options = { ["capabilities"]: ["fs:read", "model:call"] };',
    'const options = { capabilities: ["fs:read", "model:call"] as const };',
    'const options = { capabilities: ["fs:read", "model:call"] satisfies string[] };',
    'const options = { capabilities: <string[]>["fs:read", "model:call"] };',
    'const options = { capabilities: (["fs:read", "model:call"])! };',
    'const options = { capabilities: ["fs:read" as const, ("model:call" satisfies string)] };',
    'const options = { capabilities /* comment */: [\n"fs:read", /* "proc:spawn" */ "model:call"\n] };',
    'const options = { capabilities: ["fs:\\u0072ead", `model:call`] };',
  ])("literal capabilities are read from properties regardless of layout: %s", (code) => {
    expect(capabilitiesOf(code)).toEqual(["fs:read", "model:call"])
    expect(placementOf(code + "\n" + source)).toBe("sandbox")
  })

  test("only literal array members of capability properties declare capabilities", () => {
    const code = `
const options = {
  other: ["fs:write"],
  capabilities: ["model:call", ...other, make("proc:spawn"), \`net:\${name}\`, null, 1, ,],
};
const unread = { capabilities: dynamic, [name]: ["fs:read"] };
const prompt = \`capabilities: ["fs:read"]\`;
`
    expect(capabilitiesOf(code)).toEqual(["model:call"])
    expect(importsOf('const prompt = `import "node:fs"`; import("node:fs")')).toEqual([])
    expect(placementOf(code)).toBe("client")
    expect(capabilitiesOf('const prompt = `example ${({ capabilities: ["fs:read"] }).capabilities}`')).toEqual(["fs:read"])
  })

  test.each(["import {", "const options = {", "export default", 'const options = { capabilities: [`fs:\\xGG`] };'])(
    "incomplete or invalid editor source does not throw: %s", (code) => {
      expect(importsOf(code)).toEqual([])
      expect(capabilitiesOf(code)).toEqual([])
      expect(placementOf(code)).toBe("client")
    },
  )

  test("adding arbitrary comment and string examples never changes a client flow's requirements", () => {
    fc.assert(fc.property(
      fc.constantFrom("node:fs", "bun:sqlite", "@smthrs/platform-node"),
      fc.constantFrom("fs:read", "proc:spawn", "net:get", "jj:status", "*"),
      fc.string(),
      (module, capability, text) => {
        const example = `\nimport fs from "${module}"\ncapabilities: ["${capability}"]\n${text}`
        const template = example.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")
        for (const quoted of [
          `/* ${example.replaceAll("*/", "* /")} */`,
          `const example = \`${template}\`;`,
          `const example = ${JSON.stringify(example)};`,
        ]) {
          const code = quoted + "\n" + source
          expect(importsOf(code)).toEqual(["@smthrs/agent", "@smthrs/flow", "effect"])
          expect(capabilitiesOf(code)).toEqual([])
          expect(placementOf(code)).toBe("client")
        }
      },
    ), { numRuns: 100 })
  })

  test("text that only looks like an import or a capability, inside the drafted instructions, is no machine code", () => {
    const quoting = renderSource({
      ...notes,
      instructions: `Read from 'node:fs' like code would.\nimport x from "node:fs"\nSay capabilities: ["proc:spawn"] aloud.`,
    })
    expect(placementOf(quoting)).toBe("client")
    // The line `export default Flow.make("…"` names no module.
    expect(importsOf(quoting)).toEqual(["@smthrs/agent", "@smthrs/flow", "effect"])
  })
})

describe("portable source analysis", () => {
  test("the browser bundle initializes and classifies source without Node globals", async () => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("./source.ts", import.meta.url))],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "FlowSource",
      write: false,
    })
    const context = {
      client: renderSource(notes),
      machine: 'import "node:fs";',
    }
    expect(runInNewContext(
      bundle.outputFiles[0]!.text + "; [FlowSource.placementOf(client), FlowSource.placementOf(machine)]",
      context,
    )).toEqual(["client", "sandbox"])
  })
})

describe("a drafted flow's module", () => {
  test("type-checks against @smthrs/flow and @smthrs/agent as a flow.ts beside the app's own code", () => {
    // A file of its own in this folder, served from memory, so its imports resolve as the app's do.
    const file = fileURLToPath(new URL("./__generated__/flow.ts", import.meta.url))
    const source = renderSource(notes)
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      types: [],
    }
    const host = ts.createCompilerHost(options)
    const getSourceFile = host.getSourceFile
    host.getSourceFile = (name, language, ...rest) =>
      name === file ? ts.createSourceFile(name, source, language) : getSourceFile.call(host, name, language, ...rest)
    const fileExists = host.fileExists
    host.fileExists = (name) => name === file || fileExists.call(host, name)
    const program = ts.createProgram([file], options, host)
    const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(file))
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
  }, 120_000)
})
