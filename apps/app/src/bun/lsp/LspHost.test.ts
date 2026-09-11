import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { LspDiagnosticsMessageSchema, LspDiagnosticsResponseSchema, LspHoverSchema } from "@smthrs/rpc/LocalApp"
import type { NodeSidecar } from "../Node"
import type { ServerLookup } from "./LanguageServers"
import { findNode } from "../Node"
import { ENV_ALLOWLIST } from "../Pty"
import { currentSandboxHost, sandboxEnforced } from "../Sandbox"
import { languageFor, resolveServer, TYPESCRIPT_SERVER } from "./LanguageServers"
import { emptyLookup, writeFixtureProject } from "./LspFixture"
import { createLspHost, defaultServerLookup, LSP_ENV_KEYS, lspChildEnv } from "./LspHost"
import type { LspHost } from "./LspHost"
import { hoverContents, LspRequestError, redactHostPaths, toDiagnostic } from "./LspSession"

/*
 * The host seam against the REAL typescript-language-server over stdio
 * (code-intel PLAN.md §6 "Bun host seam"): a fixture project under a temp dir
 * with a tsconfig, two files and one deliberate type error. The server is
 * resolved the way production resolves it (the harness candidate dirs and
 * PATH — never a directory inside the repository) and runs under the lsp
 * seatbelt policy on macOS. Absent a server or a Node sidecar, the spawning
 * tests skip and say why; nothing stands in for the server.
 */

const node = await findNode()
const lookup = defaultServerLookup()
const resolved = resolveServer(TYPESCRIPT_SERVER, lookup, node)
const skipReason = node === null
  ? "no Node.js >= 22.19 on this machine to run the language server"
  : "missing" in resolved
  ? `no typescript-language-server on this machine (install: ${resolved.missing})`
  : undefined
if (skipReason !== undefined) console.warn(`LspHost seam tests skipped: ${skipReason}`)

let root = ""
let host: LspHost
const frames: Array<unknown> = []
const logs: Array<string> = []
const repoId = "repo-fixture"

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "smithers-lsp-fixture-")))
  await writeFixtureProject(root)
  host = createLspHost({
    publish: (_topic, message) => frames.push(message),
    node: Promise.resolve(node),
    home: tmpdir(),
    sandbox: currentSandboxHost(),
    log: (line) => logs.push(line)
  })
})

afterAll(async () => {
  await host?.killAll()
  await rm(root, { recursive: true, force: true })
})

const session = async (path = "src/index.ts") => {
  const result = await host.session(repoId, root, path)
  if (result.status !== "ok") throw new Error(`expected a session, got ${result.status}`)
  return result.session
}

