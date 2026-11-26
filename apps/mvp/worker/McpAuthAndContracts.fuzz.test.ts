import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import { describe, expect, it } from "vitest"
import * as DeviceIdentity from "../src/device/identity.vibe"
import * as IssueContract from "../src/features/issues/contract.ts"
import * as TodoView from "../src/features/todos/view.ts"
import * as McpAuth from "./mcp/Auth.vibe"
import { MCP_BLOCKED_ACTS } from "../src/features/mcp/contract.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("apps/mvp MCP Auth, Issues Contract, Device Identity & Todo View fuzz invariants", () => {
  it("McpAuth token parsing, blocked-act enforcement, agentActor & timingSafeEqualString uphold fail-closed auth", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        hexSeed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffff })),
        scheme: Schema.Literals(["Bearer", "bearer", "Basic", "Token", ""]),
        tokenKind: Schema.Literals(["valid", "short", "uppercase", "wrong_prefix", "extra_word", "oversized", "absent"]),
        actIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
        sep: Schema.Literals(["/", "_", "."]),
        tokenId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20)),
        personId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20)),
        login: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20)),
        role: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"]))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ hexSeed, scheme, tokenKind, actIdx, sep, tokenId, personId, login, role }) =>
          Effect.gen(function*() {
            const hex64 = ("a" + hexSeed.toString(16).padStart(3, "0").slice(-3)).repeat(16)
            const validToken = `sma_${hex64}`
            if (!McpAuth.isValidMcpTokenFormat(validToken)) return false
            if (McpAuth.isValidMcpTokenFormat(`sma_${hex64.toUpperCase()}`)) return false
            if (McpAuth.isValidMcpTokenFormat(`smb_${hex64}`)) return false
            if (McpAuth.isValidMcpTokenFormat(`sma_${hex64.slice(0, 63)}`)) return false

            const rawToken =
              tokenKind === "valid"
                ? validToken
                : tokenKind === "short"
                  ? `sma_${hex64.slice(0, 32)}`
                  : tokenKind === "uppercase"
                    ? `sma_${hex64.toUpperCase()}`
                    : tokenKind === "wrong_prefix"
                      ? `ghp_${hex64}`
                      : tokenKind === "extra_word"
                        ? `${validToken} extra`
                        : tokenKind === "oversized"
                          ? "a".repeat(2000)
                          : ""

            const headers: Record<string, string> =
              tokenKind === "absent" ? {} : { authorization: scheme === "" ? rawToken : `${scheme} ${rawToken}` }
            const req = HttpServerRequest.fromWeb(new Request("https://smithers.test/mcp", { headers }))
            const parsed = McpAuth.parseMcpBearer(req)

            if (tokenKind === "absent") {
              if (parsed._tag !== "Absent") return false
            } else if (tokenKind === "valid" && (scheme === "Bearer" || scheme === "bearer")) {
              if (parsed._tag !== "Token" || parsed.token !== validToken) return false
            } else {
              if (parsed._tag !== "Malformed") return false
            }

            // Agent actor ALWAYS carries act: { kind: "agent", id: "mcp:<tokenId>" }
            const actor = McpAuth.agentActor(tokenId, personId, login, role)
            if (actor.subject.kind !== "person" || actor.subject.id !== personId) return false
            if (actor.act?.kind !== "agent" || actor.act.id !== `mcp:${tokenId}`) return false

            // Blocked MCP acts MUST be blocked regardless of separator (/, _, .)
            const blockedList = [...MCP_BLOCKED_ACTS]
            const blockedAct = blockedList[actIdx % blockedList.length]!
            const variant = blockedAct.replaceAll("/", sep)
            if (!McpAuth.isBlockedMcpAct(blockedAct) || !McpAuth.isBlockedMcpAct(variant)) return false
            const exit = yield* Effect.exit(McpAuth.assertNotBlockedAct(variant))
            if (exit._tag !== "Failure") return false

            // Allowed non-blocked act passes
            const okExit = yield* Effect.exit(McpAuth.assertNotBlockedAct("issues/list"))
            if (okExit._tag !== "Success") return false

            // timingSafeEqualString symmetry & soundness
            if (!McpAuth.timingSafeEqualString(validToken, validToken)) return false
            if (McpAuth.timingSafeEqualString(validToken, `${validToken}0`)) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("IssueContract routes, IDs, bucketing, issueNumberOf & refusalOf preserve determinism and bounds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        owner: Schema.Literals(["smithersai", "octocat", "org-1"]),
        name: Schema.Literals(["smithers", "repo-2", "core"]),
        repoId: Schema.Literals(["r1", "r-abc", "org/repo"]),
        num: Schema.Int.check(Schema.isBetween({ minimum: -5, maximum: 5000 })),
        nowMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 })),
        status: Schema.NullOr(Schema.Literals([200, 400, 401, 403, 404, 409, 413, 422, 429, 500, 503])),
        code: Schema.NullOr(Schema.Literals(["not_signed_in", "no_write_access", "rate_limited", "app_not_installed", "unknown_code"])),
        login: Schema.NullOr(Schema.Literals(["alice", "bob"]))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ owner, name, repoId, num, nowMs, status, code, login }) =>
          Effect.sync(() => {
            const wr = IssueContract.writesRoute(owner, name)
            const ir = IssueContract.issuesRoute(owner, name)
            const fp = IssueContract.firstPaintRoute(owner, name)
            const ts = IssueContract.treeScopeRoute(owner, name)
            if (!wr.includes(owner) || !ir.includes(name) || !fp.includes(IssueContract.FIRST_PAINT_SEGMENT) || !ts.includes(IssueContract.TREE_SCOPE_SEGMENT)) {
              return false
            }

            if (num > 0) {
              const id = IssueContract.itemId(repoId, num)
              if (id !== `${repoId}#${num}`) return false
              const cid = IssueContract.commentId(repoId, num)
              if (cid !== `${repoId}/comment/${num}`) return false
              const parsed = IssueContract.issueNumberOf(String(num))
              if (parsed !== num) return false
              const url = IssueContract.githubIssueUrl(owner, name, num)
              if (!url.startsWith("https://github.com/") || !url.endsWith(`/issues/${num}`)) return false
            } else {
              if (IssueContract.issueNumberOf(String(num)) !== undefined) return false
            }
            if (IssueContract.issueNumberOf("not-a-number") !== undefined) return false
            if (IssueContract.issueNumberOf(String(IssueContract.MAX_ISSUE_NUMBER + 1)) !== undefined) return false

            const bucket = IssueContract.reconcileBucketStart(nowMs)
            if (bucket > nowMs || nowMs - bucket >= IssueContract.SYNC_STALE_MS) return false
            if (bucket % IssueContract.SYNC_STALE_MS !== 0) return false

            const recId = IssueContract.reconcileExecutionId(repoId, nowMs)
            const relId = IssueContract.relationsExecutionId(repoId, nowMs)
            if (!recId.includes(repoId) || !relId.includes(repoId)) return false

            const attr = IssueContract.agentAttribution(login)
            if (login === null && attr !== "Smithers") return false
            if (login !== null && attr !== `Smithers for @${login}`) return false

            const ref = IssueContract.refusalOf(status ?? undefined, code ?? undefined)
            if (ref !== undefined && !IssueContract.NOT_SENT_REASONS.includes(ref)) return false
            if (ref !== undefined && !(ref in IssueContract.NOT_SENT_COPY)) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("DeviceIdentity session/receipt validation, answer() cross-user isolation, stale() & reopenDue() prevent session confusion", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        receiptOwner: Schema.NullOr(Schema.Literals(["person-a", "person-b", DeviceIdentity.VISITOR])),
        sessionKind: Schema.Literals(["signed_in_a", "signed_in_b", "signed_out", "unreachable", "malformed"]),
        reopensOnSignIn: Schema.Boolean,
        now: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
        lastMark: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))),
        within: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })),
        validTag: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ receiptOwner, sessionKind, reopensOnSignIn, now, lastMark, within, validTag }) =>
          Effect.sync(() => {
            const receipt: DeviceIdentity.Receipt = {
              _tag: DeviceIdentity.IDENTITY_MESSAGE,
              owner: receiptOwner ?? undefined,
              outcome: "verified",
              sessionTag: validTag ? "0123456789abcdef0123456789abcdef" : "bad-tag!"
            }
            const parsedReceipt = DeviceIdentity.readReceipt(receipt)
            if (parsedReceipt === undefined) return false
            if (validTag && parsedReceipt.sessionTag !== "0123456789abcdef0123456789abcdef") return false
            if (!validTag && parsedReceipt.sessionTag !== undefined) return false
            if (DeviceIdentity.readReceipt({ _tag: "wrong" }) !== undefined) return false

            const session: DeviceIdentity.SessionNow =
              sessionKind === "signed_in_a"
                ? { signedIn: true, personId: "person-a", login: "alice", role: "member" }
                : sessionKind === "signed_in_b"
                  ? { signedIn: true, personId: "person-b", login: "bob", role: "member" }
                  : sessionKind === "signed_out"
                    ? { signedIn: false, available: true }
                    : sessionKind

            const ans = DeviceIdentity.answer(parsedReceipt, session)
            // Never return person-a's receipt when person-b is signed in!
            if (receiptOwner === "person-a" && sessionKind === "signed_in_b") {
              if (ans.owner !== undefined || ans.reopen !== true) return false
            }
            if (receiptOwner === "person-a" && sessionKind === "signed_in_a") {
              if (ans.owner !== "person-a") return false
            }
            if (receiptOwner === DeviceIdentity.VISITOR && sessionKind === "signed_out") {
              if (ans.owner !== DeviceIdentity.VISITOR) return false
            }
            if (sessionKind === "unreachable") {
              if (ans.owner !== parsedReceipt.owner) return false
            }

            // readSession refuses signedIn: true without personId
            if (DeviceIdentity.readSession({ signedIn: true }) !== undefined) return false
            const validSes = DeviceIdentity.readSession({ signedIn: true, personId: "person-a", login: "alice", role: "member" })
            if (validSes === undefined || !validSes.signedIn) return false

            // stale() invariants
            const stSame = DeviceIdentity.stale("person-a", reopensOnSignIn, validSes)
            const stOther = DeviceIdentity.stale("person-b", reopensOnSignIn, validSes)
            if (stSame !== false || stOther !== true) return false

            // reopenDue() throttle invariants
            const mem = new Map<string, string>()
            if (lastMark !== null) mem.set("m", String(lastMark))
            const due = DeviceIdentity.reopenDue(
              {
                getItem: (k) => mem.get(k) ?? null,
                setItem: (k, v) => void mem.set(k, v)
              },
              "m",
              within,
              now
            )
            const expectedDue = lastMark === null || now - lastMark >= within
            if (due !== expectedDue) return false

            // TodoView round-trip & status invariants
            const afterVal = TodoView.afterValueOf(undefined)
            if (TodoView.parseAfterChoice(afterVal) !== undefined) return false
            const indepVal = TodoView.afterValueOf(null)
            if (TodoView.parseAfterChoice(indepVal) !== null) return false
            const numVal = TodoView.afterValueOf(42)
            if (TodoView.parseAfterChoice(numVal) !== 42) return false
            if (TodoView.parseAfterChoice("-3") !== undefined) return false
            if (TodoView.parseAfterChoice("abc") !== undefined) return false

            const iso = TodoView.isoOf("2026-10-20 10:00:00.123+00")
            if (iso !== "2026-10-20T10:00:00.123+00:00") return false

            const stRequested = TodoView.statusOf(null, "queued")
            if (stRequested.kind !== "requested") return false
            if (TodoView.isDroppable({ number: null, state: "queued", pending: undefined })) return false
            if (!TodoView.isDroppable({ number: 1, state: "queued", pending: undefined })) return false
            if (TodoView.isDroppable({ number: 1, state: "merged", pending: undefined })) return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
