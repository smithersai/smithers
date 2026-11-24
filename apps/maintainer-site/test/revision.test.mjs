import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { startServer } from "../serve.mjs"

test("slice files and outlines use recorded jj history, including deleted files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-revision-"))
  const repo = join(dir, "repo"), queueDir = join(dir, "queue")
  mkdirSync(repo); mkdirSync(queueDir)
  const jj = (...args) => execFileSync("jj", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  jj("git", "init")
  writeFileSync(join(repo, "code.ts"), "// recorded\nexport const original = {\n  value: 1\n}\n")
  for (let i = 0; i < 33; i++) writeFileSync(join(repo, `file${i}.txt`), `recorded ${i}`)
  jj("describe", "-m", "recorded fixture")
  const revision = jj("log", "-r", "@", "--no-graph", "-T", "commit_id")
  jj("new")
  writeFileSync(join(repo, "code.ts"), "export const newer = 2\n")
  jj("describe", "-m", "newer fixture")
  const newer = jj("log", "-r", "@", "--no-graph", "-T", "commit_id")
  jj("new")
  rmSync(join(repo, "code.ts"))
  writeFileSync(join(repo, "live.ts"), "export const live = 1\n")
  const files = [{ path: "code.ts" }, ...Array.from({ length: 33 }, (_, i) => ({ path: `file${i}.txt` }))]
  writeFileSync(join(queueDir, "queue.json"), JSON.stringify({ items: [
    { id: "old", kind: "code", commit: revision, revision: "sha256-of-text", files },
    { id: "newer", kind: "code", commit: newer, files },
    { id: "covered", kind: "code", files },
    { id: "legacy", kind: "code", revision, files: [{ path: "live.ts" }] },
    { id: "bad", kind: "code", commit: "0000000000000000000000000000000000000000", files },
    { id: "secret", kind: "code", commit: revision, revision: "sha256-of-text", files: [{ path: ".env" }] },
    { id: "escape", kind: "code", commit: revision, files: ["../code.ts", "/code.ts", "./code.ts", "bad\u0000path"] },
  ] }))
  writeFileSync(join(queueDir, "coverage.json"), JSON.stringify({ slices: { covered: { commit: revision, revision: "sha256-of-text", files: ["code.ts:1-4"] }, coverageOnly: { commit: revision, revision: "sha256-of-text", files: ["code.ts:1-4"] } } }))
  const server = startServer({ port: 0, repo, queueDir })
  const base = await server.ready
  const get = async (endpoint, path, slice) => fetch(`${base}/api/${endpoint}?path=${encodeURIComponent(path)}&slice=${slice}`)
  try {
    const cards = await (await fetch(base + "/api/queue")).json()
    const viewed = cards.items.find((item) => item.id === "covered")
    assert.equal(viewed.commit, revision)
    const pinned = (endpoint) => fetch(`${base}/api/${endpoint}?slice=covered&path=code.ts&digest=${viewed.digest}`)
    assert.match(await (await pinned("file")).text(), /original/)
    assert.equal((await (await pinned("outline")).json()).symbols[0].name, "original")
    const coverageFile = join(queueDir, "coverage.json")
    const originalCoverage = readFileSync(coverageFile)
    writeFileSync(coverageFile, JSON.stringify({ slices: { covered: { commit: newer, files: ["code.ts"] } } }))
    for (const endpoint of ["file", "outline"]) assert.equal((await pinned(endpoint)).status, 409)
    writeFileSync(coverageFile, originalCoverage)
    for (const slice of ["old", "covered", "coverageOnly"]) {
      assert.match(await (await get("file", "code.ts", slice)).text(), /original/)
      const outline = await (await get("outline", "code.ts", slice)).json()
      assert.equal(outline.symbols[0].name, "original")
      assert.equal(outline.symbols[0].line, 2)
      assert.deepEqual(outline.comments.lines, [[1, 1]])
    }
    assert.match(await (await get("file", "code.ts", "newer")).text(), /newer/)
    assert.equal((await (await get("outline", "file0.txt", "old")).json()).supported, false)
    for (let i = 0; i < 33; i++) assert.equal(await (await get("file", `file${i}.txt`, "old")).text(), `recorded ${i}`)
    assert.match(await (await get("file", "code.ts", "old")).text(), /original/)
    assert.match(await (await get("file", "live.ts", "unrecorded")).text(), /live/)
    assert.match(await (await get("file", "live.ts", "legacy")).text(), /live/)
    assert.equal((await (await get("outline", "live.ts", "legacy")).json()).symbols[0].name, "live")
    assert.equal((await get("file", "code.ts", "bad")).status, 404)
    assert.equal((await get("outline", "code.ts", "bad")).status, 404)
    assert.equal((await get("file", "live.ts", "old")).status, 403)
    assert.equal((await get("file", ".env", "secret")).status, 403)
    for (const path of ["../code.ts", "/code.ts", "./code.ts", "bad\u0000path"])
      assert.equal((await get("file", path, "escape")).status, 403)
    assert.equal((await fetch(`${base}/api/outline?slice=old`)).status, 403)
    // A repeated read shares immutable bytes even after a working-copy edit.
    writeFileSync(join(repo, "code.ts"), "export const wrong = 2\n")
    assert.match(await (await get("file", "code.ts", "old")).text(), /original/)
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }) }
})
