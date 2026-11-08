import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { compileProjectSync } from "vibelang/project"
import { describe, expect, it } from "vitest"
import { Client } from "../src/internal/backend/Client.ts"
import { definitions } from "../src/internal/backend/Definitions.ts"
import { resources } from "../src/internal/backend/Resources.ts"

describe("backend trust and authoring contracts", () => {
  it("does not advertise exporting a secret to a branch file", () => {
    expect(Object.keys(definitions["secret set"].options.shape)).not.toContain("path")
  })

  it("refuses legacy secret file options before reading a value or contacting a backend", async () => {
    const client = new Client({ environment: {} })
    await expect(resources["secret set"]!(client, { name: "KEY" }, { path: "~/key" }))
      .rejects.toThrow("Secret values cannot be written to branch files")
  })

  it("has no timer or raw promise polling in the history subscription", () => {
    const source = ts.createSourceFile(
      "History.ts",
      readFileSync(new URL("../src/internal/backend/History.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true
    )
    const polling: Array<string> = []
    const visit = (node: ts.Node) => {
      if (
        (ts.isCallExpression(node) && ["setTimeout", "setInterval"].includes(node.expression.getText(source))) ||
        (ts.isNewExpression(node) && node.expression.getText(source) === "Promise")
      ) polling.push(node.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(polling).toEqual([])
  })

  it("requires a procedure-specific RPC body and preserves its response type", () => {
    const file = fileURLToPath(new URL("./fixtures/workflow-rpc-types.ts", import.meta.url))
    // The VibeLang checker compiles the fixture: the modules it imports reach
    // .vibe sources, which a stock TypeScript program cannot read.
    const root = fileURLToPath(new URL("../../../", import.meta.url))
    const directory = mkdtempSync(join(fileURLToPath(new URL(".", import.meta.url)), ".workflow-rpc-types-"))
    let errors: Array<string>
    try {
      writeFileSync(
        join(directory, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            target: "esnext",
            module: "nodenext",
            moduleResolution: "nodenext",
            allowImportingTsExtensions: true
          },
          files: [file]
        })
      )
      errors = compileProjectSync({ project: join(directory, "tsconfig.json"), root, cache: false }).errors
        .filter((diagnostic) => diagnostic.file !== undefined && resolve(root, diagnostic.file) === file)
        .map((diagnostic) => diagnostic.text)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
    expect(errors).toEqual([])
  }, 30_000)
})
