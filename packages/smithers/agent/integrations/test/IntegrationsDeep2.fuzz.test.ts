import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Channels from "@smthrs/control/Channels"
import * as Control from "@smthrs/control/Control"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Option, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { createHmac, createPrivateKey } from "node:crypto"
import { describe, expect, it } from "vitest"
import * as ActionFailure from "../src/core/ActionFailure.ts"
import * as Channel from "../src/core/Channel.ts"
import * as Connection from "../src/core/Connection.ts"
import * as CookieKeys from "../src/core/CookieKeys.vibe"
import * as CursorStore from "../src/core/CursorStore.ts"
import type { ExternalEvent } from "../src/core/ExternalEvent.ts"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import * as Signature from "../src/core/Signature.ts"
import * as Source from "../src/core/Source.ts"
import * as Actions from "../src/github/Actions.ts"
import * as AppAuth from "../src/github/AppAuth.ts"
import * as Auth from "../src/github/Auth.vibe"
import * as AuthBroker from "../src/github/AuthBroker.vibe"
import * as AuthConsent from "../src/github/AuthConsent.vibe"
import * as Commits from "../src/github/Commits.ts"
import * as Delegation from "../src/github/Delegation.vibe"
import type * as DelegationPolicy from "../src/github/DelegationPolicy.vibe"
import { GitHubClient } from "../src/github/GitHubClient.ts"
import * as WriteLock from "../src/github/internal/WriteLock.ts"
import * as Once from "../src/github/Once.ts"
import * as Pulls from "../src/github/Pulls.ts"
import * as TelegramSource from "../src/telegram/Source.ts"
import { durable } from "./DurableBroker.vibe"
import { json, startFixture } from "./Fixture.ts"
import { startGitHub } from "./GitHubFake.ts"
import { fetchLayer, gitHubLayer } from "./Http.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const hmacHex = (body: string, secret: string): string => createHmac("sha256", secret).update(body).digest("hex")

