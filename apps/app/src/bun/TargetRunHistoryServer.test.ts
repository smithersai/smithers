import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { RunHistoryResponseSchema, RunReplayResponseSchema } from "@smthrs/rpc/TargetGraph"
import { startLocalServer } from "./server"

test("journal append failures reach HTTP history, the host log and server shutdown", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-server-"))
  const logs: Array<string> = []
  await writeFile(join(repo, "index.html"), "fixture")
  await writeFile(join(repo, "WORKSPACE.ts"), "export default {}")
  await writeFile(join(repo, "PACKAGE.ts"), "export default {}")
  const cli = join(repo, "cli.ts")
  // Fail real appends inside this fixture's repository as the CLI exits.
  await writeFile(cli, `
    import { readdir, rename, mkdir } from "node:fs/promises"
    import { join } from "node:path"
    const dir = join(process.cwd(), ".flows", "ui", "runs")
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".jsonl")) continue
      const path = join(dir, name)
      await rename(path, path + ".saved")
      await mkdir(path)
    }
    console.log("unpersisted output")
  `)
  const server = await startLocalServer({
    port: 0, distDir: repo, home: repo, stateDir: join(repo, "state"),
    chatStub: true, allowManualRepositoryPaths: true,
    node: { path: process.execPath, version: "v22.19.0" },
    buildCli: cli, harnesses: async () => [], log: (line) => logs.push(line)
  })
  const post = async (path: string, body: unknown) => {
    const response = await fetch(server.origin + path, {
      method: "POST",
      headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: server.sessionToken },
      body: JSON.stringify(body)
    })
    expect(response.status).toBe(200)
    return response.json()
  }
  try {
    const { repo: opened } = await post("/api/repo/open", { path: repo }) as { repo: { id: string } }
    const { runId } = await post("/api/targets/run", { repoId: opened.id, verb: "ci", pattern: "//..." }) as { runId: string }
    let replay
    const deadline = Date.now() + 5_000
    do {
      replay = RunReplayResponseSchema.parse(await post("/api/targets/runs/replay", { runId }))
      if (replay.run.journal !== undefined) break
      await Bun.sleep(10)
    } while (Date.now() < deadline)
    expect(replay.run.journal).toMatchObject({ state: "degraded", error: expect.stringContaining("EISDIR") })
    expect(replay.events.some((event) => event.type === "exit")).toBe(false)
    const listed = RunHistoryResponseSchema.parse(await post("/api/targets/runs", { repoId: opened.id }))
    expect(listed.runs[0]?.journal).toEqual(replay.run.journal)
    expect(logs.filter((line) => line.includes("journal append failed"))).toHaveLength(1)
    const stopping = server.stop()
    expect(server.stop()).toBe(stopping)
    const error = await stopping.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]?.message).toContain("Target run journal append failed")
    await expect(fetch(server.origin + "/api/health")).rejects.toThrow()
  } finally {
    await server.stop().catch(() => {})
    await rm(repo, { recursive: true, force: true })
  }
}, 10_000)
