// How a branch's machine checks its branch out (worker/branch/Checkout.ts), run for real against a local git
// repository in a scratch directory: the script clones once, keeps a checkout, and starts over after a broken one.
import { GitProxy } from "@smthrs/effect-code-storage"
import { Effect } from "effect"
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { WORKSPACE } from "../../src/features/terminal/contract.ts"
import { CHECKOUT_FAILURES, checkoutArgv, checkoutForgeLogFields, checkoutForgeSpanAttributes, classifyCheckoutTransport, createCheckoutForgeTracker, DEPTH, forgeRemote } from "./Checkout.ts"

const root = mkdtempSync(join(tmpdir(), "checkout-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" })

/** A repository with `main` and `feature/x`, each with its own file. */
const remote = (() => {
  const dir = join(root, "remote")
  mkdirSync(dir)
  git(dir, "init", "-q", "-b", "main")
  writeFileSync(join(dir, "README.md"), "main\n")
  git(dir, "add", ".")
  git(dir, "commit", "-q", "-m", "first")
  git(dir, "checkout", "-q", "-b", "feature/x")
  writeFileSync(join(dir, "feature.txt"), "x\n")
  git(dir, "add", ".")
  git(dir, "commit", "-q", "-m", "feature")
  git(dir, "checkout", "-q", "main")
  return `file://${dir}`
})()

/** Runs the checkout with /workspace replaced by `workspace`, as the machine's shell would. */
const checkout = (workspace: string, branch: string, from = remote, namespace: "default" | "ephemeral" = "default") => {
  const [shell, flag, script, name, ...args] = checkoutArgv(branch, from, namespace)
  return execFileSync(shell!, [flag!, script!.replaceAll(WORKSPACE, workspace), name!, ...args], { encoding: "utf8" })
}

/** The checkout's exit code, or 0. */
const exitOf = (run: () => unknown) => {
  try {
    run()
    return 0
  } catch (error) {
    return (error as { readonly status: number }).status
  }
}

describe("checkoutArgv failures", () => {
  test("say where the checkout broke: a forge that doesn't answer, a branch it lacks, a branch whose name only starts alike", () => {
    const workspace = join(root, "failures")
    mkdirSync(workspace)
    expect(exitOf(() => checkout(workspace, "main", `file://${join(root, "no-such-forge")}`))).toBe(70)
    expect(exitOf(() => checkout(workspace, "no-such-branch"))).toBe(71)
    // `feature/x` is there; `feature` alone, a prefix of it, isn't.
    expect(exitOf(() => checkout(workspace, "feature"))).toBe(71)
    expect(CHECKOUT_FAILURES).toEqual({ 70: "forge", 71: "branch", 72: "clone", 73: "clone", 74: "clone", 75: "clone", 76: "clone" })
    // Nothing was cloned.
    expect(exitOf(() => git(workspace, "rev-parse", "HEAD"))).not.toBe(0)
  })
})