describe("the registry", () => {
  test("languageFor names TypeScript for its extensions and null otherwise", () => {
    expect(languageFor("src/App.tsx")).toBe("typescript")
    expect(languageFor("lib/index.mjs")).toBe("typescript")
    expect(languageFor("README.md")).toBeNull()
    expect(languageFor("Makefile")).toBeNull()
    expect(TYPESCRIPT_SERVER.documentLanguageId("a.tsx")).toBe("typescriptreact")
    expect(TYPESCRIPT_SERVER.documentLanguageId("a.js")).toBe("javascript")
  })

  test("global fallback discovery works with an empty PATH and home", () => {
    const globalBin = "/opt/homebrew/bin/typescript-language-server"
    const globalLookup: ServerLookup = {
      ...emptyLookup("/fixture/home"),
      isFile: (path) => path === globalBin,
      realpath: () => "/fixture/global/server.mjs"
    }
    expect(resolveServer(TYPESCRIPT_SERVER, globalLookup, { path: "/fixture/node", version: "22.19.0" }))
      .toEqual({ argv: ["/fixture/node", "/fixture/global/server.mjs", "--stdio"] })
  })

  test("a missing binary answers the install line verbatim and spawns nothing", async () => {
    const missing = createLspHost({
      publish: () => {},
      node: Promise.resolve(node),
      home: tmpdir(),
      sandbox: currentSandboxHost(),
      lookup: emptyLookup(tmpdir()),
      log: () => {}
    })
    const result = await missing.session(repoId, root, "src/index.ts")
    expect(result).toEqual({ status: "missing", language: "typescript", install: "npm i -g typescript-language-server typescript" })
    expect(missing.list()).toEqual([])
    await missing.killAll()
  })

  test("a file no server handles is unsupported before any process starts", async () => {
    expect(await host.session(repoId, root, "README.md")).toEqual({ status: "unsupported" })
  })

  /*
   * A repository is data the user opened — often read-only, often someone
   * else's. A `node_modules/.bin/typescript-language-server` inside it is a
   * program the repository chose; a hover must never run it. The binary
   * here is a real executable that would write a proof file if spawned.
   */
  test("a language-server binary inside the repository is never resolved, so opening a repository runs nothing it ships", async () => {
    const trap = await realpath(await mkdtemp(join(tmpdir(), "smithers-lsp-trap-")))
    // Simulate a global install even on machines without one. This must not
    // affect the fixture-owned lookup used to test repository refusal.
    const statSync = fs.statSync
    const globalBin = "/opt/homebrew/bin/typescript-language-server"
    const stat = spyOn(fs, "statSync").mockImplementation(((path, options) =>
      path === globalBin ? { isFile: () => true } : statSync(path, options)
    ) as typeof fs.statSync)
    try {
      await writeFixtureProject(trap)
      const proof = join(trap, "PROOF")
      const bin = join(trap, "node_modules", ".bin")
      await mkdir(bin, { recursive: true })
      await writeFile(join(bin, "typescript-language-server"), `#!/bin/sh\necho owned > "${proof}"\nexec cat\n`)
      await chmod(join(bin, "typescript-language-server"), 0o755)
      // Only fixture-owned paths exist to this lookup. Real global installs
      // cannot turn this repository-executable refusal into a server start.
      const hostOnly: ServerLookup = {
        env: { PATH: "" },
        home: join(trap, "home"),
        listDir: (path) => path === bin ? ["typescript-language-server"] : [],
        isFile: (path) => path === join(bin, "typescript-language-server"),
        realpath: (path) => path
      }
      expect(hostOnly.isFile(globalBin)).toBe(false)
      expect(resolveServer(TYPESCRIPT_SERVER, hostOnly, node)).toEqual({ missing: TYPESCRIPT_SERVER.install })
      const trapped = createLspHost({
        publish: () => {},
        node: Promise.resolve(node),
        home: tmpdir(),
        sandbox: currentSandboxHost(),
        lookup: hostOnly,
        log: () => {}
      })
      expect(await trapped.session("repo-trap", trap, "src/index.ts")).toEqual({ status: "missing", language: "typescript", install: TYPESCRIPT_SERVER.install })
      expect(trapped.list()).toEqual([])
      await trapped.killAll()
      await Bun.sleep(50)
      expect(await Bun.file(proof).exists()).toBe(false)
    } finally {
      stat.mockRestore()
      await rm(trap, { recursive: true, force: true })
    }
  })
})

