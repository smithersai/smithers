/**
 * The report says why a step was not reused.
 *
 * A person who replays a repository and finds a step ran at every commit has
 * to be told why, in the build's own words: the file the step read that
 * changed, or what the step did that keeps its result from ever being used
 * again. Before, a report held the counts and no reason.
 *
 * The real program replays two commits with the real `smthrs` and the real
 * tracer. One step reads a file; the other reaches a server this test runs,
 * as a step reaches a registry.
 */
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { bin, commit, git, observes, remove, spawn, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const workflow = (port: number): string =>
  [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - name: read",
    "        run: cat data.txt",
    "      - name: fetch",
    `        run: node -e "require('net').connect(${port}, '127.0.0.1').on('connect', function () { this.end() })"`,
    ""
  ].join("\n")

describe("a step that was not reused", () => {
  it.skipIf(!observes)("is named in the report with the build's reason", async () => {
    const server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const root = temporary("not-reused")
      made.push(root)
      git(root, "init", "--quiet", "--initial-branch=main")
      commit(root, "base", {
        ".github/workflows/ci.yml": workflow(port),
        "data.txt": "1\n",
        "docs/readme.md": "# Fixture\n"
      })
      commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
      commit(root, "the file a step reads", { "data.txt": "2\n" })
      const outcome = await spawn(bin, ["--commits", "2", "--json", "--no-trial", "--no-apply-check"], root)
      expect(outcome.stderr).not.toContain("reads are not observed")
      const report = JSON.parse(outcome.stdout) as ReplayReport
      const reached = `it reached a program outside the run on local port ${port}`
      expect(
        report.commits.map((entry) => [
          entry.normal.counts.hit,
          entry.normal.notReused?.map((
            step
          ) => [step.step, step.reason.startsWith(reached) ? reached : step.reason, step.kept]),
          entry.baseline.notReused,
          entry.mismatches.length
        ])
      ).toEqual([
        // Only docs changed: the step that reads a file is reused, and the one that reaches a server never is.
        [1, [["ci.yml:test: fetch", reached, false]], undefined, 0],
        [0, [["ci.yml:test: read", "data.txt changed", true], ["ci.yml:test: fetch", reached, false]], undefined, 0]
      ])
      expect(outcome.code).toBe(0)
      // The same lines in the report a person reads.
      const shown = await spawn(bin, ["--commits", "2", "--no-trial", "--no-apply-check"], root)
      const fetch = `node -e "require('net').connect(${port}, '127.0.0.1').on('connect', function () { this.end() })"`
      expect(shown.stdout).toContain(
        `steps not reused\n2 of 2 commits  ci.yml:test: fetch  ${fetch}  never reused: ${reached}`
      )
      expect(shown.stdout).toContain("\n1 of 2 commits  ci.yml:test: read  cat data.txt  data.txt changed")
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  }, 900_000)
})
