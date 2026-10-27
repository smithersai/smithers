import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { expect, it } from "vitest"

it("the attribution example typechecks against TestRun's Effect API", () => {
  const guide = readFileSync(new URL("../docs/guides/run-the-test-suite.md", import.meta.url), "utf8")
  const snippet = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)]
    .find(([, code]) => code?.includes("against: \"base\""))![1]!
  const filename = fileURLToPath(new URL("./attribution-doc-example.ts", import.meta.url))
  const source = `import { Effect } from "effect"\nimport * as TestRun from "../src/TestRun.ts"\n${
    snippet.replace(/^import .*$/gm, "")
  }`
  const config = ts.readConfigFile(fileURLToPath(new URL("../tsconfig.test.json", import.meta.url)), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fileURLToPath(new URL("..", import.meta.url)))
  const options = { ...parsed.options, noEmit: true, composite: false }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === filename
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram([filename], options, host)
  const errors = program.getSemanticDiagnostics(program.getSourceFile(filename))
    .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
  expect(errors).toEqual([])
})
