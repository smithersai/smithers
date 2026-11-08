import { execFileSync } from "node:child_process"
import { isAbsolute, join, relative, sep } from "node:path"
import { expect, it } from "vitest"

it("keeps transient coverage reports outside the workspace declaration walk", () => {
  const output = execFileSync("node", [
    "--input-type=module",
    "--eval",
    `
    import config from "./vitest.config.ts";
    import { realpathSync } from "node:fs";
    const directory = config.test.coverage.reportsDirectory;
    console.log(JSON.stringify({
      directory: realpathSync(directory),
      workspace: realpathSync("../../../..")
    }));
    `
  ], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" })
  const { directory, workspace } = JSON.parse(output) as { directory: string; workspace: string }
  const path = relative(workspace, directory)
  const outside = path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)
  expect({ directory, outside }).toMatchObject({ outside: true })
})
