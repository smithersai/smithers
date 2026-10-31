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
import { CHECKOUT_FAILURES, checkoutArgv, DEPTH, forgeRemote } from "./Checkout.ts"

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
    expect(CHECKOUT_FAILURES).toEqual({ 70: "forge", 71: "branch", 72: "clone" })
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

  test("fails the clone (72) on a commit the forge doesn't have, and leaves nothing checked out", () => {
    const workspace = join(root, "job-missing")
    mkdirSync(workspace)
    expect(exitOf(() => checkout(workspace, "0".repeat(40)))).toBe(72)
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
