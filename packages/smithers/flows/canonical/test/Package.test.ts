import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

test("the distribution smoke participates in the test graph after the library build", () => {
  const graph = JSON.parse(execFileSync(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    `
      import { Package } from "./PACKAGE.ts"
      import * as Target from "@smthrs/targets/Target"
      import * as NodeTest from "@smthrs/targets/NodeTest"
      import { runtime } from "../../../../.smithers/WORKSPACE.ts"

      const tests = Object.values(Package)
        .map((target) => Target.metadata(target))
        .filter((metadata) => metadata.target === "NodeTest" && metadata.kinds.includes("test"))
        .map((metadata) => ({
          argv: NodeTest.runArgv({ ...metadata.attrs, runtime }),
          cwd: metadata.attrs.cwd,
          buildsLibrary: metadata.dependencies.includes(Package.lib)
        }))
      console.log(JSON.stringify(tests))
    `
  ], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 25_000
  }))

  expect(graph).toContainEqual({
    // The workspace runtime preloads VibeLang's loader before every Node program.
    argv: ["node", "--import=vibelang/register", "--test", "test/dist-smoke.mjs"],
    cwd: "packages/smithers/flows/canonical",
    buildsLibrary: true
  })
})
