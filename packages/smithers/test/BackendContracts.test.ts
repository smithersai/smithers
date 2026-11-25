import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import ts from "typescript"
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
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowImportingTsExtensions: true
    }
    const program = ts.createProgram([file], options)
    const source = program.getSourceFile(file)!
    const errors = program.getSemanticDiagnostics(source)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    expect(errors).toEqual([])
  }, 90_000)
})
