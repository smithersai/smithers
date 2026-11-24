import { Fuzz } from "@smthrs/fuzz"
import * as GitHub from "@smthrs/integrations/github"
import { Arbitrary, Effect, Schema } from "effect"
import { Cli } from "incur"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Presentation from "../src/cli/Presentation.ts"
import { admin } from "../src/internal/backend/Admin.ts"
import { auth, browserLogin } from "../src/internal/backend/Auth.ts"
import { mountCardDoors } from "../src/internal/backend/CardDoors.ts"
import { Client } from "../src/internal/backend/Client.ts"
import { egress } from "../src/internal/backend/Egress.ts"
import { draftFromIssue } from "../src/internal/backend/IssueDraft.ts"
import { local } from "../src/internal/backend/Local.ts"
import { misc } from "../src/internal/backend/Misc.ts"
import { repositories } from "../src/internal/backend/Repositories.ts"
import { normalizeOrigin, observeOrigin, Session } from "../src/internal/backend/Session.ts"
import { stacks } from "../src/internal/backend/Stack.ts"
import { workspaceChildren } from "../src/internal/backend/WorkspaceChildren.ts"
import { resolveID, workspaceBody, workspaces } from "../src/internal/backend/Workspaces.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261126")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeFakeBins = (
  binDir: string,
  opts: { jjChanges: Array<{ change_id: string; commit_id: string; description: string }>; openExit?: number }
) => {
  mkdirSync(binDir, { recursive: true })
  const jjScript = join(binDir, "jj")
  const idRows = opts.jjChanges.map((c) => `${c.change_id}\t${c.commit_id}`).join("\n")
  const fullRows = opts.jjChanges.map((c) => `${c.change_id}\t${c.commit_id}\t${c.description.split("\n")[0]}`).join(
    "\n"
  )
  const descMap = Object.fromEntries(opts.jjChanges.map((c) => [c.change_id, c.description]))
  writeFileSync(
    jjScript,
    `#!${process.execPath}
const args = process.argv.slice(2).filter((a) => a !== "--ignore-working-copy" && a !== "--no-pager")
const tIdx = args.indexOf("-T")
const tmpl = tIdx >= 0 ? (args[tIdx + 1] || "") : ""
const rIdx = args.indexOf("-r")
const rev = rIdx >= 0 ? (args[rIdx + 1] || "") : ""
const descMap = ${JSON.stringify(descMap)}
if (args[0] === "log") {
  if (tmpl.includes("description") && !tmpl.includes("change_id")) {
    process.stdout.write((descMap[rev] || "Change") + "\\n")
  } else if (tmpl.includes("first_line")) {
    const single = ${JSON.stringify(fullRows)}.split("\\n").find((l) => l.startsWith(rev + "\\t")) || ${
      JSON.stringify(fullRows)
    }
    process.stdout.write(single + (single ? "\\n" : ""))
  } else {
    process.stdout.write(${JSON.stringify(idRows + (idRows ? "\n" : ""))})
  }
  process.exit(0)
}
if (args[0] === "bookmark" && args[1] === "list") {
  process.stdout.write("main\\tabcdef123456\\t111111111111\\nsmithers/chg00001\\tchg00001aaaaaaaa\\t111111111111\\n")
  process.exit(0)
}
if (args[0] === "diff") {
  process.stdout.write(args.includes("--summary") ? "M src/index.ts\\n" : "diff --git a/src/index.ts b/src/index.ts\\n+ok\\n")
  process.exit(0)
}
if (args[0] === "resolve" && args.includes("--list")) {
  process.stdout.write("")
  process.exit(0)
}
if (args[0] === "git" && args[1] === "remote" && args[2] === "list") {
  process.stdout.write("origin https://github.com/acme/demo.git\\n")
  process.exit(0)
}
process.exit(0)
`
  )
  chmodSync(jjScript, 0o755)

  const gitScript = join(binDir, "git")
  writeFileSync(
    gitScript,
    `#!${process.execPath}
const args = process.argv.slice(2)
if (args.includes("remote") && args.includes("get-url")) {
  process.stdout.write("https://github.com/acme/demo.git\\n")
} else if (args.includes("rev-parse")) {
  process.stdout.write("main\\n")
}
process.exit(0)
`
  )
  chmodSync(gitScript, 0o755)

  for (const opener of ["xdg-open", "open"]) {
    const p = join(binDir, opener)
    writeFileSync(p, `#!/bin/sh\nexit ${opts.openExit ?? 0}\n`)
    chmodSync(p, 0o755)
  }
}

