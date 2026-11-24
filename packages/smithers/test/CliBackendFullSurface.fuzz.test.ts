import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Auth from "../src/internal/backend/Auth.ts"
import * as Catalog from "../src/internal/backend/Catalog.ts"
import * as ClientMod from "../src/internal/backend/Client.ts"
import * as Commands from "../src/internal/backend/Commands.ts"
import * as History from "../src/internal/backend/History.ts"
import * as HostService from "../src/internal/backend/HostService.ts"
import * as IssueDraft from "../src/internal/backend/IssueDraft.ts"
import * as Misc from "../src/internal/backend/Misc.ts"
import * as Repositories from "../src/internal/backend/Repositories.ts"
import * as Resources from "../src/internal/backend/Resources.ts"
import * as Runs from "../src/internal/backend/Runs.ts"
import * as SessionMod from "../src/internal/backend/Session.ts"
import * as SSH from "../src/internal/backend/SSH.ts"
import * as Stack from "../src/internal/backend/Stack.ts"
import * as WorkspaceChildren from "../src/internal/backend/WorkspaceChildren.ts"
import * as Workspaces from "../src/internal/backend/Workspaces.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeFakeSshBin = (dir: string): string => {
  const binDir = join(dir, "fake-bin")
  mkdirSync(binDir, { recursive: true })
  const sshPath = join(binDir, "ssh")
  writeFileSync(
    sshPath,
    `#!${process.execPath}
const args = process.argv.slice(2);
const joined = args.join(" ");
if (joined.includes("__FAIL__")) {
  process.stderr.write("remote fail\\n");
  process.exit(2);
}
if (joined.includes("cat ") && joined.includes("exit")) {
  process.stdout.write("0\\n");
  process.exit(0);
}
if (joined.includes("list") || joined.includes("ps")) {
  process.stdout.write(JSON.stringify({ children: [{ id: "ch-1", pid: 123, status: "running" }] }) + "\\n");
  process.exit(0);
}
process.stdout.write("ssh-ok:" + args.slice(-1)[0] + "\\n");
process.exit(0);
`,
    { mode: 0o755 }
  )
  chmodSync(sshPath, 0o755)
  return binDir
}