describe("pending session acquisitions", () => {
  for (const action of ["closeRepo", "killAll"] as const) {
    test(`${action} cancels Node discovery before cleanup resolves and never spawns afterward`, async () => {
      const discovery = Promise.withResolvers<NodeSidecar | null>()
      const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("unexpected spawn") })
      const pendingHost = createLspHost({
        publish: () => {}, node: discovery.promise, home: root,
        sandbox: currentSandboxHost(), log: () => {},
        lookup: { ...emptyLookup(root), isFile: () => true, realpath: () => "/fixture/server.mjs" }
      })
      let outcome: unknown
      const opening = pendingHost.session("pending", root, "a.ts").then(
        (result) => { outcome = result }, (error) => { outcome = error }
      )
      try {
        if (action === "closeRepo") await pendingHost.closeRepo("pending")
        else await pendingHost.killAll()
        const settledAtCleanup = outcome
        discovery.resolve({ path: process.execPath, version: "22.19.0" })
        await opening
        expect(spawn).not.toHaveBeenCalled()
        expect(settledAtCleanup).toBeInstanceOf(LspRequestError)
        expect(outcome).toMatchObject({ code: "language_server_failed", http: 503 })
        expect(pendingHost.list()).toEqual([])
      } finally {
        discovery.resolve(null)
        await opening
        await pendingHost.killAll()
        spawn.mockRestore()
      }
    })
  }

  test("cleanup cancels every queued Node continuation before it can spawn", async () => {
    // Exercise cleanup between discovery, the cancellation race, and the
    // acquisition continuation; checking only inside a wait helper is too early.
    for (const action of ["closeRepo", "killAll"] as const) {
      for (let ticks = 0; ticks < 6; ticks++) {
        const discovery = Promise.withResolvers<NodeSidecar | null>()
        let closing = false
        let lateSpawn = false
        const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
          lateSpawn ||= closing
          throw new Error("spawn intercepted")
        })
        const pendingHost = createLspHost({
          publish: () => {}, node: discovery.promise, home: root,
          sandbox: currentSandboxHost(), log: () => {},
          lookup: { ...emptyLookup(root), isFile: () => true, realpath: () => "/fixture/server.mjs" }
        })
        const opening = pendingHost.session("pending", root, "a.ts").catch((error: unknown) => error)
        try {
          discovery.resolve({ path: process.execPath, version: "22.19.0" })
          for (let tick = 0; tick < ticks; tick++) await Promise.resolve()
          closing = true
          if (action === "closeRepo") await pendingHost.closeRepo("pending")
          else await pendingHost.killAll()
          await opening
          expect(lateSpawn).toBe(false)
        } finally {
          await pendingHost.killAll()
          spawn.mockRestore()
        }
      }
    }
  })

  test("repository close cancels only that repository and allows a fresh acquisition", async () => {
    const discovery = Promise.withResolvers<NodeSidecar | null>()
    const pendingHost = createLspHost({
      publish: () => {}, node: discovery.promise, home: root,
      sandbox: currentSandboxHost(), lookup: emptyLookup(root), log: () => {}
    })
    const closed = pendingHost.session("closed", root, "a.ts").catch((error: unknown) => error)
    const other = pendingHost.session("other", root, "a.ts")
    try {
      await pendingHost.closeRepo("closed")
      discovery.resolve(null)
      expect(await closed).toBeInstanceOf(LspRequestError)
      expect(await other).toMatchObject({ status: "missing" })
      expect(await pendingHost.session("closed", root, "a.ts")).toMatchObject({ status: "missing" })
    } finally {
      discovery.resolve(null)
      await pendingHost.killAll()
    }
  })

  test("host shutdown rejects new acquisitions, including unsupported files", async () => {
    const stopped = createLspHost({
      publish: () => {}, node: Promise.resolve(null), home: root,
      sandbox: currentSandboxHost(), lookup: emptyLookup(root), log: () => {}
    })
    await stopped.killAll()
    for (const path of ["a.ts", "README.md"]) {
      await expect(stopped.session("repo", root, path)).rejects.toMatchObject({
        code: "language_server_failed", http: 503
      })
    }
    await stopped.killAll()
  })
})

