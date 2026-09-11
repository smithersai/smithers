import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hostWorkspaceTests } from "../../scripts/host-workspace-tests"

describe("host-checkout tests require an explicit operator choice", () => {
  test(
    "the actual default integration suite neither loads nor cleans a configured but unapproved checkout",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "smithers-host-test-safety-"))
      const history = join(root, ".flows", "ui", "runs", "preexisting.jsonl")
      try {
        await mkdir(join(root, ".flows", "ui", "runs"), { recursive: true })
        await writeFile(history, "fixture history owned by somebody else")
        await writeFile(
          join(root, "PACKAGE.ts"),
          "throw new Error('a default unit run must not evaluate this workspace')"
        )
        const child = Bun.spawn([process.execPath, "test", join(import.meta.dir, "TargetGraph.integration.test.ts")], {
          cwd: join(import.meta.dir, "../.."),
          env: {
            ...process.env,
            SMITHERS_HOST_WORKSPACE_TESTS: "0",
            SMITHERS_GRAPH_READ_WORKSPACE: root,
            SMITHERS_GRAPH_RUN_WORKSPACE: root
          },
          stdout: "pipe",
          stderr: "pipe"
        })
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
        try {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text()
          ])
          expect({ code, diagnostics: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, diagnostics: "" })
          expect(stdout + stderr).toContain("7 skip")
          expect(await readFile(history, "utf8")).toBe("fixture history owned by somebody else")
        } finally {
          clearTimeout(timer)
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    15_000
  )
  test("default units never discover or select a personal checkout", () => {
    expect(hostWorkspaceTests({})).toEqual({ read: undefined, run: undefined })
    expect(hostWorkspaceTests({
      SMITHERS_GRAPH_READ_WORKSPACE: "/fixture/read",
      SMITHERS_GRAPH_RUN_WORKSPACE: "/fixture/run"
    })).toEqual({ read: undefined, run: undefined })
  })
  test("enabled tests need explicit absolute paths", () => {
    expect(() => hostWorkspaceTests({ SMITHERS_HOST_WORKSPACE_TESTS: "1" })).toThrow("explicit")
    expect(() => hostWorkspaceTests({ SMITHERS_HOST_WORKSPACE_TESTS: "1", SMITHERS_GRAPH_RUN_WORKSPACE: "relative" }))
      .toThrow("absolute")
    expect(hostWorkspaceTests({ SMITHERS_HOST_WORKSPACE_TESTS: "1", SMITHERS_GRAPH_READ_WORKSPACE: "/fixture/read" }))
      .toEqual({ read: "/fixture/read", run: undefined })
    expect(hostWorkspaceTests({ SMITHERS_HOST_WORKSPACE_TESTS: "1", SMITHERS_GRAPH_RUN_WORKSPACE: "/fixture/run" }))
      .toEqual({ read: undefined, run: "/fixture/run" })
  })
})