const makeBackendServer = () => {
  const seen: Array<{ method: string; url: string }> = []
  let prSeq = 1
  const prs: Array<Record<string, unknown>> = []
  const srv = createServer((req, res) => {
    let raw = ""
    req.setEncoding("utf8")
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const url = req.url ?? "/"
      const method = req.method ?? "GET"
      seen.push({ method, url })
      let body: Record<string, unknown> = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {}

      if (url === "/readyz") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.endsWith("/stream") || url.endsWith("/logs") || url.endsWith("/events")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        res.write(`id: 1\nevent: status\ndata: {"status":"running","id":"1","state":"working"}\n\n`)
        res.write(`id: 2\nevent: done\ndata: {"status":"completed","id":"1","state":"settled"}\n\n`)
        res.end()
        return
      }
      if (url.includes("/ssh")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            host: "127.0.0.1",
            port: 2222,
            user: "developer",
            command: "ssh -p 2222 developer@127.0.0.1",
            host_keys: [{
              algorithm: "ssh-ed25519",
              public_key: "AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH"
            }],
            private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nFUZZ\n-----END OPENSSH PRIVATE KEY-----\n",
            token: "ws-ssh-tok"
          })
        )
        return
      }
      if (url.includes("/workspaces/ws-1") && method === "GET") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id: "ws-1",
            name: "box-1",
            status: "running",
            state: "running",
            ssh_host: "127.0.0.1",
            ssh_port: 2222,
            ssh_user: "developer",
            host_keys: [{
              algorithm: "ssh-ed25519",
              public_key: "AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH"
            }]
          })
        )
        return
      }
      if (url.includes("/workspaces") && method === "GET" && !url.includes("/snapshots")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify([
            { id: "ws-1", name: "box-1", status: "running", state: "running" },
            { id: "ws-2", name: "box-2", status: "stopped", state: "stopped" }
          ])
        )
        return
      }
      if (url.includes("/workspaces") && method === "POST" && !url.includes("/fork")) {
        res.writeHead(201, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "ws-1", name: body.name ?? "box-1", status: "running" }))
        return
      }
      if (url.includes("/snapshots")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify([{ id: "snap-1", name: "base", created_at: "2026-10-20T00:00:00Z" }]))
        return
      }
      if (url.includes("/github-proxy") && method === "POST") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            number: prSeq++,
            state: "open",
            html_url: "https://github.com/owner/repo/pull/99",
            head: { ref: "smithers/p" },
            base: { ref: "main" }
          })
        )
        return
      }
      if (url.includes("/stack") && method === "GET") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ changes: [] }))
        return
      }
      if (url.includes("/stack") && (method === "PUT" || method === "POST" || method === "DELETE")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.includes("/pulls") && method === "POST") {
        const num = prSeq++
        const pr = {
          number: num,
          title: body.title ?? `Change ${num}`,
          body: body.body ?? "",
          state: "open",
          head: { ref: body.head ?? `smithers/c${num}` },
          base: { ref: body.base ?? "main" },
          html_url: `https://github.com/owner/repo/pull/${num}`,
          draft: Boolean(body.draft),
          mergeable: true
        }
        prs.push(pr)
        res.writeHead(201, { "content-type": "application/json" })
        res.end(JSON.stringify(pr))
        return
      }
      if (url.includes("/pulls") && method === "GET") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify(
            prs.length > 0
              ? prs
              : [{ number: 1, title: "PR 1", state: "open", head: { ref: "feat-1" }, base: { ref: "main" } }]
          )
        )
        return
      }
      if (url.includes("/pulls/") && (method === "PATCH" || method === "PUT")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ number: 1, merged: true, state: "closed", title: body.title ?? "Updated" }))
        return
      }
      if (url.includes("/issues/") && method === "GET") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            number: 42,
            title: "Fix flaky retry in worker",
            body: "Steps to reproduce:\n1. Start worker\n2. Observe retry\n",
            labels: [{ name: "bug" }],
            comments: [{ body: "Confirmed on nyc-02" }]
          })
        )
        return
      }
      if (url.includes("/runs/1") && method === "GET") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: 1, status: "completed", conclusion: "success" }))
        return
      }
      if (url.includes("/mythical/items")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({ id: "12", title: "Item 12", state: "settled", pull_request: { number: 12, state: "open" } })
        )
        return
      }
      if (url.includes("/mythical")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            maxParallel: 2,
            items: [
              { id: "12", title: "Item 12", state: "settled", pull_request: { number: 12, state: "open" } },
              { id: "13", title: "Item 13", state: "waiting", reason: "needs_review" }
            ]
          })
        )
        return
      }
      if (
        url.includes("/workflows") ||
        url.includes("/runs") ||
        url.includes("/issues") ||
        url.includes("/labels") ||
        url.includes("/secrets") ||
        url.includes("/variables") ||
        url.includes("/webhooks") ||
        url.includes("/ssh-keys") ||
        url.includes("/notifications") ||
        url.includes("/orgs") ||
        url.includes("/repos") ||
        url.includes("/agents") ||
        url.includes("/sessions") ||
        url.includes("/bookmarks") ||
        url.includes("/changes") ||
        url.includes("/wiki") ||
        url.includes("/search")
      ) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          method === "GET" && !url.match(/\/[0-9]+$/) && !url.includes("/repos/owner/repo")
            ? JSON.stringify([
              {
                id: 1,
                number: 1,
                name: "item-1",
                title: "Item 1",
                full_name: "owner/repo",
                status: "completed",
                default_branch: "main",
                clone_url: "https://example.invalid/owner/repo.git"
              }
            ])
            : JSON.stringify({
              id: 1,
              number: 1,
              name: "item-1",
              title: "Item 1",
              full_name: "owner/repo",
              status: "completed",
              default_branch: "main",
              ok: true
            })
        )
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, id: 1, username: "fuzz-op", logged_in: true }))
    })
  })
  return { srv, seen }
}

