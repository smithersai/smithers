import { expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

it("resolves a separate coverage scratch directory in each coordinator process", () => {
  const config = new URL("../vitest.config.ts", import.meta.url).href
  const inspect = () =>
    JSON.parse(execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `const {default: config} = await import(${JSON.stringify(config)});
     console.log(JSON.stringify({pid: process.pid, directory: config.test.coverage.reportsDirectory}));`
    ], { encoding: "utf8", timeout: 12_000 })) as { pid: number; directory: string }
  const first = inspect()
  const second = inspect()
  expect(first.pid).not.toBe(second.pid)
  for (const result of [first, second]) {
    expect(result.directory).toBe(join(tmpdir(), `flows-sandbox-coverage-${result.pid}`))
  }
  expect(join(first.directory, ".tmp")).not.toBe(join(second.directory, ".tmp"))
})

it("refuses provider environment reads outside default parameters", () => {
  const config = new URL("../eslint.config.js", import.meta.url).href
  const result = JSON.parse(execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import { Linter } from \"eslint\";" +
    "const { default: configs } = await import(" + JSON.stringify(config) + ");" +
    "const rules = configs.filter(c => c.rules?.[\"no-restricted-syntax\"]).at(-1).rules;" +
    "const linter = new Linter();" +
    "console.log(JSON.stringify([" +
    "\"const env = process.env;\"," +
    "\"consume(globalThis.process.env);\"," +
    "\"const env = globalThis.process?.env;\"," +
    "\"consume(options.hostEnvironment);\"" +
    "].map(source => linter.verify(source, {rules}).map(message => message.ruleId))));"
  ], { encoding: "utf8", timeout: 12_000 })) as Array<Array<string>>
  expect(result).toEqual([
    ["no-restricted-syntax"],
    ["no-restricted-syntax"],
    ["no-restricted-syntax"],
    []
  ])
})
