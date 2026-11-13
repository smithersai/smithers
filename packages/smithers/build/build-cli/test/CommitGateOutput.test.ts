import { Effect } from "effect"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { expect, it } from "vitest"
import { executeEffect } from "../src/internal/PackageRunner.ts"
import * as Reporter from "../src/Reporter.ts"
import { runnerFixture } from "./helpers/PackageRunnerFixture.ts"

it("reports commit gate service output from both streams against the candidate tree", async () => {
  const { root, options, plan } = await runnerFixture(
    `
const service = S.Shell.Serve({
  shell: ${JSON.stringify(JSON.stringify(process.execPath) + " server.cjs")},
  readiness: { exec: [${
      JSON.stringify(process.execPath)
    }, "-e", "require('node:fs').accessSync('ready')"], timeout: "20s" },
  stop: { signal: "SIGTERM", grace: "1s" }
})
const gate = S.Shell.Test({ shell: "test -f ready", services: [service], sandbox: "none" })
const command = S.Git.Commit({ gates: [gate], changes: ["src/**"], message: "test: candidate" })
export const Package = S.Package({ targets: { service, gate, command } })
`,
    {
      "server.cjs": `const fs = require("node:fs")
process.stdout.write("service stdout\\n")
process.stderr.write("service stderr\\n")
fs.writeFileSync("ready", "")
setInterval(() => {}, 1000)
`,
      "src/value.txt": "old"
    }
  )
  await Fs.writeFile(Path.join(root, "src/value.txt"), "candidate")
  const output: Array<{ label: string; stream: string; text: string }> = []
  const result = await Effect.runPromise(executeEffect(plan, {
    ...options,
    environment: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid"
    },
    reporter: {
      ...Reporter.plain(() => {}),
      toolOutput: (label, stream, text) => output.push({ label, stream, text })
    }
  }))
  expect(result.ok, JSON.stringify(result)).toBe(true)
  for (const stream of ["stdout", "stderr"]) {
    expect(
      output.some((entry) =>
        entry.label.startsWith("//:service") && entry.stream === stream && entry.text === `service ${stream}\n`
      ),
      JSON.stringify(output)
    ).toBe(true)
  }
  await expect(Fs.stat(Path.join(root, "ready"))).rejects.toMatchObject({ code: "ENOENT" })
})
