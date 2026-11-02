// A runner's checkouts share one mirror per repository (src/runner/Workspace.ts). jj and git keep that mirror's
// operations, refs and worktrees in files, and ten `jj workspace add`s at once on one colocated mirror fail some of
// themselves ("Could not commit packed-ref transaction", or git's config lock). A runner with capacity above one starts
// jobs at once, so every command that changes a mirror runs one at a time per mirror.
import { Effect, Exit } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import * as Workspace from "../src/runner/Workspace.ts"
import * as Host from "./fixtures/runner/host.ts"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-workspace-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const limits = { files: 10, bytes: 1024 }

test("ten checkouts of one mirror at once are each made, read and forgotten", async () => {
  const mirror = Host.mirror(root)
  const stateDir = join(root, "state")
  const checkouts = Array.from({ length: 10 }, (_, n) => Workspace.of(stateDir, `job-${n}`))
  const made = await Effect.runPromise(Effect.forEach(
    checkouts,
    (checkout) => Effect.exit(Workspace.create(mirror.path, mirror.base, checkout)),
    { concurrency: "unbounded" }
  ))
  expect(made.map((exit) => Exit.isSuccess(exit) ? "made" : String(exit.cause))).toEqual(checkouts.map(() => "made"))
  checkouts.forEach((checkout, n) => writeFileSync(join(checkout.dir, `file-${n}.txt`), `${n}\n`))
  const read = await Effect.runPromise(Effect.forEach(
    checkouts,
    (checkout) => Workspace.changes(checkout, mirror.base, limits, mirror.path),
    { concurrency: "unbounded" }
  ))
  expect(read.map((changes) => changes?.additions.map((file) => file.path))).toEqual(
    checkouts.map((_, n) => [`file-${n}.txt`])
  )
  await Effect.runPromise(Effect.forEach(checkouts, (checkout) => Workspace.remove(mirror.path, checkout), {
    concurrency: "unbounded"
  }))
  expect(checkouts.filter(Workspace.exists)).toEqual([])
}, 120_000)

// A private repository (decision 0148): the mirror is cloned and fetched over HTTPS with the host's credential, which
// git sends as a header from the command's own environment, never in its arguments or the URL. A real git smart-HTTP
// server on loopback (`git http-backend`) refuses any request without it.
test("a missing mirror is cloned with the job's credential; without it, or with a wrong one, nothing is fetched", async () => {
  const { execFileSync, spawn } = await import("node:child_process")
  const { createServer } = await import("node:http")
  const source = join(root, "source")
  const git = (args: Array<string>, cwd?: string) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root } }).trim()
  git(["init", "-q", "-b", "main", source])
  writeFileSync(join(source, "README.md"), "private\n")
  git(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "--allow-empty", "-m", "base"], source)
  git(["add", "README.md"], source)
  git(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "readme"], source)
  const base = git(["rev-parse", "HEAD"], source)
  git(["clone", "-q", "--bare", source, join(root, "served", "private.git")])
  const secret = "ghs_runner_workspace_secret"
  const expected = `Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`
  const seen: Array<string> = []
  const server = createServer((request, response) => {
    seen.push(request.url ?? "")
    if (request.headers.authorization?.toLowerCase() !== expected.toLowerCase()) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="test"' }).end()
      return
    }
    const url = new URL(request.url ?? "/", "http://localhost")
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: join(root, "served"),
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        REMOTE_USER: "x-access-token"
      }
    })
    request.pipe(cgi.stdin)
    let head = Buffer.alloc(0)
    let started = false
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (started) return void response.write(chunk)
      head = Buffer.concat([head, chunk])
      const end = head.indexOf("\r\n\r\n")
      if (end < 0) return
      started = true
      const headers: Record<string, string> = {}
      let status = 200
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const [name, ...rest] = line.split(":")
        if (name!.toLowerCase() === "status") status = Number(rest.join(":").trim().split(" ")[0])
        else headers[name!] = rest.join(":").trim()
      }
      response.writeHead(status, headers)
      response.write(head.subarray(end + 4))
    })
    cgi.stdout.on("end", () => response.end())
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  try {
    const remote = `http://127.0.0.1:${(server.address() as { port: number }).port}/private.git`
    const stateDir = join(root, "state")
    const missing = (name: string) => join(root, `mirror-${name}`)
    // No credential: a missing mirror is never cloned.
    expect(Exit.isFailure(await Effect.runPromise(Effect.exit(Workspace.create(missing("none"), base, Workspace.of(stateDir, "none")))))).toBe(true)
    // A wrong credential: git is refused.
    const wrong = { remote, username: "x-access-token", password: "wrong" }
    expect(Exit.isFailure(await Effect.runPromise(Effect.exit(Workspace.create(missing("wrong"), base, Workspace.of(stateDir, "wrong"), wrong))))).toBe(true)
    // The job's credential: cloned, checked out at the base.
    const credential = { remote, username: "x-access-token", password: secret }
    const checkout = Workspace.of(stateDir, "right")
    const made = await Effect.runPromise(Effect.exit(Workspace.create(missing("right"), base, checkout, credential)))
    expect(Exit.isSuccess(made) ? "made" : String(made.cause)).toBe("made")
    expect(readFileSync(join(checkout.dir, "README.md"), "utf8")).toBe("private\n")
    expect(seen.every((path) => !path.includes(secret))).toBe(true)
    expect(Workspace.gitAuthEnv(credential)).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${new URL(remote).origin}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: ${expected.replace("Basic", "basic")}`,
      GIT_TERMINAL_PROMPT: "0"
    })
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
  }
}, 120_000)