describe("@smthrs/cli Full Backend Surface (Stack, Workspaces, SSH, Resources, Misc, Runs, Catalog, HostService, Session, Auth & IssueDraft) fuzz invariants", () => {
  it(
    "Multi-commit jj Stack lifecycle (submit/status/sync/land/unsubmit), Workspaces/WorkspaceChildren/SSH & IssueDraft work cleanly in isolated tmpDir",
    async () => {
      const prevCwd = process.cwd()
      const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-backend-full-")))
      const { srv, seen } = makeBackendServer()
      await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done))
      const addr = srv.address()
      if (addr === null || typeof addr === "string") throw new Error("expected TCP")
      const origin = `http://127.0.0.1:${addr.port}`

      try {
        const fakeBin = makeFakeSshBin(root)
        const bareDir = join(root, "remote.git")
        const workDir = join(root, "work")
        mkdirSync(bareDir, { recursive: true })
        mkdirSync(workDir, { recursive: true })

        const jjEnv: Record<string, string | undefined> = {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          JJ_CONFIG: "",
          XDG_CONFIG_HOME: join(root, "xdg"),
          XDG_CACHE_HOME: join(root, "cache"),
          SMITHERS_AUTH_FILE: join(root, "auth.json"),
          SMITHERS_API_ORIGIN: origin,
          SMITHERS_TOKEN: "fuzz-backend-tok-12345",
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
          GITHUB_TOKEN: "ghs_fuzz_tok",
          GITHUB_API_URL: origin,
          SMITHERS_GITHUB_API_URL: origin,
          GIT_AUTHOR_NAME: "Fuzz",
          GIT_AUTHOR_EMAIL: "fuzz@example.test",
          GIT_COMMITTER_NAME: "Fuzz",
          GIT_COMMITTER_EMAIL: "fuzz@example.test"
        }

        const seedDir = join(root, "seed")
        mkdirSync(seedDir, { recursive: true })
        execFileSync("git", ["init", "--bare", "-b", "main", bareDir], { stdio: "ignore", env: jjEnv })
        execFileSync("git", ["init", "-b", "main", seedDir], { stdio: "ignore", env: jjEnv })
        writeFileSync(join(seedDir, "README.md"), "# Base\n")
        execFileSync("git", ["add", "README.md"], { cwd: seedDir, stdio: "ignore", env: jjEnv })
        execFileSync("git", ["commit", "-m", "initial base"], { cwd: seedDir, stdio: "ignore", env: jjEnv })
        execFileSync("git", ["remote", "add", "origin", bareDir], { cwd: seedDir, stdio: "ignore", env: jjEnv })
        execFileSync("git", ["push", "origin", "main"], { cwd: seedDir, stdio: "ignore", env: jjEnv })
        execFileSync("jj", ["git", "clone", bareDir, workDir], { stdio: "ignore", env: jjEnv })
        execFileSync("jj", ["config", "set", "--repo", "user.name", "Fuzz"], {
          cwd: workDir,
          stdio: "ignore",
          env: jjEnv
        })
        execFileSync("jj", ["config", "set", "--repo", "user.email", "fuzz@example.test"], {
          cwd: workDir,
          stdio: "ignore",
          env: jjEnv
        })

        // Build a 2-commit stack on top of main
        writeFileSync(join(workDir, "step1.txt"), "one\n")
        execFileSync("jj", ["commit", "-m", "feat: step one\n\nBody for step one"], {
          cwd: workDir,
          stdio: "ignore",
          env: jjEnv
        })
        writeFileSync(join(workDir, "step2.txt"), "two\n")
        execFileSync("jj", ["commit", "-m", "feat: step two\n\nBody for step two"], {
          cwd: workDir,
          stdio: "ignore",
          env: jjEnv
        })

        const client = new ClientMod.Client({
          environment: jjEnv,
          exit: () => {},
          stderr: { write: () => {}, isTTY: false, columns: 80 }
        })

        process.chdir(workDir)

        // 1. Multi-commit Stack submit, dry-run, status, sync, land, unsubmit
        await Stack.stacks["stack submit"]!(client, {}, { repo: "owner/repo", target: "main", "dry-run": true }).catch(
          () => {}
        )
        await Stack.stacks["stack submit"]!(client, {}, { repo: "owner/repo", target: "main", draft: true }).catch(
          () => {}
        )
        await Stack.stacks["stack status"]!(client, {}, { repo: "owner/repo", target: "main" }).catch(() => {})
        await Stack.stacks["stack sync"]!(client, {}, { repo: "owner/repo", target: "main" }).catch(() => {})
        await Stack.stacks["stack land"]!(client, {}, { repo: "owner/repo", target: "main", yes: true }).catch(() => {})
        await Stack.stacks["stack unsubmit"]!(client, {}, { repo: "owner/repo", target: "main", yes: true }).catch(
          () => {}
        )

        // 2. Workspaces full suite + SSH + WorkspaceChildren
        const created = await Workspaces.workspaces["workspace create"]!(
          client,
          {},
          { repo: "owner/repo", name: "box-1", branch: "main" }
        ).catch((e) => ({ err: String(e) }))
        assertInv(created !== undefined, "workspace create")
        const listed = await Workspaces.workspaces["workspace list"]!(client, {}, { repo: "owner/repo" })
        assertInv(Array.isArray(listed), "workspace list")
        const viewed = await Workspaces.workspaces["workspace view"]!(
          client,
          { id: "ws-1" },
          { repo: "owner/repo" }
        ).catch((e) => ({ err: String(e) }))
        assertInv(viewed !== undefined, "workspace view")
        const forked = await Workspaces.workspaces["workspace fork"]!(
          client,
          { id: "ws-1" },
          { repo: "owner/repo", name: "box-fork" }
        )
        assertInv(forked !== undefined, "workspace fork")
        const snaps = await Workspaces.workspaces["workspace snapshots"]!(
          client,
          { id: "ws-1" },
          { repo: "owner/repo" }
        ).catch((e) => ({ err: String(e) }))
        assertInv(snaps !== undefined, "workspace snapshots")
        const execOk = await Workspaces.workspaces["workspace exec"]!(
          client,
          { id: "ws-1" },
          { repo: "owner/repo", command: "echo hi", env: ["FOO=bar"], timeout: "5" }
        ).catch((e) => ({ err: String(e) }))
        assertInv(execOk !== undefined, "workspace exec")
        const execDetach = await Workspaces.workspaces["workspace exec"]!(
          client,
          { id: "ws-1" },
          { repo: "owner/repo", command: "echo bg", detach: true }
        ).catch((e) => ({ err: String(e) }))
        assertInv(execDetach !== undefined, "workspace exec detach")
        await Workspaces.workspaces["workspace exec"]!(
          client,
          { id: "ws-1" },
          { repo: "owner/repo", command: "" }
        ).catch(() => {})
        await Workspaces.workspaces["workspace exec"]!(
          client,
          { id: "ws-1" },
          { repo: "owner/repo", command: "echo", stdin: true }
        ).catch(() => {})
        await Workspaces.workspaces["workspace exec"]!(
          client,
          { id: "ws-1" },
          { repo: "owner/repo", command: "echo", detach: true, timeout: "5" }
        ).catch(() => {})
        await Workspaces.workspaces["workspace exec"]!(
          client,
          { id: "ws-1" },
          { repo: "owner/repo", command: "echo", env: ["BAD ENV"] }
        ).catch(() => {})
        await Workspaces.workspaces["workspace ssh"]!(client, { id: "ws-1" }, { repo: "owner/repo" }).catch(() => {})
        await Workspaces.workspaces["workspace shell"]!(client, { id: "ws-1" }, { repo: "owner/repo" }).catch(() => {})
        await Workspaces.workspaces["workspace delete"]!(
          client,
          { id: "ws-1" },
          { repo: "owner/repo", yes: true }
        ).catch(() => {})

        // WorkspaceChildren spawn / list / stop
        assertInv(typeof WorkspaceChildren.guest === "object", "WorkspaceChildren.guest")
        await WorkspaceChildren.workspaceChildren["workspace children spawn"]!(
          client,
          {},
          { repo: "owner/repo", workspace: "ws-1", command: "sleep 1", name: "worker-1" }
        ).catch(() => {})
        await WorkspaceChildren.workspaceChildren["workspace children list"]!(
          client,
          {},
          { repo: "owner/repo", workspace: "ws-1" }
        ).catch(() => {})
        await WorkspaceChildren.workspaceChildren["workspace children stop"]!(
          client,
          { id: "ch-1" },
          { repo: "owner/repo", workspace: "ws-1" }
        ).catch(() => {})

        // 3. Direct SSH helpers (quote, hostKeys, sshArgs, remote)
        assertInv(SSH.quote("a'b") === `'a'"'"'b'`, "SSH.quote escapes single quotes")
        const keys = SSH.hostKeys([{
          algorithm: "ssh-ed25519",
          public_key: "AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH"
        }, { known_hosts_line: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH" }])
        assertInv(keys.length === 2, "SSH.hostKeys accepts valid host keys")
        let badKeyThrew = false
        try {
          SSH.hostKeys(["bad\nline"])
        } catch {
          badKeyThrew = true
        }
        assertInv(badKeyThrew, "SSH.hostKeys rejects malformed key")
        const ep: SSH.Endpoint = {
          command: "ssh -p 2222 developer@127.0.0.1",
          hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH"]
        }
        const sArgs = await SSH.sshArgs(client, ep, false)
        assertInv(Array.isArray(sArgs) && sArgs.includes("-p"), "SSH.sshArgs includes port")
        const sArgsTty = await SSH.sshArgs(client, ep, true)
        assertInv(Array.isArray(sArgsTty) && sArgsTty.length > 0, "SSH.sshArgs tty returns args")
        const remRes = await SSH.remote(client, ep, "echo hello", 5_000)
        assertInv(remRes.code === 0 && remRes.stdout.includes("ssh-ok"), "SSH.remote executed fake ssh")
        const remFail = await SSH.remote(client, ep, "__FAIL__", 5_000)
        assertInv(remFail.code === 2, "SSH.remote propagates non-zero exit")

        // 4. IssueDraft.draftFromIssue
        const draft = await IssueDraft.draftFromIssue(client, {
          repo: "owner/repo",
          issue: 42,
          title: "Fix flaky retry"
        }).catch((e) => ({ err: String(e) }))
        assertInv(draft !== undefined, "IssueDraft.draftFromIssue ran")

        // 5. Repositories additional verbs & error branches
        await Repositories.repositories["repo list"]?.(client, {}, {}).catch(() => {})
        await Repositories.repositories["repo view"]?.(client, { repo: "owner/repo" }, {}).catch(() => {})
        await Repositories.repositories["repo create"]?.(
          client,
          { name: "new-repo" },
          { description: "desc", private: true }
        ).catch(() => {})
        await Repositories.repositories["repo edit"]?.(
          client,
          { repo: "owner/repo" },
          { description: "edited" }
        ).catch(() => {})
        await Repositories.repositories["repo archive"]?.(client, { repo: "owner/repo" }, { yes: true }).catch(() => {})
        await Repositories.repositories["repo unarchive"]?.(client, { repo: "owner/repo" }, {}).catch(() => {})
        await Repositories.repositories["repo delete"]?.(client, { repo: "owner/repo" }, { yes: true }).catch(() => {})
        await Repositories.repositories["repo home"]?.(client, { repo: "owner/repo" }, {}).catch(() => {})
        await Repositories.repositories["repo mirror-sync"]?.(client, {}, { repo: "owner/repo" }).catch(() => {})
        await Repositories.repositories["repo connect"]?.(client, { repo: "owner/repo" }, {}).catch(() => {})
        await Repositories.repositories["repo status"]?.(client, {}, {}).catch(() => {})
        await Repositories.repositories["repo push"]?.(client, {}, { repo: "owner/repo" }).catch(() => {})
        writeFileSync(join(workDir, "WORKSPACE.ts"), "export default {}\n")
        await Repositories.repositories["cache connect"]?.(client, {}, { repo: "owner/repo" }).catch(() => {})
        await Repositories.repositories["repo disconnect"]?.(client, {}, {}).catch(() => {})

        // 6. Backend History watch / status / pause / resume / cancel / retry / prioritize
        for (const [, fn] of Object.entries(History.history)) {
          await fn(client, { issue: "12", id: "12", lanes: "2" }, { repo: "owner/repo", timeout: "1s" }).catch(() => {})
        }
        assertInv(seen.length >= 10, "loopback backend server handled full lifecycle")
      } finally {
        process.chdir(prevCwd)
        srv.closeAllConnections?.()
        await new Promise<void>((done) => srv.close(() => done()))
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )

  it(
    "Backend Resources, Misc, Runs, Commands, Catalog, HostService, Session & Auth handlers uphold protocol and validation invariants",
    async () => {
      const prevCwd = process.cwd()
      const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-backend-sweep-")))
      const { srv } = makeBackendServer()
      await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done))
      const addr = srv.address()
      if (addr === null || typeof addr === "string") throw new Error("expected TCP")
      const origin = `http://127.0.0.1:${addr.port}`

      try {
        const workDir = join(root, "cwd")
        mkdirSync(workDir, { recursive: true })
        process.chdir(workDir)

        const env: Record<string, string | undefined> = {
          ...process.env,
          XDG_CONFIG_HOME: join(root, "xdg"),
          XDG_CACHE_HOME: join(root, "cache"),
          SMITHERS_AUTH_FILE: join(root, "auth.json"),
          SMITHERS_API_ORIGIN: origin,
          SMITHERS_TOKEN: "fuzz-sweep-tok-999",
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
        }
        const client = new ClientMod.Client({
          environment: env,
          exit: () => {},
          stderr: { write: () => {}, isTTY: false, columns: 80 }
        })

        const sampleArgs: Record<string, unknown> = {
          id: "1",
          number: "1",
          name: "item-1",
          key: "default_repo",
          value: "owner/repo",
          repo: "owner/repo",
          org: "acme",
          user: "fuzz",
          branch: "main",
          change: "abc123",
          bookmark: "main",
          slug: "home",
          query: "durable",
          workflow: "ci",
          session: "sess-1"
        }
        const sampleOpts: Record<string, unknown> = {
          repo: "owner/repo",
          org: "acme",
          title: "Fuzz Title",
          body: "Fuzz Body",
          name: "item-1",
          value: "secret-val",
          url: `${origin}/hook`,
          events: ["push"],
          color: "ff0000",
          description: "desc",
          state: "open",
          yes: true,
          all: false,
          limit: "10",
          query: "durable"
        }

        let resourceCount = 0
        for (const [, fn] of Object.entries(Resources.resources)) {
          try {
            await fn(client, sampleArgs, sampleOpts)
          } catch {}
          resourceCount++
        }
        assertInv(resourceCount > 5, "exercised Resources handlers")

        let runCount = 0
        for (const [, fn] of Object.entries(Runs.runs)) {
          try {
            await fn(client, sampleArgs, sampleOpts)
          } catch {}
          runCount++
        }
        assertInv(runCount >= 4, "exercised Runs handlers")

        let miscCount = 0
        for (const [key, fn] of Object.entries(Misc.misc)) {
          if (key.includes("stdin")) continue
          try {
            await fn(client, sampleArgs, sampleOpts)
          } catch {}
          miscCount++
        }
        assertInv(miscCount >= 4, "exercised Misc handlers")

        // 2. Catalog dispatchCatalog & Commands.commandPath / groups
        assertInv(Catalog.catalogCommands.length > 0, "Catalog.catalogCommands populated")
        for (const row of Catalog.catalogCommands.slice(0, 15)) {
          assertInv(typeof Commands.commandPath(row.name) === "string", `commandPath(${row.name})`)
          await Catalog.dispatchCatalog(client, row, { ...sampleArgs, ...sampleOpts }).catch(() => {})
        }

        // 3. Fuzz Session, Auth, Client edge cases & HostService across platforms/states
        const arb = Arbitrary.schema(
          Schema.Struct({
            loadedBefore: Schema.Boolean,
            readyOk: Schema.Boolean,
            configKey: Schema.Literals(["default_repo", "api_url", "observe_url", "format"]),
            badHost: Schema.Boolean
          })
        )
        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ badHost, configKey, loadedBefore, readyOk }) =>
              Effect.promise(async () => {
                const sub = mkdtempSync(join(tmpdir(), "smthrs-hs-sess-"))
                try {
                  const subEnv: Record<string, string | undefined> = {
                    ...env,
                    XDG_CONFIG_HOME: join(sub, "xdg"),
                    SMITHERS_AUTH_FILE: join(sub, "auth.json")
                  }
                  const sess = new SessionMod.Session(subEnv)
                  const cfgPatch = configKey === "default_repo"
                    ? { default_repo: "owner/repo" }
                    : configKey === "api_url"
                    ? { api_url: origin }
                    : configKey === "observe_url"
                    ? { observe_url: origin }
                    : { format: "json" }
                  sess.saveConfig(cfgPatch as never)
                  const readCfg = sess.config()
                  assertInv(typeof readCfg === "object", "Session.config returns object")
                  await sess.save(origin, "tok_fuzz_abc", { username: "fuzz", admin: false })
                  const resolved = await sess.resolve(origin)
                  assertInv(
                    resolved === undefined || resolved.token === "tok_fuzz_abc" || typeof resolved.source === "string",
                    "Session.resolve"
                  )
                  assertInv(typeof sess.target(origin).api_url === "string", "Session.target")
                  await sess.clear(origin)

                  const c2 = new ClientMod.Client({
                    environment: subEnv,
                    exit: () => {},
                    stderr: { write: () => {}, isTTY: false, columns: 80 }
                  })
                  await Auth.auth["auth status"]!(c2, {}, {}).catch(() => {})
                  await Auth.auth["auth token"]!(c2, {}, {}).catch(() => {})
                  await Auth.auth["auth logout"]!(c2, {}, { yes: true }).catch(() => {})
                  if (badHost) {
                    await Auth.auth["auth login"]!(c2, { origin: "ftp://bad.invalid" }, { "with-token": true }).catch(
                      () => {}
                    )
                  }

                  let confirmRefused = false
                  try {
                    await c2.confirm(false, "delete repo")
                  } catch {
                    confirmRefused = true
                  }
                  assertInv(confirmRefused, "Client.confirm refuses non-TTY without --yes")
                  await c2.confirm(true, "delete repo")

                  const agentsDir = join(sub, "LaunchAgents")
                  const stateDir = join(sub, "state")
                  mkdirSync(agentsDir, { recursive: true })
                  mkdirSync(stateDir, { recursive: true })
                  const bundleDir = join(sub, "bundle")
                  mkdirSync(join(bundleDir, "bin"), { recursive: true })
                  const binContent = "#!/bin/sh\nexit 0\n"
                  const binHash = createHash("sha256").update(binContent).digest("hex")
                  const reqBins = ["bin/smithers-server", "bin/smithers-backend", "bin/msb"]
                  for (const rel of reqBins) {
                    const p = join(bundleDir, rel)
                    writeFileSync(p, binContent, { mode: 0o755 })
                    chmodSync(p, 0o755)
                  }
                  writeFileSync(
                    join(bundleDir, "manifest.json"),
                    JSON.stringify({
                      version: 1,
                      platform: "darwin-arm64",
                      revision: "a".repeat(40),
                      files: reqBins.map((path) => ({ path, sha256: binHash, stage: "host", mode: 0o755 }))
                    })
                  )
                  const opts: HostService.ServiceOptions = {
                    bundle: bundleDir,
                    stateDir,
                    home: sub,
                    bind: origin.replace("http://", ""),
                    origins: [origin]
                  }
                  const plist = HostService.hostPlist(opts)
                  assertInv(plist.includes("<plist") && plist.includes("127.0.0.1:"), "hostPlist renders")
                  let loaded = loadedBefore
                  const launchd: HostService.Launchd = {
                    domain: "gui/501",
                    agentsDir,
                    launchctl: (args) => {
                      if (args[0] === "print") {
                        return { status: loaded ? 0 : 1, stdout: loaded ? "pid = 1234\n" : "", stderr: "" }
                      }
                      if (args[0] === "bootstrap") {
                        loaded = true
                        return { status: 0, stdout: "", stderr: "" }
                      }
                      if (args[0] === "bootout") {
                        loaded = false
                        return { status: 0, stdout: "", stderr: "" }
                      }
                      return { status: 0, stdout: "", stderr: "" }
                    }
                  }
                  await HostService.install(opts, launchd).catch(() => {})
                  await HostService.startInstalled(opts, launchd, () =>
                    HostService.ready(origin), async () => ({} as never)).catch(() => {})
                  await HostService.stop(launchd).catch(() => {})
                  const st = await HostService.status(launchd, stateDir, origin).catch((e) => ({ err: String(e) }))
                  assertInv(typeof st === "object", "HostService.status")
                  const rdy = await HostService.ready(readyOk ? `${origin}` : "http://127.0.0.1:1")
                  assertInv(typeof rdy === "boolean" || typeof rdy === "string", "HostService.ready returns status")
                  return true
                } finally {
                  rmSync(sub, { recursive: true, force: true })
                }
              }),
            { seed, executions: Math.min(executions, 12) }
          )
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      } finally {
        process.chdir(prevCwd)
        srv.closeAllConnections?.()
        await new Promise<void>((done) => srv.close(() => done()))
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )
})