describe("the language server's environment", () => {
  test("carries HOME, PATH, scratch, locale and zone — and none of the credentials the PTY allowlist hands a harness", () => {
    const source: Record<string, string> = Object.fromEntries(ENV_ALLOWLIST.map((name) => [name, `value-of-${name}`]))
    source.PATH = "/usr/local/bin:/usr/bin"
    const env = lspChildEnv(source, "/home/person", ["/opt/node/bin"])
    expect(Object.keys(env).sort()).toEqual([...LSP_ENV_KEYS].sort())
    expect(env.HOME).toBe("/home/person")
    expect(env.PATH?.split(":")[0]).toBe("/opt/node/bin")
    expect(env.PATH).toContain("/usr/local/bin")
    for (const name of ENV_ALLOWLIST) {
      if (/API_KEY|SSH_AUTH_SOCK|CONFIG_DIR|_HOME$|_DIR$|^USER$|^SHELL$|EDITOR|PAGER/.test(name)) expect(env).not.toHaveProperty(name)
    }
    expect(env).not.toHaveProperty("TERM")
  })
})

describe("host paths never leave the session", () => {
  const root = "/Users/person/checkouts/repo"
  test("a path under the repository becomes repository-relative, the root itself a dot, and quotes and positions stay", () => {
    expect(redactHostPaths(`module "${root}/src/greet"`, root)).toBe(`module "src/greet"`)
    expect(redactHostPaths(`File '${root}/src/a.ts' is not under 'rootDir' '${root}'.`, root)).toBe("File 'src/a.ts' is not under 'rootDir' '.'.")
    expect(redactHostPaths(`at ${root}/src/a.ts:12:3 and ${root}/`, root)).toBe("at src/a.ts:12:3 and .")
  })
  test("a path outside the repository keeps only its last segment, so the host's layout and user name never leave", () => {
    expect(redactHostPaths(`module "/private/var/folders/x/sec-outside-1/secret"`, root)).toBe(`module "…/secret"`)
    expect(redactHostPaths(`/Users/person/other/pkg/index.d.ts`, root)).toBe("…/index.d.ts")
    expect(redactHostPaths("see /tmp/", root)).toBe("see …/tmp/")
  })
  test("relative paths, URLs and lone slashes are not paths of the host", () => {
    for (const text of ["src/greet.ts", "node_modules/typescript/lib/lib.es5.d.ts", "https://smithers.sh/docs/x", "a / b", "/", "1/2"]) {
      expect(redactHostPaths(text, root)).toBe(text)
    }
  })
})

describe("mapping the server's shapes once, at the session", () => {
  test("hover contents: MarkupContent, MarkedString, code MarkedString and arrays become one markdown string, and the cap says when it cut", () => {
    expect(hoverContents({ kind: "markdown", value: "```ts\nconst a: 1\n```" })).toEqual({ contents: "```ts\nconst a: 1\n```", truncated: false })
    expect(hoverContents("plain")).toEqual({ contents: "plain", truncated: false })
    expect(hoverContents({ language: "typescript", value: "const a: 1" })).toEqual({ contents: "```typescript\nconst a: 1\n```", truncated: false })
    expect(hoverContents(["one", { language: "ts", value: "two" }])).toEqual({ contents: "one\n\n```ts\ntwo\n```", truncated: false })
    expect(hoverContents([])).toEqual({ contents: "", truncated: false })
    const cut = hoverContents("x".repeat(10_000))
    expect(cut.contents.length).toBe(4096)
    expect(cut.truncated).toBe(true)
    // The redaction runs before the cut, so the cap counts what is shown.
    expect(hoverContents("module \"/r/src/a\"", (text) => redactHostPaths(text, "/r"))).toEqual({ contents: "module \"src/a\"", truncated: false })
  })

  test("diagnostics: 0-based ranges become 1-based, numeric severities and codes become words and text", () => {
    expect(toDiagnostic({
      range: { start: { line: 3, character: 23 }, end: { line: 3, character: 29 } },
      message: "Property 'lenght' does not exist on type 'string'.",
      severity: 2,
      code: 2551,
      source: "typescript",
      relatedInformation: [{ location: { uri: "file:///x", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }, message: "here" }]
    })).toEqual({
      line: 4,
      character: 24,
      endLine: 4,
      endCharacter: 30,
      severity: "warning",
      message: "Property 'lenght' does not exist on type 'string'.",
      source: "typescript",
      code: "2551"
    })
    expect(toDiagnostic({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, message: "m" })).toEqual({
      line: 1,
      character: 1,
      endLine: 1,
      endCharacter: 1,
      severity: "error",
      message: "m"
    })
  })
})

