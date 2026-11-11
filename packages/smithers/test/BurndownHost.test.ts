/**
 * `smthrs flow start` hosts a Burndown over a repository's issues with nothing
 * installed in the project: the pattern, the GitHub client and the flow core
 * all come from the CLI's own installation.
 */
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { processBudget } from "./support/bin.ts"
import { temporaryEnvironment } from "./temporaryEnvironment.ts"

const execute = promisify(execFile)
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const example = fileURLToPath(new URL("../examples/burn-down-issues.ts", import.meta.url))
const guide = fileURLToPath(new URL("../docs/guides/burn-down-issues.md", import.meta.url))

interface Row {
  readonly id: string
  readonly status: string
  readonly detail: string
}

describe("a Burndown hosted by smthrs flow start", processBudget, () => {
  let root: string
  let github: Server
  let requests: Array<string>
  /** What the repository `acme/app` lists; any other repository is unknown. */
  let listed: Array<Record<string, unknown>>

  beforeEach(async () => {
    requests = []
    listed = []
    github = createServer((request, response) => {
      requests.push(request.url ?? "")
      const known = (request.url ?? "").startsWith("/repos/acme/app/issues?")
      response.writeHead(known ? 200 : 404, { "content-type": "application/json" })
      response.end(JSON.stringify(known ? listed : { message: "Not Found" }))
    })
    await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve))
    // A repository and one flow file. No package.json and no node_modules.
    root = await realpath(await mkdtemp(join(tmpdir(), "smithers-burndown-host-")))
    await mkdir(join(root, ".git"))
    await mkdir(join(root, ".smithers", "flows", "issues"), { recursive: true })
    await cp(example, join(root, ".smithers", "flows", "issues", "flow.ts"))
  }, 30_000)

  afterEach(async () => {
    await new Promise((resolve) => github.close(resolve))
    await rm(root, { recursive: true, force: true })
  })

  const smthrs = (args: ReadonlyArray<string>) =>
    execute(process.execPath, ["--no-warnings", "--import", preload, bin, ...args, "--root", root, "--json"], {
      cwd: root,
      env: {
        PATH: process.env["PATH"],
        ...temporaryEnvironment(),
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"],
        SMITHERS_FFI_LIBRARY_PATH: process.env["SMITHERS_FFI_LIBRARY_PATH"],
        SMITHERS_BACKEND: "sqlite",
        SMITHERS_GITHUB_API_BASE_URL: `http://127.0.0.1:${(github.address() as AddressInfo).port}`,
        SMITHERS_GITHUB_TOKEN: ""
      },
      timeout: 200_000
    }).then(
      (result) => ({ ...result, code: 0 as number | string }),
      (error: { stdout: string; stderr: string; code: number | string }) => error
    )

  const burnDown = (data: unknown) => smthrs(["flow", "start", "issues", "--data", JSON.stringify(data), "--wait"])

  /** Every durable execution the engine recorded, with the lineage's last result. */
  const recorded = () => {
    const database = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
    try {
      const runs = database.prepare(
        "SELECT run_id AS id, status, json_extract(state_json, '$.flowName') AS flow, " +
          "json_extract(state_json, '$.result.exit.value.rows') AS rows FROM flows_runs ORDER BY created_at_ms, run_id"
      ).all() as unknown as ReadonlyArray<{ id: string; status: string; flow: string; rows: string | null }>
      const rounds = runs.filter((run) => run.flow === "issues/rounds")
      const last = rounds.at(-1)?.rows
      return {
        rounds: rounds.map((run) => run.status),
        work: runs.filter((run) => run.flow === "issues/work").map((run) => `${run.id}: ${run.status}`).sort(),
        rows: (last === null || last === undefined ? [] : JSON.parse(last)) as ReadonlyArray<Row>
      }
    } finally {
      database.close()
    }
  }

  const issue = (number: number, title: string, extra: Record<string, unknown> = {}) => ({ number, title, ...extra })

  it("works each open issue as its own durable child and lands them all, with nothing installed", async () => {
    listed = [
      issue(7, "Crash on empty input"),
      issue(8, "Bump the parser", { pull_request: { url: "https://example.test/pulls/8" } }),
      issue(9, "Slow first paint"),
      ...Array.from({ length: 4 }, (_, index) => issue(20 + index, `Backlog ${index}`))
    ]
    const result = await burnDown({ repo: "acme/app" })
    expect(result.code, result.stdout + result.stderr).toBe(0)
    expect(await readdir(root)).not.toContain("node_modules")
    const { rounds, rows, work } = recorded()
    // Six issues through four slots: two rounds of work, then the round that finds nothing left.
    expect(rounds).toEqual(["completed", "completed", "completed"])
    expect(work).toEqual([
      "issues/20: completed",
      "issues/21: completed",
      "issues/22: completed",
      "issues/23: completed",
      "issues/7: completed",
      "issues/9: completed"
    ])
    expect(rows.map(({ id, status }) => `${id}: ${status}`).sort()).toEqual([
      "20: landed",
      "21: landed",
      "22: landed",
      "23: landed",
      "7: landed",
      "9: landed"
    ])
    expect(rows.find((row) => row.id === "7")?.detail).toBe("acme/app#7: Crash on empty input")
    expect(requests.every((url) => url.startsWith("/repos/acme/app/issues?state=open"))).toBe(true)
    expect(requests.some((url) => url.includes("labels="))).toBe(false)
  })

  it("asks GitHub for one label's issues only, and drains at once when there are none", async () => {
    const result = await burnDown({ repo: "acme/app", label: "good first issue" })
    expect(result.code, result.stdout + result.stderr).toBe(0)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.map((url) => new URL(url, "http://github.test").searchParams.get("labels"))).toEqual(
      requests.map(() => "good first issue")
    )
    expect(recorded()).toEqual({ rounds: ["completed"], work: [], rows: [] })
  })

  it("fails the run with GitHub's answer when the repository cannot be listed", async () => {
    const result = await burnDown({ repo: "acme/missing" })
    expect(result.code, result.stdout + result.stderr).not.toBe(0)
    const report = JSON.parse(result.stdout) as { readonly status: string; readonly cause: string }
    expect(report.status).toBe("failed")
    expect(report.cause).toContain("404")
    expect(recorded().work).toEqual([])
  })

  it("is the flow file the guide prints", async () => {
    expect(await readFile(guide, "utf8")).toContain("```ts\n" + await readFile(example, "utf8") + "```")
  })
})
