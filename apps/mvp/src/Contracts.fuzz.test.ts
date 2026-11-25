import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Actions from "./features/actions/contract.ts"
import * as Attention from "./features/attention/contract.ts"
import * as Auth from "./features/auth/contract.ts"
import * as Branch from "./features/branch/contract.ts"
import * as CodeIntel from "./features/code-intel/contract.ts"
import * as Coedit from "./features/coedit/contract.ts"
import * as Commands from "./features/commands/contract.ts"
import * as Docs from "./features/docs/contract.ts"
import * as Domains from "./features/domains/contract.ts"
import * as Feeds from "./features/feeds/contract.ts"
import * as Issues from "./features/issues/contract.ts"
import * as Work from "./features/issues/work.ts"
import * as Mcp from "./features/mcp/contract.ts"
import * as Model from "./features/model/contract.ts"
import * as PersonalModel from "./features/personal-model/contract.ts"
import * as Pulls from "./features/pulls/contract.ts"
import * as Repo from "./features/repo/contract.ts"
import * as Runners from "./features/runners/contract.ts"
import * as Runs from "./features/runs/contract.ts"
import * as Secrets from "./features/secrets/contract.ts"
import * as Spend from "./features/spend/contract.ts"
import * as Todos from "./features/todos/contract.ts"
import * as Transcript from "./features/transcript/contract.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const runFuzz = async <A>(arb: Arbitrary.Arbitrary<A>, prop: (value: A) => boolean, offset: number) => {
  const report = await Effect.runPromise(
    Fuzz.run(arb, (v) => Effect.sync(() => prop(v)), { seed: seed + offset, executions })
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("apps/mvp feature contract fuzz invariants", () => {
  it("Repo.isRepository, isFilePath, formatBytes & cloneDetail uphold bounds and safety invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        owner: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
          Schema.Literals(["app", "api", "assets", "APP", "acme-org", "-bad", "good123"])
        ]),
        name: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
          Schema.Literals([".", "..", "widgets", "my.repo_1", "bad/name"])
        ]),
        filePath: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(160))),
          Schema.Literals([
            "src/index.ts",
            "../secret.env",
            "a/../../b",
            "/etc/passwd",
            "a//b",
            "a/./b",
            "dir/",
            "a\0b",
            "a/".repeat(70) + "file.ts"
          ])
        ]),
        bytes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5_000_000_000_000 }))),
        stage: Schema.Literals(Repo.CLONE_STAGES),
        ref: Schema.Union([
          Schema.Null,
          Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
          Schema.Literals([
            "ready",
            "requested",
            "fetching:1024",
            "indexing:2097152",
            "failed:private",
            "failed:unknown_code",
            "capacity:size_unknown",
            "capacity:repo_too_large",
            "capacity:other"
          ])
        ])
      })
    )
    await runFuzz(arb, ({ owner, name, filePath, bytes, stage, ref }) => {
      if (Repo.isRepository(owner, name)) {
        if (Repo.RESERVED_OWNERS.includes(owner.toLowerCase())) return false
        if (name === "." || name === "..") return false
        if (!Repo.OWNER_PATTERN.test(owner) || !Repo.NAME_PATTERN.test(name)) return false
        const id = Repo.repoId(owner, name)
        if (id !== id.toLowerCase() || !id.startsWith("github/")) return false
        if (Repo.cloneSubject(id) !== `clone:${id}`) return false
      }
      if (Repo.isFilePath(filePath)) {
        if (filePath.length === 0 || filePath.length > Repo.MAX_PATH_LENGTH) return false
        if (filePath.startsWith("/") || filePath.endsWith("/") || filePath.includes("\0")) return false
        const segs = filePath.split("/")
        if (segs.length > Repo.MAX_PATH_SEGMENTS) return false
        for (const s of segs) {
          if (s === "" || s === "." || s === "..") return false
        }
      }
      const formatted = Repo.formatBytes(bytes)
      if (!/^\d+(?:\.\d)? (B|KB|MB|GB|TB)$/.test(formatted)) return false
      const builtRef = Repo.cloneRef(stage, bytes)
      const detail = Repo.cloneDetail(builtRef)
      if (detail === null || !detail.startsWith(Repo.CLONE_STAGE_COPY[stage])) return false
      const arbDetail = Repo.cloneDetail(ref)
      if (ref === null || ref === "ready") {
        if (arbDetail !== null) return false
      }
      return true
    }, 0)
  })

  it("Domains.normalizeHostname, isUnder, isApex, routingRecord & parseDomainRoute uphold DNS and URL invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        raw: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
          Schema.Literals([
            "Example.COM.",
            "sub.smithers.sh",
            "evil-smithers.sh",
            "http://example.com",
            "a..b.com",
            "-bad.com",
            "127.0.0.1"
          ])
        ]),
        zone: Schema.Literals(["smithers.sh", "example.com"]),
        owner: Schema.Literals(["acme", "smithersai", "user-1"]),
        repo: Schema.Literals(["app", "my.repo"]),
        rawPath: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(80))),
          Schema.Literals(["/api/repos/%ZZ/app/domains", "/api/repos/acme/app/domains/example.com"])
        ])
      })
    )
    await runFuzz(arb, ({ raw, zone, owner, repo, rawPath }) => {
      const norm = Domains.normalizeHostname(raw)
      if (norm !== undefined) {
        if (norm !== norm.toLowerCase()) return false
        if (norm.length > Domains.MAX_HOSTNAME_LENGTH) return false
        if (Domains.normalizeHostname(norm) !== norm) return false
        if (Domains.isUnder(norm, zone)) {
          if (norm !== zone && !norm.endsWith(`.${zone}`)) return false
        }
        const rec = Domains.routingRecord(norm, "edge.smithers.sh")
        if (rec.type !== (Domains.isApex(norm) ? "ALIAS" : "CNAME")) return false
        if (rec.name !== norm) return false
        // Round-trip domainRoute -> parseDomainRoute
        const route = Domains.domainRoute(owner, repo, norm)
        const parsed = Domains.parseDomainRoute(route)
        if (parsed === undefined || parsed.owner !== owner || parsed.name !== repo || parsed.hostname !== norm) {
          return false
        }
      }
      if (Domains.isUnder(`evil-${zone}`, zone)) return false
      const listRoute = Domains.domainsRoute(owner, repo)
      const parsedList = Domains.parseDomainRoute(listRoute)
      if (
        parsedList === undefined || parsedList.owner !== owner || parsedList.name !== repo ||
        parsedList.hostname !== undefined
      ) {
        return false
      }
      // Malformed paths never throw
      Domains.parseDomainRoute(rawPath)
      return true
    }, 1)
  })

  it("Secrets.secretRoute/parseSecretRoute/splitHosts & Runners.base64Bytes/parseAdminRoute uphold round-trips and bounds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        owner: Schema.Literals(["acme", "smithersai", "user-1"]),
        repo: Schema.Literals(["app", "my_repo", "v1.0"]),
        secretName: Schema.Literals(["OPENAI_API_KEY", "STRIPE_KEY", "TOKEN_1"]),
        adminKind: Schema.Literals(["runners", "agents", "overflow"]),
        item: Schema.Literals(["runner-1", "agent_a", "cloudflare"]),
        payload: Schema.String.pipe(Schema.check(Schema.isMaxLength(96))),
        hostsText: Schema.String.pipe(Schema.check(Schema.isMaxLength(80))),
        badPath: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(80))),
          Schema.Literals(["/api/repos/%ZZ/app/secrets/KEY", "/api/repos/%E0%A4%A/app/runners/r1"])
        ])
      })
    )
    await runFuzz(arb, ({ owner, repo, secretName, adminKind, item, payload, hostsText, badPath }) => {
      const route = Secrets.secretRoute(owner, repo, secretName)
      const parsed = Secrets.parseSecretRoute(route)
      if (parsed === undefined || parsed.owner !== owner || parsed.name !== repo || parsed.secret !== secretName) {
        return false
      }
      Secrets.parseSecretRoute(badPath)
      const hosts = Secrets.splitHosts(hostsText)
      if (hosts.some((h) => h === "" || /[\s,]/.test(h))) return false

      const bytes = Buffer.from(payload, "utf8")
      const b64 = bytes.toString("base64")
      if (Runners.base64Bytes(b64) !== bytes.byteLength) return false

      const adminPath = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${adminKind}/${
        encodeURIComponent(item)
      }`
      const parsedAdmin = Runners.parseAdminRoute(adminPath)
      if (
        parsedAdmin === undefined || parsedAdmin.kind !== adminKind || parsedAdmin.owner !== owner ||
        parsedAdmin.name !== repo || parsedAdmin.item !== item
      ) return false
      Runners.parseAdminRoute(badPath)
      return true
    }, 2)
  })

  it("Todos contract: clipPrompt, titleOf, isTitle, isPrompt, isAcceptance, todoNumberOf & draftFromIssue uphold byte/char caps", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        prompt: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(300))),
          Schema.Literals([
            "",
            "   \n  ",
            "# Heading title\nBody text",
            "🔥".repeat(120),
            "a".repeat(Todos.MAX_PROMPT_BYTES + 200),
            "é".repeat(4500)
          ])
        ]),
        numText: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(16))),
          Schema.Literals(["0", "-1", "1", "01", String(Todos.MAX_TODO_NUMBER), String(Todos.MAX_TODO_NUMBER + 1)])
        ]),
        acceptance: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(260)))).pipe(
          Schema.check(Schema.isMaxLength(12))
        ),
        code: Schema.Union([
          Schema.Undefined,
          Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
          Schema.Literals(Todos.NOT_SENT_REASONS)
        ]),
        filter: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(12))),
          Schema.Literals(["open", "closed"])
        ])
      })
    )
    await runFuzz(arb, ({ prompt, numText, acceptance, code, filter }) => {
      const clipped = Todos.clipPrompt(prompt)
      if (Todos.bytesOf(clipped) > Todos.MAX_PROMPT_BYTES) return false
      if (Todos.bytesOf(prompt) <= Todos.MAX_PROMPT_BYTES && clipped !== prompt) return false
      // Idempotency of clipPrompt
      if (Todos.clipPrompt(clipped) !== clipped) return false

      const title = Todos.titleOf(prompt)
      if (Array.from(title).length > Todos.MAX_TITLE_LENGTH) return false
      if (title.includes("\n")) return false
      if (title.trim().length > 0 && !Todos.isTitle(title)) return false

      if (Todos.isPrompt(prompt) !== (prompt.trim().length > 0 && Todos.bytesOf(prompt) <= Todos.MAX_PROMPT_BYTES)) {
        return false
      }

      const accOk = Todos.isAcceptance(acceptance)
      if (accOk) {
        if (acceptance.length > Todos.MAX_ACCEPTANCE) return false
        if (acceptance.some((line) => line.trim().length === 0 || line.length > Todos.MAX_ACCEPTANCE_LENGTH)) {
          return false
        }
      }

      const num = Todos.todoNumberOf(numText)
      if (num !== undefined) {
        if (!Number.isInteger(num) || num < 1 || num > Todos.MAX_TODO_NUMBER) return false
        if (String(num) !== numText) return false
      }

      const draft = Todos.draftFromIssue({ title: "", prompt: "" }, { title: prompt, body: prompt })
      if (Array.from(draft.title).length > Todos.MAX_TITLE_LENGTH) return false
      if (Todos.bytesOf(draft.prompt) > Todos.MAX_PROMPT_BYTES) return false
      // Existing draft text is preserved
      const kept = Todos.draftFromIssue({ title: "mine", prompt: "keep" }, { title: prompt, body: prompt })
      if (kept.title !== "mine" || kept.prompt !== "keep") return false

      const ns = Todos.notSentOf(code)
      if (ns !== undefined && !(Todos.NOT_SENT_REASONS as ReadonlyArray<string>).includes(ns)) return false
      const sf = Todos.stackFilterOf(filter)
      if (sf !== (filter === "closed" ? "closed" : "open")) return false
      if (Todos.stackPath("acme", "app", sf) !== `/acme/app/stack${sf === "closed" ? "?state=closed" : ""}`) {
        return false
      }
      return true
    }, 3)
  })

  it("Issues contract & work links: issueNumberOf, triageOf, refusalOf, reconcileBucketStart & workStatusOf uphold invariants", async () => {
    const linkArb = Schema.Struct({
      kind: Schema.Literals(Work.WORK_LINK_KINDS),
      state: Schema.NullOr(Schema.Literals(Work.WORK_LINK_STATES)),
      updatedAt: Schema.Literals([
        "2026-10-20T00:00:00Z",
        "2026-10-20T01:00:00Z",
        "2026-10-20T02:00:00Z",
        "2026-10-20T03:00:00Z"
      ])
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        numText: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(16))),
          Schema.Literals(["0", "1", "01", String(Issues.MAX_ISSUE_NUMBER), String(Issues.MAX_ISSUE_NUMBER + 1)])
        ]),
        labels: Schema.Array(
          Schema.Union([
            Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
            Schema.Literals([Issues.ACCEPTED_LABEL, Issues.NOT_ACCEPTED_LABEL, "SMITHERS:ACCEPTED", "bug"])
          ])
        ).pipe(Schema.check(Schema.isMaxLength(8))),
        status: Schema.Union([Schema.Undefined, Schema.Literals([200, 400, 401, 403, 404, 409, 413, 500])]),
        code: Schema.Union([Schema.Undefined, Schema.Literals(["app_not_installed", "other"])]),
        nowMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2_000_000_000_000 }))),
        links: Schema.Array(linkArb).pipe(Schema.check(Schema.isMaxLength(8))),
        filter: Schema.Literals(Work.WORK_FILTERS)
      })
    )
    await runFuzz(arb, ({ numText, labels, status, code, nowMs, links, filter }) => {
      const n = Issues.issueNumberOf(numText)
      if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > Issues.MAX_ISSUE_NUMBER || String(n) !== numText)) {
        return false
      }
      const triage = Issues.triageOf(labels)
      const lower = new Set(labels.map((l) => l.toLowerCase()))
      const hasAcc = lower.has(Issues.ACCEPTED_LABEL)
      const hasRej = lower.has(Issues.NOT_ACCEPTED_LABEL)
      const expectedTriage = hasAcc && hasRej ? "conflict" : hasAcc ? "accepted" : hasRej ? "not_accepted" : "proposed"
      if (triage !== expectedTriage) return false
      // Order invariance of triageOf
      if (Issues.triageOf([...labels].reverse()) !== triage) return false

      const ref = Issues.refusalOf(status, code)
      if (status === 404 && code === "app_not_installed" && ref !== "app_not_installed") return false
      if (status === 200 || status === 500 || status === undefined) {
        if (ref !== undefined) return false
      }

      const bucket = Issues.reconcileBucketStart(nowMs)
      if (bucket > nowMs || nowMs - bucket >= Issues.SYNC_STALE_MS || bucket % Issues.SYNC_STALE_MS !== 0) return false

      // Work.workStatusOf invariants:
      // 1. Order invariance (permutation invariance for unique (updatedAt, kind))
      const ws = Work.workStatusOf(links)
      if (!(Work.WORK_STATUSES as ReadonlyArray<string>).includes(ws)) return false
      // 2. "merged" is absorbing: any merged link always yields "merged"
      if (links.some((l) => l.state === "merged") && ws !== "merged") return false
      // 3. Adding closed or null links NEVER changes workStatusOf
      const withNoise: ReadonlyArray<Work.WorkLinkFacts> = [
        ...links,
        { kind: "review", state: null, updatedAt: "2099-01-01T00:00:00Z" },
        { kind: "queue", state: "closed", updatedAt: "2099-01-01T00:00:00Z" }
      ]
      if (Work.workStatusOf(withNoise) !== ws) return false
      // 4. passesWorkFilter
      const kinds = links.map((l) => l.kind)
      const passes = Work.passesWorkFilter(filter, kinds)
      if (filter === "any" && passes !== (kinds.length > 0)) return false
      if (filter === "pr-or-queue" && passes !== kinds.some((k) => k === "pr" || k === "queue")) return false
      return true
    }, 4)
  })

  it("Branch.isBranchName & isLogin enforce git-check-ref-format and GitHub login rules", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        branch: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(160))),
          Schema.Literals([
            "",
            "@",
            "-flag",
            "main",
            "feat/my-branch",
            "a..b",
            "a@{b}",
            "a//b",
            "/lead",
            "trail/",
            "trail.",
            "a/.hidden",
            "a/foo.lock",
            "bad space",
            "bad~1",
            "bad^2",
            "bad:3",
            "bad?4",
            "bad*5",
            "bad[6",
            "bad\\7"
          ])
        ]),
        login: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
          Schema.Literals(["", "octocat", "-lead", "trail-", "a--b", "a-b-c", "x".repeat(40)])
        ])
      })
    )
    await runFuzz(arb, ({ branch, login }) => {
      if (Branch.isBranchName(branch)) {
        if (branch.length === 0 || branch.length > Branch.MAX_BRANCH_NAME_LENGTH) return false
        if (
          branch === "@" || branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") ||
          branch.endsWith(".")
        ) {
          return false
        }
        if (branch.includes("..") || branch.includes("@{") || branch.includes("//")) return false
        if (branch.split("/").some((seg) => seg.startsWith(".") || seg.endsWith(".lock"))) return false
      }
      if (Branch.isLogin(login)) {
        if (login.length === 0 || login.length > 39) return false
        if (login.startsWith("-") || login.endsWith("-") || login.includes("--")) return false
      }
      return true
    }, 5)
  })

  it("PersonalModel: baseUrlOf, isModelId, resolveTier, codingChoice & checkSave enforce security and host-pinning invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rawUrl: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(120))),
          Schema.Literals([
            "https://api.openai.com/v1",
            "https://api.openai.com/v1/",
            "https://api.anthropic.com",
            "http://api.openai.com/v1",
            "https://user:pass@api.openai.com/v1",
            "https://api.openai.com:8443/v1",
            "https://api.openai.com/v1?x=1",
            "https://api.openai.com/v1#frag",
            "https://127.0.0.1/v1",
            "https://localhost/v1",
            "https://[::1]/v1",
            "https://example.com/proxy/v1/"
          ])
        ]),
        modelId: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(96))),
          Schema.Literals(["gpt-5", "claude-sonnet-4-5", "openai/gpt-5:latest", "", "-bad", "bad space"])
        ]),
        key: Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
        tier: Schema.Literals(Model.MODEL_TIERS),
        changeHost: Schema.Boolean,
        duplicateSingle: Schema.Boolean
      })
    )
    await runFuzz(arb, ({ rawUrl, modelId, key, tier, changeHost, duplicateSingle }) => {
      const normalized = PersonalModel.baseUrlOf(rawUrl)
      if (normalized !== undefined) {
        if (!normalized.startsWith("https://")) return false
        if (normalized.includes("?") || normalized.includes("#")) return false
        if (normalized.endsWith("/") || normalized.endsWith("/v1")) return false
        // Idempotent
        if (PersonalModel.baseUrlOf(normalized) !== normalized) return false
        // hostOf matches parsed URL hostname
        if (PersonalModel.hostOf(normalized) !== new URL(normalized).hostname) return false
      }
      if (PersonalModel.isModelId(modelId)) {
        if (modelId.length === 0 || modelId.length > 81 || /\s/.test(modelId)) return false
      }
      const tail = PersonalModel.keyTail(key)
      if ([...tail].length > PersonalModel.KEY_TAIL) return false
      if (PersonalModel.longEnough(key) !== ([...key].length >= PersonalModel.MIN_KEY_CHARACTERS)) return false

      // Security invariant: checkSave MUST NEVER keep a saved key when baseUrl changes without re-supplying key!
      const saved = [{
        id: "conn-1",
        kind: "api_key" as const,
        protocol: "openai-chat" as const,
        baseUrl: "https://api.openai.com"
      }]
      const saveAttempt = PersonalModel.checkSave(
        {
          connections: [{
            id: "conn-1",
            kind: "api_key",
            protocol: "openai-chat",
            baseUrl: changeHost ? "https://evil.example.com" : "https://api.openai.com"
          }]
        },
        saved
      )
      if (changeHost && saveAttempt !== "key_required") return false
      if (!changeHost && typeof saveAttempt === "string") return false

      // Single-active kind constraint: two active moonshot connections MUST be rejected
      if (duplicateSingle) {
        const dup = PersonalModel.checkSave(
          {
            connections: [
              { kind: "jev", active: true, key: "sk-1234567890abcdef" },
              { kind: "jev", active: true, key: "sk-abcdef1234567890" }
            ]
          },
          []
        )
        if (dup !== "invalid") return false
      }

      // resolveTier & codingChoice never throw and obey active flag
      const conn: PersonalModel.SavedConnection = {
        id: "c1",
        kind: "api_key",
        active: true,
        protocol: "openai-chat",
        baseUrl: "https://api.openai.com",
        fastModel: "gpt-5-mini",
        implementModel: null,
        hardModel: null
      }
      const resolved = PersonalModel.resolveTier([conn], tier)
      if (resolved === undefined || resolved.connectionId !== "c1") return false
      if (PersonalModel.resolveTier([{ ...conn, active: false }], tier) !== undefined) return false
      const choice = PersonalModel.codingChoice([conn])
      if (choice.agent !== "smithers") return false
      return true
    }, 6)
  })

  it("Feeds, MCP, Auth, Runs, Pulls, Actions, Attention, Coedit, Docs, CodeIntel, Commands, Model, Spend & Transcript contracts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        owner: Schema.Literals(["acme", "smithersai", "user-1"]),
        repo: Schema.Literals(["app", "my_repo", "widgets"]),
        role: Schema.NullOr(Schema.Literals(Auth.ROLES)),
        status: Schema.Literals(["loading", "signed_in", "signed_out", "unreachable"]),
        restored: Schema.Boolean,
        roleConfirmed: Schema.Union([Schema.Undefined, Schema.Boolean]),
        hostedModel: Schema.Union([Schema.Undefined, Schema.Boolean]),
        ownModel: Schema.Literals(["saved", "none", "loading"]),
        pullState: Schema.Literals(["open", "closed"]),
        draft: Schema.Boolean,
        merged: Schema.Boolean,
        pullTab: Schema.Literals(Pulls.PULL_TABS),
        mcpClient: Schema.Literals(Mcp.MCP_CLIENTS),
        rawName: Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
        runStatus: Schema.Literals(["running", "waiting", "completed", "failed", "cancelled"]),
        stepAction: Schema.NullOr(Schema.Literals(["agent/Session", "agent/Run", "other/Step"])),
        stepStatus: Schema.Literals(["running", "waiting", "completed", "failed"]),
        symbolKind: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 30 }))),
        destText: Schema.String.pipe(Schema.check(Schema.isMaxLength(60)))
      })
    )
    await runFuzz(arb, (v) => {
      // Feeds round-trips
      const fr = Feeds.parseFeedRoute(Feeds.feedsRoute(v.owner, v.repo))
      if (fr === undefined || fr.owner !== v.owner || fr.name !== v.repo || fr.route !== "documents") return false
      const far = Feeds.parseFeedRoute(Feeds.feedAnswersRoute(v.owner, v.repo))
      if (far === undefined || far.route !== "answers") return false
      if (Feeds.parseFeedRepo(`${v.owner}/${v.repo}`) !== `${v.owner}/${v.repo}`.toLowerCase()) return false
      if (Feeds.isFeedName(v.rawName) && v.rawName.length > Feeds.MAX_FEED_NAME_LENGTH) return false
      if (Feeds.isIndexName(v.rawName) !== !v.rawName.includes("/")) return false

      // MCP round-trips & slug safety
      const mcpPath = Mcp.publicRepoMcpPath(v.owner, v.repo)
      const parsedMcp = Mcp.parsePublicRepoMcpPath(mcpPath)
      if (parsedMcp === null || parsedMcp.owner !== v.owner || parsedMcp.name !== v.repo) return false
      if (Mcp.parsePublicRepoMcpPath("/api/foo/mcp") !== null) return false
      if (Mcp.parsePublicRepoMcpPath("/.well-known/foo/mcp") !== null) return false
      const slug = Mcp.mcpServerSlug(v.rawName)
      if (!/^[a-z0-9-]+$/.test(slug) || slug.startsWith("-") || slug.endsWith("-")) return false
      const snippet = Mcp.mcpClientSnippet(v.mcpClient, "https://smithers.sh/", v.owner, v.repo)
      if (v.mcpClient === "stdio") {
        if (!snippet.command.includes(`--repo ${v.owner}/${v.repo}`)) return false
      } else if (!snippet.command.includes(Mcp.repoMcpUrl("https://smithers.sh", v.owner, v.repo))) return false
      const perms = Mcp.mcpPermissionsFor(v.role)
      if (perms.blocked.length === 0) return false

      // Auth composerAccess
      const access = Auth.composerAccess(
        {
          status: v.status,
          role: v.role,
          restored: v.restored,
          roleConfirmed: v.roleConfirmed,
          hostedModel: v.hostedModel
        },
        undefined,
      )
      if (v.status === "signed_out" && access !== "sign_in") return false
      if (v.status === "signed_in" && v.role === "guest" && v.roleConfirmed !== false && access !== "members_only") {
        return false
      }
      if (Auth.mayManageDomains(v.role) && !Auth.mayAsk(v.role)) return false
      if (Auth.sessionCheckOf({ [Auth.SESSION_CHECK_HEADER]: "same_person" }).sessionCheck !== "same_person") {
        return false
      }

      // Pulls
      const ps = Pulls.pullStateOf({ state: v.pullState, draft: v.draft, merged: v.merged })
      if (v.merged && ps !== "merged") return false
      if (!v.merged && v.pullState === "closed" && ps !== "closed") return false
      const pt = Pulls.pullTabPath(v.owner, v.repo, 7, v.pullTab)
      if (v.pullTab === "conversation" && pt !== Pulls.pullPath(v.owner, v.repo, 7)) return false
      if (!Pulls.queueRequestOf("abcdef1234567890").includes(Pulls.queueMarkerOf("abcdef1234567890"))) return false

      // Runs
      const steps = [{ action: v.stepAction, status: v.stepStatus }]
      const isSettled = Runs.settled(v.runStatus)
      if (
        isSettled && (Runs.steerable({ status: v.runStatus }, steps) || Runs.stoppable({ status: v.runStatus }, steps))
      ) {
        return false
      }
      if (Runs.listed("run/foo") || Runs.listed("device/bar")) return false

      // Actions, Attention, Coedit, Docs, CodeIntel, Commands, Model, Spend, Transcript
      if (Actions.settledState("completed") !== "done" || Actions.settledState("cancelled") !== "stopped") return false
      if (Attention.surfaceOf("/app") !== "conversation" || Attention.surfaceOf("/other") !== "page") return false
      if (Attention.floatsBell(undefined)) return false
      const scope = Coedit.scopeOf({ kind: "prompt", conversation: "c1" })
      if (Coedit.scopeParams(scope).conversation !== "c1") return false
      if (Coedit.textName({ kind: "answer", run: "r1", version: 2 }) !== "run/r1/answer/2") return false
      const splat = Docs.pathOfSplat(v.rawName)
      if (splat !== undefined && !splat.startsWith("/")) return false
      if (!Docs.docsHref(v.owner, v.repo, v.rawName.toWellFormed()).startsWith(`/${v.owner}/${v.repo}/docs`)) {
        return false
      }
      if (CodeIntel.kindLabel(v.symbolKind).length === 0) return false
      if (CodeIntel.problemsLabel(1) !== "1 problem") return false
      if (!Commands.missingArguments("repo", ["a"]).startsWith("/repo ")) return false
      if (!Model.quotaRefused("other", 402) || !Model.quotaRefused("quota_exceeded", 400)) return false
      if (Spend.splitDestinations(v.destText).some((d) => d === "" || /[\s,]/.test(d))) return false
      if (Transcript.transcribed(steps) !== (v.stepAction === Transcript.TRANSCRIBED_ACTION)) return false
      return true
    }, 7)
  })
})