describe.skipIf(skipReason !== undefined)("the real typescript-language-server over stdio", () => {
  test("hover answers the declared type at a 1-based position, with the token's range and the digest of the file it read", async () => {
    const live = await session()
    const { hover, digest } = await live.hover("src/index.ts", { line: 3, character: 7 })
    if (hover === null) throw new Error("hover answered null")
    expect(LspHoverSchema.parse(hover)).toEqual(hover)
    expect(hover.contents).toContain("const message: string")
    expect(hover.truncated).toBe(false)
    expect(hover.range).toEqual({ line: 3, character: 7, endLine: 3, endCharacter: 14 })
    expect(digest).toBe(createHash("sha256").update(await readFile(join(root, "src", "index.ts"))).digest("hex"))
    expect(live.state).toBe("ready")
    expect(host.list()).toEqual([{ repoId, language: "typescript", state: "ready" }])
    // The seatbelt policy is the one the spawn ran under (Sandbox.test.ts asserts its text).
    const spawnLine = logs.find((line) => line.startsWith(`lsp ${repoId}/typescript: pid`))
    expect(spawnLine).toContain(sandboxEnforced(currentSandboxHost()) ? "(sandbox on)" : "(sandbox off)")
  }, 20_000)

  test("a hover over whitespace answers null, not an empty hover", async () => {
    const live = await session()
    expect((await live.hover("src/index.ts", { line: 2, character: 1 })).hover).toBeNull()
  }, 20_000)

  test("the server's free text names no host path: a module specifier hovers as its repository-relative module, an import from outside the repository as its last segment only", async () => {
    const live = await session()
    // The specifier `"./greet"` on line 1: tsserver answers `module "<absolute path>/src/greet"`.
    const inside = await live.hover("src/index.ts", { line: 1, character: 25 })
    expect(inside.hover?.contents).toContain(`module "src/greet"`)
    expect(inside.hover?.contents).not.toContain(root)
    // A file beside the repository, imported by a relative path that climbs out of it.
    const outside = await realpath(await mkdtemp(join(tmpdir(), "smithers-lsp-outside-")))
    try {
      await writeFile(join(outside, "secret.ts"), "export const secret = \"hunter2-outside-the-repo\"\n")
      await writeFile(join(root, "src", "climb.ts"), `import { secret } from "../../${basename(outside)}/secret"\nexport const s = secret\n`)
      const specifier = await live.hover("src/climb.ts", { line: 1, character: 26 })
      expect(specifier.hover?.contents).toContain(`module "…/secret"`)
      expect(specifier.hover?.contents).not.toContain(outside)
      expect(specifier.hover?.contents).not.toContain(tmpdir())
      // The type of what was imported is still the type: the boundary is the path, not the symbol.
      const symbol = await live.hover("src/climb.ts", { line: 2, character: 18 })
      expect(symbol.hover?.contents).toContain("secret")
      expect(symbol.hover?.contents).not.toContain(outside)
    } finally {
      await rm(join(root, "src", "climb.ts"), { force: true })
      await rm(outside, { recursive: true, force: true })
    }
  }, 20_000)

  test("definition answers the declaring file and line, relative to the repository, with the server's total", async () => {
    const live = await session()
    const answer = await live.definition("src/index.ts", { line: 3, character: 17 })
    expect(answer.locations).toEqual([{ path: "src/greet.ts", line: 6, character: 14, endLine: 6, endCharacter: 19 }])
    expect(answer).toMatchObject({ total: 1, omitted: 0 })
    expect(answer.digest).toBe(createHash("sha256").update(await readFile(join(root, "src", "index.ts"))).digest("hex"))
  }, 20_000)

  test("a definition inside a linked package is outside the repository: omitted from the list and counted, never 'none found'", async () => {
    const live = await session()
    // `length` on a string literal is declared in lib.es5.d.ts under node_modules/typescript, a link out of the checkout.
    await writeFile(join(root, "src", "len.ts"), "export const n = \"abc\".length\n")
    try {
      const answer = await live.definition("src/len.ts", { line: 1, character: 24 })
      expect(answer.locations).toEqual([])
      expect(answer.total).toBeGreaterThanOrEqual(1)
      expect(answer.omitted).toBe(answer.total)
      // The misspelled `lenght` on line 4 of index.ts has no definition anywhere: total 0, omitted 0 — a different answer.
      expect(await live.definition("src/index.ts", { line: 4, character: 25 })).toMatchObject({ locations: [], total: 0, omitted: 0 })
    } finally {
      await rm(join(root, "src", "len.ts"), { force: true })
    }
  }, 20_000)

  test("diagnostics answer the deliberate error and the bus carries the same frame on the repository's topic", async () => {
    const live = await session()
    /*
     * tsserver publishes in passes (syntactic, then semantic, then
     * suggestions) and the deliberate error rides the semantic one: on a
     * loaded machine the first publication after didOpen is the empty
     * syntactic pass, so the error is awaited across calls — each answers the
     * latest publication — rather than pinned to the first.
     */
    let answer = await live.diagnostics("src/index.ts", 5000)
    const deadline = Date.now() + 15_000
    while (!(answer.items ?? []).some((item) => item.code === "2551")) {
      if (Date.now() > deadline) throw new Error(`the deliberate diagnostic never arrived; last answer: ${JSON.stringify(answer.items)}`)
      await Bun.sleep(50)
      answer = await live.diagnostics("src/index.ts", 5000)
    }
    expect(LspDiagnosticsResponseSchema.parse(answer)).toEqual(answer)
    expect(answer.path).toBe("src/index.ts")
    expect(answer.total).toBe(answer.items?.length ?? null)
    expect(answer.digest).toBe(createHash("sha256").update(await readFile(join(root, "src", "index.ts"))).digest("hex"))
    const deliberate = answer.items?.find((item) => item.code === "2551")
    expect(deliberate).toMatchObject({ line: 4, character: 24, endLine: 4, endCharacter: 30, severity: "error", code: "2551", source: "typescript" })
    expect(deliberate?.message).toContain("lenght")
    const published = frames.map((frame) => LspDiagnosticsMessageSchema.safeParse(frame)).filter((parsed) => parsed.success).map((parsed) => parsed.data)
    const mine = published.find((frame) => frame.path === "src/index.ts" && frame.digest === answer.digest && frame.total === answer.total)
    expect(mine).toMatchObject({ type: "lsp.diagnostics", repoId, path: "src/index.ts", items: answer.items, total: answer.total, digest: answer.digest })
    // A second ask for an unchanged file answers the same publication without waiting for another.
    const started = performance.now()
    expect(await live.diagnostics("src/index.ts", 5000)).toEqual(answer)
    expect(performance.now() - started).toBeLessThan(1000)
  }, 20_000)

  test("a clean file answers an empty list, never null", async () => {
    const live = await session()
    const answer = await live.diagnostics("src/greet.ts", 5000)
    expect(answer.items).toEqual([])
  }, 20_000)

  test("a changed file is re-synced from disk before the next answer, and the answer names the new digest", async () => {
    const live = await session()
    const before = (await live.diagnostics("src/greet.ts", 5000)).digest
    const changed = "export const greet = (name: string): number => name\n"
    await writeFile(join(root, "src", "greet.ts"), changed)
    const answer = await live.diagnostics("src/greet.ts", 5000)
    expect(answer.items?.map((item) => item.code)).toEqual(["2322"])
    expect(answer.digest).not.toBe(before)
    expect(answer.digest).toBe(createHash("sha256").update(changed).digest("hex"))
  }, 20_000)

  test("a request in flight holds the idle clock: a server is never retired mid-answer", async () => {
    // One millisecond of idle: the clock fires many times during the first request (initialize, project load, hover) and must restart behind it.
    const eager = createLspHost({
      publish: () => {},
      node: Promise.resolve(node),
      home: tmpdir(),
      sandbox: currentSandboxHost(),
      idleMs: 1,
      log: () => {}
    })
    try {
      const result = await eager.session("repo-eager", root, "src/index.ts")
      if (result.status !== "ok") throw new Error(result.status)
      expect((await result.session.hover("src/index.ts", { line: 3, character: 7 })).hover?.contents).toContain("const message:")
      // With nothing in flight the clock runs out and the server leaves.
      const deadline = Date.now() + 10_000
      while (eager.list().length > 0) {
        if (Date.now() > deadline) throw new Error("the idle server never shut down")
        await Bun.sleep(20)
      }
      expect(result.session.state).toBe("exited")
    } finally {
      await eager.killAll()
    }
  }, 20_000)

  test("paths are held to the files seam's rules: traversal, out-of-root and missing files are refused with its codes", async () => {
    const live = await session()
    await expect(live.hover("../etc/passwd", { line: 1, character: 1 })).rejects.toMatchObject({ code: "invalid_path", http: 400 })
    await expect(live.hover("src/nope.ts", { line: 1, character: 1 })).rejects.toMatchObject({ code: "path_not_found", http: 404 })
    await expect(live.hover("src", { line: 1, character: 1 })).rejects.toBeInstanceOf(LspRequestError)
  }, 20_000)

  test("one server per (repository, language): a second file reuses the process", async () => {
    const first = await session("src/index.ts")
    const second = await session("src/greet.ts")
    expect(second.pid).toBe(first.pid)
    expect(host.list()).toHaveLength(1)
  })

  test("idle shutdown ends the server cleanly and drops it from the table", async () => {
    const idle = createLspHost({
      publish: () => {},
      node: Promise.resolve(node),
      home: tmpdir(),
      sandbox: currentSandboxHost(),
      idleMs: 1000,
      log: () => {}
    })
    try {
      const result = await idle.session("repo-idle", root, "src/index.ts")
      if (result.status !== "ok") throw new Error(result.status)
      expect((await result.session.hover("src/index.ts", { line: 3, character: 7 })).hover).not.toBeNull()
      const deadline = Date.now() + 10_000
      while (idle.list().length > 0) {
        if (Date.now() > deadline) throw new Error("the idle server never shut down")
        await Bun.sleep(50)
      }
      expect(result.session.state).toBe("exited")
      // LSP shutdown then exit: the server leaves on its own, no signal needed.
      expect(await result.session.exited).toBe(0)
    } finally {
      await idle.killAll()
    }
  }, 20_000)

  test("closeRepo ends the repository's servers and leaves other repositories alone; killAll ends the rest", async () => {
    const other = await host.session("repo-other", root, "src/index.ts")
    if (other.status !== "ok") throw new Error(other.status)
    await other.session.ready
    const mine = await session()
    expect(host.list().map((row) => row.repoId).sort()).toEqual(["repo-fixture", "repo-other"])
    await host.closeRepo(repoId)
    expect(mine.state).toBe("exited")
    expect(host.list()).toEqual([{ repoId: "repo-other", language: "typescript", state: "ready" }])
    // The next request after a repository close starts a fresh server.
    const fresh = await session()
    expect(fresh.pid).not.toBe(mine.pid)
    expect((await fresh.hover("src/index.ts", { line: 3, character: 7 })).hover).not.toBeNull()
    await host.killAll()
    expect(other.session.state).toBe("exited")
    expect(fresh.state).toBe("exited")
    expect(host.list()).toEqual([])
  }, 30_000)
})
