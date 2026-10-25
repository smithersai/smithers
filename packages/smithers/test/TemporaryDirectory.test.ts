import { access, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, it } from "vitest"
import { withTemporaryDirectory } from "./helpers/TemporaryDirectory.ts"

it.each(["success", "setup", "teardown"])("removes the workspace after %s", async (outcome) => {
  let directory = ""
  const failure = new Error(outcome)
  const operation = withTemporaryDirectory("smithers-guide-cli-", async (root) => {
    directory = root
    await writeFile(join(root, "WORKSPACE.ts"), "export const Workspace = 1\n")
    await access(join(root, "WORKSPACE.ts"))
    if (outcome === "setup") throw failure
    try {
      return "completed"
    } finally {
      // Quickstart's cancel-all command can reject during teardown.
      if (outcome === "teardown") throw failure
    }
  })
  if (outcome === "success") await expect(operation).resolves.toBe("completed")
  else await expect(operation).rejects.toBe(failure)
  await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" })
})
