import { globSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { expect, it } from "vitest"

it("typechecks the test bootstrap, CI and target declarations beside package sources", () => {
  const configPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url))
  const cwd = dirname(configPath)
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  expect(config.error).toBeUndefined()
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd)
  expect(parsed.errors).toEqual([])
  const checked = new Set(parsed.fileNames)
  const declared = globSync(["src/**/*.ts", "test/**/*.ts", "test-utils/**/*.ts", "ci/**/*.ts", "PACKAGE.ts", "vitest.config.ts"], { cwd })
  expect(declared).toContain("test-utils/test-schemas.ts")
  expect(declared.filter((path) => !checked.has(resolve(cwd, path)))).toEqual([])
})
