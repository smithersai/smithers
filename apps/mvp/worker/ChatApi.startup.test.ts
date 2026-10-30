// Startup has a deterministic gate here; bench/startup.ts retains the 200 ms performance budget.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { DEV_FEED_KEY } from "./feeds/dev.ts"
import { bundle, type Output } from "./test/startup/bundle.ts"

const EVALUATE = fileURLToPath(new URL("./test/startup/evaluate.mjs", import.meta.url))

describe("ChatApi's startup", () => {
  let dir = ""
  let output: ReadonlyArray<Output>
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chatapi-startup-"))
    output = await bundle()
    for (const file of output) {
      const path = join(dir, file.fileName)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file.type === "chunk" ? file.code! : file.source!)
    }
  }, 180_000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("loads its settings while keeping the request program out of startup's static module graph", () => {
    const chunks = new Map(output.filter(file => file.type === "chunk").map(file => [file.fileName, file]))
    const eager = new Set<string>()
    const visit = (name: string) => {
      if (eager.has(name)) return
      eager.add(name)
      const chunk = chunks.get(name)
      expect(chunk, name).toBeDefined()
      for (const dependency of chunk!.imports!) if (chunks.has(dependency)) visit(dependency)
    }
    visit("ChatApi.js")
    const programChunks = [...chunks.values()].filter(chunk =>
      Object.keys(chunk.modules!).some(module => module.endsWith("/worker/ChatApiProgram.ts")))
    expect(programChunks).toHaveLength(1)
    expect(eager.has(programChunks[0]!.fileName)).toBe(false)
    expect([...eager].flatMap(name => chunks.get(name)!.dynamicImports!)).toContain(programChunks[0]!.fileName)

    // Load the actual bundle too: graph separation must not conceal a broken startup.
    const ran = spawnSync(process.execPath, ["--no-warnings", EVALUATE, join(dir, "ChatApi.js")], { encoding: "utf8" })
    expect(ran.status, ran.stderr).toBe(0)
    expect(JSON.parse(ran.stdout.trim().split("\n").at(-1)!)).toMatchObject({ evaluationMs: expect.any(Number) })
  })

  test("never holds alchemy dev's development feed key: a deploy accepts only FEED_KEYS (docs/features/feeds.md#development)", () => {
    const text = output.map((file) => file.type === "chunk" ? file.code! : String(file.source ?? "")).join("\n")
    // The bundle is the real one: it holds the feeds' routes, just not the key.
    expect(text).toContain("FEED_KEYS")
    expect(text).not.toContain(DEV_FEED_KEY)
    expect(output.some((file) => Object.keys(file.modules ?? {}).some((module) => /worker\/(DevChatApi|feeds\/dev)\.ts$/.test(module))))
      .toBe(false)
  })
})