describe("checkoutArgv", () => {
  test("clones the one branch into an empty workspace, shallow", () => {
    const workspace = join(root, "a")
    mkdirSync(workspace)
    checkout(workspace, "feature/x")
    expect(git(workspace, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feature/x")
    expect(readFileSync(join(workspace, "feature.txt"), "utf8")).toBe("x\n")
    expect(git(workspace, "branch", "-r").trim()).toBe("origin/feature/x")
    expect(Number(git(workspace, "rev-list", "--count", "HEAD").trim())).toBeLessThanOrEqual(DEPTH)
  })

  test("ephemeral checkout retains complete history beyond the ordinary depth limit", () => {
    const dir = join(root, "history")
    mkdirSync(dir)
    git(dir, "init", "-q", "-b", "main")
    for (let n = 0; n <= DEPTH; n++) {
      writeFileSync(join(dir, "history"), String(n))
      git(dir, "add", ".")
      git(dir, "commit", "-q", "-m", `commit ${n}`)
    }
    for (const namespace of ["default", "ephemeral"] as const) {
      const workspace = join(root, namespace)
      mkdirSync(workspace)
      checkout(workspace, "main", `file://${dir}`, namespace)
      expect(git(workspace, "rev-parse", "--is-shallow-repository").trim()).toBe(String(namespace === "default"))
      expect(Number(git(workspace, "rev-list", "--count", "HEAD").trim())).toBe(namespace === "default" ? DEPTH : DEPTH + 1)
    }
  })

  test("keeps a checkout that is there: nothing in it changes", () => {
    const workspace = join(root, "b")
    mkdirSync(workspace)
    checkout(workspace, "main")
    writeFileSync(join(workspace, "work.txt"), "mine\n")
    checkout(workspace, "main")
    expect(readFileSync(join(workspace, "work.txt"), "utf8")).toBe("mine\n")
  })

  test("preserves files when a broken checkout cannot resolve HEAD", () => {
    const workspace = join(root, "c")
    mkdirSync(join(workspace, ".git"), { recursive: true })
    writeFileSync(join(workspace, "partial"), "")
    expect(() => checkout(workspace, "main")).toThrow()
    expect(readFileSync(join(workspace, "partial"), "utf8")).toBe("")
  })

  test("fails on a branch the remote doesn't have, and the branch is an argument, never script", () => {
    const workspace = join(root, "d")
    mkdirSync(workspace)
    expect(() => checkout(workspace, "nope; touch pwned")).toThrow()
    expect(() => readFileSync("pwned")).toThrow()
    expect(checkoutArgv("main", "r")[3]).toBe("checkout")
  })
})

describe("checkoutArgv for a CI job", () => {
  test("checks out one commit by its id, detached, with no branch: a commit only a branch reaches, never the default", () => {
    const workspace = join(root, "job")
    mkdirSync(workspace)
    const feature = git(remote.slice("file://".length), "rev-parse", "feature/x").trim()
    checkout(workspace, feature)
    expect(git(workspace, "rev-parse", "HEAD").trim()).toBe(feature)
    expect(readFileSync(join(workspace, "feature.txt"), "utf8")).toBe("x\n")
    expect(exitOf(() => git(workspace, "symbolic-ref", "-q", "HEAD"))).not.toBe(0)
    // Shallow: the one commit.
    expect(git(workspace, "rev-list", "--count", "HEAD").trim()).toBe("1")
  })

  test("moves an image's checkout of another commit to the job's commit, keeping untracked node_modules; once there, keeps it", () => {
    const workspace = join(root, "job-image")
    mkdirSync(workspace)
    const main = git(remote.slice("file://".length), "rev-parse", "main").trim()
    const feature = git(remote.slice("file://".length), "rev-parse", "feature/x").trim()
    checkout(workspace, main)
    mkdirSync(join(workspace, "node_modules"))
    writeFileSync(join(workspace, "node_modules", "kept.txt"), "kept\n")
    checkout(workspace, feature)
    expect(git(workspace, "rev-parse", "HEAD").trim()).toBe(feature)
    expect(readFileSync(join(workspace, "feature.txt"), "utf8")).toBe("x\n")
    expect(readFileSync(join(workspace, "node_modules", "kept.txt"), "utf8")).toBe("kept\n")
    // At the commit already: nothing is fetched, even from a forge that no longer answers.
    checkout(workspace, feature, "file:///nowhere/at/all")
    expect(git(workspace, "rev-parse", "HEAD").trim()).toBe(feature)
  })

  test("finishes a checkout a stopped machine left half done: a repository with its origin and no HEAD", () => {
    const workspace = join(root, "job-resumed")
    mkdirSync(workspace)
    git(workspace, "init", "-q")
    git(workspace, "remote", "add", "origin", remote)
    const feature = git(remote.slice("file://".length), "rev-parse", "feature/x").trim()
    checkout(workspace, feature)
    expect(git(workspace, "rev-parse", "HEAD").trim()).toBe(feature)
  })

  test("identifies initialization when a file already occupies the workspace path", () => {
    const workspace = join(root, "workspace-file")
    writeFileSync(workspace, "occupied")
    expect(exitOf(() => checkout(workspace, "0".repeat(40)))).toBe(73)
    expect(readFileSync(workspace, "utf8")).toBe("occupied")
  })

  test("identifies conflicting origin URLs when the target commit changes", () => {
    const workspace = join(root, "conflicting-origin")
    mkdirSync(workspace)
    git(workspace, "init", "-q")
    git(workspace, "remote", "add", "origin", remote)
    git(workspace, "config", "--add", "remote.origin.url", "file:///other")
    expect(exitOf(() => checkout(workspace, "0".repeat(40)))).toBe(74)
  })

  test("identifies an index lock that prevents writing the fetched revision", () => {
    const workspace = join(root, "locked-index")
    mkdirSync(workspace)
    git(workspace, "init", "-q")
    writeFileSync(join(workspace, ".git/index.lock"), "held")
    const main = git(remote.slice("file://".length), "rev-parse", "main").trim()
    expect(exitOf(() => checkout(workspace, main))).toBe(76)
    expect(readFileSync(join(workspace, ".git/index.lock"), "utf8")).toBe("held")
  })

  test("identifies the fetch (75) for a commit the forge doesn't have, and leaves nothing checked out", () => {
    const workspace = join(root, "job-missing")
    mkdirSync(workspace)
    expect(exitOf(() => checkout(workspace, "0".repeat(40)))).toBe(75)
    expect(exitOf(() => git(workspace, "rev-parse", "--verify", "-q", "HEAD"))).not.toBe(0)
  })
})

describe("forgeRemote", () => {
  test("names the forge proxy's host and the repository, escaped, never a credential", () => {
    expect(forgeRemote("octocat", "Spoon-Knife")).toBe("http://forge.smithers.internal/octocat/Spoon-Knife")
    expect(forgeRemote("o", "a b")).toBe("http://forge.smithers.internal/o/a%20b")
  })
})


test("the real git client checks out an ephemeral branch through the scoped SDK proxy", async () => {
  const dir = remote.slice("file://".length)
  const execute = (command: string, args: string[], input?: Uint8Array, protocol?: string) => new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...(protocol ? { GIT_PROTOCOL: protocol } : {}) } })
    const chunks: Buffer[] = []
    let errors = ""
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => { errors += String(chunk) })
    child.on("error", reject)
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(errors)))
    child.stdin.end(input)
  })
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      if (req.url!.startsWith("/upstream")) {
        const discovery = req.method === "GET"
        const pack = await execute("git", ["upload-pack", "--stateless-rpc", ...(discovery ? ["--advertise-refs"] : []), dir], body, req.headers["git-protocol"] as string | undefined)
        res.writeHead(200, { "content-type": `application/x-git-upload-pack-${discovery ? "advertisement" : "result"}` })
        res.end(discovery ? Buffer.concat([Buffer.from("001e# service=git-upload-pack\n0000"), pack]) : pack)
        return
      }
      const request = new Request(`${origin}${req.url}`, {
        method: req.method, headers: req.headers as Record<string, string>,
        ...(req.method === "POST" ? { body } : {}),
      })
      const { response, context } = await Effect.runPromise(Effect.all({
        response: GitProxy.uploadPack(HttpServerRequest.fromWeb(request), { url: `${origin}/upstream` }, "feature/x"),
        context: Effect.context<never>(),
      }).pipe(Effect.provide(FetchHttpClient.layer)))
      const web = HttpServerResponse.toWeb(response, { context })
      res.writeHead(web.status, Object.fromEntries(web.headers))
      res.end(Buffer.from(await web.arrayBuffer()))
    } catch (error) {
      res.writeHead(500)
      res.end(String(error))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const workspace = join(root, "scoped")
    mkdirSync(workspace)
    const [shell, flag, script, name, ...args] = checkoutArgv("feature/x", `${origin}/proxy`, "ephemeral")
    await execute(shell!, [flag!, script!.replaceAll(WORKSPACE, workspace), name!, ...args])
    expect(readFileSync(join(workspace, "feature.txt"), "utf8")).toBe("x\n")
    expect(git(workspace, "rev-parse", "--is-shallow-repository").trim()).toBe("false")
    expect(git(workspace, "for-each-ref", "--format=%(refname)", "refs/remotes").trim().split("\n")).toEqual(["refs/remotes/origin/HEAD", "refs/remotes/origin/feature/x"])
    expect(git(workspace, "rev-list", "--count", "HEAD").trim()).toBe("2")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

/** Runs the real checkout script asynchronously and returns both exit code and captured stderr. */
const runCheckoutCapture = (workspace: string, branch: string, from: string, namespace: "default" | "ephemeral" = "default") =>
  new Promise<{ readonly exitCode: number; readonly stderr: string }>((resolve, reject) => {
    const [shell, flag, script, name, ...args] = checkoutArgv(branch, from, namespace)
    const child = spawn(shell!, [flag!, script!.replaceAll(WORKSPACE, workspace), name!, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8") })
    child.on("error", reject)
    child.on("close", (code) => resolve({ exitCode: code ?? 137, stderr }))
  })

describe("real git transport failure classification", () => {
  test("discriminates HTTP statuses on info/refs and upload-pack, mid-stream drops, missing objects, DNS, local storage and branch absence", async () => {
    const dir = remote.slice("file://".length)
    const mainSha = git(dir, "rev-parse", "main").trim()
    const runGitUploadPack = (args: ReadonlyArray<string>, input: Buffer, protocol?: string) =>
      new Promise<Buffer>((resolve, reject) => {
        const child = spawn("git", ["upload-pack", "--stateless-rpc", ...args, dir], {
          env: { ...process.env, ...(protocol ? { GIT_PROTOCOL: protocol } : {}) },
        })
        const chunks: Buffer[] = []
        let errors = ""
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
        child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8") })
        child.on("error", reject)
        // Like git-http-backend, upload-pack emits pkt-line ERR responses on stdout even when exiting non-zero.
        child.on("close", (code) => {
          const output = Buffer.concat(chunks)
          if (code === 0 || output.length > 0) resolve(output)
          else reject(new Error(errors))
        })
        child.stdin.end(input)
      })

    let mode:
      | { readonly kind: "refs-status"; readonly status: number }
      | { readonly kind: "pack-status"; readonly status: number }
      | { readonly kind: "pack-drop" }
      | { readonly kind: "real" } = { kind: "real" }

    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      if (req.method === "GET" && req.url?.includes("/info/refs")) {
        if (mode.kind === "refs-status") {
          res.writeHead(mode.status, { "content-type": "text/plain" })
          res.end(`upstream status ${mode.status}`)
          return
        }
        const pack = await runGitUploadPack(["--advertise-refs"], body, req.headers["git-protocol"] as string | undefined)
        res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" })
        res.end(Buffer.concat([Buffer.from("001e# service=git-upload-pack\n0000"), pack]))
        return
      }
      if (req.method === "POST" && req.url?.includes("/git-upload-pack")) {
        if (mode.kind === "pack-status") {
          res.writeHead(mode.status, { "content-type": "text/plain" })
          res.end(`upload-pack status ${mode.status}`)
          return
        }
        if (mode.kind === "pack-drop") {
          res.writeHead(200, { "content-type": "application/x-git-upload-pack-result", "content-length": "4096" })
          res.write("0008NAK\n")
          res.destroy()
          return
        }
        const pack = await runGitUploadPack([], body, req.headers["git-protocol"] as string | undefined)
        res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" })
        res.end(pack)
        return
      }
      res.writeHead(403)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    let step = 0
    const nextDir = (label: string) => {
      const dirPath = join(root, `transport-${++step}-${label}`)
      mkdirSync(dirPath)
      return dirPath
    }

    try {
      // HTTP statuses on GET /info/refs during pinned fetch (75).
      for (const status of [401, 403, 404, 429, 500, 502, 503, 504] as const) {
        mode = { kind: "refs-status", status }
        const ran = await runCheckoutCapture(nextDir(`refs-${status}`), mainSha, `${origin}/evmts/tevm`)
        expect(ran.exitCode).toBe(75)
        expect(classifyCheckoutTransport(ran.exitCode, ran.stderr)).toEqual({
          checkoutTransportCause: "http_status",
          checkoutHttpStatus: status,
        })
      }

      // HTTP statuses on POST /git-upload-pack after a clean GET /info/refs (75).
      for (const status of [403, 429, 502, 503] as const) {
        mode = { kind: "pack-status", status }
        const ran = await runCheckoutCapture(nextDir(`pack-${status}`), mainSha, `${origin}/evmts/tevm`)
        expect(ran.exitCode).toBe(75)
        expect(classifyCheckoutTransport(ran.exitCode, ran.stderr)).toEqual({
          checkoutTransportCause: "http_status",
          checkoutHttpStatus: status,
        })
      }

      // Abrupt connection drop mid-pack -> interrupted.
      mode = { kind: "pack-drop" }
      const dropped = await runCheckoutCapture(nextDir("drop"), mainSha, `${origin}/evmts/tevm`)
      expect(dropped.exitCode).toBe(75)
      expect(classifyCheckoutTransport(dropped.exitCode, dropped.stderr)).toEqual({
        checkoutTransportCause: "interrupted",
      })

      // Missing commit SHA against a real smart-HTTP git server -> missing_object.
      mode = { kind: "real" }
      const missing = await runCheckoutCapture(nextDir("missing"), "0".repeat(40), `${origin}/evmts/tevm`)
      expect(missing.exitCode).toBe(75)
      expect(classifyCheckoutTransport(missing.exitCode, missing.stderr)).toEqual({
        checkoutTransportCause: "missing_object",
      })

      // Branch ls-remote failure (70) preserves HTTP status cause; absent branch (71) carries no transport cause.
      mode = { kind: "refs-status", status: 502 }
      const forge502 = await runCheckoutCapture(nextDir("forge-502"), "main", `${origin}/evmts/tevm`)
      expect(forge502.exitCode).toBe(70)
      expect(classifyCheckoutTransport(forge502.exitCode, forge502.stderr)).toEqual({
        checkoutTransportCause: "http_status",
        checkoutHttpStatus: 502,
      })

      mode = { kind: "real" }
      const absentBranch = await runCheckoutCapture(nextDir("absent-branch"), "no-such-branch", `${origin}/evmts/tevm`)
      expect(absentBranch.exitCode).toBe(71)
      expect(classifyCheckoutTransport(absentBranch.exitCode, absentBranch.stderr)).toEqual({})

      // Local storage error: locked index during worktree checkout (76) -> pack_storage.
      const locked = nextDir("locked")
      git(locked, "init", "-q")
      writeFileSync(join(locked, ".git/index.lock"), "held")
      const lockedRun = await runCheckoutCapture(locked, mainSha, `${origin}/evmts/tevm`)
      expect(lockedRun.exitCode).toBe(76)
      expect(classifyCheckoutTransport(lockedRun.exitCode, lockedRun.stderr)).toEqual({
        checkoutTransportCause: "pack_storage",
      })

      // DNS failure against RFC 6761 .invalid hostname -> dns.
      const dnsRun = await runCheckoutCapture(nextDir("dns"), mainSha, "http://nonexistent.invalid/evmts/tevm")
      expect(dnsRun.exitCode).toBe(75)
      expect(classifyCheckoutTransport(dnsRun.exitCode, dnsRun.stderr)).toEqual({
        checkoutTransportCause: "dns",
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    // Closed localhost port -> interrupted (connection refused).
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
    const closedPort = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const refused = await runCheckoutCapture(nextDir("refused"), mainSha, `http://127.0.0.1:${closedPort}/evmts/tevm`)
    expect(refused.exitCode).toBe(75)
    expect(classifyCheckoutTransport(refused.exitCode, refused.stderr)).toEqual({
      checkoutTransportCause: "interrupted",
    })
  }, 30_000)

  test("classifyCheckoutTransport enforces precedence, ignores spoofed remote sidebands, distinguishes unknown, and never echoes stderr", () => {
    const secret = "tok_secret_customer_token_sentinel"
    const cases: ReadonlyArray<readonly [number, string, ReturnType<typeof classifyCheckoutTransport>]> = [
      // Local storage wins over downstream pack/EOF symptoms.
      [75, `fatal: write error: No space left on device (${secret})\nfatal: early EOF\nfatal: index-pack failed`, { checkoutTransportCause: "pack_storage" }],
      // Explicit HTTP status wins over trailing remote hangup.
      [75, `error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502\nfatal: the remote end hung up unexpectedly`, { checkoutTransportCause: "http_status", checkoutHttpStatus: 502 }],
      // DNS timeout classifies as dns rather than generic timeout.
      [75, `fatal: unable to access 'http://forge.smithers.internal/${secret}': Resolving timed out after 3000 milliseconds`, { checkoutTransportCause: "dns" }],
      // Signal sentinel or OOM-killed git child classifies as interrupted even with invalid index-pack output.
      [75, `smithers-checkout-signal:137\n`, { checkoutTransportCause: "interrupted" }],
      [75, `error: index-pack died of signal 9\nfatal: fetch-pack: invalid index-pack output`, { checkoutTransportCause: "interrupted" }],
      [137, ``, { checkoutTransportCause: "interrupted" }],
      // Corrupt pack without stream drop or signal classifies as pack_storage.
      [75, `fatal: pack has bad object at offset 42: inflate returned -3\nfatal: index-pack failed`, { checkoutTransportCause: "pack_storage" }],
      // Unadvertised commit object classifies as missing_object.
      [75, `error: Server does not allow request for unadvertised object c2a8c83dee3f40ca0f5d15ffb2ccabad6dcd0129`, { checkoutTransportCause: "missing_object" }],
      // Spoofed remote sideband cannot masquerade as HTTP 502; real local error wins or falls back to unknown.
      [75, `remote: The requested URL returned error: 502\nfatal: remote error: upload-pack: not our ref 0000000000000000000000000000000000000000`, { checkoutTransportCause: "missing_object" }],
      [75, `remote: The requested URL returned error: 502\nremote: Could not resolve host: ${secret}`, { checkoutTransportCause: "unknown" }],
      // Unknown is explicitly returned on unclassified non-71 failures, distinct from omitted historical records.
      [75, `fatal: unexpected opaque failure involving ${secret}`, { checkoutTransportCause: "unknown" }],
      [75, ``, { checkoutTransportCause: "unknown" }],
      [71, ``, {}],
    ]
    for (const [exitCode, stderr, expected] of cases) {
      const classified = classifyCheckoutTransport(exitCode, stderr)
      expect(classified).toEqual(expected)
      expect(JSON.stringify(classified)).not.toContain(secret)
    }
  })
})

describe("createCheckoutForgeTracker", () => {
  test("tracks unreached, host_mismatch, no_branch, unscoped, failed, and per-stage reached receipts without clobbering stages", () => {
    expect(createCheckoutForgeTracker().snapshot()).toEqual({ routing: "unreached" })

    const mismatch = createCheckoutForgeTracker()
    mismatch.onHostMismatch()
    expect(mismatch.snapshot()).toEqual({ routing: "host_mismatch" })

    const noBranch = createCheckoutForgeTracker()
    noBranch.onHostMismatch()
    noBranch.onNoBranch()
    expect(noBranch.snapshot()).toEqual({ routing: "no_branch" })

    const unscoped = createCheckoutForgeTracker()
    unscoped.onUnscoped(403)
    expect(unscoped.snapshot()).toEqual({
      routing: "unscoped",
      refused: { source: "proxy", status: 403, outcome: "refused" },
    })

    const failed = createCheckoutForgeTracker()
    failed.onFailed()
    expect(failed.snapshot()).toEqual({ routing: "failed" })

    // info-refs 404 followed by a refused dumb-HTTP fallback keeps both stages distinct.
    const refs404 = createCheckoutForgeTracker()
    refs404.onResponse("github", { service: "info-refs", source: "upstream", outcome: "4xx", status: 404 })
    refs404.onResponse("github", { service: "refused", source: "proxy", outcome: "refused", status: 403 })
    refs404.onHostMismatch()
    refs404.onFailed()
    expect(refs404.snapshot()).toEqual({
      routing: "reached",
      upstream: "github",
      infoRefs: { source: "upstream", status: 404, outcome: "4xx" },
      refused: { source: "proxy", status: 403, outcome: "refused" },
    })

    // info-refs 200 followed by upload-pack 404 records both stages.
    const pack404 = createCheckoutForgeTracker()
    pack404.onResponse("github", { service: "info-refs", source: "upstream", outcome: "ok", status: 200 })
    pack404.onResponse("github", { service: "upload-pack", source: "upstream", outcome: "4xx", status: 404 })
    // Out-of-range status is ignored; unknown outcome normalizes to status class.
    pack404.onResponse("deployment", { service: "refused", source: "proxy", outcome: "custom_unlisted", status: 502 })
    pack404.onResponse("deployment", { service: "upload-pack", source: "upstream", outcome: "4xx", status: 999 })
    const snap = pack404.snapshot()
    expect(snap).toEqual({
      routing: "reached",
      upstream: "deployment",
      infoRefs: { source: "upstream", status: 200, outcome: "ok" },
      uploadPack: { source: "upstream", status: 404, outcome: "4xx" },
      refused: { source: "proxy", status: 502, outcome: "5xx" },
    })
    expect(checkoutForgeLogFields(snap)).toEqual({
      forgeRouting: "reached",
      forgeUpstream: "deployment",
      forgeInfoRefsSource: "upstream",
      forgeInfoRefsStatus: 200,
      forgeInfoRefsOutcome: "ok",
      forgeUploadPackSource: "upstream",
      forgeUploadPackStatus: 404,
      forgeUploadPackOutcome: "4xx",
      forgeRefusedSource: "proxy",
      forgeRefusedStatus: 502,
      forgeRefusedOutcome: "5xx",
    })
    expect(checkoutForgeSpanAttributes(snap)).toEqual({
      "ci.checkout.forge.routing": "reached",
      "ci.checkout.forge.upstream": "deployment",
      "ci.checkout.forge.info_refs.source": "upstream",
      "ci.checkout.forge.info_refs.status": 200,
      "ci.checkout.forge.info_refs.outcome": "ok",
      "ci.checkout.forge.upload_pack.source": "upstream",
      "ci.checkout.forge.upload_pack.status": 404,
      "ci.checkout.forge.upload_pack.outcome": "4xx",
      "ci.checkout.forge.refused.source": "proxy",
      "ci.checkout.forge.refused.status": 502,
      "ci.checkout.forge.refused.outcome": "5xx",
    })
  })
})
