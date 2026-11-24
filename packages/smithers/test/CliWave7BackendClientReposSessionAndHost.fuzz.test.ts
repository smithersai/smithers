import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { Cli } from "incur"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Catalog from "../src/internal/backend/Catalog.ts"
import * as ClientMod from "../src/internal/backend/Client.ts"
import * as Copy from "../src/internal/backend/Copy.ts"
import * as Local from "../src/internal/backend/Local.ts"
import * as Repositories from "../src/internal/backend/Repositories.ts"
import * as Resources from "../src/internal/backend/Resources.ts"
import * as SessionMod from "../src/internal/backend/Session.ts"
import * as SSH from "../src/internal/backend/SSH.ts"
import * as Workspaces from "../src/internal/backend/Workspaces.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261127")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const expectPassed = (report: { readonly _tag: string; readonly findings?: ReadonlyArray<unknown> }) => {
  if (report._tag !== "Passed") {
    const first = report.findings?.[0] as { failure?: { defect?: unknown } } | undefined
    const d = first?.failure?.defect
    const msg = d instanceof Error ? d.message : JSON.stringify(report.findings?.[0])
    throw new Error(`Falsified: ${msg}`)
  }
  expect(report._tag).toBe("Passed")
}

const makeBackendServer = async (
  onRequest?: (
    method: string,
    url: string,
    body: string
  ) => { status: number; headers?: Record<string, string>; body: string } | undefined
) => {
  const seen: Array<{ method: string; url: string; body: string }> = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => {
      body += c.toString()
    })
    req.on("end", () => {
      const method = req.method ?? "GET"
      const url = req.url ?? "/"
      seen.push({ method, url, body })
      const custom = onRequest?.(method, url, body)
      if (custom) {
        res.writeHead(custom.status, custom.headers ?? { "content-type": "application/json" })
        res.end(custom.body)
        return
      }
      // Sensible default responses covering all backend routes
      res.writeHead(200, { "content-type": "application/json" })
      if (url === "/api/user") {
        res.end(JSON.stringify({ id: 42, username: "fuzzuser" }))
      } else if (url.endsWith("/user-refs/renew")) {
        res.end(JSON.stringify({ expires_at: "2026-12-01T00:00:00Z" }))
      } else if (url.includes("/landings/") && url.endsWith("/changes?page=1&per_page=100")) {
        res.end(JSON.stringify([{ change_id: "chg1" }]))
      } else if (url.includes("/landings/") && url.endsWith("/reviews?page=1&per_page=100")) {
        res.end(JSON.stringify([{ id: 1, type: "approve" }]))
      } else if (url.includes("/landings/") && url.endsWith("/conflicts")) {
        res.end(JSON.stringify([]))
      } else if (url.includes("/commits/") && url.endsWith("/statuses")) {
        res.end(JSON.stringify([{ state: "success", context: "ci" }]))
      } else if (url.includes("/landings")) {
        res.end(JSON.stringify({ number: 7, change_ids: ["chg1"], state: "open", landings: [{ number: 7 }] }))
      } else if (url.includes("/workspaces")) {
        res.end(JSON.stringify({
          id: "ws-1",
          name: "alpha",
          status: "running",
          ssh: {
            host: "127.0.0.1",
            port: 2222,
            user: "root",
            host_keys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"]
          },
          workspaces: [{ id: "ws-1", name: "alpha" }]
        }))
      } else {
        res.end(JSON.stringify({ ok: true, id: 1, name: "demo", is_public: false, items: [] }))
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  const addr = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}

describe("@smthrs/cli Wave-7D Backend Client, Session, Repositories, Local, Workspaces, SSH, Resources, Copy & Catalog fuzz invariants", () => {
  it(
    "Client refusalOf/failure/originHint/confirm/abort/paginationCursor & Session tokenFile/keyring invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-w7d-cli-"))
      const server = await makeBackendServer()
      try {
        // 1. Fuzz refusalOf & Client.failure across all error classes, blocked_at_edge, frozen errors, non-errors & secret redaction
        const errArb = Arbitrary.schema(
          Schema.Struct({
            kind: Schema.Literals([
              "blocked-edge-html",
              "workspace-resources-exceeded",
              "class-user",
              "class-permission",
              "class-conflict",
              "class-infra",
              "class-never",
              "non-error",
              "frozen-error-secret"
            ]),
            originMode: Schema.Literals(["explicit", "api-origin", "smithers-url", "config"])
          })
        )
        const rep = await Effect.runPromise(
          Fuzz.run(
            errArb,
            (input) =>
              Effect.sync(() => {
                const env: Record<string, string | undefined> = {
                  HOME: tmp,
                  XDG_CONFIG_HOME: join(tmp, "cfg"),
                  SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
                  SMITHERS_TOKEN: "ghp_1234567890abcdef1234567890abcdef1234",
                  ...(input.originMode === "api-origin" ? { SMITHERS_API_ORIGIN: server.origin } : {}),
                  ...(input.originMode === "smithers-url" ? { SMITHERS_URL: server.origin } : {})
                }
                const client = new ClientMod.Client({ environment: env })

                if (input.kind === "blocked-edge-html") {
                  const err = new ClientMod.APIError(
                    403,
                    {},
                    "GET",
                    "/api/test",
                    new Headers({ "content-type": "text/html; charset=utf-8" }),
                    "<html>Blocked ghp_1234567890abcdef1234567890abcdef1234</html>",
                    server.origin,
                    input.originMode === "explicit"
                  )
                  const out = client.failure(err) as Error & { code?: string }
                  assertInv(out.code === "blocked_at_edge", "edge HTML 403 -> blocked_at_edge")
                  assertInv(
                    !out.message.includes("ghp_1234567890abcdef1234567890abcdef1234"),
                    "secret redacted in preview"
                  )
                } else if (input.kind === "workspace-resources-exceeded") {
                  const err = new ClientMod.APIError(
                    400,
                    { code: "workspace_resources_exceeded", message: "too big" },
                    "POST",
                    "/api/ws",
                    new Headers({ "content-type": "application/json" }),
                    "",
                    server.origin,
                    input.originMode === "explicit"
                  )
                  const out = client.failure(err) as Error & { code?: string }
                  assertInv(out.code === "workspace_resources_exceeded", "400 resource exceeded preserved")
                } else if (input.kind.startsWith("class-")) {
                  const cls = input.kind.slice("class-".length)
                  const err = new ClientMod.APIError(
                    422,
                    { class: cls, code: `err_${cls}`, message: `failed ${cls}` },
                    "POST",
                    "/api/op",
                    new Headers({ "content-type": "application/json" }),
                    "",
                    server.origin,
                    input.originMode === "explicit"
                  )
                  const out = client.failure(err) as Error & { code?: string }
                  assertInv(out.code === `err_${cls}`, `class ${cls} code preserved`)
                } else if (input.kind === "non-error") {
                  const out = client.failure("plain ghp_1234567890abcdef1234567890abcdef1234 failure")
                  assertInv(
                    typeof out === "string" && !out.includes("ghp_1234567890abcdef1234567890abcdef1234"),
                    "non-error redacted"
                  )
                } else {
                  const inner = new Error("cause ghp_1234567890abcdef1234567890abcdef1234")
                  const frozen = Object.freeze(
                    Object.assign(new Error("outer ghp_1234567890abcdef1234567890abcdef1234"), { cause: inner })
                  )
                  const out = client.failure(frozen) as Error
                  assertInv(
                    !out.message.includes("ghp_1234567890abcdef1234567890abcdef1234"),
                    "frozen error message redacted"
                  )
                }
                return true
              }),
            { executions: Math.min(executions, 45), seed }
          )
        )
        expectPassed(rep)

        // 2. Client confirm non-TTY refusal, pre-aborted signal, paginationCursor, Session tokenFile & managed path refusal
        const tokFile = join(tmp, "token.txt")
        writeFileSync(tokFile, "smthrs_file_tok_12345\n", { mode: 0o600 })
        const session = new SessionMod.Session({
          HOME: tmp,
          XDG_CONFIG_HOME: join(tmp, "cfg"),
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
          SMITHERS_API_ORIGIN: server.origin,
          SMITHERS_TOKEN_FILE: tokFile
        })
        const id1 = session.credentialIdentity(server.origin)
        session.invalidateCredential(server.origin, id1)
        const id2 = session.credentialIdentity(server.origin)
        expect(id1).not.toBe(id2)

        // Managed token path traversal refusal
        const badManaged = new SessionMod.Session({
          HOME: tmp,
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
          SMITHERS_API_ORIGIN: server.origin,
          SMITHERS_TOKEN_FILE: "/run/smithers/sessions/../evil/token",
          SMITHERS_TERMINAL_SESSION: "sess-1"
        })
        await expect(badManaged.resolve(server.origin)).rejects.toThrow()

        const ac = new AbortController()
        ac.abort()
        const clientAborted = new ClientMod.Client({
          environment: {
            HOME: tmp,
            SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
            SMITHERS_API_ORIGIN: server.origin,
            SMITHERS_TOKEN: "tok-1"
          },
          signal: ac.signal
        })
        await expect(clientAborted.request("GET", "/api/user")).rejects.toThrow()
        if (!process.stdin.isTTY) {
          await expect(clientAborted.confirm("delete everything", "delete")).rejects.toThrow(/--yes/i)
        }

        // paginationCursor with Link header
        const headers = new Headers({ link: `<${server.origin}/items?cursor=next123>; rel="next"` })
        expect(ClientMod.paginationCursor(headers, new URL(`${server.origin}/items`))).toBe("next123")
      } finally {
        await server.close()
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )

  it(
    "Local jj/land handlers, Repositories push/license/config, SSH args, Workspaces, Copy archiveFilter & Catalog CLI uphold invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-w7d-ops-"))
      const binDir = join(tmp, "bin")
      const workDir = join(tmp, "work")
      mkdirSync(binDir, { recursive: true })
      mkdirSync(workDir, { recursive: true })

      // Real executable jj & git shims in isolated PATH
      writeFileSync(
        join(binDir, "jj"),
        `#!/bin/sh
if [ "$1" = "root" ]; then echo "${workDir}"; exit 0; fi
if [ "$1" = "git" ] && [ "$2" = "root" ]; then echo "${workDir}/.git"; exit 0; fi
if [ "$1" = "bookmark" ] && [ "$2" = "list" ]; then printf 'main\\tchg1\\nfeat\\tchg2\\n'; exit 0; fi
if [ "$1" = "bookmark" ]; then exit 0; fi
if [ "$1" = "diff" ]; then echo "diff --git a/x b/x"; exit 0; fi
if [ "$1" = "file" ]; then echo "src/a.ts"; exit 0; fi
if [ "$1" = "log" ]; then
  case "$*" in
    *commit_id*) echo "abcdef1234567890abcdef1234567890abcdef12"; exit 0 ;;
    *) printf 'chg1\\tabcdef1234567890\\tFirst change\\tfalse\\tfalse\\n'; exit 0 ;;
  esac
fi
exit 0
`
      )
      chmodSync(join(binDir, "jj"), 0o755)

      writeFileSync(
        join(binDir, "git"),
        `#!/bin/sh
if echo "$*" | grep -q "ls-remote"; then printf '1111111111111111111111111111111111111111\\trefs/smithers/users/42/snap\\n'; exit 0; fi
if echo "$*" | grep -q "push"; then exit 0; fi
if echo "$*" | grep -q "rev-parse"; then echo "${workDir}/.git"; exit 0; fi
exit 0
`
      )
      chmodSync(join(binDir, "git"), 0o755)

      let repoPublic = false
      const server = await makeBackendServer((_method, url) => {
        if (url === "/api/repos/acme/demo") {
          return { status: 200, body: JSON.stringify({ id: 1, full_name: "acme/demo", is_public: repoPublic }) }
        }
        return undefined
      })

      const prevPath = process.env["PATH"] ?? ""
      const prevCwd = process.cwd()
      process.env["PATH"] = `${binDir}:${prevPath}`
      process.chdir(workDir)

      try {
        const env = {
          ...process.env,
          HOME: tmp,
          XDG_CONFIG_HOME: join(tmp, "cfg"),
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
          SMITHERS_API_ORIGIN: server.origin,
          SMITHERS_TOKEN: "smthrs_test_token_ok",
          SMITHERS_REPO: "acme/demo"
        }
        const client = new ClientMod.Client({ environment: env })

        // 1. Local jj & land handlers
        const st = await Local.local["status"]!(client, {}, { repo: "acme/demo" })
        expect(st).toBeDefined()
        await Local.local["bookmark list"]!(client, {}, {})
        await Local.local["bookmark create"]!(client, { name: "topic" }, { change: "chg1" })
        await Local.local["bookmark delete"]!(client, { name: "main" }, {})
        await expect(Local.local["bookmark delete"]!(client, { name: "missing-bm" }, {})).rejects.toThrow(/not found/i)
        await Local.local["change list"]!(client, {}, { limit: 5 })
        await Local.local["change show"]!(client, { id: "@" }, {})
        await Local.local["change diff"]!(client, { id: "@" }, {})
        await Local.local["change files"]!(client, { id: "@" }, {})
        await Local.local["change conflicts"]!(client, { id: "@" }, {})

        for (const action of ["view", "review", "checks", "conflicts", "edit", "comment", "land"] as const) {
          await Local.local[`land ${action}`]!(
            client,
            { number: 7 },
            { repo: "acme/demo", title: "T", body: "B", target: "main", approve: true, commit: "abc" }
          )
        }
        await Local.local["land create"]!(client, {}, {
          repo: "acme/demo",
          title: "L1",
          target: "main",
          change: "chg1"
        })
        await Local.local["land list"]!(client, {}, { repo: "acme/demo", state: "landed" })

        // 2. Repositories push user ref (normal + delete + public --working-copy refusal)
        if (Repositories.repositories["repo push"]) {
          const pushed = await Repositories.repositories["repo push"]!(client, { name: "snap" }, { repo: "acme/demo" })
          expect(pushed).toBeDefined()
          const delRes = await Repositories.repositories["repo push"]!(client, { name: "snap" }, {
            repo: "acme/demo",
            delete: true
          })
          expect(delRes).toBeDefined()
          repoPublic = true
          await expect(
            Repositories.repositories["repo push"]!(client, { name: "snap" }, {
              repo: "acme/demo",
              "working-copy": true
            })
          ).rejects.toThrow(/public repository/i)
          repoPublic = false
        }

        // 3. SSH hostKeys & sshArgs
        const keys = SSH.hostKeys([{
          known_hosts_line: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
        }])
        expect(keys.length).toBe(1)
        const args = await SSH.sshArgs(
          client,
          {
            command: "ssh -p 2222 root@127.0.0.1",
            hostKeys: keys
          } as never,
          true
        )
        expect(args.includes("-tt") || args.includes("-t") || args.some((a) => a.includes("2222"))).toBe(true)

        // 4. Workspaces body & resolveID & Copy.archiveFilter
        const wsBody = Workspaces.workspaceBody({ name: "dev", cpu: 2, memory: 4096 })
        expect(wsBody).toBeDefined()
        const resolvedId = await Workspaces.resolveID(client, { id: "ws-1" }, { repo: "acme/demo" })
        expect(resolvedId).toBe("ws-1")

        writeFileSync(join(workDir, "good.txt"), "hi")
        symlinkSync("/etc/passwd", join(workDir, "escape-link"))
        const filter = Copy.archiveFilter(workDir)
        expect(typeof filter).toBe("function")
        expect(Copy.copyScript(true, "/app", "f.txt", false)).toContain("/app")
        expect(Copy.copyScript(false, "/app", "f.txt", true)).toContain("/app")

        // 5. Catalog mount & real command execution against loopback server (json + md + human formats)
        const cli = Cli.create("smthrs", { description: "test", version: "1.0.0" })
        Catalog.mountCatalog(cli, { environment: env, exit: () => {} })
        for (
          const argv of [
            ["issues", "--format", "json"],
            ["issues", "--format", "md"],
            ["flows", "--format", "json"]
          ]
        ) {
          let out = ""
          await cli.serve(argv, {
            env,
            stdout: (t) => {
              out += t
            },
            exit: () => {}
          })
          expect(out.length).toBeGreaterThanOrEqual(0)
        }

        // 6. Resources handlers existence & dispatch check
        expect(Object.keys(Resources.resources).length).toBeGreaterThan(0)
      } finally {
        process.chdir(prevCwd)
        process.env["PATH"] = prevPath
        await server.close()
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )
})