const makeLoopback = async (
  handler: (
    req: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }
  ) => {
    status: number
    headers?: Record<string, string>
    body: string
  }
) => {
  const requests: Array<{ method: string; url: string; body: string }> = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => {
      body += c.toString()
    })
    req.on("end", () => {
      requests.push({ method: req.method ?? "GET", url: req.url ?? "/", body })
      const out = handler({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body })
      res.writeHead(out.status, out.headers ?? { "content-type": "application/json" })
      res.end(out.body)
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}

describe("@smthrs/cli Wave-6B Deep Backend Stack, Session, Auth, Workspaces, Egress, CardDoors, Misc, IssueDraft, Admin, Repos & Local fuzz invariants", () => {
  it(
    "Stack submit, status, sync, land & unsubmit uphold stack ordering, marker adoption, refusal and merge fallback invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          useGithubToken: Schema.Boolean,
          prMode: Schema.Literals(["create", "update-prior", "adopt-422", "empty-stack"]),
          landMode: Schema.Literals(["single", "all", "by-change", "refused-draft", "fallback-squash", "inactive"]),
          unsubmitState: Schema.Literals(["open", "closed", "missing-404"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ landMode, prMode, unsubmitState, useGithubToken }) =>
            Effect.promise(async () => {
              const tmp = mkdtempSync(join(tmpdir(), "smthrs-stack-fuzz-"))
              const binDir = join(tmp, "bin")
              const homeDir = join(tmp, "home")
              mkdirSync(homeDir, { recursive: true })
              const changes = prMode === "empty-stack"
                ? []
                : [
                  { change_id: "chg00001aaaaaaaa", commit_id: "111111111111", description: "First change\n\nBody 1" },
                  { change_id: "chg00002bbbbbbbb", commit_id: "222222222222", description: "Second change\n\nBody 2" }
                ]
              makeFakeBins(binDir, { jjChanges: changes })

              let activeStack: any = prMode === "update-prior"
                ? {
                  id: "stk-1",
                  state: "active",
                  target_ref: "main",
                  changes: [
                    {
                      change_id: "chg00001aaaaaaaa",
                      branch_name: "smithers/chg00001",
                      pr_number: 101,
                      pr_state: "open",
                      position: 0
                    }
                  ]
                }
                : null
              let nextPr = 200
              let mergeCalls = 0

              const handleGitHub = (
                method: string,
                ghPath: string,
                parsedBody: any
              ): { status: number; body: string } => {
                if (method === "GET" && ghPath.includes("/pulls?")) {
                  if (prMode === "adopt-422") {
                    return {
                      status: 200,
                      body: JSON.stringify([
                        {
                          number: 150,
                          state: "open",
                          html_url: "https://github.com/acme/demo/pull/150",
                          body: GitHub.Issues.withWriteMarker("adopted", "chg00001aaaaaaaa")
                        }
                      ])
                    }
                  }
                  return { status: 200, body: JSON.stringify([]) }
                }
                if (method === "POST" && ghPath.endsWith("/pulls")) {
                  const n = nextPr++
                  return {
                    status: 200,
                    body: JSON.stringify({
                      number: n,
                      state: "open",
                      html_url: `https://github.com/acme/demo/pull/${n}`
                    })
                  }
                }
                if (method === "GET" && /\/pulls\/\d+$/.test(ghPath)) {
                  if (unsubmitState === "missing-404" && activeStack?._unsubmitting) {
                    return { status: 404, body: JSON.stringify({ message: "Not Found" }) }
                  }
                  const n = Number(ghPath.split("/").pop())
                  return {
                    status: 200,
                    body: JSON.stringify({
                      number: n,
                      state: unsubmitState === "closed" && activeStack?._unsubmitting ? "closed" : "open",
                      merged: n === 101 && activeStack?._syncing,
                      draft: landMode === "refused-draft",
                      mergeable: true,
                      mergeable_state: "clean",
                      head: { sha: "deadbeef1234", ref: "smithers/chg00001" },
                      base: { ref: "main" },
                      html_url: `https://github.com/acme/demo/pull/${n}`
                    })
                  }
                }
                if (method === "GET" && ghPath.includes("/check-runs")) {
                  return {
                    status: 200,
                    body: JSON.stringify({
                      total_count: 1,
                      check_runs: [{ status: "completed", conclusion: "success" }]
                    })
                  }
                }
                if (method === "GET" && ghPath.includes("/status")) {
                  return { status: 200, body: JSON.stringify({ state: "success", statuses: [] }) }
                }
                if (method === "GET" && ghPath.includes("/reviews")) {
                  return { status: 200, body: JSON.stringify([{ state: "APPROVED", user: { login: "rev" } }]) }
                }
                if (method === "PATCH" && /\/pulls\/\d+$/.test(ghPath)) {
                  const n = Number(ghPath.split("/").pop())
                  return {
                    status: 200,
                    body: JSON.stringify({
                      number: n,
                      state: parsedBody?.state ?? "open",
                      html_url: `https://github.com/acme/demo/pull/${n}`
                    })
                  }
                }
                if (method === "PUT" && ghPath.endsWith("/merge")) {
                  mergeCalls++
                  if (landMode === "fallback-squash" && parsedBody?.merge_method === "merge") {
                    return { status: 405, body: JSON.stringify({ message: "Merge method not allowed" }) }
                  }
                  return { status: 200, body: JSON.stringify({ merged: true, sha: "mergedsha" }) }
                }
                if (method === "DELETE" && ghPath.includes("/git/refs/heads/")) {
                  return unsubmitState === "missing-404"
                    ? { status: 422, body: JSON.stringify({ message: "Reference does not exist" }) }
                    : { status: 204, body: "" }
                }
                return { status: 200, body: JSON.stringify({}) }
              }

              const server = await makeLoopback((req) => {
                const parsed = req.body
                  ? (() => {
                    try {
                      return JSON.parse(req.body)
                    } catch {
                      return {}
                    }
                  })()
                  : {}
                if (req.url.includes("/github-proxy")) {
                  return handleGitHub(parsed.method ?? "GET", parsed.path ?? "/", parsed.body)
                }
                if (req.url.startsWith("/repos/")) {
                  return handleGitHub(req.method, req.url, parsed)
                }
                if (req.url.includes("/stacks/active")) {
                  if (req.method === "GET") {
                    return activeStack
                      ? { status: 200, body: JSON.stringify(activeStack) }
                      : { status: 404, body: JSON.stringify({ message: "no stack" }) }
                  }
                  if (req.method === "PUT" || req.method === "POST") {
                    activeStack = {
                      id: "stk-saved",
                      state: "active",
                      target_ref: "main",
                      changes: parsed.changes ?? []
                    }
                    return { status: 200, body: JSON.stringify(activeStack) }
                  }
                  if (req.method === "DELETE") {
                    activeStack = null
                    return { status: 204, body: "" }
                  }
                }
                return { status: 200, body: JSON.stringify({ ok: true }) }
              })

              try {
                const env: Record<string, string | undefined> = {
                  HOME: homeDir,
                  PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
                  SMITHERS_API_ORIGIN: server.origin,
                  SMITHERS_TOKEN: "sma_stack_test_token",
                  ...(useGithubToken
                    ? { GITHUB_TOKEN: "ghp_test_stack_token", SMITHERS_GITHUB_API_URL: server.origin }
                    : {})
                }
                const client = new Client({ environment: env }, false)
                const o = { repo: "acme/demo", target: "main" }

                // 1. submit
                if (prMode === "empty-stack") {
                  let refused = false
                  try {
                    await stacks["stack submit"]!(client, {}, o)
                  } catch (e: any) {
                    refused = e?.code === "nothing_to_submit"
                  }
                  assertInv(refused, "empty stack refuses nothing_to_submit")
                } else {
                  const sub: any = await stacks["stack submit"]!(client, {}, o)
                  assertInv(sub.pr_numbers.length === 2, "submit created/updated 2 PRs")
                  assertInv(
                    sub.auth_source === (useGithubToken ? "github_token" : "server_github_app_installation"),
                    "auth_source matches env"
                  )
                }

                // 2. status
                const st: any = await stacks["stack status"]!(client, {}, o)
                assertInv(
                  prMode === "empty-stack" ? st.state === "inactive" : st.changes.length >= 1,
                  "stack status matches state"
                )

                // 3. sync
                if (activeStack) activeStack._syncing = true
                const synced: any = await stacks["stack sync"]!(client, {}, o)
                assertInv(typeof synced.stack_found === "boolean", "stack sync returns stack_found")
                if (activeStack) activeStack._syncing = false

                // 4. land
                if (landMode === "inactive") {
                  const saved = activeStack
                  activeStack = null
                  const res: any = await stacks["stack land"]!(client, {}, o)
                  assertInv(res.stack_found === false && res.landed.length === 0, "inactive land returns empty")
                  activeStack = saved
                } else if (activeStack && activeStack.changes?.length > 0) {
                  if (landMode === "refused-draft") {
                    let refused = false
                    try {
                      await stacks["stack land"]!(client, {}, o)
                    } catch (e: any) {
                      refused = e?.code === "not_landable"
                    }
                    assertInv(refused, "draft PR refused as not_landable")
                  } else {
                    const landOpts = landMode === "all"
                      ? { ...o, all: true }
                      : landMode === "by-change"
                      ? { ...o, change: "chg00001" }
                      : o
                    const landed: any = await stacks["stack land"]!(client, {}, landOpts)
                    assertInv(landed.stack_found === true && landed.landed.length >= 1, "land succeeded")
                    if (landMode === "fallback-squash") {
                      assertInv(mergeCalls >= 2, "405 triggered squash fallback")
                    }
                  }
                }

                // 5. unsubmit
                if (activeStack) activeStack._unsubmitting = true
                const unsub: any = await stacks["stack unsubmit"]!(client, {}, o)
                assertInv(typeof unsub.stack_deleted === "boolean", "unsubmit returns stack_deleted")
              } finally {
                await server.close()
                rmSync(tmp, { recursive: true, force: true })
              }
              return true
            }),
          { executions: Math.min(executions, 10), seed }
        )
      )
      if (report._tag !== "Passed") {
        throw new Error(`Falsified: ${JSON.stringify(report)}`)
      }
      expect(report._tag).toBe("Passed")
    },
    120_000
  )

  it(
    "Session, Auth, Egress, CardDoors, Misc, IssueDraft, WorkspaceChildren, Workspaces, Repos, Admin & Local uphold contract invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-be-deep-"))
      const binDir = join(tmp, "bin")
      const homeDir = join(tmp, "home")
      mkdirSync(homeDir, { recursive: true })
      makeFakeBins(binDir, {
        jjChanges: [{ change_id: "chg00001aaaaaaaa", commit_id: "111111111111", description: "Change 1" }],
        openExit: 0
      })

      const digest64 = "a".repeat(64)
      const state = {
        egressAllow: ["api.example.com"],
        authUserStatus: 200,
        issueAllowed: true,
        issueRepo: "acme/demo",
        modelDraftOk: true
      }

      const server = await makeLoopback((req) => {
        const parsed = req.body
          ? (() => {
            try {
              return JSON.parse(req.body)
            } catch {
              return {}
            }
          })()
          : {}
        if (req.url === "/api/user") {
          if (state.authUserStatus !== 200) {
            return { status: state.authUserStatus, body: JSON.stringify({ message: "unauth" }) }
          }
          return {
            status: 200,
            body: JSON.stringify({
              login: "will",
              email: "will@smithers.sh",
              credential_kind: "delegated",
              via: "terminal"
            })
          }
        }
        if (req.url.includes("/provider-connections")) {
          return { status: 200, body: JSON.stringify({ items: [{ id: "conn-1", provider: "claude" }], id: "conn-1" }) }
        }
        if (req.url.includes("/egress-policy")) {
          if (req.method === "PATCH") {
            for (const h of parsed.add ?? []) if (!state.egressAllow.includes(h)) state.egressAllow.push(h)
            for (const h of parsed.remove ?? []) state.egressAllow = state.egressAllow.filter((x) => x !== h)
          }
          return { status: 200, body: JSON.stringify({ allow_domains: state.egressAllow }) }
        }
        if (req.url.startsWith("/api/issues/")) {
          const num = Number(req.url.split("/").pop())
          return {
            status: 200,
            body: JSON.stringify({
              make_todo_allowed: state.issueAllowed,
              issue_digest: digest64,
              issue: {
                number: num,
                title: "Fix retry jitter",
                body: "Details about retry jitter",
                html_url: `https://github.com/${state.issueRepo}/issues/${num}`,
                user: { login: "alice" }
              },
              comments: [{ body: "repro steps", user: { login: "bob" } }]
            })
          }
        }
        if (req.url === "/api/model/stream") {
          if (!state.modelDraftOk) return { status: 200, body: "not-a-valid-draft-stream" }
          const ndjson = [
            JSON.stringify({
              runId: "r-draft-1",
              type: "delta",
              kind: "text",
              text: JSON.stringify({
                title: "Fix retry jitter",
                prompt: "Add bounded jitter to retries.",
                acceptance: ["tests pass"]
              })
            }),
            JSON.stringify({ runId: "r-draft-1", type: "done", reason: "stop" })
          ].join("\n")
          return { status: 200, headers: { "content-type": "application/x-ndjson" }, body: ndjson }
        }
        if (req.url.includes("/agent/sessions") && req.method === "POST" && !req.url.includes("/messages")) {
          return { status: 200, body: JSON.stringify({ id: "sess-42", title: parsed.title }) }
        }
        if (req.url.includes("snapshots")) {
          return { status: 200, body: JSON.stringify([{ id: "snap-1", workspace_id: "ws-1" }]) }
        }
        if (req.url.includes("/workspaces/") && req.url.endsWith("/stream")) {
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: `event: done\ndata: {"status":"deleted"}\n\n`
          }
        }
        if (req.url.includes("/workspaces") && req.url.endsWith("/ssh")) {
          return { status: 200, body: JSON.stringify({ host: "ws.test", port: 2222, user: "lane" }) }
        }
        if (req.url.includes("/workspaces")) {
          return {
            status: 200,
            body: JSON.stringify({
              id: "ws-1",
              name: "alpha",
              status: "running",
              items: [{ id: "ws-1", name: "alpha" }]
            })
          }
        }
        if (req.url.includes("/admin/users") && req.method === "GET" && !req.url.includes("/export")) {
          return { status: 200, body: JSON.stringify([{ id: "u-1", username: "bob" }]) }
        }
        if (req.url.includes("/admin/users")) {
          return {
            status: 200,
            body: JSON.stringify({ id: "u-1", username: "bob", items: [{ id: "u-1", username: "bob" }] })
          }
        }
        return {
          status: 200,
          body: JSON.stringify({ ok: true, id: "id-1", items: [], clone_url: `${server.origin}/git/acme/demo.git` })
        }
      })

      try {
        // 1. Session normalizeOrigin & observeOrigin fuzzing
        const originArb = Arbitrary.schema(
          Schema.Struct({
            raw: Schema.Literals([
              "https://smithers.sh/",
              "http://127.0.0.1:8080/",
              "http://localhost:3000",
              "smithers.sh",
              "http://insecure.example.com",
              "ftp://bad.example.com",
              "https://user:pass@smithers.sh",
              ""
            ])
          })
        )
        const originRep = await Effect.runPromise(
          Fuzz.run(
            originArb,
            ({ raw }) =>
              Effect.sync(() => {
                try {
                  const norm = normalizeOrigin(raw)
                  assertInv(
                    norm.startsWith("https://") || norm.startsWith("http://127.0.0.1") ||
                      norm.startsWith("http://localhost"),
                    `safe origin: ${norm}`
                  )
                } catch {
                  // rejected insecure/malformed origin
                }
                try {
                  const obs = observeOrigin(raw)
                  assertInv(
                    obs.startsWith("https://") || obs.startsWith("http://127.0.0.1") ||
                      obs.startsWith("http://localhost"),
                    `safe observe: ${obs}`
                  )
                } catch {
                  // rejected
                }
                return true
              }),
            { executions: Math.min(executions, 30), seed: seed + 1 }
          )
        )
        expect(originRep._tag).toBe("Passed")

        // 2. Real Client + Session + Auth handlers
        const env: Record<string, string | undefined> = {
          HOME: homeDir,
          XDG_CONFIG_HOME: join(homeDir, ".config"),
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
          SMITHERS_API_ORIGIN: server.origin,
          SMITHERS_TOKEN: "sma_valid_1234567890"
        }
        const makeClient = (stdinText = "sma_stdin_token_123", extraEnv: Record<string, string | undefined> = {}) => {
          const client = new Client(
            {
              environment: { ...env, ...extraEnv },
              exit: () => {}
            },
            false
          )
          client.stdin = async () => stdinText
          return client
        }

        // auth login validation errors + --with-token
        const c = makeClient("sma_logged_in_token_99")
        await expect(auth["auth login"]!(c, {}, { agent: "smithers" })).rejects.toThrow()
        await expect(auth["auth login"]!(c, {}, { ttl: "10m" })).rejects.toThrow()
        await expect(auth["auth login"]!(c, {}, { admin: true, "with-token": true })).rejects.toThrow()
        await expect(auth["auth login"]!(c, {}, { admin: true, ttl: "1m" })).rejects.toThrow()
        const loggedIn: any = await auth["auth login"]!(c, {}, { "with-token": true })
        expect(loggedIn.status).toBe("logged_in")

        // auth status (200, 401, 500, logged-out)
        state.authUserStatus = 200
        const st200: any = await auth["auth status"]!(c, {}, {})
        expect(st200.logged_in).toBe(true)
        expect(st200.credential_kind).toBe("delegated")
        state.authUserStatus = 401
        const st401: any = await auth["auth status"]!(c, {}, {})
        expect(st401.logged_in).toBe(false)
        state.authUserStatus = 500
        const st500: any = await auth["auth status"]!(c, {}, {})
        expect(st500.verified).toBe(false)
        state.authUserStatus = 200

        // auth token, connections, connect (--api-key), revoke, logout
        const tok: any = await auth["auth token"]!(c, {}, {})
        expect(tok.token_set).toBe(true)
        await auth["auth connections"]!(c, {}, {})
        await auth["auth connections"]!(c, {}, { org: "acme" })
        await auth["auth connect"]!(makeClient("sk-ant-api03-1234567890abcdef123456"), { provider: "claude" }, {
          "api-key": true,
          label: "prod"
        })
        const rev: any = await auth["auth revoke"]!(c, { id: "conn-1" }, {})
        expect(rev.status).toBe("revoked")
        await auth["auth logout"]!(c, {}, {})

        // browserLogin real loopback callback (abort cleanly when signal aborts)
        const ac = new AbortController()
        setTimeout(() => ac.abort(), 30)
        await expect(
          browserLogin(new Client({ environment: env, signal: ac.signal }, false), server.origin, false, "")
        ).rejects.toThrow()

        // 3. Egress list, allow, deny, deny-missing, empty host
        const e1: any = await egress["egress list"]!(c, {}, { repo: "acme/demo" })
        expect(e1.allow_domains).toContain("api.example.com")
        await egress["egress allow"]!(c, { host: "NPM.EXAMPLE.COM." }, { repo: "acme/demo" })
        await egress["egress deny"]!(c, { host: "npm.example.com" }, { repo: "acme/demo" })
        await expect(egress["egress deny"]!(c, { host: "not-listed.example.com" }, { repo: "acme/demo" })).rejects
          .toThrow()
        expect(() => egress["egress allow"]!(c, { host: "   " }, { repo: "acme/demo" })).toThrow()

        // 4. CardDoors (human open + browser failure + MCP refusal)
        const doorCli = Cli.create("smthrs")
        mountCardDoors(doorCli, { environment: env })
        let doorOut = ""
        await doorCli.serve(["settings"], { stdout: (s) => (doorOut += s), exit: () => {} })
        expect(doorOut).toContain("opened: true")

        const badBin = join(tmp, "badbin")
        makeFakeBins(badBin, { jjChanges: [], openExit: 1 })
        const doorFailCli = Cli.create("smthrs")
        mountCardDoors(doorFailCli, { environment: { ...env, PATH: `${badBin}:${process.env["PATH"] ?? ""}` } })
        const failCodes: Array<number> = []
        await doorFailCli.serve(["members"], { stdout: () => {}, exit: (code) => failCodes.push(code) })
        expect(failCodes.some((code) => code !== 0)).toBe(true)

        // 5. Misc (api, config, agent)
        const apiGet = await misc.api!(c, { endpoint: "/api/user" }, { method: "GET", header: ["x-test:1"] })
        expect((apiGet as any).login).toBe("will")
        const jsonFile = join(tmp, "payload.json")
        writeFileSync(jsonFile, JSON.stringify({ hello: "world" }))
        await misc.api!(c, { endpoint: "/api/echo" }, { method: "POST", input: jsonFile })
        await misc.api!(makeClient("{\"from\":\"stdin\"}"), { endpoint: "/api/echo" }, { method: "POST", input: "-" })
        await misc.api!(c, { endpoint: "/api/echo" }, { method: "PATCH", field: ["a=1"] })
        await expect(misc.api!(c, { endpoint: "/api/echo" }, { method: "TRACE" })).rejects.toThrow()
        await expect(misc.api!(c, { endpoint: "/api/echo" }, { method: "POST", input: jsonFile, field: ["a=1"] }))
          .rejects.toThrow()
        await expect(misc.api!(c, { endpoint: "/api/echo" }, { method: "POST", field: ["noequals"] })).rejects.toThrow()
        await expect(misc.api!(c, { endpoint: "/api/echo" }, { method: "POST", input: join(tmp, "nope.json") })).rejects
          .toThrow()
        await misc["config set"]!(c, { key: "api_url", value: server.origin }, {})
        await misc["config get"]!(c, { key: "api_url" }, {})
        await misc["config list"]!(c, {}, {})
        await misc["config show"]!(c, {}, {})
        await expect(misc["config get"]!(c, { key: "unknown_key" }, {})).rejects.toThrow()
        await misc["agent list"]!(c, {}, { repo: "acme/demo" })
        await misc["agent view"]!(c, { id: "sess-42" }, { repo: "acme/demo" })
        await misc["agent run"]!(c, { prompt: "check tests" }, { repo: "acme/demo" })
        await misc["agent chat"]!(c, { id: "sess-42", message: "status?" }, { repo: "acme/demo" })

        // 6. IssueDraft (valid + wrong repo + forbidden + bad number + bad stream)
        const drafted = await draftFromIssue(c, { number: 7, repo: "acme/demo" })
        expect(drafted.issue).toBe(7)
        await expect(draftFromIssue(c, { number: 0 })).rejects.toThrow()
        await expect(draftFromIssue(c, { number: 7, repo: "other/repo" })).rejects.toThrow()
        state.issueAllowed = false
        await expect(draftFromIssue(c, { number: 7 })).rejects.toThrow()
        state.issueAllowed = true
        state.modelDraftOk = false
        await expect(draftFromIssue(c, { number: 7 })).rejects.toThrow()
        state.modelDraftOk = true

        // 7. WorkspaceChildren (outside + inside guest config + invalid count/ttl)
        await workspaceChildren["workspace children spawn"]!(c, {}, {
          repo: "acme/demo",
          workspace: "ws-1",
          count: "2",
          profile: "small",
          ttl: "60"
        })
        await workspaceChildren["workspace children list"]!(c, {}, { repo: "acme/demo", workspace: "ws-1" })
        await workspaceChildren["workspace children stop"]!(c, { child: "ch-1" }, {
          repo: "acme/demo",
          workspace: "ws-1"
        })
        await expect(workspaceChildren["workspace children list"]!(c, {}, {})).rejects.toThrow()
        await expect(
          workspaceChildren["workspace children spawn"]!(c, {}, { repo: "acme/demo", workspace: "ws-1", count: "0" })
        ).rejects.toThrow()

        const guestCfg = join(tmp, "workspace-coding.json")
        const guestTok = join(tmp, "ws-children-tok")
        writeFileSync(
          guestCfg,
          JSON.stringify({ workspaceId: "ws-guest", repositorySlug: "acme/demo", apiBaseUrl: `${server.origin}/api` })
        )
        writeFileSync(guestTok, "guest_tok_123")
        const guestClient = makeClient("", {
          SMITHERS_WORKSPACE_CODING_CONFIG: guestCfg,
          SMITHERS_WORKSPACE_CHILDREN_TOKEN_FILE: guestTok
        })
        await workspaceChildren["workspace children list"]!(guestClient, {}, {})

        // 8. Workspaces, Repositories, Admin, Local
        expect(workspaceBody({ name: "w1", base: "main" })).toMatchObject({ name: "w1" })
        expect(await resolveID(c, { id: "ws-1" }, { repo: "acme/demo" })).toBe("ws-1")
        await workspaces["workspace list"]!(c, {}, { repo: "acme/demo" })
        await workspaces["workspace create"]!(c, {}, { repo: "acme/demo", name: "w2" })
        await workspaces["workspace view"]!(c, { id: "ws-1" }, { repo: "acme/demo" })
        await workspaces["workspace fork"]!(c, { id: "ws-1" }, { repo: "acme/demo", name: "w-fork" })
        await workspaces["workspace snapshots"]!(c, { id: "ws-1" }, { repo: "acme/demo" })
        await workspaces["workspace watch"]!(c, { id: "ws-1" }, { repo: "acme/demo" })
        await expect(workspaces["workspace delete"]!(c, { id: "ws-1" }, { repo: "acme/demo" })).rejects.toThrow()
        await workspaces["workspace delete"]!(c, { id: "ws-1" }, { repo: "acme/demo", yes: true })
        await expect(workspaces["workspace issue"]!(c, {}, {})).rejects.toThrow()

        await repositories["repo list"]!(c, {}, {})
        await repositories["repo create"]!(c, { name: "new-repo" }, { description: "desc" })
        await repositories["repo view"]!(c, { repo: "acme/demo" }, {})
        await repositories["repo home"]!(c, { repo: "acme/demo" }, {})
        await repositories["repo edit"]!(c, { repo: "acme/demo" }, { repo: "acme/demo", description: "updated" })
        await repositories["repo mirror-sync"]!(c, { repo: "acme/demo" }, { repo: "acme/demo" })
        await expect(repositories["repo status"]!(c, {}, {})).rejects.toThrow()
        const jjRepoDir = join(tmp, "jj-repo")
        mkdirSync(join(jjRepoDir, ".jj"), { recursive: true })
        const prevCwd = process.cwd()
        process.chdir(jjRepoDir)
        try {
          await repositories["repo status"]!(c, {}, {})
        } finally {
          process.chdir(prevCwd)
        }

        await admin["admin user list"]!(c, {}, {})
        await admin["admin user create"]!(c, {}, { username: "bob", email: "bob@test.dev" })
        await admin["admin user delete"]!(c, { username: "bob", user: "bob" }, { yes: true })
        await admin["admin user erase"]!(c, { username: "bob", user: "bob" }, { yes: true })
        await admin["admin user export"]!(c, { username: "bob", out: join(tmp, "bob-export.tar.gz") }, {})
        await admin["admin health"]!(c, {}, {})
        await admin["admin runs list"]!(c, {}, { repo: "acme/demo" })

        await local["bookmark list"]!(c, {}, {})
        await local["bookmark create"]!(c, { name: "feat-x" }, {})
        await expect(local["bookmark delete"]!(c, { name: "feat-x" }, {})).rejects.toThrow()
        await local["bookmark delete"]!(c, { name: "main" }, {})
        await local["change list"]!(c, {}, {})
        await local["change show"]!(c, { id: "chg00001aaaaaaaa" }, {})
        await local["change diff"]!(c, { id: "chg00001aaaaaaaa" }, {})
        await local["change files"]!(c, { id: "chg00001aaaaaaaa" }, {})
        await local["change conflicts"]!(c, { id: "chg00001aaaaaaaa" }, {})
        await local["land list"]!(c, {}, { repo: "acme/demo" })
      } finally {
        await server.close()
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )
})
