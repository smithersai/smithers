import { createServer } from "node:http"
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises"
import { resolve, join } from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { EXECUTOR_TOKEN_ENV, EXECUTOR_TOKEN_HEADER, executorTokenAuthorized } from "./executorAuth"

// One container is one visitor. It holds no credentials, Kubernetes token,
// persistent volume or other visitor's data. NetworkPolicy denies all egress.
const ROOT = process.env.TUTORIAL_WORKSPACE ?? "/workspace/repo"
const SEED = process.env.TUTORIAL_SEED ?? "/app/snapshot.json"
const PORT = Number(process.env.PORT ?? 3001)
const MAX_BYTES = 128 * 1024
const EDITABLE = new Set(["README.md", "src/hello.ts", "src/hello.test.ts"])
const ALLOWED = new Set(["README.md", "package.json", "src/hello.ts", "src/hello.test.ts", "src/server.ts", ".github/workflows/test.yml"])
let queue: Promise<unknown> = Promise.resolve()
let initialized = false
let baseline = ""

export async function command(args: string[], executable = "git", timeout = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: ROOT, detached: true, env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0"
    }, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = "", exceeded = false
    const stop = () => { try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL") } catch {} }
    const timer = setTimeout(stop, timeout)
    const collect = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (stdout.length + stderr.length + chunk.length > MAX_BYTES) { exceeded = true; stop(); return }
      if (target === "stdout") stdout += chunk.toString(); else stderr += chunk.toString()
    }
    child.stdout.on("data", chunk => collect(chunk, "stdout"))
    child.stderr.on("data", chunk => collect(chunk, "stderr"))
    child.on("error", error => { clearTimeout(timer); reject(error) })
    child.on("close", code => { clearTimeout(timer); stop(); done({ code: code ?? 137, stdout, stderr: stderr + (exceeded ? "\nOutput limit exceeded." : "") }) })
  })
}
async function git(args: string[]) { const result = await command(["-c", "core.hooksPath=/dev/null", ...args]); if (result.code !== 0) throw new Error(result.stderr || "Git operation failed"); return result.stdout.trim() }
async function safeFile(path: string) {
  if (!ALLOWED.has(path)) throw new Error("File is outside the example repository's editable paths")
  let current = ROOT
  for (const segment of path.split("/")) {
    current = join(current, segment)
    const info = await lstat(current).catch(() => undefined)
    if (info?.isSymbolicLink()) throw new Error("Symbolic links are not allowed")
  }
  return resolve(ROOT, path)
}
async function seed() {
  if (initialized) return
  await mkdir(ROOT, { recursive: true })
  const snapshot = JSON.parse(await readFile(SEED, "utf8")) as { files: Record<string, string> }
  for (const [path, content] of Object.entries(snapshot.files)) {
    const target = await safeFile(path); await mkdir(resolve(target, ".."), { recursive: true }); await writeFile(target, content)
  }
  await git(["init", "-b", "main"])
  await git(["config", "user.name", "Smithers tutorial"])
  await git(["config", "user.email", "tutorial@smithers.invalid"])
  await git(["add", "--all"])
  await git(["commit", "-m", "Example repository starting point"])
  baseline = await git(["rev-parse", "HEAD"])
  initialized = true
}
async function files() {
  const result: Record<string, string> = {}
  let bytes = 0
  for (const path of ALLOWED) {
    const target = await safeFile(path)
    const info = await lstat(target).catch(() => undefined)
    if (info === undefined) continue
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Invalid repository file")
    bytes += info.size; if (bytes > MAX_BYTES) throw new Error("Repository output exceeds limit")
    result[path] = await readFile(target, "utf8")
  }
  return result
}
async function act(body: Record<string, unknown>) {
  await seed()
  switch (body.action) {
    case "snapshot": return { files: await files(), base: baseline, head: await git(["rev-parse", "HEAD"]) }
    case "files": return { files: await files() }
    case "apply": {
      if (body.files === null || typeof body.files !== "object" || Array.isArray(body.files)) throw new Error("files must be an object")
      const entries = Object.entries(body.files)
      if (entries.length === 0 || entries.length > ALLOWED.size) throw new Error("Invalid edit count")
      const edits: Array<[string, string]> = []
      let bytes = 0
      for (const [path, content] of entries) {
        if (!EDITABLE.has(path)) throw new Error("Only greeting, tests and README may be edited")
        if (typeof content !== "string" || Buffer.byteLength(content) > 64 * 1024) throw new Error("File content must be text within 64 KiB")
        bytes += Buffer.byteLength(content); if (bytes > MAX_BYTES) throw new Error("Edits exceed limit")
        edits.push([await safeFile(path), content])
      }
      for (const [path, content] of edits) await writeFile(path, content)
      return { files: await files() }
    }
    case "test": {
      const args = ["--permission", "--allow-fs-read=*", "--experimental-test-isolation=none", "--test", "--test-reporter=tap", "/app/regression.mjs", "src/hello.test.ts"]
      const result = await command(args, "node", 20_000)
      const required = ["missing name receives world", "empty name receives world", "provided name is preserved"]
      const allRecorded = required.every(name => result.stdout.split("\n").some(line => /^ok \d+ - /.test(line) && line.includes(name)))
      if (result.code === 0 && !allRecorded) return { ...result, code: 1, stderr: result.stderr + "\nThe protected regression checks did not all complete.", command: `node ${args.join(" ")}` }
      return { ...result, command: `node ${args.join(" ")}` }
    }
    case "commit": {
      if (typeof body.message !== "string" || body.message.length < 1 || body.message.length > 300 || body.message.includes("\0")) throw new Error("Invalid commit message")
      if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 8 || body.idempotencyKey.length > 256)) throw new Error("Invalid commit key")
      const marker = typeof body.idempotencyKey === "string" ? `Tutorial-Run: ${createHash("sha256").update(body.idempotencyKey).digest("hex")}` : undefined
      if (marker !== undefined) {
        const previous = await git(["log", "--all", "--format=%H", "--fixed-strings", `--grep=${marker}`, "--max-count=1"])
        if (previous !== "") return { sha: previous, subject: await git(["show", "-s", "--format=%s", previous]), parent: await git(["show", "-s", "--format=%P", previous]) }
      }
      // Add only named example files; model/test-created hooks and other paths
      // cannot enter a commit through this API.
      await git(["add", "--", ...ALLOWED])
      await git(["commit", "-m", body.message, ...(marker === undefined ? [] : ["-m", marker])])
      return { sha: await git(["rev-parse", "HEAD"]), subject: body.message, parent: await git(["show", "-s", "--format=%P", "HEAD"]) }
    }
    case "diff": {
      const base = body.base ?? baseline
      if (typeof base !== "string" || !/^[a-f0-9]{40}$/.test(base)) throw new Error("Invalid diff base")
      await git(["cat-file", "-e", `${base}^{commit}`])
      return { base, head: await git(["rev-parse", "HEAD"]), patch: await git(["diff", "--no-ext-diff", "--no-textconv", base, "--", ...ALLOWED]) }
    }
    default: throw new Error("Unknown executor action")
  }
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") { response.writeHead(200); response.end("ok"); return }
  if (request.method !== "POST" || request.url !== "/execute") { response.writeHead(404); response.end(); return }
  // The coordinator's per-session token, when the pod was launched with one.
  // /health stays open: the kubelet readiness probe carries no credentials.
  if (!executorTokenAuthorized(request.headers[EXECUTOR_TOKEN_HEADER], process.env[EXECUTOR_TOKEN_ENV])) {
    response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" })
    response.end(JSON.stringify({ message: "Executor authentication required" }))
    return
  }
  try {
    let size = 0; const chunks: Buffer[] = []
    for await (const chunk of request) { size += chunk.length; if (size > MAX_BYTES) throw new Error("Request exceeds limit"); chunks.push(chunk) }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid request")
    const result = queue.then(() => act(body as Record<string, unknown>))
    queue = result.catch(() => undefined)
    const value = await result
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value))
  } catch (error) {
    response.writeHead(422, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ message: error instanceof Error ? error.message : "Executor failed" }))
  }
})
server.listen(PORT, "0.0.0.0")
