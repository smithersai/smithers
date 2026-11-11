import { Effect } from "effect"
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "vitest"
import { GitProxy } from "../src/index.ts"

const execute = promisify(execFile)

test("a real git clone then fetch negotiates gzip after 100 commits through a scoped proxy", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-proxy-"))
  const repository = join(root, "remote")
  const guest = join(root, "guest")
  const git = async (cwd: string, ...args: Array<string>) =>
    (await execute("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd })).stdout
      .trim()
  const requests: Array<{ encoding: string | undefined; status: number }> = []
  const failures: Array<unknown> = []
  const server = createServer(async (req, res) => {
    try {
      const chunks: Array<Buffer> = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      if (req.url!.startsWith("/upstream")) {
        const discovery = req.method === "GET"
        const pack = await new Promise<Buffer>((resolve, reject) => {
          const child = spawn("git", [
            "upload-pack",
            "--stateless-rpc",
            ...(discovery ? ["--advertise-refs"] : []),
            repository
          ], { env: { ...process.env, GIT_PROTOCOL: String(req.headers["git-protocol"] ?? "") } })
          const output: Array<Buffer> = []
          let errors = ""
          child.stdout.on("data", (chunk: Buffer) => output.push(chunk))
          child.stderr.on("data", (chunk: Buffer) => {
            errors += String(chunk)
          })
          child.on("error", reject)
          child.on("close", (code) => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(errors)))
          child.stdin.end(body)
        })
        res.writeHead(200, {
          "content-type": `application/x-git-upload-pack-${discovery ? "advertisement" : "result"}`
        })
        res.end(discovery ? Buffer.concat([Buffer.from("001e# service=git-upload-pack\n0000"), pack]) : pack)
        return
      }
      const request = new Request(`${origin}${req.url}`, {
        method: req.method!,
        headers: req.headers as Record<string, string>,
        ...(req.method === "POST" ? { body } : {})
      })
      const { response, context } = await Effect.runPromise(
        Effect.all({
          response: GitProxy.uploadPack(HttpServerRequest.fromWeb(request), { url: `${origin}/upstream` }, "main"),
          context: Effect.context<never>()
        }).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const web = HttpServerResponse.toWeb(response, { context })
      if (req.method === "POST") {
        requests.push({ encoding: req.headers["content-encoding"], status: web.status })
      }
      res.writeHead(web.status, Object.fromEntries(web.headers))
      res.end(Buffer.from(await web.arrayBuffer()))
    } catch (error) {
      failures.push(error)
      res.writeHead(500)
      res.end()
    }
  })
  let origin = ""
  try {
    await mkdir(repository)
    await git(repository, "init", "-q", "-b", "main")
    for (let index = 0; index < 100; index++) {
      await git(repository, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", `commit ${index}`)
    }
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await git(root, "clone", "-q", `${origin}/proxy`, guest)
    expect(await git(guest, "rev-list", "--count", "HEAD")).toBe("100")
    await git(repository, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "new upstream commit")
    const tip = await git(repository, "rev-parse", "HEAD")
    await git(guest, "fetch", "origin")
    expect(await git(guest, "rev-parse", "origin/main")).toBe(tip)
    expect(await git(guest, "rev-list", "--count", "origin/main")).toBe("101")
    expect(requests.some((request) => request.encoding === "gzip")).toBe(true)
    expect(requests.every((request) => request.status === 200)).toBe(true)
    expect(failures).toEqual([])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