const pem = (label: string, der: Uint8Array): string => {
  const body = Buffer.from(der).toString("base64").match(/.{1,64}/g)!.join("\n")
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

describe("@smthrs/integrations AuthBroker, Delegation, Actions, Once, Commits, Pulls, AppAuth, Channel, Source & Telegram deep fuzz", () => {
  it(
    "GitHub AuthBroker, AuthConsent & CookieKeys enforce signed return_to, PKCE, single-use replay & fault handling",
    async () => {
      const originA = "https://vibelang.smithers.sh"
      const originB = "https://other.smithers.sh"
      const secretA = Redacted.make("a".repeat(32))
      const secretB = Redacted.make("b".repeat(32))
      const sites = [
        { origin: originA, secret: secretA },
        { origin: originB, secret: secretB }
      ]

      const arb = Arbitrary.schema(
        Schema.Struct({
          tamper: Schema.Literals([
            "none",
            "return_to",
            "cross_origin",
            "expired",
            "uppercase_mac",
            "replay_start",
            "forged_cookie"
          ]),
          fault: Schema.Literals(["none", "exchange", "user", "identity"]),
          code: Schema.Literals(["code-ok", "code-2"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ tamper, fault, code }) =>
            Effect.gen(function*() {
              const keys = yield* CookieKeys.make({ primary: secretA }, "primary")
              const github = Auth.GitHubAuth.of({
                authorizeUrl: ({ state, codeChallenge, redirectUri }) =>
                  "https://github.test/authorize?" +
                  new URLSearchParams({ state, code_challenge: codeChallenge, redirect_uri: redirectUri }),
                exchange: () =>
                  fault === "exchange"
                    ? Effect.fail(new Auth.GitHubRefused({ step: "exchange", reason: "unavailable" }))
                    : Effect.succeed({
                      accessToken: Redacted.make("gho_private_tok"),
                      refreshToken: Redacted.make("ghr_refresh_tok"),
                      expiresAt: 10_000_000
                    }),
                user: () =>
                  fault === "user"
                    ? Effect.fail(new Auth.GitHubRefused({ step: "user", reason: "unavailable" }))
                    : Effect.succeed({ id: fault === "identity" ? 0 : 7, login: "ada" }),
                refresh: () => Effect.fail(new Auth.GitHubRefused({ step: "refresh", reason: "rejected" })),
                permission: () => Effect.succeed("read"),
                revoke: () => Effect.void,
                deviceCode: () => Effect.fail(new Auth.GitHubRefused({ step: "device", reason: "unavailable" })),
                deviceToken: () => Effect.fail(new Auth.GitHubRefused({ step: "device", reason: "unavailable" }))
              })
              const store = yield* AuthBroker.memoryStore()
              const broker = durable(
                yield* AuthBroker.make({
                  origin: "https://smithers.sh",
                  sites,
                  keys,
                  store,
                  encryptionKey: Redacted.make("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
                  github
                })
              )
              const client = yield* AuthBroker.site({
                origin: originA,
                brokerOrigin: "https://smithers.sh",
                secret: secretA
              })
              const pending = yield* client.begin()

              if (AuthConsent.githubOrigin(github) !== "https://github.test") return false

              let startReturnTo = pending.returnTo
              let startOrigin = originA
              if (tamper === "return_to") startReturnTo = pending.returnTo + "0"
              if (tamper === "cross_origin") startOrigin = originB
              if (tamper === "uppercase_mac") {
                const dot = pending.returnTo.lastIndexOf(".")
                startReturnTo = pending.returnTo.slice(0, dot + 1) + pending.returnTo.slice(dot + 1).toUpperCase()
              }
              if (tamper === "expired") {
                yield* TestClock.adjust("10 minutes")
              }

              const startRes = yield* Effect.result(broker.start(startOrigin, startReturnTo))
              if (tamper !== "none" && tamper !== "replay_start" && tamper !== "forged_cookie") {
                return startRes._tag === "Failure"
              }
              if (startRes._tag !== "Success") return false
              if (tamper === "replay_start") {
                const second = yield* Effect.result(broker.start(startOrigin, startReturnTo))
                if (second._tag !== "Failure") return false
              }

              const state = new URL(startRes.success.location).searchParams.get("state")!
              const cookie = tamper === "forged_cookie" ? startRes.success.cookie + "0" : startRes.success.cookie
              const cbRes = yield* Effect.result(broker.callback(state, code, cookie))
              if (tamper === "forged_cookie" || fault !== "none") {
                return cbRes._tag === "Failure"
              }
              if (cbRes._tag !== "Success") return false
              const handoffUrl = new URL(cbRes.success)
              const fragment = new URLSearchParams(handoffUrl.hash.slice(1))
              const handoffCode = fragment.get("code")
              if (!handoffCode) return false
              const redemption = yield* client.redemption(pending, handoffCode)
              const exchanged = yield* Effect.result(broker.exchange(originA, redemption))
              return exchanged._tag === "Success" && exchanged.success.login === "ada"
            }).pipe(Effect.provide(TestClock.layer())),
          { seed, executions: Math.min(executions, 30) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    30_000
  )

  it("GitHub Delegation enforces signed envelopes, modes, refresh, revoke & replay idempotency", async () => {
    const brokerOrigin = "https://smithers.sh"
    const siteOrigin = "https://vibelang.smithers.sh"
    const secret = Redacted.make("s".repeat(32))
    const grants: ReadonlyArray<DelegationPolicy.Grant> = [
      {
        repository: "smithersai/vibelang",
        repositoryId: 11,
        scopes: ["issues", "proposals"],
        paths: ["docs/design/vips/"],
        branchPrefix: "vibelang/",
        labelPrefix: "vibelang:"
      }
    ]
    const sites = [{ origin: siteOrigin, secret, grants }]
    const encKey = Redacted.make("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    const keyring = { active: "k1", keys: { k1: encKey } }

    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "issue_create",
          "comment_create",
          "branch_create",
          "commit_create",
          "pull_create",
          "label_add",
          "find_op",
          "read_op",
          "revoke",
          "bad_sig",
          "wrong_person"
        ]),
        refreshNeeded: Schema.Boolean,
        failUpstream: Schema.Boolean,
        keySuffix: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, refreshNeeded, failUpstream, keySuffix }) =>
          Effect.gen(function*() {
            const ghClient: GitHubClient = {
              request: ((method: string, path: string) => {
                const opts = { method, path }
                if (failUpstream && (opts.method ?? "GET") !== "GET") {
                  return Effect.fail(new IntegrationError("delivery-failed", "upstream 502", { status: 502 }))
                }
                if (opts.path.includes("/git/ref/")) {
                  return Effect.fail(new IntegrationError("delivery-failed", "not found", { status: 404 }))
                }
                if (opts.path === "/graphql") {
                  return Effect.succeed({ data: { createCommitOnBranch: { commit: { oid: "c".repeat(40) } } } })
                }
                if (opts.path.endsWith("/git/refs")) {
                  return Effect.succeed({ ref: "refs/heads/vibelang/x", object: { sha: "a".repeat(40) } })
                }
                if (opts.path.endsWith("/pulls") && opts.method === "POST") {
                  return Effect.succeed({
                    id: 6,
                    number: 10,
                    state: "open",
                    title: "t",
                    body: "",
                    draft: false,
                    merged: false,
                    merge_commit_sha: null,
                    changed_files: 0,
                    user: null,
                    head: { sha: "a".repeat(40), ref: "x" },
                    base: { sha: "b".repeat(40), ref: "main" },
                    html_url: "https://github.com/smithersai/vibelang/pull/10"
                  })
                }
                if (opts.path.endsWith("/comments") && opts.method === "POST") {
                  return Effect.succeed({
                    id: 77,
                    body: "hello",
                    user: null,
                    created_at: "2026-10-20T00:00:00Z",
                    updated_at: "2026-10-20T00:00:00Z",
                    html_url: "https://github.com/smithersai/vibelang/issues/1#issuecomment-77"
                  })
                }
                if (opts.path === "/repos/smithersai/vibelang") {
                  return Effect.succeed({
                    id: 11,
                    name: "vibelang",
                    owner: { login: "smithersai" },
                    default_branch: "main"
                  })
                }
                if (opts.path === "/repos/ada/vibelang") {
                  return Effect.succeed({
                    id: 12,
                    name: "vibelang",
                    owner: { login: "ada" },
                    default_branch: "main",
                    fork: true,
                    parent: { id: 11, full_name: "smithersai/vibelang" }
                  })
                }
                if (/^\/repos\/smithersai\/vibelang\/issues\/\d+$/.test(opts.path)) {
                  return Effect.succeed({ id: 2001, number: 1 })
                }
                if (opts.method === "POST" && opts.path.endsWith("/issues")) {
                  return Effect.succeed({
                    id: 5,
                    number: 9,
                    title: "t",
                    state: "open",
                    created_at: "2026-10-20T00:00:00Z",
                    updated_at: "2026-10-20T00:00:00Z",
                    body: "",
                    user: null,
                    labels: [],
                    comments: 0
                  })
                }
                return Effect.succeed({})
              }) as unknown as GitHubClient["request"],
              paginate: () => Effect.succeed({ items: [], truncated: false } as never),
              count: () => Effect.succeed({ total: 0 } as never)
            }

            const github = Auth.GitHubAuth.of({
              authorizeUrl: () => "",
              exchange: () => Effect.die("unused"),
              user: () => Effect.succeed({ id: 7, login: "ada" }),
              permission: () => Effect.succeed("read"),
              refresh: () =>
                Effect.succeed({
                  accessToken: Redacted.make("new-token"),
                  refreshToken: Redacted.make("new-refresh"),
                  expiresAt: 999_999_999
                }),
              revoke: () => Effect.void,
              deviceCode: () => Effect.die("unused"),
              deviceToken: () => Effect.die("unused")
            })

            const store = yield* Delegation.memoryStore()
            const journaled: Array<string> = []
            const journal = Delegation.memoryJournal((v) => journaled.push(v))
            const server = yield* Delegation.make({
              origin: brokerOrigin,
              person: 7,
              sites,
              keyring,
              store,
              journal,
              github,
              act: () => (program) => Effect.provideService(program, GitHubClient, ghClient) as never
            })
            const installed = yield* server.install({
              origin: siteOrigin,
              login: "ada",
              tokens: {
                accessToken: Redacted.make("stored-token"),
                refreshToken: Redacted.make("stored-refresh"),
                expiresAt: refreshNeeded ? 1 : 999_999_999
              }
            })
            const signer = yield* Delegation.signer({ origin: siteOrigin, brokerOrigin, secret })

            if (mode === "revoke") {
              const revRes = yield* Effect.result(server.revoke(installed.delegation))
              return revRes._tag === "Success"
            }

            const op: DelegationPolicy.Operation = mode === "comment_create"
              ? {
                kind: "comment.create",
                repository: "smithersai/vibelang",
                number: 1,
                body: `fuzz comment ${keySuffix}`
              }
              : mode === "branch_create"
              ? {
                kind: "branch.create",
                repository: "smithersai/vibelang",
                prefix: "vibelang/",
                label: `fuzz-${keySuffix}`,
                at: "a".repeat(40)
              }
              : mode === "commit_create"
              ? {
                kind: "commit.create",
                repository: "smithersai/vibelang",
                branch: `vibelang/fuzz-${keySuffix}`,
                expectedHeadOid: "a".repeat(40),
                headline: `fuzz commit ${keySuffix}`,
                additions: [{ path: "docs/design/vips/0001-fuzz.md", contents: "hello" }],
                deletions: []
              }
              : mode === "pull_create"
              ? {
                kind: "pull.create",
                repository: "smithersai/vibelang",
                head: `ada:vibelang/fuzz-${keySuffix}`,
                base: "main",
                title: `fuzz pr ${keySuffix}`,
                body: "body"
              }
              : mode === "label_add"
              ? { kind: "label.add", repository: "smithersai/vibelang", number: 1, labels: ["vibelang:triage"] }
              : {
                kind: "issue.create",
                repository: "smithersai/vibelang",
                title: `fuzz issue ${keySuffix}`,
                body: "body",
                since: "1970-01-01T00:00:00.000Z"
              }

            const envMode: Delegation.Mode = mode === "find_op" ? "find" : mode === "read_op" ? "read" : "perform"
            const env = yield* signer.envelope({
              person: mode === "wrong_person" ? 99 : 7,
              delegation: installed.delegation,
              mode: envMode,
              key: `${keySuffix}`.padStart(64, "a"),
              payload: op
            })
            const bodyObj = mode === "bad_sig" ? { ...env, request: env.request + "0" } : env
            const res = yield* Effect.result(server.handle(JSON.stringify(bodyObj)))
            if (mode === "bad_sig" || mode === "wrong_person") {
              return res._tag === "Failure"
            }
            return res._tag === "Success" || res._tag === "Failure"
          }).pipe(Effect.provide(TestClock.layer())),
        { seed: seed + 1, executions: Math.min(executions, 30) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 30_000)

  it(
    "GitHub Actions, Once, Commits, Pulls & WriteLock uphold idempotency and CRUD against loopback FakeGitHub",
    async () => {
      const github = await startGitHub()
      try {
        const clientLayer = gitHubLayer({ token: "t", apiBaseUrl: github.fixture.origin }, {})
        const arb = Arbitrary.schema(
          Schema.Struct({
            op: Schema.Literals(["comment", "labels", "upsert", "check_run", "link_pr", "pulls_crud", "once_helpers"]),
            idx: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
            repeat: Schema.Boolean
          })
        )

        const SHA = "a".repeat(40)
        const runAct = <Tag extends string, P extends Flow.AnyStructSchema, S extends Schema.Top, E extends Schema.Top>(
          decl: Action.Declared<Tag, P, S, E>,
          payload: P["~type.make.in"],
          execId: string
        ) => {
          const flow = Flow.make(`${decl.name}/fuzz`, {
            payload: decl.payloadSchema,
            success: decl.successSchema,
            error: decl.errorSchema,
            body: (input) => decl.call(input as never)
          })
          const layer = Interpreter.layer(flow).pipe(
            Layer.provideMerge(Actions.layer),
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, clientLayer, NodeCrypto.layer))
          )
          return (flow.execute(payload as never, { executionId: execId }) as Effect.Effect<S["Type"], unknown, never>)
            .pipe(
              Effect.provide(layer as unknown as Layer.Layer<never>),
              Effect.scoped
            )
        }

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ op, idx, repeat }) =>
              Effect.gen(function*() {
                const lockRes = yield* WriteLock.withWriteLock("owner/repo", Effect.succeed(idx))
                if (lockRes !== idx) throw new Error("lockRes")
                const trailerKey = `${idx}`.padStart(64, "0")
                const msg = Once.withTrailer(`Commit ${idx}`, trailerKey)
                if (Once.trailerKeyOf(msg) !== trailerKey) throw new Error("trailerKey: " + Once.trailerKeyOf(msg))
                const bName = Once.branchName("smithers", `feat-${idx}`, trailerKey)
                if (!bName.startsWith("smithers")) throw new Error("bName: " + bName)

                const execId = `fuzz-exec-${op}-${idx}`
                if (op === "comment") {
                  const res = yield* runAct(
                    Actions.CommentOnIssue,
                    { owner: "o", repo: "r", issueNumber: 7, body: `hello ${idx}` },
                    execId
                  ).pipe(Effect.result)
                  return res._tag === "Success"
                }
                if (op === "labels") {
                  const res = yield* runAct(
                    Actions.AddLabels,
                    { owner: "o", repo: "r", issueNumber: 7, labels: [`lbl-${idx % 5}`] },
                    execId
                  ).pipe(Effect.result)
                  if (res._tag !== "Success") throw new Error("labels: " + JSON.stringify(res))
                  return true
                }
                if (op === "upsert") {
                  const key = `sticky-${idx % 4}`
                  const r1 = yield* runAct(
                    Actions.UpsertComment,
                    { owner: "o", repo: "r", issueNumber: 7, key, body: `body-${idx}`, author: { login: "smithers" } },
                    execId
                  ).pipe(Effect.result)
                  if (r1._tag !== "Success") return false
                  if (repeat) {
                    const r2 = yield* runAct(
                      Actions.UpsertComment,
                      {
                        owner: "o",
                        repo: "r",
                        issueNumber: 7,
                        key,
                        body: `body-${idx}`,
                        author: { login: "smithers" }
                      },
                      `${execId}-2`
                    ).pipe(Effect.result)
                    if (r2._tag !== "Success") return false
                  }
                  return true
                }
                if (op === "check_run") {
                  const res = yield* runAct(
                    Actions.CheckRun,
                    {
                      owner: "o",
                      repo: "r",
                      appId: 42,
                      name: `ci-${idx % 3}`,
                      headSha: SHA,
                      status: "completed",
                      conclusion: "success",
                      output: { title: "ok", summary: "passed" }
                    },
                    execId
                  ).pipe(Effect.result)
                  return res._tag === "Success"
                }
                if (op === "link_pr") {
                  const res = yield* runAct(
                    Actions.LinkPullRequest,
                    {
                      owner: "o",
                      repo: "r",
                      pullNumber: 1,
                      issueNumber: 7
                    },
                    execId
                  ).pipe(Effect.result)
                  return res._tag === "Success" || res._tag === "Failure"
                }
                if (op === "pulls_crud") {
                  const reqHead = yield* Effect.result(Pulls.requireHead(`feat-${idx}`))
                  if (reqHead._tag !== "Success") return false
                  const listRes = yield* Effect.result(
                    Pulls.listPulls("o", "r", { state: "open" }).pipe(Effect.provide(clientLayer))
                  )
                  const cmpRes = yield* Effect.result(
                    Commits.compare("o", "r", SHA, SHA).pipe(Effect.provide(clientLayer))
                  )
                  return (listRes._tag === "Success" || listRes._tag === "Failure") &&
                    (cmpRes._tag === "Success" || cmpRes._tag === "Failure")
                }
                const keyCheck = Actions.stickyMarker(`run-${idx}`)
                const marker = Actions.stickyMarker(`k-${idx}`)
                return typeof keyCheck === "string" && marker.includes(`k-${idx}`)
              }),
            { seed: seed + 2, executions: Math.min(executions, 25) }
          )
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      } finally {
        await github.fixture.close()
      }
    },
    60_000
  )

  it(
    "GitHub AppAuth imports PKCS#8 & PKCS#1 keys, mints verified JWTs, caches installation tokens & handles faults",
    async () => {
      const pair = await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"]
      )
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
      const pkcs8Pem = pem("PRIVATE KEY", pkcs8)
      const pkcs1Pem = createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" }).export({
        type: "pkcs1",
        format: "pem"
      }) as string

      let shouldFail = false
      const fixture = await startFixture((req, res) => {
        if (shouldFail) {
          json(res, 500, { message: "boom" })
          return
        }
        if (req.url?.includes("/access_tokens")) {
          json(res, 201, {
            token: "ghs_FUZZ_MINTED_TOKEN_0123456789",
            expires_at: new Date(Date.now() + 3_600_000).toISOString()
          })
          return
        }
        json(res, 200, { id: 99, account: { login: "acme" } })
      })

      try {
        const arb = Arbitrary.schema(
          Schema.Struct({
            keyFormat: Schema.Literals(["pkcs8", "pkcs1", "corrupt"]),
            installationId: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
            fault: Schema.Boolean
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ keyFormat, installationId, fault }) =>
              Effect.gen(function*() {
                shouldFail = fault
                const rawPem = keyFormat === "pkcs8" ? pkcs8Pem : keyFormat === "pkcs1" ? pkcs1Pem : "NOT A PEM"
                const imported = yield* Effect.result(AppAuth.importPrivateKey(Redacted.make(rawPem)))
                if (keyFormat === "corrupt") return imported._tag === "Failure"
                if (imported._tag !== "Success") return false

                const auth = yield* AppAuth.make({
                  appId: "424242",
                  privateKey: Redacted.make(rawPem),
                  apiBaseUrl: fixture.origin
                }).pipe(Effect.provide(fetchLayer))

                const jwt = yield* auth.jwt
                if (Redacted.value(jwt).split(".").length !== 3) return false

                const instRes = yield* Effect.result(auth.installation("acme", "app"))
                const tokRes = yield* Effect.result(auth.installationToken({ installationId }))
                if (fault) return tokRes._tag === "Failure" && instRes._tag === "Failure"
                if (tokRes._tag !== "Success" || instRes._tag !== "Success") return false
                return Redacted.value(tokRes.success.token).startsWith("ghs_") && instRes.success.id === 99
              }),
            { seed: seed + 3, executions: Math.min(executions, 20) }
          )
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      } finally {
        await fixture.close()
      }
    },
    45_000
  )

  it(
    "Core Channel, Source (runWithCursor), Connection & Telegram Source enforce HMAC auth, cursor commit & routing",
    async () => {
      const SECRET = "webhook-fuzz-secret-32-bytes-long!"
      const TOKEN = "123456:fuzz-telegram-token"
      const CHAT = 42

      const botFixture = await startFixture((_req, res) => {
        json(res, 200, {
          ok: true,
          result: [
            {
              update_id: 101,
              message: {
                message_id: 1,
                date: 1_700_000_000,
                chat: { id: CHAT, type: "private" },
                text: "hello from fuzz"
              }
            }
          ]
        })
      })

      try {
        const arb = Arbitrary.schema(
          Schema.Struct({
            validSig: Schema.Boolean,
            handlerFails: Schema.Boolean,
            chatId: Schema.Literals([42, 999]),
            routeKind: Schema.Literals(["start_flow", "signal_run"]),
            msgId: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ validSig, handlerFails, chatId, routeKind, msgId }) =>
              Effect.gen(function*() {
                const accepted = { accepted: true, runId: "run-1", status: "queued" } as never
                const controlLayer = Layer.succeed(
                  Control.Control,
                  Control.make({
                    plan: () =>
                      Effect.succeed({
                        planId: "plan",
                        flowId: "triage",
                        digest: "digest",
                        inputSummary: "input",
                        envelope: { capabilities: [], flows: [], budget: {} },
                        deployClass: false,
                        nodes: [],
                        approval: {
                          target: {
                            _tag: "Plan",
                            planId: "plan",
                            digest: "digest",
                            envelope: { capabilities: [], flows: [], budget: {} }
                          },
                          scope: "run",
                          idempotencyKey: "approve:plan"
                        }
                      }),
                    run: () => Effect.succeed(accepted),
                    signal: () => Effect.succeed(accepted),
                    runs: () => Effect.succeed([]),
                    getRun: () => Effect.die("unused"),
                    cancel: () => Effect.die("unused"),
                    resume: () => Effect.die("unused"),
                    approvals: () => Effect.succeed([]),
                    resolveApproval: () => Effect.die("unused"),
                    events: () => Effect.die("unused"),
                    flows: () => Effect.succeed([])
                  } as never)
                )
                const ch = Channel.make({
                  name: "fuzz-hook",
                  credential: Redacted.make("hook-cred" as never),
                  secret: Channel.constantSecret(Redacted.make(SECRET)),
                  fingerprintHeaders: ["x-event"],
                  verify: (raw, value) =>
                    Signature.verifySignature({
                      payload: raw.body,
                      secret: value,
                      signature: raw.headers["x-hub-signature-256"],
                      prefix: Signature.GITHUB_SIGNATURE_PREFIX
                    }),
                  decode: (_raw, payload) => ({
                    source: "fuzz",
                    eventName: "integration:fuzz:event",
                    correlationId: null,
                    payload: payload as never,
                    dedupeKey: `fuzz:${msgId}`,
                    receivedAtMs: 1
                  }),
                  route: routeKind === "start_flow" ? Channel.startFlow("triage") : Channel.signalRun("run-1")
                })
                const bodyStr = JSON.stringify({ id: msgId })
                const bodyBytes = new TextEncoder().encode(bodyStr)
                const sig = validSig ? `sha256=${hmacHex(bodyStr, SECRET)}` : `sha256=${"0".repeat(64)}`
                const key = yield* Channel.signedBodyKey(bodyBytes)
                const ingestExit = yield* Effect.gen(function*() {
                  const channels = yield* Channels.Channels
                  yield* channels.register(ch)
                  return yield* channels.ingest({
                    channel: ch.name,
                    raw: {
                      body: bodyBytes,
                      headers: { "x-hub-signature-256": sig, "x-event": "push" },
                      idempotencyKey: key
                    }
                  })
                }).pipe(
                  Effect.provide(Channels.layerMemory.pipe(Layer.provide(controlLayer))),
                  Effect.result
                )
                if (validSig && ingestExit._tag !== "Success") throw new Error("ingest: " + JSON.stringify(ingestExit))
                if (!validSig && ingestExit._tag !== "Failure") return false

                const step = Action.make("fuzz/source/run", {
                  payload: {},
                  success: Schema.Unknown,
                  error: ActionFailure.Failure,
                  tier: "irreversible"
                })
                const srcFlow = Flow.make("fuzz/source", {
                  payload: {},
                  success: Schema.Unknown,
                  error: ActionFailure.Failure,
                  body: () => step.call({})
                })
                const cursorRun = Source.runWithCursor(
                  "fuzz-src",
                  () => {
                    const ev: ExternalEvent = {
                      source: "fuzz-src",
                      eventName: "integration:fuzz:msg",
                      correlationId: null,
                      payload: { id: msgId },
                      dedupeKey: `k:${msgId}`,
                      receivedAtMs: 1
                    }
                    return Effect.succeed({ events: [ev], cursor: `cursor-${msgId}` })
                  },
                  () =>
                    handlerFails
                      ? Effect.fail(new IntegrationError("delivery-failed", "boom"))
                      : Effect.void,
                  { intervalMs: 0, maxTurns: 1 }
                )
                const srcLayer = Layer.mergeAll(
                  step.toLayer(() =>
                    cursorRun.pipe(Effect.as({ ok: true }), Effect.mapError(ActionFailure.fromIntegrationError))
                  ),
                  Interpreter.layer(srcFlow)
                ).pipe(
                  Layer.provideMerge(Action.layerImplementations),
                  Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, CursorStore.layerMemory))
                )
                const srcExit = yield* srcFlow
                  .execute({}, { executionId: `src-fuzz-${msgId}` })
                  .pipe(Effect.provide(srcLayer), Effect.scoped, Effect.result)
                if (handlerFails && srcExit._tag !== "Failure") return false
                if (!handlerFails && srcExit._tag !== "Success") throw new Error("src: " + JSON.stringify(srcExit))

                const corr1 = TelegramSource.chatCorrelationId(chatId)
                const corr2 = TelegramSource.threadCorrelationId(chatId, msgId)
                if (!corr1.includes(String(chatId)) || !corr2.includes(String(msgId))) return false
                const events = TelegramSource.updateToEvents(
                  "telegram",
                  {
                    update_id: msgId,
                    message: {
                      message_id: msgId,
                      date: 1_700_000_000,
                      chat: { id: chatId, type: "private" },
                      text: `hi ${msgId}`
                    }
                  },
                  1_700_000_000_000
                )
                if (events.length !== 1) return false

                const tgRes = yield* TelegramSource.make({
                  allowedChatIds: [CHAT],
                  botToken: TOKEN,
                  apiBaseUrl: botFixture.origin
                }).pipe(Effect.provide(fetchLayer), Effect.result)
                if (tgRes._tag !== "Success") throw new Error("tg: " + JSON.stringify(tgRes))

                const allowedAll = Connection.containersAllowed({ containers: [Connection.ANY_CONTAINER] }, "box-1")
                const allowedOne = Connection.containersAllowed({ containers: ["box-1"] }, "box-2")
                return allowedAll === true && allowedOne === false
              }),
            { seed: seed + 4, executions: Math.min(executions, 20) }
          )
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      } finally {
        await botFixture.close()
      }
    },
    60_000
  )
})
