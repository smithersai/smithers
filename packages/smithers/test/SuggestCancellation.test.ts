import { Effect } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { expect, it } from "vitest"
import * as Suggest from "../src/Suggest.ts"
import * as Checklist from "../src/suggest/Checklist.ts"
import * as Ui from "../src/Ui.vibe"

const options = {
  root: "/repo",
  list: false,
  json: true,
  environment: { MOONSHOT_API_KEY: "test-key" },
  homeDirectory: "/absent",
  readFile: () => undefined
}

it("stops JSON output and repository reads after interruption", async () => {
  const controller = new AbortController()
  const repository = Checklist.memoryRepository("/repo", {
    "package.json": JSON.stringify({ scripts: { test: "vitest run", release: "changeset publish" } }),
    "vitest.config.ts": "export default {}",
    "eslint.config.js": "export default []",
    "packages/core/package.json": "{}"
  })
  const documents: Array<string> = []
  let reads = 0
  const running = Effect.runPromiseExit(
    Suggest.run({
      ...options,
      repository: {
        ...repository,
        read: (path) => {
          reads++
          return repository.read(path)
        }
      },
      emit: (line) => {
        documents.push(line)
        controller.abort()
      }
    }),
    { signal: controller.signal }
  )
  await running
  const count = documents.length
  const readCount = reads
  // Flush every check's event-loop yield, without elapsed-time assumptions.
  for (const _check of Checklist.checks) await new Promise<void>((resolve) => setImmediate(resolve))
  expect(count).toBe(1)
  expect(documents).toHaveLength(count)
  expect(reads).toBe(readCount)
})

it("cancels follow-ups with status 130 and no further prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-confirm-cancel-"))
  const file = join(root, "implemented.txt")
  const input = new PassThrough()
  const chunks: Array<string> = []
  let sent = false
  let selected = false
  const questions = new Set<string>()
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = String(chunk)
      chunks.push(text)
      if (!selected && text.includes("Which one should I implement?")) {
        selected = true
        setImmediate(() => input.write("\r"))
      } else if (
        selected && !text.includes("Which one should I implement?") && text.includes("?") && !questions.has(text)
      ) {
        questions.add(text)
        sent = true
        setImmediate(() => input.write("\u0003"))
      }
      callback()
    }
  })
  const ui = Ui.make({ input, output, interactive: true })
  try {
    const outcome = await Effect.runPromise(
      Suggest.run({
        ...options,
        json: false,
        repository: Checklist.memoryRepository("/repo", {
          "package.json": JSON.stringify({ scripts: { test: "vitest run", release: "changeset publish" } }),
          "vitest.config.ts": "export default {}",
          "eslint.config.js": "export default []",
          "packages/core/package.json": "{}"
        }),
        implement: () =>
          Effect.sync(() => {
            writeFileSync(file, "written before cancellation")
            return { files: [file], command: "", notes: "" }
          })
      }).pipe(Effect.provideService(Ui.Ui, ui))
    )
    expect(sent).toBe(true)
    expect(outcome.status).toBe("cancelled")
    expect(Suggest.exitStatus(outcome)).toBe(130)
    expect(outcome.implemented).toHaveLength(1)
    expect(readFileSync(file, "utf8")).toBe("written before cancellation")
    expect(chunks.join("")).not.toContain("Make it incremental")
  } finally {
    input.destroy()
    output.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})
