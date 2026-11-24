import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import {
  Arbitrary,
  Cause,
  Console,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Metric,
  Option,
  PubSub,
  Redacted,
  References,
  Schema,
  Scope,
  Stream,
  Tracer
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
  Consensus,
  EngineEvent,
  ExecutionFact,
  Journal,
  JournalEvent,
  JournalMetrics,
  Migrations,
  OwnerId,
  Projection,
  RedactedLogger,
  Redaction,
  SqlConsensus,
  SqlJournal,
  TelemetryLog
} from "../src/index.ts"
import { JournalDigest } from "../src/internal/JournalDigest.ts"
import { JournalTestObserver, type Observations } from "../src/internal/JournalTestObserver.ts"
import { TelemetryText } from "../src/internal/TelemetryText.ts"
import * as JournalGeneration from "../src/JournalGeneration.ts"
import * as Notifying from "../src/test/Notifying.ts"
import * as TestJournal from "../src/test/TestJournal.ts"
import * as Leases from "./fixtures/leases.ts"

const isWellFormed = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "250"))
const sqlExecutions = Math.min(executions, 28)
const mediumExecutions = Math.min(executions, 120)
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const HexChar = Schema.Literals(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"])
const Base64UrlChar = Schema.Literals([
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "A",
  "B",
  "C",
  "D",
  "0",
  "1",
  "2",
  "3",
  "-",
  "_"
])

const assertFuzz = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const silentLog = Logger.layer([])
const migratedDb = () => Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const asRun = (s: string): JournalEvent.RunId => s as JournalEvent.RunId
const asSource = (s: string): JournalEvent.SourceId => s as JournalEvent.SourceId
const asSeq = (n: number): JournalEvent.Seq => n as JournalEvent.Seq
const asSourceSeq = (n: number): JournalEvent.SourceSeq => n as JournalEvent.SourceSeq
const asLineage = (s: string): JournalEvent.LineageId => s as JournalEvent.LineageId
const asDispatch = (s: string): JournalEvent.DispatchId => s as JournalEvent.DispatchId
const asWait = (s: string): JournalEvent.WaitId => s as JournalEvent.WaitId
const asCommand = (s: string): JournalEvent.CommandId => s as JournalEvent.CommandId
const asTs = (n: number): JournalEvent.TimestampMs => n as JournalEvent.TimestampMs
const asQty = (n: number): typeof JournalEvent.NonNegativeQuantity.Type =>
  n as typeof JournalEvent.NonNegativeQuantity.Type

const mkOwner = (idx: number): OwnerId.OwnerId => ({
  hostId: idx % 2 === 0 ? "host-a" : "host-b",
  pid: 100 + idx,
  nonce: `nonce-${idx}`
})

const holdLease = (sql: SqlClient.SqlClient, runId: string, owner: OwnerId.OwnerId, heartbeatAtMs = 0) =>
  sql`
    INSERT INTO flows_consensus_leases (
      run_id, owner_host_id, owner_pid, owner_nonce, granted_at_ms, heartbeat_at_ms
    ) VALUES (
      ${runId}, ${owner.hostId}, ${owner.pid}, ${owner.nonce}, ${heartbeatAtMs}, ${heartbeatAtMs}
    )
    ON CONFLICT (run_id) DO UPDATE SET
      owner_host_id = excluded.owner_host_id,
      owner_pid = excluded.owner_pid,
      owner_nonce = excluded.owner_nonce,
      granted_at_ms = excluded.granted_at_ms,
      heartbeat_at_ms = excluded.heartbeat_at_ms,
      claim_host_id = NULL,
      claim_pid = NULL,
      claim_nonce = NULL,
      claimed_at_ms = NULL
  `

const mkInput = (
  runId: string,
  sourceId: string,
  eventType: string,
  payload: unknown,
  opts?: { sourceSeq?: number; dedupe?: JournalEvent.Dedupe; meta?: unknown }
): JournalEvent.Input =>
  new JournalEvent.Input({
    runId: asRun(runId),
    sourceId: asSource(sourceId),
    ...(opts?.sourceSeq === undefined ? {} : { sourceSeq: asSourceSeq(opts.sourceSeq) }),
    ...(opts?.dedupe === undefined ? {} : { dedupe: opts.dedupe }),
    eventType,
    payload,
    ...(opts?.meta === undefined ? {} : { meta: opts.meta })
  }, { disableChecks: true })

describe("@smthrs/journal fuzz security & codec invariants", () => {
  it("Redaction strips sensitive keys, all built-in/diagnostic leak forms, custom rules, and Smithers tokens", async () => {
    const redactor = Redaction.make()
    const diagRedactor = Redaction.make({ rules: Redaction.diagnosticRules })
    const customRedactor = Redaction.make({
      rules: [
        ...Redaction.defaultRules,
        { id: "custom-secret", pattern: /CUSTOM_[0-9a-f]{8}/g, replace: "[CUSTOM_MASKED]" }
      ]
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        sensitiveKey: Schema.Literals([
          "password",
          "apiKey",
          "authorization",
          "access_token",
          "clientSecret",
          "privateKey",
          "session_cookie"
        ]),
        safeKey: Schema.Literals(["status", "count", "label", "stage", "inputTokens", "outputTokens"]),
        tokenBody: Schema.Array(HexChar),
        b64Body: Schema.Array(Base64UrlChar),
        prefix: Schema.String.check(Schema.isMaxLength(20)),
        suffix: Schema.String.check(Schema.isMaxLength(20)),
        depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
        quoteStyle: Schema.Literals(["\"", "'", "`", ""])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ sensitiveKey, safeKey, tokenBody, b64Body, prefix, suffix, depth, quoteStyle }) => {
          const hex40 = (tokenBody.join("") + "0123456789abcdef0123456789abcdef01234567").slice(0, 40)
          const hex36 = hex40.slice(0, 36)
          const b6444 = (b64Body.join("") + "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789").slice(0, 44)
          const cleanPrefix = prefix.replace(/[\r\n"'`\\]/g, " ")
          const cleanSuffix = suffix.replace(/[\r\n"'`\\]/g, " ")

          // All major secret forms
          const ghp = `ghp_${hex36}`
          const bearer = `Bearer ${hex36}`
          const sk = `sk-ant-api03-${hex36}`
          const smm = `smm_${b6444}`
          const smt1 = `smt1.${b6444.slice(0, 12)}.${b6444}`
          const signedSm = `smithers_task_v1.${b6444.slice(0, 10)}.${b6444.slice(0, 16)}`
          const patSm = `smithers_pat_${b6444.slice(0, 24)}`
          const accessSm = `smithers_agent_${hex40}`
          const pem = `-----BEGIN PRIVATE KEY-----\n${b6444}\n-----END PRIVATE KEY-----`
          const pemTrunc = `-----BEGIN RSA PRIVATE KEY-----\n${b6444}`
          const urlCred = `postgres://alice:s3cr3t${hex36.slice(0, 8)}@db.example.com:5432/app`
          const gitOauth = `https://${hex36}:x-oauth-basic@github.com/org/repo.git`
          const basicRaw = btoa(`user:${hex36.slice(0, 12)}`)
          const basicLower = `basic ${basicRaw}`
          const basicUpper = `Basic ${hex36.slice(0, 12)}`
          const jwtHeader = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=+$/g, "")
          const jwtPayload = btoa(JSON.stringify({ sub: hex36.slice(0, 8) })).replace(/=+$/g, "")
          const jwt = `${jwtHeader}.${jwtPayload}.${b6444.slice(0, 16)}`
          const awsKey = `AKIA${hex36.slice(0, 16).toUpperCase().replace(/[^A-Z0-9]/g, "A")}`
          const slackTok = `xoxb-${hex36.slice(0, 10)}-${hex36.slice(10, 20)}-${b6444.slice(0, 16)}`
          const assign = `api_key=${quoteStyle}${hex36.slice(0, 16)}${quoteStyle} password => ${quoteStyle}pw${
            hex36.slice(0, 8)
          }${quoteStyle}`
          const containerAssign = `client_secret={a:"${hex36.slice(0, 10)}",b:[1,2]} token=('${hex36.slice(0, 8)}' + '${
            hex36.slice(8, 16)
          }')`
          const flagCmd = `cli --password ${hex36.slice(0, 12)} --api-key "${hex36.slice(0, 10)} tail" COOKIE=sess_${
            hex36.slice(0, 10)
          }`

          let nested: Record<string, unknown> = {
            [sensitiveKey]: `secret-val-${hex36}`,
            [safeKey]: safeKey.endsWith("Tokens")
              ? 42
              : `${cleanPrefix} ${ghp} ${bearer} ${sk} ${smm} ${smt1} ${signedSm} ${patSm} ${accessSm} ${cleanSuffix}`,
            pem,
            pemTrunc,
            urlCred,
            gitOauth,
            basicLower,
            basicUpper,
            jwt,
            awsKey,
            slackTok,
            assign,
            containerAssign,
            flagCmd,
            safeIdentifier: "smithers_auth_file a basic example",
            custom: `CUSTOM_${hex36.slice(0, 8)}`
          }
          for (let i = 0; i < depth; i++) nested = { wrap: nested }

          const redacted = redactor(nested)
          const serialized = JSON.stringify(redacted)
          for (
            const secret of [
              ghp,
              bearer,
              sk,
              smm,
              smt1,
              signedSm,
              patSm,
              accessSm,
              `s3cr3t${hex36.slice(0, 8)}`,
              `${hex36}:x-oauth-basic`,
              basicRaw,
              jwt,
              awsKey,
              slackTok,
              `pw${hex36.slice(0, 8)}`,
              `sess_${hex36.slice(0, 10)}`
            ]
          ) {
            if (serialized.includes(secret)) throw new Error(`leaked in default: ${secret} in ${serialized}`)
          }
          if (!serialized.includes("smithers_auth_file")) throw new Error("stripped smithers_auth_file")
          if (!serialized.includes("a basic example")) throw new Error("stripped basic example")
          if (serialized.includes(`secret-val-${hex36}`)) throw new Error(`leaked sensitiveKey ${sensitiveKey}`)
          if (safeKey.endsWith("Tokens") && !serialized.includes("42")) {
            throw new Error("stripped numeric token counter")
          }

          // Custom redactor masks custom rule + default rules
          const customOut = JSON.stringify(customRedactor(nested))
          if (customOut.includes(`CUSTOM_${hex36.slice(0, 8)}`)) throw new Error("leaked custom rule")
          if (customOut.includes(`secret-val-${hex36}`)) throw new Error("leaked sensitiveKey in custom")

          // Diagnostic rules cover headers, -p flags, curl -u, sshpass -p, signed queries, bare userinfo, header pairs
          const diagSample = {
            hdr: `Authorization: Token tok_${hex36.slice(0, 12)}\nCookie: sid=${hex36.slice(0, 12)}`,
            pair: `["Authorization", "Secret ${hex36.slice(0, 12)}"]`,
            curl: `curl -u admin:pass_${hex36.slice(0, 10)} https://tok_${hex36.slice(0, 10)}@host.test/path?sig=s_${
              hex36.slice(0, 10)
            }`,
            mysql: `mysql -p pass_${hex36.slice(0, 8)} -psecret_${hex36.slice(0, 8)} --database ok -print`,
            sshpass: `sshpass -p --weird_${hex36.slice(0, 8)} ssh host`,
            shortBearer: `Bearer abcd`,
            angle: `api_key=<sec_${hex36.slice(0, 10)}>`,
            multiline: `password:\n  ${hex36.slice(0, 12)}`,
            argv: ["--password", `argvpw_${hex36.slice(0, 8)}`, "sshpass", "-p", `--argv_${hex36.slice(0, 8)}`]
          }
          const diagOut = JSON.stringify(Redaction.redactDiagnostic(diagSample))
          const diagOut2 = JSON.stringify(diagRedactor(diagSample))
          if (diagOut !== diagOut2) throw new Error("diag mismatch")
          for (
            const secret of [
              `tok_${hex36.slice(0, 12)}`,
              `sid=${hex36.slice(0, 12)}`,
              `Secret ${hex36.slice(0, 12)}`,
              `pass_${hex36.slice(0, 10)}`,
              `tok_${hex36.slice(0, 10)}@`,
              `s_${hex36.slice(0, 10)}`,
              `secret_${hex36.slice(0, 8)}`,
              `--weird_${hex36.slice(0, 8)}`,
              `sec_${hex36.slice(0, 10)}`,
              `argvpw_${hex36.slice(0, 8)}`,
              `--argv_${hex36.slice(0, 8)}`
            ]
          ) {
            if (diagOut.includes(secret)) throw new Error(`leaked in diag: ${secret} in ${diagOut}`)
          }
          if (!diagOut.includes("-print") || !diagOut.includes("--database ok")) {
            throw new Error(`over-redacted mysql: ${diagOut}`)
          }

          // redactJsonString: valid JSON redacts secrets, malformed JSON returns original without throwing,
          // throwing redactor degrades safely to JSON-encoded placeholder
          const jsonOut = Redaction.redactJsonString(JSON.stringify(nested), redactor)
          if (jsonOut.includes(ghp)) throw new Error("jsonOut leaked ghp")
          const brokenIn = `{broken ${ghp} ${cleanPrefix}`
          const brokenOut = Redaction.redactJsonString(brokenIn, redactor)
          if (brokenOut !== brokenIn) throw new Error("brokenOut changed")
          const primOut = Redaction.redactJsonString(JSON.stringify(`hi ${smm}`), redactor)
          if (primOut.includes(smm)) throw new Error("primOut leaked smm")
          const throwingRedactor = Object.assign(
            () => {
              throw new Error("boom")
            },
            { rules: [] }
          ) as unknown as Redaction.Redactor
          if (Redaction.redactJsonString("{\"a\":1}", throwingRedactor) !== JSON.stringify(Redaction.placeholder)) {
            throw new Error("throwing redactor did not degrade to placeholder")
          }

          // makeNoop returns exact value
          const noop = Redaction.makeNoop()
          if (noop(nested) !== nested) throw new Error("noop mutated")

          return true
        },
        { seed, executions: mediumExecutions }
      )
    )
    assertFuzz(report)
  })

  it("Redaction traversal handles exotic JS values, depth limits, circular refs, throwing getters, and sensitive keys", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        exceedDepth: Schema.Boolean,
        binLen: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 })),
        hex: Schema.Array(HexChar),
        includeCircular: Schema.Boolean,
        includeThrowingGetter: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ exceedDepth, binLen, hex, includeCircular, includeThrowingGetter }) => {
          const tok = `ghp_${(hex.join("") + "0123456789abcdef0123456789abcdef01234567").slice(0, 36)}`
          // Depth error vs name mode (Redaction.maxDepth = 256)
          const depth = exceedDepth ? Redaction.maxDepth + 3 : 6
          let deep: unknown = { leaf: tok }
          for (let i = 0; i < depth; i++) deep = { next: deep }

          const named = Redaction.redact(deep, { onTooDeep: "name" })
          if (JSON.stringify(named).includes(tok)) return false
          if (exceedDepth && !JSON.stringify(named).includes(Redaction.depthMarker)) return false

          if (exceedDepth) {
            let threwDepth = false
            try {
              Redaction.redact(deep, { onTooDeep: "throw" })
            } catch (e) {
              threwDepth = e instanceof Redaction.RedactionDepthError
            }
            if (!threwDepth) return false
          }

          // Exotic values
          const u8 = new Uint8Array(binLen)
          const ab = new ArrayBuffer(binLen)
          const dv = new DataView(ab)
          const err = new Error(`boom ${tok}`)
          ;(err as unknown as Record<string, unknown>).cause = new Error(`inner ${tok}`)
          ;(err as unknown as Record<string, unknown>).apiKey = `secret-${tok}`
          const map = new Map<unknown, unknown>([["password", tok], [`key-${tok}`, `val-${tok}`]])
          const set = new Set<unknown>([tok, 123])
          const nullProto = Object.create(null) as Record<string, unknown>
          nullProto[`hdr ${tok}`] = tok
          nullProto.ok = "fine"
          const sparse: Array<unknown> = []
          sparse[2] = tok

          const obj: Record<string, unknown> = {
            u8,
            ab,
            dv,
            fn: () => tok,
            sym: Symbol(tok),
            big: BigInt(1234567890),
            validDate: new Date(1700000000000),
            invalidDate: new Date(Number.NaN),
            re: new RegExp("abc", "g"),
            err,
            map,
            set,
            nullProto,
            sparse,
            undef: undefined,
            nil: null,
            bool: true,
            num: 3.14
          }
          if (includeCircular) {
            obj.self = obj
            const arr: Array<unknown> = [tok]
            arr.push(arr)
            obj.circArr = arr
          }
          if (includeThrowingGetter) {
            const hostile: Record<string, unknown> = {}
            Object.defineProperty(hostile, "exploding", {
              enumerable: true,
              get() {
                throw new Error(`getter-fail ${tok}`)
              }
            })
            let getterThrew = false
            try {
              Redaction.redact(hostile)
            } catch {
              getterThrew = true
            }
            if (!getterThrew) throw new Error("expected getter throw")

            const proxy = new Proxy({}, {
              ownKeys() {
                throw new Error(`proxy-keys ${tok}`)
              }
            })
            let proxyThrew = false
            try {
              Redaction.redact(proxy)
            } catch {
              proxyThrew = true
            }
            if (!proxyThrew) throw new Error("expected proxy throw")
          }

          const out = Redaction.redact(obj, { onTooDeep: "name" }) as Record<string, unknown>
          const json = JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
          if (json.includes(tok)) throw new Error(`traversal leaked tok: ${json}`)
          if (out.fn !== Redaction.functionMarker) throw new Error("fn marker")
          if (out.sym !== Redaction.symbolMarker) throw new Error("sym marker")
          // Binary views are returned as { "[Binary]": "Uint8Array N bytes", ...redactedProps }
          const hasBinaryMarker = (v: unknown): boolean =>
            typeof v === "object" && v !== null && Redaction.binaryMarker in (v as Record<string, unknown>)
          if (!hasBinaryMarker(out.u8) || !hasBinaryMarker(out.ab) || !hasBinaryMarker(out.dv)) {
            throw new Error(`binary marker missing: ${JSON.stringify({ u8: out.u8, ab: out.ab, dv: out.dv })}`)
          }

          // Large binary > binaryWalkLimit, proxied binary, and binary with extra own property
          const hugeBuf = new Uint8Array(Redaction.binaryWalkLimit + 16)
          const hugeOut = Redaction.redact(hugeBuf)
          if (!hasBinaryMarker(hugeOut)) throw new Error("huge binary marker")
          const proxiedBuf = new Proxy(new Uint8Array(4), {})
          if (!hasBinaryMarker(Redaction.redact(proxiedBuf))) throw new Error("proxied binary marker")
          const taggedBuf = Object.assign(new Uint8Array(4), { apiKey: tok, note: `ok ${tok}` })
          const taggedOut = Redaction.redact(taggedBuf) as Record<string, unknown>
          if (!hasBinaryMarker(taggedOut) || JSON.stringify(taggedOut).includes(tok)) throw new Error("tagged binary")

          // toJSON returning self and returning replacement object
          const toJsonSelf = {
            apiKey: tok,
            toJSON() {
              return this
            }
          }
          const toJsonRepl = {
            toJSON() {
              return { token: tok, safe: "ok" }
            }
          }
          if (JSON.stringify(Redaction.redact({ toJsonSelf, toJsonRepl })).includes(tok)) throw new Error("toJSON leak")

          // Token counter keys: non-number values MUST still be redacted
          const counterRes = Redaction.redact({ inputTokens: 100, outputTokens: tok, apiKey: 999 }) as Record<
            string,
            unknown
          >
          if (counterRes.inputTokens !== 100) throw new Error("inputTokens")
          if (counterRes.outputTokens !== Redaction.placeholder) {
            throw new Error(`outputTokens: ${String(counterRes.outputTokens)}`)
          }
          if (counterRes.apiKey !== Redaction.placeholder) throw new Error(`apiKey: ${String(counterRes.apiKey)}`)

          // Custom rule reusing a built-in id + non-global rule + Smithers contextual barrier
          const customBuiltIn = Redaction.make({
            rules: [
              { id: "jwt", pattern: /MYJWT_[0-9a-f]+/, replace: "[MYJWT]" },
              { id: "smithers-machine-token", pattern: /smm_[A-Za-z0-9_-]{43,}/g }
            ]
          })
          const cOut = String(customBuiltIn(`MYJWT_${hex.join("") || "a"} smm_${"a".repeat(44)}`))
          if (!cOut.includes("[MYJWT]") || cOut.includes("a".repeat(44))) throw new Error(`cOut: ${cOut}`)

          return true
        },
        { seed: seed + 1, executions: mediumExecutions }
      )
    )
    assertFuzz(report)
  })

  it("Redaction.lineRedactor redacts across arbitrary chunk splits, multiline PEM/containers, and overlong/held limits", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        hex: Schema.Array(HexChar),
        chunkSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })),
        useCrlf: Schema.Boolean,
        mode: Schema.Literals(["pem", "container", "quoted", "overlong", "manyHeld", "customNonGlobal"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ hex, chunkSize, useCrlf, mode }) => {
          const tok = `ghp_${(hex.join("") + "0123456789abcdef0123456789abcdef01234567").slice(0, 36)}`
          const nl = useCrlf ? "\r\n" : "\n"
          const lr = mode === "customNonGlobal"
            ? Redaction.lineRedactor([{ id: "nonglobal", pattern: /ghp_[0-9a-f]{36}/ }])
            : Redaction.lineRedactor()

          let streamText: string
          if (mode === "pem") {
            streamText =
              `before${nl}-----BEGIN PRIVATE KEY-----${nl}${tok}${nl}secondline${nl}-----END PRIVATE KEY-----${nl}after ${tok}${nl}`
          } else if (mode === "container") {
            streamText = `password = {${nl}  nested: "${tok}",${nl}  ok: 1${nl}}${nl}done${nl}`
          } else if (mode === "quoted") {
            streamText = `api_key = "${nl}${tok}${nl}"${nl}plain${nl}`
          } else if (mode === "overlong") {
            const huge = `x`.repeat(Redaction.maxPartialLine + 128) + tok
            streamText = `${huge}${nl}tail ${tok}${nl}`
          } else if (mode === "manyHeld") {
            // Trigger eagerHeldLines / maxHeldLines
            const inner = Array.from({ length: 24 }, (_, i) => `  line_${i}: "${tok}"`).join(nl)
            streamText = `secret = {${nl}${inner}${nl}}${nl}`
          } else {
            streamText = `line1 ${tok}${nl}line2 ${tok}${nl}`
          }

          const collected: Array<string> = []
          const lines = streamText.split(nl)
          for (const rawLine of lines) {
            if (rawLine.length > chunkSize) {
              for (let i = 0; i < rawLine.length - chunkSize; i += chunkSize) {
                lr.part(rawLine.slice(i, i + chunkSize))
              }
              const remStart = Math.floor((rawLine.length - 1) / chunkSize) * chunkSize
              collected.push(...lr.line(rawLine.slice(remStart)))
            } else {
              collected.push(...lr.line(rawLine))
            }
          }
          const peeked = lr.peek()
          if (peeked.join("\n").includes(tok)) return false
          collected.push(...lr.line(`final ${tok}`))
          collected.push(...lr.flush())
          const joined = collected.join("\n")
          if (joined.includes(tok)) return false
          if (mode === "overlong" && !joined.includes(Redaction.omittedLine)) return false
          return true
        },
        { seed: seed + 2, executions: mediumExecutions }
      )
    )
    assertFuzz(report)
  })

  it("RedactedLogger wraps loggers idempotently and redacts messages, causes, stack frames, annotations, and all Console methods", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        hex: Schema.Array(HexChar),
        reasonKind: Schema.Literals(["fail", "die", "interrupt", "empty"]),
        msgKind: Schema.Literals(["string", "object", "error", "errorSubclass", "deep", "redacted", "array"]),
        consoleMethod: Schema.Literals([
          "assert",
          "clear",
          "count",
          "countReset",
          "debug",
          "dir",
          "dirxml",
          "error",
          "group",
          "groupCollapsed",
          "groupEnd",
          "info",
          "log",
          "table",
          "time",
          "timeEnd",
          "timeLog",
          "trace",
          "warn"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ hex, reasonKind, msgKind, consoleMethod }) =>
          Effect.gen(function*() {
            const tok = `ghp_${(hex.join("") + "0123456789abcdef0123456789abcdef01234567").slice(0, 36)}`
            const recorded: Array<unknown> = []
            const consoleCalls: Array<unknown> = []
            const stubConsole: Console.Console = {
              assert: (...args) => {
                consoleCalls.push(args)
              },
              clear: () => {
                consoleCalls.push("clear")
              },
              count: (...args) => {
                consoleCalls.push(args)
              },
              countReset: (...args) => {
                consoleCalls.push(args)
              },
              debug: (...args) => {
                consoleCalls.push(args)
              },
              dir: (...args) => {
                consoleCalls.push(args)
              },
              dirxml: (...args) => {
                consoleCalls.push(args)
              },
              error: (...args) => {
                consoleCalls.push(args)
              },
              group: (...args) => {
                consoleCalls.push(args)
              },
              groupCollapsed: (...args) => {
                consoleCalls.push(args)
              },
              groupEnd: () => {
                consoleCalls.push("groupEnd")
              },
              info: (...args) => {
                consoleCalls.push(args)
              },
              log: (...args) => {
                consoleCalls.push(args)
              },
              table: (...args) => {
                consoleCalls.push(args)
              },
              time: (...args) => {
                consoleCalls.push(args)
              },
              timeEnd: (...args) => {
                consoleCalls.push(args)
              },
              timeLog: (...args) => {
                consoleCalls.push(args)
              },
              trace: (...args) => {
                consoleCalls.push(args)
              },
              warn: (...args) => {
                consoleCalls.push(args)
              }
            }

            const captureLogger = Logger.make((opts) => {
              recorded.push({
                msg: opts.message,
                cause: Cause.pretty(opts.cause),
                ann: opts.fiber.getRef(References.CurrentLogAnnotations)
              })
              const c = opts.fiber.getRef(Console.Console)
              switch (consoleMethod) {
                case "clear":
                  c.clear()
                  break
                case "groupEnd":
                  c.groupEnd()
                  break
                case "assert":
                  c.assert(false, `assert ${tok}`)
                  break
                case "count":
                  c.count(`api_key=${tok}`)
                  break
                case "countReset":
                  c.countReset(`api_key=${tok}`)
                  break
                case "dir":
                  c.dir({ password: tok })
                  break
                case "dirxml":
                  c.dirxml({ token: tok })
                  break
                case "table":
                  c.table([{ apiKey: tok }])
                  break
                case "time":
                  c.time(`token=${tok}`)
                  break
                case "timeEnd":
                  c.timeEnd(`token=${tok}`)
                  break
                case "timeLog":
                  c.timeLog(`token=${tok}`, `val ${tok}`)
                  break
                default:
                  c[consoleMethod](`msg ${tok}`, { secret: tok })
              }
            })

            const wrapped = RedactedLogger.wrap(captureLogger)
            if (!RedactedLogger.isRedacted(wrapped)) return false
            if (RedactedLogger.wrap(wrapped) !== wrapped) return false

            let msg: unknown
            if (msgKind === "string") msg = `hello ${tok}`
            else if (msgKind === "object") msg = { apiKey: tok, note: `Bearer ${tok}` }
            else if (msgKind === "error") {
              const e = new Error(`err ${tok}`)
              ;(e as unknown as Record<string, unknown>).cause = new Error(`cause ${tok}`)
              msg = e
            } else if (msgKind === "errorSubclass") {
              class LeakyError extends Error {
                override readonly name = `Leaky ${tok}`
                toJSON() {
                  return { leak: tok }
                }
                get [Symbol.toStringTag]() {
                  return tok
                }
              }
              msg = new LeakyError(`sub ${tok}`)
            } else if (msgKind === "deep") {
              let d: unknown = tok
              for (let i = 0; i < 270; i++) d = { x: d }
              msg = d
            } else if (msgKind === "redacted") {
              msg = Redacted.make(tok)
            } else {
              msg = [tok, { password: tok }]
            }

            let cause: Cause.Cause<unknown> = Cause.empty
            if (reasonKind === "fail") {
              let frame: References.StackFrame | undefined = {
                name: `leaf ${tok}`,
                stack: () => `at ${tok}`,
                parent: undefined
              }
              for (let i = 0; i < 40; i++) {
                frame = { name: `f${i} ${tok}`, stack: () => `stack ${tok}`, parent: frame }
              }
              cause = Cause.fromReasons([
                Cause.makeFailReason(new Error(`fail ${tok}`)).annotate(
                  Context.make(Cause.StackTrace, frame)
                )
              ])
            } else if (reasonKind === "die") {
              cause = Cause.die({ defect: tok, apiKey: tok })
            } else if (reasonKind === "interrupt") {
              const frame: References.StackFrame = {
                name: `int ${tok}`,
                stack: () => `intstack ${tok}`,
                parent: undefined
              }
              cause = Cause.fromReasons([
                Cause.makeInterruptReason(1).annotate(
                  Context.make(Cause.InterruptorStackTrace, frame)
                )
              ])
            }

            const program = Effect.logError(msg, cause).pipe(
              Effect.annotateLogs({ apiKey: tok, note: `ann ${tok}` }),
              Effect.provideService(Console.Console, stubConsole),
              Effect.provide(RedactedLogger.layer()),
              Effect.provide(Logger.layer([captureLogger]))
            )
            yield* program

            const dumped = JSON.stringify({ recorded, consoleCalls }, (_k, v) =>
              v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v)
            return !dumped.includes(tok) && recorded.length === 1 && consoleCalls.length === 1
          }),
        { seed: seed + 3, executions: mediumExecutions }
      )
    )
    assertFuzz(report)
  })

  it("TelemetryLog.snapshot is total, bounded, redacted, schema-valid, and handles spans, causes, and hostile values", async () => {
    const isLog = Schema.is(TelemetryLog.Log)
    const arb = Arbitrary.schema(
      Schema.Struct({
        hex: Schema.Array(HexChar),
        budgetMode: Schema.Literals(["default", "zero", "tiny", "medium", "nan"]),
        msgKind: Schema.Literals(["string", "longString", "array", "exotic", "deep", "wide", "circular", "throwing"]),
        causeKind: Schema.Literals(["empty", "fail", "die", "interrupt", "combined"]),
        withSpan: Schema.Boolean,
        withOwnAnnotations: Schema.Boolean,
        faultText: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ hex, budgetMode, msgKind, causeKind, withSpan, withOwnAnnotations, faultText }) =>
          Effect.gen(function*() {
            const tok = `ghp_${(hex.join("") + "0123456789abcdef0123456789abcdef01234567").slice(0, 36)}`
            const snapshots: Array<TelemetryLog.Log> = []
            const maximumBytes = budgetMode === "default"
              ? undefined
              : budgetMode === "zero"
              ? 0
              : budgetMode === "tiny"
              ? 180
              : budgetMode === "medium"
              ? 900
              : Number.NaN

            const logger = Logger.make((opts) => {
              const adjusted = msgKind === "string"
                ? { ...opts, message: `scalar ${tok}` }
                : msgKind === "longString"
                ? { ...opts, message: `${"a".repeat(600)} ${tok}` }
                : opts
              snapshots.push(
                TelemetryLog.snapshot(adjusted, {
                  ...(maximumBytes === undefined ? {} : { maximumBytes }),
                  ...(withOwnAnnotations ? { annotations: { runId: "r1", ownSecret: tok } } : {})
                })
              )
            })

            let msg: unknown = `msg ${tok}`
            if (msgKind === "array") msg = [`a ${tok}`, 1, true, null, undefined]
            else if (msgKind === "exotic") {
              msg = {
                red: Redacted.make(tok),
                date: new Date(1700000000000),
                badDate: new Date(Number.NaN),
                err: Object.assign(new Error(`e ${tok}`), { cause: new Error(`c ${tok}`), extra: tok }),
                map: new Map([["k", tok]]),
                set: new Set([tok]),
                bin: new Uint8Array([1, 2, 3]),
                sym: Symbol(tok),
                fn: () => tok,
                big: BigInt(99),
                re: /abc/i
              }
            } else if (msgKind === "deep") {
              let d: unknown = tok
              for (let i = 0; i < 72; i++) d = { d }
              msg = d
            } else if (msgKind === "wide") {
              msg = Array.from({ length: 120 }, (_, i) => `${i}:${tok}`)
            } else if (msgKind === "circular") {
              const c: Record<string, unknown> = { a: tok }
              c.self = c
              msg = c
            } else if (msgKind === "throwing") {
              const hostile: Record<string, unknown> = {}
              Object.defineProperty(hostile, "bad", {
                enumerable: true,
                get() {
                  throw new Error(`boom ${tok}`)
                }
              })
              msg = hostile
            }

            let cause: Cause.Cause<unknown> = Cause.empty
            if (causeKind === "fail") cause = Cause.fail(`fail ${tok}`)
            else if (causeKind === "die") cause = Cause.die(new Error(`die ${tok}`))
            else if (causeKind === "interrupt") cause = Cause.interrupt(7)
            else if (causeKind === "combined") {
              cause = Cause.combine(Cause.fail(`f ${tok}`), Cause.combine(Cause.die(`d ${tok}`), Cause.interrupt(3)))
            }

            const span = Tracer.externalSpan({
              traceId: "0123456789abcdef0123456789abcdef",
              spanId: "0123456789abcdef",
              sampled: true
            })

            let eff: Effect.Effect<void> = Effect.logInfo(msg, cause).pipe(
              Effect.annotateLogs({ runId: "override-attempt", fiberSecret: tok, plain: "ok" }),
              Effect.provide(Logger.layer([logger]))
            )
            if (withSpan) eff = eff.pipe(Effect.provideService(Tracer.ParentSpan, span))
            if (faultText) {
              eff = eff.pipe(
                Effect.provideService(TelemetryText, {
                  charCodeAt: (s, i) => s.charCodeAt(i),
                  encode: () => {
                    throw new Error("encode failed")
                  }
                })
              )
            }
            yield* eff

            if (snapshots.length !== 1) return false
            const snap = snapshots[0]!
            if (!isLog(snap)) return false
            const json = JSON.stringify(snap)
            if (faultText) {
              if (snap.message !== TelemetryLog.unrenderableMarker) return false
            } else {
              // When budget is tiny/zero, degraded fallback keeps raw settings.annotations verbatim,
              // otherwise redaction always strips tok.
              if (snap.message !== TelemetryLog.truncatedMarker && json.includes(tok)) return false
              if (withSpan && (snap.traceId !== span.traceId || snap.spanId !== span.spanId)) return false
            }
            return true
          }),
        { seed: seed + 4, executions: mediumExecutions }
      )
    )
    assertFuzz(report)
  })

  it("ExecutionFact.equal, fold, and foldControl maintain provenance, tree human-wait coverage, and gap invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        status: Schema.Literals(["pending", "running", "suspended", "completed", "failed", "cancelled"]),
        childStatus: Schema.Literals(["running", "suspended", "completed"]),
        parentPolicy: Schema.Literals(["cancel", "detach"]),
        treeVersionPresent: Schema.Boolean,
        approvalWait: Schema.Boolean,
        includeGap: Schema.Boolean,
        includeStaleGen: Schema.Boolean,
        includeGenBump: Schema.Boolean,
        includeBenignDecision: Schema.Boolean,
        includeUnknownDecision: Schema.Boolean,
        includeInterrupted: Schema.Boolean,
        includeSecondRound: Schema.Boolean,
        controlMode: Schema.Literals(["valid", "missingBound", "conflictBound", "malformedEvent", "projectionGap"]),
        matchObserved: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (cfg) => {
          const mkObs = (
            id: string,
            parentRunId: string | null,
            roundOrdinal: number,
            status: ExecutionFact.Observation["status"],
            waiting: ExecutionFact.Observation["waiting"],
            flipJsonKeyOrder = false
          ): ExecutionFact.Observation => ({
            executionId: asRun(id),
            flowName: "demo.flow",
            status,
            createdAtMs: asTs(1000 + roundOrdinal),
            startedAtMs: asTs(1010),
            finishedAtMs: status === "completed" || status === "failed" || status === "cancelled" ? asTs(2000) : null,
            parentRunId: parentRunId === null ? null : asRun(parentRunId),
            lineageId: asRun("lin-1"),
            roundOrdinal: asQty(roundOrdinal),
            cancelRequestedAtMs: null,
            ...(cfg.treeVersionPresent ? { treeVersion: 1 as const, parentPolicy: cfg.parentPolicy } : {}),
            waiting: waiting === null
              ? null
              : {
                ...waiting,
                ...(cfg.treeVersionPresent
                  ? {
                    point: "approve-deploy",
                    request: flipJsonKeyOrder ? { b: [1, 2], a: "x" } : { a: "x", b: [1, 2] }
                  }
                  : {})
              }
          })

          const waitObj = cfg.approvalWait
            ? { reason: "approval", wakeAtMs: null, tokenDigest: "sha256:abc" }
            : null
          const rootObs = mkObs("root-1", null, 0, cfg.status, null)
          const round2Obs = mkObs("root-2", null, 1, cfg.status, null)
          const currentId = cfg.includeSecondRound ? "root-2" : "root-1"
          const childObs = mkObs("child-1", currentId, 0, cfg.childStatus, waitObj)

          // Verify equal() reflexivity and JSON key-order invariance
          const childReordered = mkObs("child-1", currentId, 0, cfg.childStatus, waitObj, true)
          if (!ExecutionFact.equal(childObs, childReordered)) return false
          if (ExecutionFact.equal(rootObs, childObs)) return false

          const inputs: Array<ExecutionFact.Input> = []
          let seq = 0
          inputs.push({
            executionId: "root-1",
            generation: 0,
            sequence: seq++,
            eventType: "flows.engine.run-decision",
            payload: { executionFact: { version: 1, baseline: "created", observation: rootObs } }
          })
          // Duplicate / older sequence must be ignored
          inputs.push({
            executionId: "root-1",
            generation: 0,
            sequence: 0,
            eventType: "flows.engine.run-decision",
            payload: { executionFact: { version: 1, baseline: "created", observation: rootObs } }
          })
          // Null generation without gap ignored
          inputs.push({
            executionId: "root-1",
            generation: null,
            sequence: seq++,
            eventType: "flows.engine.run-decision",
            payload: {}
          })
          if (cfg.includeBenignDecision) {
            inputs.push({
              executionId: "root-1",
              generation: 0,
              sequence: seq++,
              eventType: "flows.engine.run-decision",
              payload: { decision: "lease-reconfirmed" }
            })
          }
          if (cfg.includeGap) {
            inputs.push({
              executionId: "root-1",
              generation: 0,
              sequence: seq++,
              eventType: "gap",
              payload: {},
              gap: true
            })
            // Re-establish baseline after gap
            inputs.push({
              executionId: "root-1",
              generation: 0,
              sequence: seq++,
              eventType: "flows.engine.run-decision",
              payload: { executionFact: { version: 1, baseline: "created", observation: rootObs } }
            })
          }
          if (cfg.includeGenBump) {
            inputs.push({
              executionId: "root-1",
              generation: 1,
              sequence: 0,
              eventType: "flows.engine.run-decision",
              payload: { executionFact: { version: 1, baseline: "created", observation: rootObs } }
            })
            if (cfg.includeStaleGen) {
              inputs.push({
                executionId: "root-1",
                generation: 0,
                sequence: 99,
                eventType: "flows.engine.interrupted",
                payload: {}
              })
            }
          }
          if (cfg.includeUnknownDecision) {
            inputs.push({
              executionId: "root-1",
              generation: cfg.includeGenBump ? 1 : 0,
              sequence: 50,
              eventType: "flows.engine.run-decision",
              payload: { decision: "mystery-mutation" }
            })
          }
          if (cfg.includeInterrupted) {
            inputs.push({
              executionId: "root-1",
              generation: cfg.includeGenBump ? 1 : 0,
              sequence: 51,
              eventType: "flows.engine.interrupted",
              payload: {}
            })
          }
          if (cfg.includeSecondRound) {
            inputs.push({
              executionId: "root-2",
              generation: 0,
              sequence: 0,
              eventType: "flows.engine.run-decision",
              payload: { executionFact: { version: 1, baseline: "created", observation: round2Obs } }
            })
          }
          inputs.push({
            executionId: "child-1",
            generation: 0,
            sequence: 0,
            eventType: "flows.engine.run-decision",
            payload: { executionFact: { version: 1, baseline: "created", observation: childObs } }
          })

          const expectedWaits = cfg.parentPolicy === "cancel" && cfg.approvalWait && cfg.childStatus !== "completed"
            ? [childReordered]
            : []
          const observed: ExecutionFact.View = {
            root: rootObs,
            current: cfg.includeSecondRound ? round2Obs : rootObs,
            ...(cfg.treeVersionPresent ? { humanWaits: cfg.matchObserved ? expectedWaits : [rootObs] } : {})
          }

          const folded = ExecutionFact.fold(inputs, "root-1", observed)
          if (!Schema.is(ExecutionFact.Provenance)(folded.provenance)) return false
          const observedMatches = !cfg.treeVersionPresent || cfg.matchObserved
          const isClean = !cfg.includeUnknownDecision && !cfg.includeInterrupted && observedMatches
          if (isClean && folded.provenance.source !== "events") return false
          if (!isClean && folded.provenance.source === "events") return false

          // Exercise foldControl
          const bridge: Array<ExecutionFact.BridgeEvent> = [
            {
              runId: "other-ctrl",
              kind: "control.engine.bound",
              payload: { version: 1, controlRunId: "other-ctrl", executionId: "x" }
            }
          ]
          if (cfg.controlMode !== "missingBound") {
            bridge.push({
              runId: "ctrl-1",
              kind: "control.engine.bound",
              payload: { version: 1, controlRunId: "ctrl-1", executionId: "root-1" }
            })
          }
          if (cfg.controlMode === "conflictBound") {
            bridge.push({
              runId: "ctrl-1",
              kind: "control.engine.bound",
              payload: { version: 1, controlRunId: "ctrl-1", executionId: "root-other" }
            })
          }
          for (const inp of inputs) {
            if (inp.gap || inp.generation === null) continue
            bridge.push({
              runId: "ctrl-1",
              kind: "control.engine.event",
              payload: {
                version: 1,
                executionId: inp.executionId,
                generation: inp.generation,
                sequence: inp.sequence,
                eventType: inp.eventType,
                payload: inp.payload
              }
            })
          }
          if (cfg.controlMode === "malformedEvent") {
            bridge.push({
              runId: "ctrl-1",
              kind: "control.engine.event",
              payload: { version: 99, executionId: "root-1" }
            })
          }
          if (cfg.controlMode === "projectionGap") {
            bridge.push({
              runId: "ctrl-1",
              kind: "control.engine.projection-gap",
              payload: { executionId: "root-1", generation: 0 }
            })
          }
          const ctrlRes = ExecutionFact.foldControl(bridge, "ctrl-1", observed)
          if (ctrlRes === undefined) return false
          if (cfg.controlMode === "missingBound" && ctrlRes.provenance.source !== "legacy-observation") return false
          if (cfg.controlMode === "conflictBound" && ctrlRes.provenance.source !== "unverified-observation") {
            return false
          }
          return true
        },
        { seed: seed + 5, executions: mediumExecutions }
      )
    )
    assertFuzz(report)
  })

  it("EngineEvent constructors, decoders, relativePath, and node/plan schemas round-trip and reject foreign/unsupported/malformed inputs", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        lineageKind: Schema.Literals(["root", "child", "fork", "continuation"]),
        attemptState: Schema.Literals(["running", "suspended", "succeeded", "failed"]),
        stateKind: Schema.Literals([
          "execution-running",
          "execution-suspended",
          "execution-completed",
          "deferred",
          "clock"
        ]),
        unknownPolicy: Schema.Literals(["ignore", "surface"]),
        currentMarkerKind: Schema.Literals(["started", "finished"]),
        rootKind: Schema.Literals(["none", "slash", "winRoot", "normal", "trailingSlash"]),
        pathKind: Schema.Literals(["inside", "outside", "traversal", "empty"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (cfg) =>
          Effect.gen(function*() {
            const runId = cfg.lineageKind === "root" ? asRun("run-root") : asRun("run-child")
            const rootRunId = asRun("run-root")
            const lineageId = asLineage("lin-1")
            const parentRunId = cfg.lineageKind === "root" ? null : asRun("run-parent")
            const round = cfg.lineageKind === "root" ? 0 : 1
            const lineage: EngineEvent.Lineage = cfg.lineageKind === "root"
              ? { kind: "root", runId, lineageId, rootRunId, round: 0, parentRunId: null }
              : { kind: cfg.lineageKind, runId, lineageId, rootRunId, round: asQty(round), parentRunId: parentRunId! }

            const lifecycle: EngineEvent.AttemptLifecycle = cfg.attemptState === "running"
              ? { state: "running", startedAtMs: asTs(100), heartbeatAtMs: asTs(120) }
              : cfg.attemptState === "suspended"
              ? { state: "suspended", startedAtMs: asTs(100), checkpoint: { step: 1 } }
              : cfg.attemptState === "succeeded"
              ? {
                state: "succeeded",
                startedAtMs: asTs(100),
                finishedAtMs: asTs(200),
                result: { _tag: "Success", value: { ok: true } }
              }
              : {
                state: "failed",
                startedAtMs: asTs(100),
                finishedAtMs: asTs(200),
                result: { _tag: "Failure", reason: "error", detail: "boom" }
              }

            const attemptInput = EngineEvent.attempt(
              {
                version: 2,
                lineage,
                executionId: runId,
                stepKeyDigest: asDispatch("step-digest-1"),
                attempt: asQty(1),
                lifecycle
              },
              asSource("engine"),
              asSourceSeq(0),
              { trace: "t1" }
            )

            const mkEntry = (
              inp: JournalEvent.Input,
              override?: Partial<{ runId: string; sourceId: string; eventType: string; meta: unknown }>
            ) => ({
              runId: override?.runId ?? inp.runId,
              seq: 0,
              eventId: JournalEvent.makeEventId(inp.runId, inp.sourceId, inp.sourceSeq ?? asSourceSeq(0)),
              sourceId: override?.sourceId ?? inp.sourceId,
              sourceSeq: inp.sourceSeq ?? 0,
              emittedAtMs: 1000,
              eventType: override?.eventType ?? inp.eventType,
              payload: inp.payload,
              meta: override?.meta !== undefined ? override.meta : (inp.meta ?? null)
            })

            const consumer: EngineEvent.Consumer = {
              runId,
              lineageId,
              rootRunId,
              round: asQty(round),
              parentRunId,
              sources: [asSource("engine")],
              unknown: cfg.unknownPolicy
            }

            const decodedAttempt = yield* EngineEvent.decodeEntry(mkEntry(attemptInput), consumer)
            if (decodedAttempt._tag !== "Attempt") return false

            // State event
            const stateEventPayload: EngineEvent.StatePayload = {
              version: 2,
              lineage,
              executionId: runId,
              event: cfg.stateKind === "execution-running"
                ? { _tag: "Execution", lifecycle: { state: "running", waits: [] } }
                : cfg.stateKind === "execution-suspended"
                ? {
                  _tag: "Execution",
                  lifecycle: { state: "suspended", waits: [{ _tag: "Deferred", waitId: asWait("w1") }] }
                }
                : cfg.stateKind === "execution-completed"
                ? { _tag: "Execution", lifecycle: { state: "completed", result: { _tag: "Success", value: 42 } } }
                : cfg.stateKind === "deferred"
                ? {
                  _tag: "DeferredCompleted",
                  waitId: asWait("w1"),
                  result: { _tag: "Failure", reason: "interrupted", detail: null }
                }
                : { _tag: "ClockScheduled", clockId: asCommand("c1"), waitId: asWait("w1"), dueAtMs: asTs(5000) }
            }
            const stateInput = EngineEvent.stateEvent(stateEventPayload, asSource("engine"), asSourceSeq(1))
            const decodedState = yield* EngineEvent.decodeEntry(mkEntry(stateInput), consumer)
            if (decodedState._tag !== "State") return false

            // Foreign runId / sourceId / lineage
            const foreignErr = yield* Effect.flip(
              EngineEvent.decodeEntry(mkEntry(attemptInput, { sourceId: "other" }), consumer)
            )
            if (foreignErr.code !== "foreign") return false
            const foreignLineageErr = yield* Effect.flip(
              EngineEvent.decodeEntry(mkEntry(attemptInput), { ...consumer, lineageId: asLineage("wrong-lin") })
            )
            if (foreignLineageErr.code !== "foreign") return false

            // Unsupported flows.engine.* vs non-engine unknown/ignored
            const unsupErr = yield* Effect.flip(
              EngineEvent.decodeEntry(mkEntry(attemptInput, { eventType: "flows.engine.v99.future" }), consumer)
            )
            if (unsupErr.code !== "unsupported") return false
            const customRes = yield* EngineEvent.decodeEntry(
              mkEntry(attemptInput, { eventType: "app.custom" }),
              consumer
            )
            if (cfg.unknownPolicy === "ignore" ? customRes._tag !== "Ignored" : customRes._tag !== "Unknown") {
              return false
            }

            // Malformed
            const malErr = yield* Effect.flip(EngineEvent.decodeEntry({ broken: true }, consumer))
            if (malErr.code !== "malformed") return false

            // decodeCurrentAttempt (valid, foreign, malformed)
            const curRow = {
              runId,
              seq: 1,
              eventId: "e1",
              sourceId: "engine",
              sourceSeq: 2,
              emittedAtMs: 1000,
              eventType: cfg.currentMarkerKind === "started"
                ? "flows.engine.attempt-started"
                : "flows.engine.attempt-finished",
              payload: cfg.currentMarkerKind === "started"
                ? { runId, stepKeyDigest: "step-1", attempt: 0, tier: "sealed" }
                : { runId, stepKeyDigest: "step-1", attempt: 0, state: "succeeded" },
              meta: { lineageId }
            }
            const curDecoded = yield* EngineEvent.decodeCurrentAttempt(curRow, consumer)
            if (curDecoded.lineageId !== lineageId) return false
            const curForeign = yield* Effect.flip(
              EngineEvent.decodeCurrentAttempt({ ...curRow, sourceId: "stranger" }, consumer)
            )
            if (curForeign.code !== "foreign") return false
            const curBad = yield* Effect.flip(EngineEvent.decodeCurrentAttempt({ bad: 1 }, consumer))
            if (curBad.code !== "malformed") return false

            // relativePath
            const root = cfg.rootKind === "none"
              ? undefined
              : cfg.rootKind === "slash"
              ? "/"
              : cfg.rootKind === "winRoot"
              ? "C:\\"
              : cfg.rootKind === "normal"
              ? "/repo/app"
              : "/repo/app/"
            const p = cfg.pathKind === "inside"
              ? "/repo/app/src/flow.ts"
              : cfg.pathKind === "outside"
              ? "/other/file.ts"
              : cfg.pathKind === "traversal"
              ? "/repo/app/../secret.ts"
              : ""
            const rel = EngineEvent.relativePath(root, p)
            if ((cfg.rootKind === "normal" || cfg.rootKind === "trailingSlash") && cfg.pathKind === "inside") {
              if (rel !== "src/flow.ts") return false
            } else {
              if (rel !== undefined) return false
            }

            // Node & plan schemas
            const validDeclared = Schema.is(EngineEvent.DeclaredAt)({ path: "src/flow.ts", line: 10 })
            const invalidDeclared = Schema.is(EngineEvent.DeclaredAt)({ path: "/abs/flow.ts", line: 10 })
            const validRev = Schema.is(EngineEvent.SourceRevision)("0123456789abcdef0123456789abcdef01234567")
            const validSettled = Schema.is(EngineEvent.NodeSettledPayload)({
              nodeId: "n1",
              outcome: "built",
              attempts: 1
            })
            return validDeclared && !invalidDeclared && validRev && validSettled
          }),
        { seed: seed + 6, executions: mediumExecutions }
      )
    )
    assertFuzz(report)
  })

  it("JournalEvent helpers and schema boundaries are deterministic and reject invalid identifiers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        stream: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24)),
        runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24)),
        sourceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24)),
        sourceSeq: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
        text: Schema.String
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ stream, runId, sourceId, sourceSeq, text }) => {
          const cleanStream = stream.replace(/[^a-zA-Z0-9._-]/g, "a") || "a"
          const cleanRun = runId.replace(/[^a-zA-Z0-9._-]/g, "b") || "b"
          const cleanSource = sourceId.replace(/[^a-zA-Z0-9._-]/g, "c") || "c"
          const companion = JournalEvent.companionRunId(cleanStream, cleanRun)
          if (!JournalEvent.isCompanionRunId(companion)) return false
          if (JournalEvent.isCompanionRunId(cleanRun)) return false

          const id1 = JournalEvent.makeEventId(asRun(cleanRun), asSource(cleanSource), asSourceSeq(sourceSeq))
          const id2 = JournalEvent.makeEventId(asRun(cleanRun), asSource(cleanSource), asSourceSeq(sourceSeq))
          if (id1 !== id2) return false

          // Identifier guards: reject empty, NUL, lone surrogate, > maxIdentifierLength
          if (Schema.is(JournalEvent.RunId)("")) return false
          if (Schema.is(JournalEvent.RunId)("a\0b")) return false
          if (Schema.is(JournalEvent.RunId)("\ud800")) return false
          if (Schema.is(JournalEvent.RunId)("a".repeat(JournalEvent.maxIdentifierLength + 1))) return false
          if (!Schema.is(JournalEvent.RunId)(cleanRun)) return false

          if (isWellFormed(text)) {
            const d1 = JournalEvent.contentDigest(text)
            const d2 = JournalEvent.contentDigest(text)
            if (d1 !== d2 || !/^[0-9a-f]{64}$/.test(d1)) return false
          }
          return true
        },
        { seed: seed + 7, executions }
      )
    )
    assertFuzz(report)
  })
})

describe("@smthrs/journal Consensus & SqlConsensus fuzz invariants", () => {
  const Action = Schema.Union([
    Schema.Struct({
      op: Schema.Literal("claim"),
      key: Schema.Literals(["k1", "k2"]),
      owner: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
      dt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 40_000 }))
    }),
    Schema.Struct({
      op: Schema.Literal("activate"),
      key: Schema.Literals(["k1", "k2"]),
      owner: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
      wrongGrant: Schema.Boolean,
      dt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5_000 }))
    }),
    Schema.Struct({
      op: Schema.Literal("heartbeat"),
      key: Schema.Literals(["k1", "k2"]),
      owner: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
      dt: Schema.Int.check(Schema.isBetween({ minimum: -500, maximum: 5_000 }))
    }),
    Schema.Struct({
      op: Schema.Literal("reconfirm"),
      key: Schema.Literals(["k1", "k2"]),
      owner: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
      dt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5_000 }))
    }),
    Schema.Struct({
      op: Schema.Literal("release"),
      key: Schema.Literals(["k1", "k2"]),
      owner: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))
    }),
    Schema.Struct({
      op: Schema.Literal("steal"),
      key: Schema.Literals(["k1", "k2"]),
      owner: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
      expected: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
      kind: Schema.Literals(["lease-expired", "same-host-pid-dead"]),
      dt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 40_000 })),
      badCheckedAt: Schema.Boolean
    }),
    Schema.Struct({
      op: Schema.Literal("recover"),
      key: Schema.Literals(["k1", "k2"]),
      stale: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
      observer: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
      kind: Schema.Literals(["lease-expired", "same-host-pid-dead"]),
      dt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 40_000 })),
      wrongGrant: Schema.Boolean
    }),
    Schema.Struct({
      op: Schema.Literal("guard"),
      key: Schema.Literals(["k1", "k2"]),
      owner: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))
    })
  ])

  it("Consensus.layerLocal and SqlConsensus.layer are observationally equivalent across arbitrary lease action sequences", async () => {
    const arb = Arbitrary.schema(Schema.Array(Action).check(Schema.isMinLength(1), Schema.isMaxLength(18)))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (actions) =>
          Effect.scoped(Effect.gen(function*() {
            const localCtx = yield* Layer.build(Consensus.layerLocal)
            const sqlCtx = yield* Layer.build(SqlConsensus.layer.pipe(Layer.provide(migratedDb())))
            const local = Context.get(localCtx, Consensus.Consensus)
            const sqlC = Context.get(sqlCtx, Consensus.Consensus)

            let now = 1000
            const lastGrant = new Map<string, number>()

            for (const act of actions) {
              const owner = mkOwner("owner" in act ? act.owner : act.observer)
              if ("dt" in act) now = Math.max(0, now + act.dt)

              const runBoth = <A>(
                fn: (c: Consensus.Service) => Effect.Effect<A, Consensus.ConsensusError>
              ) => Effect.all([Effect.result(fn(local)), Effect.result(fn(sqlC))])

              const key = act.key
              let res: [unknown, unknown]
              if (act.op === "claim") {
                const [l, s] = yield* runBoth((c) => c.claim(key, owner, now))
                if (l._tag === "Success" && l.success._tag === "Claimed") {
                  lastGrant.set(`${key}:${act.owner}`, l.success.grantedAtMs)
                }
                res = [l, s]
              } else if (act.op === "activate") {
                const grant = (lastGrant.get(`${key}:${act.owner}`) ?? 0) + (act.wrongGrant ? 1 : 0)
                res = yield* runBoth((c) => c.activate(key, owner, grant, now))
              } else if (act.op === "heartbeat") {
                res = yield* runBoth((c) => c.heartbeat(key, owner, now))
              } else if (act.op === "reconfirm") {
                res = yield* runBoth((c) => c.reconfirm(key, owner, now))
              } else if (act.op === "release") {
                res = yield* runBoth((c) => c.release(key, owner))
              } else if (act.op === "steal") {
                const ev: Consensus.LivenessEvidence = {
                  expectedOwner: mkOwner(act.expected),
                  checkedAtMs: act.badCheckedAt ? now - 100 : now,
                  kind: act.kind
                }
                const [l, s] = yield* runBoth((c) => c.steal(key, owner, now, ev))
                if (l._tag === "Success" && l.success._tag === "Claimed") {
                  lastGrant.set(`${key}:${act.owner}`, l.success.grantedAtMs)
                }
                res = [l, s]
              } else if (act.op === "recover") {
                const stale = mkOwner(act.stale)
                const grant = (lastGrant.get(`${key}:${act.stale}`) ?? 0) + (act.wrongGrant ? 1 : 0)
                const ev: Consensus.LivenessEvidence = {
                  expectedOwner: stale,
                  checkedAtMs: now,
                  kind: act.kind
                }
                res = yield* runBoth((c) => c.recover(key, stale, grant, owner, now, ev))
              } else {
                res = yield* runBoth((c) => c.guard(key, owner))
              }

              const norm = (r: unknown) => {
                const x = r as { _tag: string; success?: unknown; failure?: Consensus.ConsensusError }
                return x._tag === "Success" ? { ok: x.success } : { err: x.failure?.code }
              }
              if (JSON.stringify(norm(res[0])) !== JSON.stringify(norm(res[1]))) return false
            }
            return true
          })).pipe(Effect.provide(silentLog)),
        { seed: seed + 10, executions: sqlExecutions }
      )
    )
    assertFuzz(report)
  })

  it("Consensus.layerLocal withPermit enforces mutual exclusion, renewal, steal/recover, and fence_lost under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        workMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 2500 })),
        mode: Schema.Literals([
          "race",
          "stealDead",
          "recoverStaleClaim",
          "fenceLost",
          "persistenceTimeout",
          "activateLost"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ workMs, mode }) =>
          Effect.gen(function*() {
            const consensus = yield* Consensus.makeLocal
            const o1 = mkOwner(0) // host-a, pid 100
            const o2 = mkOwner(2) // host-a, pid 102 (same host, diff pid)
            const o3 = mkOwner(1) // host-b, pid 101 (diff host)

            if (mode === "race") {
              let inCritical = 0
              let overlap = false
              let completed = 0
              const task = (owner: OwnerId.OwnerId) =>
                consensus.withPermit(
                  "res-1",
                  owner,
                  () => Effect.succeed(true),
                  Effect.gen(function*() {
                    inCritical++
                    if (inCritical > 1) overlap = true
                    yield* Effect.sleep(Duration.millis(Math.min(workMs, 1500)))
                    inCritical--
                    completed++
                  })
                )
              yield* Effect.all([task(o1), task(o2)], { concurrency: 2 })
              return !overlap && completed === 2
            }

            if (mode === "stealDead") {
              const g = yield* consensus.claim("res-dead", o1, 0)
              if (g._tag !== "Claimed") return false
              yield* consensus.activate("res-dead", o1, g.grantedAtMs, 0)
              // Same-host dead pid steal (o2 has same hostId as o1, diff pid)
              const val = yield* consensus.withPermit(
                "res-dead",
                o2,
                () => Effect.succeed(false),
                Effect.succeed("stolen")
              )
              return val === "stolen"
            }

            if (mode === "recoverStaleClaim") {
              yield* consensus.claim("res-claim", o1, 0)
              yield* Effect.sleep(Duration.millis(Duration.toMillis(Consensus.heartbeatStaleAfter) + 100))
              const val = yield* consensus.withPermit(
                "res-claim",
                o3,
                () => Effect.succeed(false),
                Effect.succeed("recovered")
              )
              return val === "recovered"
            }

            if (mode === "fenceLost") {
              const exit = yield* Effect.exit(
                consensus.withPermit(
                  "res-fence",
                  o1,
                  () => Effect.succeed(true),
                  Effect.gen(function*() {
                    yield* consensus.release("res-fence", o1)
                    yield* Effect.sleep(Duration.seconds(3))
                  })
                )
              )
              return Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof Consensus.ConsensusError &&
                (Cause.squash(exit.cause) as Consensus.ConsensusError).code === "fence_lost"
            }

            if (mode === "persistenceTimeout") {
              // Wrap consensus so reconfirm always fails transiently with persistence_failed
              const failingStrategy = {
                ...consensus,
                reconfirm: () =>
                  Effect.fail(new Consensus.ConsensusError({ code: "persistence_failed", message: "transient" }))
              }
              const exit = yield* Effect.exit(
                Consensus.resourcePermit(
                  failingStrategy,
                  () => Effect.succeed(undefined),
                  "res-persist",
                  o1,
                  () => Effect.succeed(true),
                  Effect.sleep(Duration.seconds(60))
                )
              )
              return Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof Consensus.ConsensusError &&
                (Cause.squash(exit.cause) as Consensus.ConsensusError).code === "persistence_failed"
            }

            // activateLost: first activate returns Lost, second succeeds
            let attempts = 0
            const flakyStrategy = {
              ...consensus,
              activate: (k: string, o: OwnerId.OwnerId, g: number, n: number) =>
                attempts++ === 0
                  ? Effect.succeed({ _tag: "Lost" } as const)
                  : consensus.activate(k, o, g, n)
            }
            const res = yield* Consensus.resourcePermit(
              flakyStrategy,
              () => Effect.succeed(undefined),
              "res-act",
              o1,
              () => Effect.succeed(true),
              Effect.succeed(99)
            )
            return res === 99 && attempts >= 2
          }).pipe(Effect.provide(silentLog)),
        { seed: seed + 11, executions: 30, execution: FuzzSimulation.execution() }
      )
    )
    assertFuzz(report)
  })

  it("SqlConsensus withPermit and storage failures (dropped table) report persistence_failed", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        key: Schema.Literals(["r1", "r2"]),
        stealBeforeDrop: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ key, stealBeforeDrop }) =>
          Effect.scoped(Effect.gen(function*() {
            const stack = SqlConsensus.layer.pipe(Layer.provideMerge(migratedDb()))
            const ctx = yield* Layer.build(stack)
            const consensus = Context.get(ctx, Consensus.Consensus)
            const sql = Context.get(ctx, SqlClient.SqlClient)
            const o1 = mkOwner(0)
            const o2 = mkOwner(2)

            if (stealBeforeDrop) {
              yield* holdLease(sql, key, o1, 0)
              const val = yield* consensus.withPermit(key, o2, () => Effect.succeed(false), Effect.succeed("ok"))
              if (val !== "ok") return false
            } else {
              const val = yield* consensus.withPermit(key, o1, () => Effect.succeed(true), Effect.succeed("ok"))
              if (val !== "ok") return false
            }

            // Drop table and verify every operation reports persistence_failed
            yield* sql`DROP TABLE flows_consensus_leases`
            const nowMs = Duration.toMillis(Consensus.heartbeatStaleAfter) + 10
            const ev: Consensus.LivenessEvidence = { expectedOwner: o1, checkedAtMs: nowMs, kind: "lease-expired" }
            const errs = yield* Effect.forEach([
              consensus.claim(key, o1, 1),
              consensus.activate(key, o1, 0, 1),
              consensus.heartbeat(key, o1, 1),
              consensus.reconfirm(key, o1, 1),
              consensus.release(key, o1),
              consensus.steal(key, o2, nowMs, ev),
              consensus.recover(key, o1, 0, o2, nowMs, ev),
              consensus.guard(key, o1)
            ], Effect.flip)
            return errs.every((e) => e.code === "persistence_failed" && e.cause !== undefined)
          })).pipe(Effect.provide(TestClock.layer()), Effect.provide(silentLog)),
        { seed: seed + 12, executions: 10 }
      )
    )
    assertFuzz(report)
  })
})

describe("@smthrs/journal Journal, Notifying, Generation & Projection fuzz invariants", () => {
  it("Journal.makeNoop / layerNoop, Notifying.wrap / layer, and JournalGeneration honor contracts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        runSuffix: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
        failBefore: Schema.Boolean,
        payloadNum: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ runSuffix, failBefore, payloadNum }) =>
          Effect.scoped(Effect.gen(function*() {
            const runId = asRun(`noop-run-${runSuffix}`)
            const owner = mkOwner(0)
            const inp = mkInput(runId, "src", "ev", { n: payloadNum })

            // Exercise every method on makeNoop / layerNoop
            const noopCtx = yield* Layer.build(Journal.layerNoop())
            const noop = Context.get(noopCtx, Journal.Journal)
            const closedCalls = yield* Effect.forEach([
              noop.emitLossy(inp),
              noop.emitDurable(inp, owner),
              noop.emitDurableUnfenced(inp),
              noop.entries({ runId, limit: 10 }),
              noop.flush,
              noop.checkpoint({ runId, seq: asSeq(0), state: {} }, owner),
              noop.latestCheckpoint(runId),
              noop.compact({ runId }, owner),
              Stream.runCollect(noop.stream({ runId })),
              Stream.runCollect(
                noop.project(
                  Projection.make({ name: "p", initial: 0, reduce: (s) => Effect.succeed(s + 1) }),
                  { runId }
                )
              )
            ], Effect.flip)
            if (!closedCalls.every((e) => e.code === "journal_closed")) return false
            if ((yield* noop.transact(Effect.succeed(7))) !== 7) return false
            if ((yield* noop.whenCommitted(Effect.void)) !== true) return false
            const sub = yield* noop.changes
            if (sub === undefined) return false

            // Notifying.wrap on custom service (Effect prop, Effect method, non-Effect method, plain prop)
            const events: Array<string> = []
            const custom = Notifying.wrap(
              {
                ping: Effect.succeed("pong"),
                echo: (x: number) => failBefore ? Effect.fail("boom") : Effect.succeed(x * 2),
                syncFn: (x: number) => x + 1,
                plain: 42
              },
              (op, order) =>
                Effect.sync(() => {
                  events.push(`${op}:${order}`)
                })
            )
            if (custom.plain !== 42 || custom.syncFn(3) !== 4) return false
            if ((yield* custom.ping) !== "pong") return false
            const echoRes = yield* Effect.result(custom.echo(payloadNum))
            if (failBefore) {
              if (echoRes._tag !== "Failure") return false
              if (events.includes("echo:after")) return false
            } else {
              if (echoRes._tag !== "Success" || echoRes.success !== payloadNum * 2) return false
              if (!events.includes("echo:before") || !events.includes("echo:after")) return false
            }

            // Notifying.layer wrapping TestJournal.layer
            const jEvents: Array<string> = []
            const jLayer = Notifying.layer(Journal.Journal, (op, order) =>
              Effect.sync(() => {
                jEvents.push(`${op}:${order}`)
              })).pipe(Layer.provide(TestJournal.layer({ capacity: 16, overflow: "reject" })))
            const jCtx = yield* Layer.build(jLayer)
            const j = Context.get(jCtx, Journal.Journal)
            yield* j.emitDurableUnfenced(inp)
            if (!jEvents.includes("emitDurableUnfenced:before") || !jEvents.includes("emitDurableUnfenced:after")) {
              return false
            }
            return true
          })).pipe(Effect.provide(silentLog)),
        { seed: seed + 15, executions: 25 }
      )
    )
    assertFuzz(report)

    // Also cover JournalGeneration.initialize on a read-only SQLite file
    const root = mkdtempSync(join(tmpdir(), "journal-fuzz-ro-"))
    const filename = join(root, "store.db")
    try {
      const db = new DatabaseSync(filename)
      db.exec("CREATE TABLE flows_migrations (id INTEGER)")
      db.close()
      const tables = await Effect.runPromise(
        Effect.gen(function*() {
          yield* JournalGeneration.initialize
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`
        }).pipe(Effect.provide(NodeDatabase.layer({ filename, readOnly: true })))
      )
      expect(tables).toEqual([{ name: "flows_migrations" }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("@smthrs/journal SqlJournal fuzz invariants", () => {
  const JournalOp = Schema.Union([
    Schema.Struct({
      op: Schema.Literal("emitDurable"),
      run: Schema.Literals(["r1", "r2"]),
      src: Schema.Literals(["s1", "s2"]),
      eventType: Schema.Literals(["ev.a", "ev.b"]),
      val: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
      explicitSeq: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
      dedupe: Schema.Literals(["content", "identity"]),
      wrongOwner: Schema.Boolean
    }),
    Schema.Struct({
      op: Schema.Literal("emitUnfenced"),
      run: Schema.Literals(["r1", "r2"]),
      src: Schema.Literals(["s1", "s2"]),
      eventType: Schema.Literals(["ev.a", "ev.b"]),
      val: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
      explicitSeq: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
      dedupe: Schema.Literals(["content", "identity"])
    }),
    Schema.Struct({
      op: Schema.Literal("emitLossy"),
      run: Schema.Literals(["r1", "r2"]),
      src: Schema.Literals(["s1", "s2"]),
      eventType: Schema.Literals(["ev.a", "ev.b"]),
      val: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
      explicitSeq: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
      dedupe: Schema.Literals(["content", "identity"])
    }),
    Schema.Struct({ op: Schema.Literal("flush") }),
    Schema.Struct({
      op: Schema.Literal("entries"),
      run: Schema.Literals(["r1", "r2"]),
      order: Schema.Literals(["asc", "desc"]),
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
      filterType: Schema.NullOr(Schema.Literals(["ev.a", "ev.b"]))
    }),
    Schema.Struct({
      op: Schema.Literal("checkpoint"),
      run: Schema.Literals(["r1", "r2"]),
      wrongOwner: Schema.Boolean,
      badSeq: Schema.Boolean
    }),
    Schema.Struct({
      op: Schema.Literal("compact"),
      run: Schema.Literals(["r1", "r2"]),
      wrongOwner: Schema.Boolean,
      explicitUpTo: Schema.Boolean
    }),
    Schema.Struct({ op: Schema.Literal("heads") }),
    Schema.Struct({ op: Schema.Literal("generation"), run: Schema.Literals(["r1", "r2"]) })
  ])

  it("SqlJournal stateful command sequences preserve monotonic seq, idempotency, fencing, pagination, checkpoints, compaction, and tally", async () => {
    const arb = Arbitrary.schema(Schema.Array(JournalOp).check(Schema.isMinLength(3), Schema.isMaxLength(16)))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (ops) =>
          Effect.scoped(Effect.gen(function*() {
            const db = yield* Layer.build(migratedDb())
            const sql = Context.get(db, SqlClient.SqlClient)
            const owner = mkOwner(0)
            const intruder = mkOwner(1)
            yield* holdLease(sql, "r1", owner)
            yield* holdLease(sql, "r2", owner)

            const jCtx = yield* Layer.build(
              SqlJournal.layer({ capacity: 64, batchSize: 4, overflow: "reject" }).pipe(
                Layer.provide(Layer.succeedContext(db))
              )
            )
            const journal = Context.get(jCtx, Journal.Journal)
            const committedSeqs = new Map<string, Array<number>>([["r1", []], ["r2", []]])
            const latestCkpt = new Map<string, number>()

            for (const op of ops) {
              if (op.op === "emitDurable") {
                const inp = mkInput(op.run, op.src, op.eventType, { v: op.val }, {
                  ...(op.explicitSeq === null ? {} : { sourceSeq: op.explicitSeq }),
                  dedupe: op.dedupe
                })
                const [tally, res] = yield* JournalMetrics.tally(
                  Effect.result(journal.emitDurable(inp, op.wrongOwner ? intruder : owner))
                )
                if (op.wrongOwner) {
                  if (res._tag !== "Failure" || res.failure.code !== "fence_lost") return false
                  if (tally.events !== 0) return false
                } else if (res._tag === "Success") {
                  if (res.success._tag === "Accepted") {
                    if (tally.events !== 1) return false
                    const arr = committedSeqs.get(op.run)!
                    if (arr.length > 0 && res.success.seq <= arr[arr.length - 1]!) return false
                    arr.push(res.success.seq)
                    // recorded() must know this committed entry if explicitSeq was set
                    if (op.explicitSeq !== null && !(yield* journal.recorded!(inp))) return false
                  } else if (res.success._tag === "Duplicate") {
                    if (tally.events !== 0) return false
                  }
                } else if (res.failure.code !== "idempotency_conflict") {
                  return false
                }
              } else if (op.op === "emitUnfenced") {
                const inp = mkInput(op.run, op.src, op.eventType, { v: op.val }, {
                  ...(op.explicitSeq === null ? {} : { sourceSeq: op.explicitSeq }),
                  dedupe: op.dedupe
                })
                const [tally, res] = yield* JournalMetrics.tally(Effect.result(journal.emitDurableUnfenced(inp)))
                if (res._tag === "Success") {
                  if (res.success._tag === "Accepted") {
                    if (tally.events !== 1) return false
                    const arr = committedSeqs.get(op.run)!
                    if (arr.length > 0 && res.success.seq <= arr[arr.length - 1]!) return false
                    arr.push(res.success.seq)
                  } else if (tally.events !== 0) return false
                } else if (res.failure.code !== "idempotency_conflict") {
                  return false
                }
              } else if (op.op === "emitLossy") {
                const inp = mkInput(op.run, op.src, op.eventType, { v: op.val }, {
                  ...(op.explicitSeq === null ? {} : { sourceSeq: op.explicitSeq }),
                  dedupe: op.dedupe
                })
                const res = yield* Effect.result(journal.emitLossy(inp))
                if (res._tag === "Failure" && res.failure.code !== "idempotency_conflict") return false
              } else if (op.op === "flush") {
                const res = yield* Effect.result(journal.flush)
                if (res._tag === "Failure" && res.failure.code !== "idempotency_conflict") return false
                // Refresh committedSeqs from DB after flush
                for (const r of ["r1", "r2"] as const) {
                  const rows = yield* sql<
                    { seq: number }
                  >`SELECT seq FROM flows_journal_events WHERE run_id = ${r} ORDER BY seq`
                  committedSeqs.set(r, rows.map((x) => Number(x.seq)))
                }
              } else if (op.op === "entries") {
                const page = yield* journal.entries({
                  runId: asRun(op.run),
                  order: op.order,
                  limit: op.limit,
                  ...(op.filterType === null ? {} : { eventTypes: [op.filterType] })
                })
                if (page.entries.length > op.limit) return false
                for (let i = 1; i < page.entries.length; i++) {
                  const prev = page.entries[i - 1]!.seq
                  const curr = page.entries[i]!.seq
                  if (op.order === "asc" ? curr <= prev : curr >= prev) return false
                }
                if (op.filterType !== null && page.entries.some((e) => e.eventType !== op.filterType)) return false
              } else if (op.op === "checkpoint") {
                const arr = committedSeqs.get(op.run)!
                const targetSeq = op.badSeq || arr.length === 0 ? 9999 : arr[arr.length - 1]!
                const res = yield* Effect.result(
                  journal.checkpoint(
                    { runId: asRun(op.run), seq: asSeq(targetSeq), state: { snap: targetSeq } },
                    op.wrongOwner ? intruder : owner
                  )
                )
                if (op.wrongOwner) {
                  if (res._tag !== "Failure" || res.failure.code !== "fence_lost") return false
                } else if (op.badSeq || arr.length === 0) {
                  if (res._tag !== "Failure") return false
                } else if (res._tag === "Success") {
                  latestCkpt.set(op.run, targetSeq)
                  const got = yield* journal.latestCheckpoint(asRun(op.run))
                  if (Option.isNone(got) || got.value.seq < targetSeq) return false
                }
              } else if (op.op === "compact") {
                const ckptSeq = latestCkpt.get(op.run)
                const res = yield* Effect.result(
                  journal.compact(
                    {
                      runId: asRun(op.run),
                      ...(op.explicitUpTo && ckptSeq !== undefined ? { upTo: asSeq(ckptSeq) } : {})
                    },
                    op.wrongOwner ? intruder : owner
                  )
                )
                if (op.wrongOwner) {
                  if (res._tag !== "Failure" || res.failure.code !== "fence_lost") return false
                } else if (ckptSeq === undefined) {
                  if (res._tag !== "Failure") return false
                } else if (res._tag === "Success") {
                  // Compacting again at same checkpoint is idempotent (deleted === 0)
                  const again = yield* journal.compact({ runId: asRun(op.run), upTo: res.success.checkpointSeq }, owner)
                  if (again.deleted !== 0) return false
                }
              } else if (op.op === "heads") {
                const h = yield* journal.heads!([asRun("r1"), asRun("r2"), asRun("r-empty")])
                const emptyHead = h.find((x) => x.runId === asRun("r-empty"))
                if (emptyHead === undefined || emptyHead.maxSeq !== null) return false
              } else if (op.op === "generation") {
                const gen = yield* journal.generation!(asRun(op.run))
                if (gen.generation !== 0 || gen.afterSeq !== -1) return false
              }
            }
            return true
          })).pipe(Effect.provide(TestClock.layer()), Effect.provide(silentLog)),
        { seed: seed + 20, executions: sqlExecutions }
      )
    )
    assertFuzz(report)
  })

  it("SqlJournal validates options, overflow policies (reject/drop-newest/drop-oldest), maxEntryBytes, and sourceEventCache eviction", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        overflow: Schema.Literals(["reject", "drop-newest", "drop-oldest"]),
        capacity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        extraCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 64 })),
        invalidOpt: Schema.Literals(["cap0", "batch0", "cache0", "maxBytes0", "compThreshold0"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ overflow, capacity, extraCount, maxBytes, invalidOpt }) =>
          Effect.scoped(Effect.gen(function*() {
            // 1. Invalid options rejected cleanly
            const badOpts: SqlJournal.SqlJournalOptions = invalidOpt === "cap0"
              ? { capacity: 0, overflow: "reject" }
              : invalidOpt === "batch0"
              ? { capacity: 4, batchSize: 0, overflow: "reject" }
              : invalidOpt === "cache0"
              ? { capacity: 4, sourceEventCache: 0, overflow: "reject" }
              : invalidOpt === "maxBytes0"
              ? { capacity: 4, maxEntryBytes: 0, overflow: "reject" }
              : {
                capacity: 4,
                overflow: "reject",
                compaction: { entryThreshold: 0, capture: () => Effect.succeed(null) }
              }

            const badErr = yield* Effect.flip(
              Layer.build(SqlJournal.layer(badOpts).pipe(Layer.provide(migratedDb())))
            )
            if (!(badErr instanceof Journal.JournalError) || badErr.code !== "invalid_event") return false

            // 2. Gated DurableWriter to test overflow policies deterministically
            const gate = yield* Deferred.make<void>()
            const gatedDb = Layer.provideMerge(
              Layer.effect(
                DurableWriter.DurableWriter,
                Effect.map(DurableWriter.DurableWriter, (base) =>
                  DurableWriter.DurableWriter.of({
                    write: (eff, opts) => Deferred.await(gate).pipe(Effect.andThen(base.write(eff, opts)))
                  }))
              ),
              migratedDb()
            )
            const ctx = yield* Layer.build(
              SqlJournal.layer({ capacity, overflow, batchSize: 1 }).pipe(Layer.provide(gatedDb))
            )
            const j = Context.get(ctx, Journal.Journal)
            // Wait for background drain fiber to pick up first item or block on gate
            const total = capacity + extraCount + 2
            let sawOverflowSignal = false
            for (let i = 0; i < total; i++) {
              const r = yield* Effect.result(j.emitLossy(mkInput("ov-run", "s1", "ev", { i }, { sourceSeq: i })))
              if (overflow === "reject" && r._tag === "Failure" && r.failure.code === "queue_overflow") {
                sawOverflowSignal = true
              }
              if (overflow === "drop-newest" && r._tag === "Success" && r.success._tag === "Dropped") {
                sawOverflowSignal = true
              }
              if (overflow === "drop-oldest" && r._tag === "Success") {
                sawOverflowSignal = true
              }
            }
            yield* Deferred.succeed(gate, undefined)
            yield* j.flush
            if (!sawOverflowSignal) return false

            // 3. maxEntryBytes + non-JSON payload + sourceEventCache eviction
            const ctx2 = yield* Layer.build(
              SqlJournal.layer({
                capacity: 16,
                overflow: "reject",
                maxEntryBytes: maxBytes,
                sourceEventCache: 2
              }).pipe(Layer.provide(migratedDb()))
            )
            const j2 = Context.get(ctx2, Journal.Journal)
            // Oversized payload fails invalid_event without consuming a sequence
            const overErr = yield* Effect.flip(
              j2.emitDurableUnfenced(mkInput("b-run", "s1", "ev", { big: "x".repeat(maxBytes + 20) }))
            )
            if (overErr.code !== "invalid_event") return false

            // Non-serializable payload (BigInt / circular) fails invalid_event
            const bigErr = yield* Effect.flip(
              j2.emitDurableUnfenced(mkInput("b-run", "s1", "ev", { big: BigInt(1) }))
            )
            if (bigErr.code !== "invalid_event") return false

            // Invalid input / invalid options on read/checkpoint/compact/stream
            const badRead = yield* Effect.flip(j2.entries({ runId: asRun(""), limit: 1 }))
            if (badRead.code !== "invalid_event") return false

            // Emit 4 tiny entries so sourceEventCache=2 evicts seq 0
            for (let i = 0; i < 4; i++) {
              const r = yield* j2.emitDurableUnfenced(mkInput("b-run", "s1", "e", i, { sourceSeq: i }))
              if (r._tag !== "Accepted" || r.seq !== i) return false
            }
            // Retry evicted sourceSeq=0 with identical content via lossy -> optimistic Accepted, flush succeeds
            const dupLossy = yield* j2.emitLossy(mkInput("b-run", "s1", "e", 0, { sourceSeq: 0 }))
            if (dupLossy._tag !== "Accepted") return false
            yield* j2.flush

            // Retry evicted sourceSeq=1 with DIFFERENT content via lossy -> conflict surfaces at flush
            yield* j2.emitLossy(mkInput("b-run", "s1", "e", 999, { sourceSeq: 1 }))
            const conflict = yield* Effect.flip(j2.flush)
            if (conflict.code !== "idempotency_conflict") return false
            return true
          })).pipe(Effect.provide(TestClock.layer()), Effect.provide(silentLog)),
        { seed: seed + 21, executions: 18 }
      )
    )
    assertFuzz(report)
  })

  it("SqlJournal transact (commit/rollback/nested/whenCommitted), emitDeferred, and recall preserve atomicity", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nEvents: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        rollbackOuter: Schema.Boolean,
        rollbackInner: Schema.Boolean,
        useDeferred: Schema.Boolean,
        useRecall: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ nEvents, rollbackOuter, rollbackInner, useDeferred, useRecall }) =>
          Effect.scoped(Effect.gen(function*() {
            const db = yield* Layer.build(migratedDb())
            const sql = Context.get(db, SqlClient.SqlClient)
            const owner = mkOwner(0)
            yield* holdLease(sql, "tx-run", owner)
            yield* holdLease(sql, "def-run", owner)

            const jCtx = yield* Layer.build(
              SqlJournal.layer({ capacity: 32, overflow: "reject" }).pipe(
                Layer.provide(Layer.succeedContext(db))
              )
            )
            const j = Context.get(jCtx, Journal.Journal)

            let committedCallbacks = 0
            const [tally, txRes] = yield* JournalMetrics.tally(
              Effect.result(
                j.transact(
                  Effect.gen(function*() {
                    for (let i = 0; i < nEvents; i++) {
                      yield* j.emitDurable(mkInput("tx-run", "s1", "tx.ev", { i }, { sourceSeq: i }), owner)
                    }
                    const registered = yield* j.whenCommitted(Effect.sync(() => {
                      committedCallbacks++
                    }))
                    if (registered !== true || committedCallbacks !== 0) {
                      return yield* Effect.fail("unexpected-immediate")
                    }

                    // Nested savepoint
                    const nestedRes = yield* Effect.result(
                      j.transact(
                        Effect.gen(function*() {
                          yield* j.emitDurableUnfenced(
                            mkInput("tx-run", "s2", "nested.ev", { ok: true }, { sourceSeq: 0 })
                          )
                          if (rollbackInner) return yield* Effect.fail("inner-abort")
                        })
                      )
                    )
                    if (rollbackInner && nestedRes._tag !== "Failure") return yield* Effect.fail("expected-inner-fail")
                    if (rollbackOuter) return yield* Effect.fail("outer-abort")
                    return "committed"
                  })
                )
              )
            )

            const page = yield* j.entries({ runId: asRun("tx-run"), limit: 50 })
            if (rollbackOuter) {
              if (txRes._tag !== "Failure") return false
              if (page.entries.length !== 0) return false
              if (committedCallbacks !== 0) return false
              if (tally.events !== 0) return false
            } else {
              if (txRes._tag !== "Success") return false
              const expected = nEvents + (rollbackInner ? 0 : 1)
              if (page.entries.length !== expected) return false
              if (committedCallbacks !== 1) return false
              if (tally.events !== expected) return false
            }

            // Deferred + recall
            if (useDeferred) {
              for (let i = 0; i < nEvents; i++) {
                yield* j.emitDeferred!(mkInput("def-run", "sd", "def.ev", { i }, { sourceSeq: i }), owner)
              }
              // Duplicate deferred entry is deduplicated in memory
              yield* j.emitDeferred!(mkInput("def-run", "sd", "def.ev", { i: 0 }, { sourceSeq: 0 }), owner)
              // Flushing via a durable emit on the same run commits deferred entries in order first
              yield* j.emitDurable(mkInput("def-run", "sd", "barrier.ev", { after: true }, { sourceSeq: 100 }), owner)
              const defPage = yield* j.entries({ runId: asRun("def-run"), limit: 50 })
              if (defPage.entries.length !== nEvents + 1) return false
              if (defPage.entries[defPage.entries.length - 1]!.eventType !== "barrier.ev") return false

              if (useRecall) {
                // Reopen fresh journal with sourceEventCache=16, call recall(), then recorded() & emitDeferred
                const j2Ctx = yield* Layer.build(
                  SqlJournal.layer({ capacity: 16, overflow: "reject", sourceEventCache: 16 }).pipe(
                    Layer.provide(Layer.succeedContext(db))
                  )
                )
                const j2 = Context.get(j2Ctx, Journal.Journal)
                yield* j2.recall!(asRun("def-run"))
                if (!(yield* j2.recorded!(mkInput("def-run", "sd", "def.ev", { i: 0 }, { sourceSeq: 0 })))) return false
                // Identical deferred re-emit is dropped without error
                yield* j2.emitDeferred!(mkInput("def-run", "sd", "def.ev", { i: 0 }, { sourceSeq: 0 }), owner)
                yield* j2.flush
              }
            }
            return true
          })).pipe(Effect.provide(TestClock.layer()), Effect.provide(silentLog)),
        { seed: seed + 22, executions: sqlExecutions }
      )
    )
    assertFuzz(report)
  })

  it("SqlJournal stream (replay-then-follow), changes, project, compaction barrier with active readers, and compacted_range", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        initialCount: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 5 })),
        liveCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        useLossyLive: Schema.Boolean,
        testReducerError: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ initialCount, liveCount, useLossyLive, testReducerError }) =>
          Effect.scoped(Effect.gen(function*() {
            const db = yield* Layer.build(migratedDb())
            const sql = Context.get(db, SqlClient.SqlClient)
            const owner = mkOwner(0)
            yield* holdLease(sql, "s-run", owner)

            const jCtx = yield* Layer.build(
              SqlJournal.layer({ capacity: 32, overflow: "reject" }).pipe(
                Layer.provide(Layer.succeedContext(db))
              )
            )
            const j = Context.get(jCtx, Journal.Journal)

            // Subscribe to changes PubSub
            const sub = yield* j.changes

            // Emit initial entries
            for (let i = 0; i < initialCount; i++) {
              yield* j.emitDurable(mkInput("s-run", "src", "step", { i }, { sourceSeq: i }), owner)
            }

            // Verify changes received frozen entries
            const pubItems: Array<JournalEvent.Entry> = []
            for (let i = 0; i < initialCount; i++) {
              pubItems.push(yield* PubSub.take(sub))
            }
            if (pubItems.length !== initialCount || !Object.isFrozen(pubItems[0])) return false

            // Start live stream reading initialCount + liveCount entries
            const total = initialCount + liveCount
            const started = yield* Deferred.make<void>()
            const streamFiber = yield* j.stream({ runId: asRun("s-run") }).pipe(
              Stream.tap((entry) => entry.seq === 0 ? Deferred.succeed(started, undefined) : Effect.void),
              Stream.take(total),
              Stream.runCollect,
              Effect.forkChild({ startImmediately: true })
            )
            yield* Deferred.await(started)

            // Checkpoint at seq initialCount - 1 while stream reader is active at seq < checkpoint
            yield* j.checkpoint({
              runId: asRun("s-run"),
              seq: asSeq(initialCount - 1),
              state: { at: initialCount - 1 }
            }, owner)

            // Emit live entries
            for (let i = 0; i < liveCount; i++) {
              const inp = mkInput("s-run", "src", "step", { i: initialCount + i }, { sourceSeq: initialCount + i })
              if (useLossyLive) yield* j.emitLossy(inp)
              else yield* j.emitDurable(inp, owner)
            }
            if (useLossyLive) yield* j.flush

            const streamed = [...(yield* Fiber.join(streamFiber))]
            if (streamed.length !== total) return false
            for (let i = 0; i < total; i++) {
              if (streamed[i]!.seq !== i) return false
            }

            // Now stream is closed; compact succeeds
            const compacted = yield* j.compact({ runId: asRun("s-run") }, owner)
            if (compacted.checkpointSeq !== initialCount - 1 || compacted.deleted !== initialCount - 1) return false

            // Stream starting below compaction floor fails compacted
            const rangeErr = yield* Effect.flip(
              Stream.runCollect(j.stream({ runId: asRun("s-run") }).pipe(Stream.take(1)))
            )
            if (rangeErr.code !== "compacted") return false

            // Entries starting below compaction floor fails compacted
            const pageRangeErr = yield* Effect.flip(j.entries({ runId: asRun("s-run"), limit: 10 }))
            if (pageRangeErr.code !== "compacted") return false

            // Stream and project starting at compaction floor succeed
            const afterFloor = yield* Stream.runCollect(
              j.stream({ runId: asRun("s-run"), afterSequence: asSeq(initialCount - 1) }).pipe(Stream.take(liveCount))
            )
            if (afterFloor.length !== liveCount) return false

            const sumProj = Projection.make({
              name: "sum",
              initial: 0,
              reduce: (acc, entry) =>
                testReducerError
                  ? Effect.fail("reducer-boom")
                  : Effect.succeed(acc + entry.seq)
            })
            const projRes = yield* Effect.result(
              Stream.runCollect(
                j.project(sumProj, { runId: asRun("s-run"), afterSequence: asSeq(initialCount - 1) }).pipe(
                  Stream.take(liveCount + 1)
                )
              )
            )
            if (testReducerError) {
              if (projRes._tag !== "Failure" || projRes.failure.code !== "projection_failed") return false
            } else {
              if (projRes._tag !== "Success" || projRes.success.length !== liveCount + 1) return false
            }
            return true
          })).pipe(Effect.provide(TestClock.layer()), Effect.provide(silentLog)),
        { seed: seed + 23, executions: 18 }
      )
    )
    assertFuzz(report)
  })

  it("SqlJournal auto-compaction (success, failure damping, timeout), JournalTestObserver, JournalGeneration.forget, JournalDigest fault, and sink failure", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        threshold: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 4 })),
        captureMode: Schema.Literals(["ok", "fail", "timeout"]),
        channel: Schema.Literals(["durable", "lossy"]),
        testForgetAndDigestFault: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ threshold, captureMode, channel, testForgetAndDigestFault }) =>
          Effect.scoped(Effect.gen(function*() {
            let obs: Observations | undefined
            let drains = 0
            const observerLayer = Layer.succeed(JournalTestObserver, {
              opened: (o) => {
                obs = o
              },
              drainRegistered: () => {
                drains++
              }
            })
            let captures = 0
            const db = yield* Layer.build(migratedDb())
            const sql = Context.get(db, SqlClient.SqlClient)

            const jCtx = yield* Layer.build(
              SqlJournal.layer({
                capacity: 32,
                batchSize: 1,
                overflow: "reject",
                compaction: {
                  entryThreshold: threshold,
                  capture: (_runId, upTo) => {
                    captures++
                    if (captureMode === "fail") return Effect.fail(new Error("capture failed"))
                    if (captureMode === "timeout") return Effect.sleep(Duration.seconds(45)).pipe(Effect.as({ upTo }))
                    return Effect.succeed({ capturedUpTo: upTo })
                  }
                }
              }).pipe(
                Layer.provide(observerLayer),
                Layer.provide(Layer.succeedContext(db))
              )
            )
            const j = Context.get(jCtx, Journal.Journal)

            const acOwner = { hostId: "ac-fuzz", pid: 1, nonce: "ac-nonce" }
            yield* Leases.hold(sql, asRun("ac-run"), acOwner)
            const emitOne = (i: number) => {
              const inp = mkInput("ac-run", "s1", "ev", { i }, { sourceSeq: i })
              return channel === "durable" ? j.emitDurable(inp, acOwner) : j.emitLossy(inp)
            }

            if (captureMode === "timeout") {
              // Emit threshold entries in a forked fiber and advance TestClock past 30s timeout
              const f = yield* Effect.gen(function*() {
                for (let i = 0; i < threshold; i++) {
                  yield* emitOne(i)
                }
                if (channel === "lossy") {
                  // #4555: lossy writes never compact; follow with a fenced owner write to trigger capture
                  yield* j.flush
                  yield* j.emitDurable(
                    mkInput("ac-run", "s1", "ev", { i: threshold }, { sourceSeq: threshold }),
                    acOwner
                  )
                }
                yield* j.flush
              }).pipe(Effect.forkChild({ startImmediately: true }))
              // Advance virtual clock so 30s capture timeout fires cleanly
              for (let step = 0; step < 5; step++) {
                yield* TestClock.adjust(Duration.seconds(10))
                yield* Effect.yieldNow
              }
              yield* Fiber.join(f)
              if (captures < 1) return false
            } else {
              for (let i = 0; i < threshold + 1; i++) {
                yield* emitOne(i)
              }
              yield* j.flush
              if (channel === "lossy") {
                // #4555: lossy bursts never compact on their own
                if (captures !== 0) return false
                yield* j.emitDurable(
                  mkInput("ac-run", "s1", "ev", { i: threshold + 1 }, { sourceSeq: threshold + 1 }),
                  acOwner
                )
                yield* j.flush
              }
              if (captureMode === "ok") {
                const ckpt = yield* j.latestCheckpoint(asRun("ac-run"))
                if (Option.isNone(ckpt) || ckpt.value.compactedAtMs === null) return false
                if (obs === undefined || obs.barrierCount() !== 0) return false
              } else {
                // Failed capture is damped and never fails emit
                if (captures < 1) return false
              }
            }

            if (testForgetAndDigestFault) {
              // Exercise JournalGeneration.forget after manual truncation (including flows_journal_dedup)
              yield* sql`DELETE FROM flows_journal_events WHERE run_id = 'ac-run'`
              yield* sql`DELETE FROM flows_journal_checkpoints WHERE run_id = 'ac-run'`
              yield* sql`DELETE FROM flows_journal_dedup WHERE run_id = 'ac-run'`
              yield* JournalGeneration.forget(["ac-run"]).pipe(Effect.provide(Layer.succeedContext(db)))
              const afterForget = yield* j.emitDurableUnfenced(
                mkInput("ac-run", "s1", "fresh", { after: true }, { sourceSeq: 0 })
              )
              if (afterForget._tag !== "Accepted" || afterForget.seq !== 0) {
                throw new Error(`afterForget: ${JSON.stringify(afterForget)}`)
              }

              // Exercise JournalDigest failure
              const badDigestCtx = yield* Layer.build(
                SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
                  Layer.provide(Layer.succeed(JournalDigest, {
                    digest: () => Effect.fail(new Error("digest unavailable"))
                  })),
                  Layer.provide(Layer.succeedContext(db))
                )
              )
              const badDigestJ = Context.get(badDigestCtx, Journal.Journal)
              // Trigger contentFingerprint via duplicate comparison after cache miss
              yield* badDigestJ.emitDurableUnfenced(mkInput("dig-run", "s1", "ev", { a: 1 }, { sourceSeq: 0 }))
              const digRes = yield* Effect.result(
                badDigestJ.emitDurableUnfenced(mkInput("dig-run", "s1", "ev", { a: 2 }, { sourceSeq: 0 }))
              )
              if (digRes._tag !== "Failure") throw new Error("digRes expected failure")

              // Pre-seed floor for sink-run so DROP TABLE hits INSERT (sink_failed),
              // while entries() hits read_failed.
              yield* j.emitDurableUnfenced(mkInput("sink-run", "s1", "seed", { x: 0 }))
              yield* sql`DROP TABLE flows_journal_events`
              const readFail = yield* Effect.flip(
                j.entries({ runId: asRun("unseen-run"), limit: 5 })
              )
              if (readFail.code !== "read_failed") throw new Error(`readFail: ${readFail.code}`)
              const durFail = yield* Effect.flip(
                j.emitDurableUnfenced(mkInput("sink-run", "s1", "ev", { x: 1 }))
              )
              if (durFail.code !== "sink_failed") throw new Error(`durFail: ${durFail.code}`)
              yield* j.emitLossy(mkInput("sink-run", "s1", "ev", { x: 2 }))
              const lossyFail = yield* Effect.flip(j.flush)
              if (lossyFail.code !== "sink_failed") throw new Error(`lossyFail: ${lossyFail.code}`)
            }

            void drains
            return true
          })).pipe(
            Effect.provide(TestClock.layer()),
            Effect.provideService(Metric.MetricRegistry, new Map()),
            Effect.provide(silentLog)
          ),
        { seed: seed + 24, executions: 14 }
      )
    )
    assertFuzz(report)
  })
})

describe("@smthrs/journal deep edge-case & fault-injection fuzz invariants", () => {
  it("Redaction deep grammar & lineRedactor overflow/risky/held-limit paths never leak credentials", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        hex: Schema.Array(HexChar),
        grammarCase: Schema.Literals([
          "unclosedContainer",
          "multilineContainer",
          "headerContainer",
          "apostropheAndQuotes",
          "separatorsAndSpaces",
          "userinfoAndConcat",
          "unclosedAngleAndFlags",
          "smithersBarrier",
          "hostileBinary"
        ]),
        lineCase: Schema.Literals([
          "overlongSafe",
          "overlongRiskyBrace",
          "overlongRiskyPem",
          "overlongDeepDropped",
          "maxHeldLines",
          "maxHeldBytes",
          "smithersBarrierLine"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ hex, grammarCase, lineCase }) => {
          const h = (hex.join("") + "0123456789abcdef0123456789abcdef01234567").slice(0, 24)
          const sec = `sec_${h}`
          const smm = `smm_${"A".repeat(44)}`
          const red = Redaction.make()
          const diag = Redaction.make({ rules: Redaction.diagnosticRules })

          if (grammarCase === "unclosedContainer") {
            const out = String(red(`password={a: "${sec}", b: [1, 2`))
            if (out.includes(sec)) throw new Error(`unclosedContainer leaked: ${out}`)
          } else if (grammarCase === "multilineContainer") {
            const out = String(red(`credentials: {\n  a: "${sec}",\n  b: 1\n}`))
            if (out.includes(sec)) throw new Error(`multilineContainer leaked: ${out}`)
          } else if (grammarCase === "headerContainer") {
            const out = String(diag(`"cookie":["sid=${sec}"],\n"set-cookie":["a=${sec}"`))
            if (out.includes(sec)) throw new Error(`headerContainer leaked: ${out}`)
          } else if (grammarCase === "apostropheAndQuotes") {
            const out1 = String(red(`password=it's_${sec} ok=1`))
            const out2 = String(red(`{"token":"${sec}"}`))
            const out3 = String(red(`{\\"token\\":\\"${sec}\\"}`))
            const out4 = String(red(`[password=${sec}]`))
            if (out1.includes(sec) || out2.includes(sec) || out3.includes(sec) || out4.includes(sec)) {
              throw new Error(`apostropheAndQuotes leaked`)
            }
          } else if (grammarCase === "separatorsAndSpaces") {
            const out1 = String(red(`token=${sec}&safe=ok;password=${sec},x=1`))
            const out2 = String(red(`password=word1 ${sec} end`))
            const out3 = String(red(`sortKeys=keep_${h} idempotencyKey=keep_${h} apiKey=${sec}`))
            if (out1.includes(sec) || out3.includes(sec) || !out3.includes(`keep_${h}`)) {
              throw new Error(`separatorsAndSpaces failed: ${out1} | ${out2} | ${out3}`)
            }
          } else if (grammarCase === "userinfoAndConcat") {
            const out1 = String(red(`https://x-access-token:${sec}@github.com/org/repo`))
            const out2 = String(red(`api_key="${sec.slice(0, 8)}" + "${sec.slice(8)}"`))
            const out3 = String(red(`password=[REDACTED] --password [REDACTED]`))
            if (
              out1.includes(sec) || out2.includes(sec.slice(8)) || !out1.includes("github.com") ||
              !out3.includes("[REDACTED]")
            ) {
              throw new Error(`userinfoAndConcat failed: ${out1} | ${out2}`)
            }
          } else if (grammarCase === "unclosedAngleAndFlags") {
            const out1 = String(diag(`api_key=<${sec}\nnextline`))
            const out2 = String(diag(`["Set-Cookie", "sid=${sec}"] ["Proxy-Authorization", "Basic ${sec}"]`))
            const out3 = String(diag(`curl --user "${sec}:pw_${h}" --user justname`))
            const out4 = String(diag(`openssl -passin pass:${sec} mysql -p/etc/my.cnf -p --db x -pthread`))
            if (out1.includes(sec) || out2.includes(sec) || out3.includes(`pw_${h}`) || out4.includes(sec)) {
              throw new Error(`unclosedAngleAndFlags leaked`)
            }
            if (!out3.includes("justname") || !out4.includes("-pthread")) {
              throw new Error(`unclosedAngleAndFlags over-redacted`)
            }
          } else if (grammarCase === "smithersBarrier") {
            // Custom rule AFTER a Smithers rule creates a context barrier; PEM + Smithers token triggers overlap protection
            const barrierRed = Redaction.make({
              rules: [
                ...Redaction.defaultRules,
                { id: "post-barrier", pattern: /POST_BARRIER/g, replace: "REPLACED" }
              ]
            })
            const out = String(
              barrierRed(`-----BEGIN PRIVATE KEY-----\n${smm}\n-----END PRIVATE KEY----- POST_BARRIER password=${smm}`)
            )
            if (out.includes(smm)) throw new Error(`smithersBarrier leaked: ${out}`)
          } else {
            // Binary view whose constructor getter throws + revoked proxy over binary
            const throwingCtor = new Uint8Array(4)
            Object.defineProperty(throwingCtor, "constructor", {
              get() {
                throw new Error("no ctor")
              }
            })
            const res = red(throwingCtor) as Record<string, unknown>
            if (res[Redaction.binaryMarker] !== Redaction.binaryMarker) throw new Error("throwingCtor fallback")
            const { proxy, revoke } = Proxy.revocable(new Uint8Array(4), {})
            revoke()
            let threwRevoked = false
            try {
              red(proxy)
            } catch {
              threwRevoked = true
            }
            if (!threwRevoked) throw new Error("expected revoked proxy throw")
          }

          // Line redactor edge cases
          if (lineCase === "overlongSafe") {
            const lr = Redaction.lineRedactor()
            lr.part("a".repeat(Redaction.maxPartialLine + 100))
            lr.part("b".repeat(500))
            const pk = lr.peek()
            const emitted = [...lr.line("tail"), ...lr.flush()]
            if (!pk.includes(Redaction.omittedLine) || !emitted.includes(Redaction.omittedLine)) {
              throw new Error("overlongSafe")
            }
          } else if (lineCase === "overlongRiskyBrace") {
            const lr = Redaction.lineRedactor()
            lr.line(`password = {`)
            lr.part("x".repeat(20_000) + "{ " + sec + " ".repeat(20_000))
            const out1 = lr.line("end")
            lr.part("after-withheld")
            const out2 = lr.line("ignored-line")
            const pk = lr.peek()
            const fl = lr.flush()
            if (
              !out1.includes(Redaction.omittedLine) || out2.length !== 0 || pk[0] !== Redaction.placeholder ||
              !fl.includes(Redaction.placeholder)
            ) {
              throw new Error("overlongRiskyBrace")
            }
          } else if (lineCase === "overlongRiskyPem") {
            const lr = Redaction.lineRedactor()
            lr.part("x".repeat(18_000) + "-----BEGIN PRIVATE KEY-----" + sec + "y".repeat(18_000))
            const out = [...lr.line("z"), ...lr.flush()]
            if (out.join("\n").includes(sec) || !out.includes(Redaction.omittedLine)) {
              throw new Error("overlongRiskyPem")
            }
          } else if (lineCase === "overlongDeepDropped") {
            const lr = Redaction.lineRedactor()
            lr.part("x".repeat(18_000) + "(".repeat(1100) + ")".repeat(1100) + "y".repeat(18_000))
            const out = [...lr.line("z"), ...lr.flush()]
            if (!out.includes(Redaction.omittedLine)) throw new Error("overlongDeepDropped")
          } else if (lineCase === "maxHeldLines") {
            const lr = Redaction.lineRedactor()
            const out: Array<string> = []
            out.push(...lr.line(`password = {`))
            for (let i = 0; i < Redaction.maxHeldLines + 5; i++) {
              out.push(...lr.line(`  k${i}: "${sec}"`))
            }
            out.push(...lr.flush())
            if (out.join("\n").includes(sec) || !out.includes(Redaction.placeholder)) throw new Error("maxHeldLines")
          } else if (lineCase === "maxHeldBytes") {
            const lr = Redaction.lineRedactor()
            const out: Array<string> = []
            out.push(...lr.line(`password = {`))
            const chunk = `  val: "${sec}_${"z".repeat(4000)}"`
            for (let i = 0; i < 20; i++) {
              out.push(...lr.line(chunk))
            }
            out.push(...lr.flush())
            if (out.join("\n").includes(sec)) throw new Error("maxHeldBytes")
          } else {
            const lr = Redaction.lineRedactor([
              ...Redaction.diagnosticRules,
              { id: "barrier", pattern: /BARRIER/g, replace: "X" }
            ])
            const out = [
              ...lr.line(`-----BEGIN PRIVATE KEY-----`),
              ...lr.line(`${smm}`),
              ...lr.line(`-----END PRIVATE KEY----- BARRIER`),
              ...lr.flush()
            ]
            if (out.join("\n").includes(smm)) throw new Error("smithersBarrierLine")
          }
          return true
        },
        { seed: seed + 30, executions: 60 }
      )
    )
    assertFuzz(report)
  })

  it("RedactedLogger and TelemetryLog handle hostile errors, cycles, throwing consoles/proxies, UTF-8 bounds, and member caps", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        hex: Schema.Array(HexChar),
        throwAllConsole: Schema.Boolean,
        hugeKind: Schema.Literals(["array", "object", "errorKeys", "unicode", "proxyThrow"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ hex, throwAllConsole, hugeKind }) =>
          Effect.gen(function*() {
            const tok = `ghp_${(hex.join("") + "0123456789abcdef0123456789abcdef01234567").slice(0, 36)}`

            // 1. RedactedLogger: throwing error name/message/stack, cyclic & diamond Error, no-withErrors redactor, throwing redactor
            const hostileErr = new Error("ok")
            Object.defineProperty(hostileErr, "name", {
              get() {
                throw new Error(tok)
              }
            })
            Object.defineProperty(hostileErr, "message", {
              get() {
                throw new Error(tok)
              }
            })
            Object.defineProperty(hostileErr, "stack", {
              get() {
                throw new Error(tok)
              }
            })

            const cyclicErr = new Error(`cyc ${tok}`)
            ;(cyclicErr as unknown as Record<string, unknown>).cause = cyclicErr
            const diamond = { a: cyclicErr, b: cyclicErr }

            const noopRed = Redaction.makeNoop()
            const noopArg = RedactedLogger.redactArgument(cyclicErr, noopRed)
            if (!(noopArg instanceof Error)) throw new Error("noopArg")

            const badRed = Object.assign(() => {
              throw new Error("boom")
            }, { rules: [] }) as unknown as Redaction.Redactor
            if (RedactedLogger.redactArgument({ a: tok }, badRed) !== "[Unrenderable]") throw new Error("badRed")

            const hostArg = RedactedLogger.redactArgument({ hostileErr, diamond }, Redaction.make()) as {
              readonly hostileErr: Error
              readonly diamond: { readonly a: Error; readonly b: Error }
            }
            if (
              hostArg.hostileErr.name !== "Error" ||
              hostArg.hostileErr.message !== "" ||
              hostArg.diamond.a !== hostArg.diamond.b ||
              hostArg.diamond.a.message.includes(tok)
            ) {
              throw new Error("hostArg check failed")
            }

            // Redacting console: delegate throws on first call (fallback to [Unrenderable]) or always throws (undefined)
            let calls = 0
            const flakyConsole = {
              assert: () => {},
              clear: () => {},
              count: () => {},
              countReset: () => {},
              debug: () => {},
              dir: () => {},
              dirxml: () => {},
              error: () => {},
              group: () => {},
              groupCollapsed: () => {},
              groupEnd: () => {},
              info: () => {},
              log: (...args: ReadonlyArray<unknown>) => {
                calls++
                if (throwAllConsole || calls === 1) throw new Error(`console-fail ${String(args[0])}`)
                return "recovered"
              },
              table: () => {},
              time: () => {},
              timeEnd: () => {},
              timeLog: () => {},
              trace: () => {},
              warn: () => {}
            } as unknown as Console.Console
            const rc = RedactedLogger.redactingConsole(flakyConsole, Redaction.make())
            const res = rc.log(`hello ${tok}`) as unknown
            if (throwAllConsole ? res !== undefined : res !== "recovered") throw new Error("flakyConsole")

            // Non-Console/non-Annotations ref passes through redactedFiber + throwing frame.stack()
            const CustomRef = Context.Reference<string>("fuzz/CustomRef", { defaultValue: () => "custom-val" })
            let observedRef = ""
            const probeLogger = Logger.make((opts) => {
              observedRef = opts.fiber.getRef(CustomRef)
            })
            const badFrame: References.StackFrame = {
              name: `n ${tok}`,
              stack: () => {
                throw new Error(tok)
              },
              parent: undefined
            }
            const frameCause = Cause.fromReasons([
              Cause.makeFailReason(hostileErr).annotate(Context.make(Cause.StackTrace, badFrame))
            ])
            yield* Effect.logError(frameCause).pipe(
              Effect.provide(RedactedLogger.layer()),
              Effect.provide(Logger.layer([probeLogger]))
            )
            if (observedRef !== "custom-val") throw new Error("customRef passthrough")

            // 2. TelemetryLog deep edge cases
            const snaps: Array<TelemetryLog.Log> = []
            const tLogger = Logger.make((opts) => {
              snaps.push(
                TelemetryLog.snapshot(opts, {
                  maximumBytes: hugeKind === "unicode" ? 260 : 8192,
                  annotations: { a: "1", b: "2" }
                })
              )
            })
            let payload: unknown
            if (hugeKind === "array") {
              const arr = new Array<unknown>(TelemetryLog.maximumSnapshotMembers + 5)
              arr[0] = "first"
              // sparse hole + getter-only element
              Object.defineProperty(arr, 1, { get: () => "g", enumerable: true })
              payload = arr
            } else if (hugeKind === "object") {
              const big: Record<string, unknown> = {}
              for (let i = 0; i < TelemetryLog.maximumSnapshotMembers + 5; i++) big[`k${i}`] = i
              payload = big
            } else if (hugeKind === "errorKeys") {
              const e = new Error("e")
              Object.defineProperty(e, "stack", {
                get() {
                  throw new Error("no stack")
                }
              })
              Object.defineProperty(e, "getterProp", {
                get() {
                  return "val"
                },
                enumerable: true
              }) // Two long keys that truncate to the same prefix under tight budget
              ;(e as unknown as Record<string, unknown>)[`${"p".repeat(120)}_1`] = 1
              ;(e as unknown as Record<string, unknown>)[`${"p".repeat(120)}_2`] = 2
              payload = e
            } else if (hugeKind === "unicode") {
              payload = { emoji: "🔐🚀秘密".repeat(80), tok }
            } else {
              payload = new Proxy({}, {
                ownKeys() {
                  throw new Error("no names")
                },
                getPrototypeOf() {
                  throw new Error("no proto")
                }
              })
            }
            // Shadow all fiber annotations so `rest` sees {}
            yield* Effect.logInfo(payload).pipe(
              Effect.annotateLogs({ a: "shadowed", b: "shadowed" }),
              Effect.provide(Logger.layer([tLogger]))
            )
            if (snaps.length !== 1 || !Schema.is(TelemetryLog.Log)(snaps[0])) throw new Error("telemetry snap")
            return true
          }),
        { seed: seed + 31, executions: 35 }
      )
    )
    assertFuzz(report)
  })

  it("Consensus.makeNoop/layerNoop, local transactional rollback, and ExecutionFact gap/malformed edge cases", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rollbackTx: Schema.Boolean,
        key: Schema.Literals(["k1", "k2"]),
        execCase: Schema.Literals(["initialGap", "gapGenBump", "invalidFact", "badBound", "malformedNoExecId"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rollbackTx, key, execCase }) =>
          Effect.scoped(Effect.gen(function*() {
            const o1 = mkOwner(0)
            const o2 = mkOwner(1)

            // Consensus.makeNoop / layerNoop / make
            const noopCtx = yield* Layer.build(Consensus.layerNoop())
            const noop = Consensus.make(Context.get(noopCtx, Consensus.Consensus))
            const ev: Consensus.LivenessEvidence = { expectedOwner: o1, checkedAtMs: 1000, kind: "lease-expired" }
            if ((yield* noop.claim(key, o1, 0))._tag !== "Rejected") throw new Error("noop claim")
            if ((yield* noop.activate(key, o1, 0, 0))._tag !== "Lost") throw new Error("noop activate")
            if ((yield* noop.heartbeat(key, o1, 0))._tag !== "Lost") throw new Error("noop hb")
            if ((yield* noop.reconfirm(key, o1, 0))._tag !== "Lost") throw new Error("noop reconfirm")
            yield* noop.release(key, o1)
            if ((yield* noop.steal(key, o2, 1000, ev))._tag !== "Rejected") throw new Error("noop steal")
            if ((yield* noop.recover(key, o1, 0, o2, 1000, ev))._tag !== "Rejected") throw new Error("noop recover")
            if ((yield* Effect.flip(noop.guard(key, o1))).code !== "fence_lost") throw new Error("noop guard")
            if (
              (yield* Effect.flip(noop.withPermit(key, o1, () => Effect.succeed(true), Effect.void))).code !==
                "persistence_failed"
            ) {
              throw new Error("noop withPermit")
            }

            // provesDeath & matchesEvidence edge cases (including cross-host-unreachable-stale)
            if (Consensus.provesDeath({ expectedOwner: o1, checkedAtMs: 100, kind: "same-host-pid-dead" }, o1)) {
              throw new Error("same pid should not prove death")
            }
            if (
              Consensus.matchesEvidence(o1, o2, 100, {
                expectedOwner: o1,
                checkedAtMs: 100,
                kind: "same-host-pid-dead"
              })
            ) {
              throw new Error("diff host should not match same-host-pid-dead")
            }
            if (
              !Consensus.matchesEvidence(o1, o2, 100, {
                expectedOwner: o1,
                checkedAtMs: 100,
                kind: "cross-host-unreachable-stale"
              })
            ) {
              throw new Error("diff host should match cross-host-unreachable-stale")
            }
            if (
              Consensus.matchesEvidence(o1, o1, 100, {
                expectedOwner: o1,
                checkedAtMs: 100,
                kind: "cross-host-unreachable-stale"
              })
            ) {
              throw new Error("same host should not match cross-host-unreachable-stale")
            }
            if (
              Consensus.matchesEvidence(o1, o2, 100, { expectedOwner: o1, checkedAtMs: 200, kind: "lease-expired" })
            ) {
              throw new Error("mismatched checkedAtMs should not match")
            }

            // Consensus.makeLocal transactional rollback via DurableWriter
            const dbCtx = yield* Layer.build(TestDatabase.layer)
            const writer = Context.get(dbCtx, DurableWriter.DurableWriter)
            const local = yield* Consensus.makeLocal
            const txRes = yield* Effect.result(
              writer.write(
                Effect.gen(function*() {
                  const c = yield* local.claim(key, o1, 100)
                  if (c._tag !== "Claimed") return yield* Effect.fail("claim-failed")
                  yield* local.activate(key, o1, c.grantedAtMs, 100)
                  if (rollbackTx) return yield* Effect.fail("abort-tx")
                })
              )
            )
            const guardRes = yield* Effect.result(local.guard(key, o1))
            if (rollbackTx) {
              if (txRes._tag !== "Failure" || guardRes._tag !== "Failure") throw new Error("local rollback failed")
            } else {
              if (txRes._tag !== "Success" || guardRes._tag !== "Success") throw new Error("local commit failed")
            }

            // Consensus.resourcePermit error in activate + direct fence_lost from reconfirm
            const failAct = {
              ...local,
              activate: () =>
                Effect.fail(new Consensus.ConsensusError({ code: "persistence_failed", message: "act err" }))
            }
            const actErr = yield* Effect.flip(
              Consensus.resourcePermit(
                failAct,
                () => Effect.succeed(undefined),
                "err-key",
                o2,
                () => Effect.succeed(true),
                Effect.void
              )
            )
            if (actErr.code !== "persistence_failed") throw new Error("failAct")

            // ExecutionFact edge cases
            if (execCase === "initialGap") {
              const r = ExecutionFact.fold(
                [{ executionId: "r1", generation: 0, sequence: -1, eventType: "gap", payload: {}, gap: true }],
                "r1"
              )
              if (r.provenance.source !== "unverified-observation") throw new Error("initialGap")
            } else if (execCase === "gapGenBump") {
              const r = ExecutionFact.fold(
                [
                  { executionId: "r1", generation: 0, sequence: 0, eventType: "gap", payload: {}, gap: true },
                  { executionId: "r1", generation: 2, sequence: 0, eventType: "gap", payload: {}, gap: true }
                ],
                "r1"
              )
              if (r.provenance.generation !== 2) throw new Error("gapGenBump")
            } else if (execCase === "invalidFact") {
              const r = ExecutionFact.fold(
                [{
                  executionId: "r1",
                  generation: 0,
                  sequence: 0,
                  eventType: "other.ev",
                  payload: { executionFact: { bogus: 1 } }
                }],
                "r1"
              )
              if (r.provenance.source !== "unverified-observation") throw new Error("invalidFact")
            } else if (execCase === "badBound") {
              const r = ExecutionFact.foldControl(
                [{
                  runId: "c1",
                  kind: "control.engine.bound",
                  payload: { version: 2, controlRunId: "c1", executionId: "" }
                }],
                "c1"
              )
              if (r !== undefined) throw new Error("badBound without observed")
            } else {
              const r = ExecutionFact.foldControl(
                [
                  {
                    runId: "c1",
                    kind: "control.engine.bound",
                    payload: { version: 1, controlRunId: "c1", executionId: "r1" }
                  },
                  { runId: "c1", kind: "control.engine.event", payload: { version: 99 } },
                  { runId: "c1", kind: "control.engine.projection-gap", payload: { executionId: "r1" } }
                ],
                "c1"
              )
              if (r !== undefined) throw new Error("malformedNoExecId without observed")
            }

            // Direct default JournalDigest call
            const bytes = new TextEncoder().encode("journal-fuzz-digest")
            const hashed = yield* JournalDigest.defaultValue().digest(bytes)
            if (hashed.byteLength !== 32) throw new Error("digest length")

            return true
          })).pipe(Effect.provide(TestClock.layer()), Effect.provide(silentLog)),
        { seed: seed + 32, executions: 25 }
      )
    )
    assertFuzz(report)
  })

  it("SqlJournal reader_behind, nested compaction, deferred conflicts, corrupt rows, writer defects, closed journal, and layerWith", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        faultCase: Schema.Literals([
          "readerBehind",
          "nestedCompactWithPending",
          "deferredConflictAndFinalizer",
          "corruptRowAndCheckpoint",
          "writerDefect",
          "closedJournalAndInvalidOwner",
          "layerWithAndDefaultTestJournal"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ faultCase }) =>
          Effect.scoped(Effect.gen(function*() {
            const owner = mkOwner(0)
            const intruder = mkOwner(1)

            if (faultCase === "readerBehind") {
              const db = yield* Layer.build(migratedDb())
              const sql = Context.get(db, SqlClient.SqlClient)
              yield* holdLease(sql, "rb-run", owner)
              const jCtx = yield* Layer.build(
                SqlJournal.layer({ capacity: 16, batchSize: 1, overflow: "reject" }).pipe(
                  Layer.provide(Layer.succeedContext(db))
                )
              )
              const j = Context.get(jCtx, Journal.Journal)
              for (let i = 0; i < 4; i++) {
                yield* j.emitDurable(mkInput("rb-run", "s1", "ev", { i }, { sourceSeq: i }), owner)
              }
              yield* j.checkpoint({ runId: asRun("rb-run"), seq: asSeq(3), state: { at: 3 } }, owner)

              // Hold a live stream paused at seq 0 so reader.cursor < checkpointSeq - 1
              const paused = yield* Deferred.make<void>()
              const releaseReader = yield* Deferred.make<void>()
              const readerFiber = yield* j.stream({ runId: asRun("rb-run") }).pipe(
                Stream.mapEffect((entry) =>
                  entry.seq === 0
                    ? Deferred.succeed(paused, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseReader)),
                      Effect.as(entry)
                    )
                    : Effect.succeed(entry)
                ),
                Stream.take(4),
                Stream.runDrain,
                Effect.forkChild({ startImmediately: true })
              )
              yield* Deferred.await(paused)
              const blocked = yield* Effect.flip(j.compact({ runId: asRun("rb-run") }, owner))
              yield* Deferred.succeed(releaseReader, undefined)
              yield* Fiber.join(readerFiber)
              if (blocked.code !== "reader_behind") throw new Error(`expected reader_behind, got ${blocked.code}`)
              return true
            }

            if (faultCase === "nestedCompactWithPending") {
              const gate = yield* Deferred.make<void>()
              const db = yield* Layer.build(migratedDb())
              const sql = Context.get(db, SqlClient.SqlClient)
              const baseWriter = Context.get(db, DurableWriter.DurableWriter)
              yield* holdLease(sql, "nc-run", owner)

              let blockWrites = false
              const customWriter = DurableWriter.DurableWriter.of({
                write: (eff, opts) =>
                  (blockWrites ? Deferred.await(gate) : Effect.void).pipe(Effect.andThen(baseWriter.write(eff, opts)))
              })
              const jCtx = yield* Layer.build(
                SqlJournal.layer({ capacity: 16, overflow: "reject" }).pipe(
                  Layer.provide(Layer.merge(
                    Layer.succeed(DurableWriter.DurableWriter)(customWriter),
                    Layer.succeed(SqlClient.SqlClient)(sql)
                  ))
                )
              )
              const j = Context.get(jCtx, Journal.Journal)
              yield* j.emitDurable(mkInput("nc-run", "s1", "ev", { i: 0 }, { sourceSeq: 0 }), owner)
              yield* j.emitDurable(mkInput("nc-run", "s1", "ev", { i: 1 }, { sourceSeq: 1 }), owner)
              yield* j.checkpoint({ runId: asRun("nc-run"), seq: asSeq(1), state: { at: 1 } }, owner)

              // Queue a lossy entry while background writer is gated, then compact inside transact (nested!)
              blockWrites = true
              yield* j.emitLossy(mkInput("nc-run", "s2", "lossy", { i: 2 }, { sourceSeq: 0 }))
              blockWrites = false
              yield* Deferred.succeed(gate, undefined)
              const compacted = yield* j.transact(j.compact({ runId: asRun("nc-run") }, owner), { partition: "nc-run" })
              if (compacted.checkpointSeq !== 1) throw new Error("nested compact")
              yield* j.flush
              return true
            }

            if (faultCase === "deferredConflictAndFinalizer") {
              const db = yield* Layer.build(migratedDb())
              const sql = Context.get(db, SqlClient.SqlClient)
              yield* holdLease(sql, "dc-run", owner)

              const innerScope = yield* Scope.make()
              const jCtx = yield* Layer.buildWithScope(
                SqlJournal.layer({ capacity: 16, overflow: "reject" }).pipe(Layer.provide(Layer.succeedContext(db))),
                innerScope
              )
              const j = Context.get(jCtx, Journal.Journal)
              // Commit s1:0 with { v: 1 }
              yield* j.emitDurable(mkInput("dc-run", "s1", "ev", { v: 1 }, { sourceSeq: 0 }), owner)
              // 1. Deferred entry by displaced intruder is silently discarded on flushRun
              yield* j.emitDeferred!(mkInput("dc-run", "s3", "intruder", { v: 0 }, { sourceSeq: 0 }), intruder)
              yield* j.transact(Effect.void, { partition: "dc-run" })
              // 2. Deferred entry by real owner with conflicting content triggers deferredFailure + lostEntries metric
              yield* j.emitDeferred!(mkInput("dc-run", "s1", "ev", { v: 999 }, { sourceSeq: 0 }), owner)
              yield* j.transact(
                // Also test emitDeferred directly inside an open transaction!
                j.emitDeferred!(mkInput("dc-run", "s4", "in-tx", { v: 4 }, { sourceSeq: 0 }), owner),
                { partition: "dc-run" }
              )
              const flushErr = yield* Effect.flip(j.flush)
              if (flushErr.code !== "idempotency_conflict") {
                throw new Error(`deferred flush err: ${flushErr.code}`)
              }
              // 3. Leave another deferred entry queued when scope closes to exercise finalizer flushDeferred
              yield* j.emitDeferred!(mkInput("dc-run", "s2", "tail", { v: 2 }, { sourceSeq: 0 }), owner)
              yield* Scope.close(innerScope, Exit.void)
              // 4. emitDeferred after close -> journal_closed
              const closedDef = yield* Effect.flip(
                j.emitDeferred!(mkInput("dc-run", "s2", "after-close", { v: 3 }, { sourceSeq: 1 }), owner)
              )
              if (closedDef.code !== "journal_closed") throw new Error("closedDef")
              return true
            }

            if (faultCase === "corruptRowAndCheckpoint") {
              const db = yield* Layer.build(migratedDb())
              const sql = Context.get(db, SqlClient.SqlClient)
              const jCtx = yield* Layer.build(
                SqlJournal.layer({ capacity: 16, batchSize: 1, overflow: "reject" }).pipe(
                  Layer.provide(Layer.succeedContext(db))
                )
              )
              const j = Context.get(jCtx, Journal.Journal)
              // Insert corrupt JSON row + corrupt JSON checkpoint directly (bypassing SQLite CHECK constraints)
              yield* sql`PRAGMA ignore_check_constraints = ON`
              yield* sql`
                INSERT INTO flows_journal_events (
                  run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json
                ) VALUES ('corrupt-run', 0, 'ev-corrupt', 's1', 0, 0, 'ev', '{bad json', 'null')
              `
              yield* sql`
                INSERT INTO flows_journal_checkpoints (run_id, seq, state_json, created_at_ms, compacted_at_ms)
                VALUES ('corrupt-run', 0, '{bad json', 0, NULL)
              `
              yield* sql`PRAGMA ignore_check_constraints = OFF`
              const rowErr = yield* Effect.flip(j.entries({ runId: asRun("corrupt-run"), limit: 5 }))
              const ckptErr = yield* Effect.flip(j.latestCheckpoint(asRun("corrupt-run")))
              if (rowErr.code !== "decode_failed" || ckptErr.code !== "decode_failed") {
                throw new Error(`corrupt codes: ${rowErr.code}, ${ckptErr.code}`)
              }
              return true
            }

            if (faultCase === "writerDefect") {
              const db = yield* Layer.build(migratedDb())
              const sql = Context.get(db, SqlClient.SqlClient)
              const defectWriter = DurableWriter.DurableWriter.of({
                write: () => Effect.die(new Error("boom defect"))
              })
              const jCtx = yield* Layer.build(
                SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
                  Layer.provide(Layer.merge(
                    Layer.succeed(DurableWriter.DurableWriter)(defectWriter),
                    Layer.succeed(SqlClient.SqlClient)(sql)
                  ))
                )
              )
              const j = Context.get(jCtx, Journal.Journal)
              yield* j.emitLossy(mkInput("def-w", "s1", "ev", { a: 1 }, { sourceSeq: 0 }))
              const err = yield* Effect.flip(j.flush)
              if (err.code !== "sink_failed") throw new Error(`defect err: ${err.code}`)
              return true
            }

            if (faultCase === "closedJournalAndInvalidOwner") {
              let obs: Observations | undefined
              const obsLayer = Layer.succeed(JournalTestObserver, {
                opened: (o) => {
                  obs = o
                },
                drainRegistered: () => {}
              })
              const db = yield* Layer.build(migratedDb())
              const innerScope = yield* Scope.make()
              const jCtx = yield* Layer.buildWithScope(
                SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
                  Layer.provide(obsLayer),
                  Layer.provide(Layer.succeedContext(db))
                ),
                innerScope
              )
              const j = Context.get(jCtx, Journal.Journal)

              // Check observer.admission for unknown & active run
              if ((yield* obs!.admission(asRun("unknown"))) !== undefined) throw new Error("unknown admission")
              yield* j.emitDurableUnfenced(mkInput("act-run", "s1", "ev", { x: 1 }))
              const adm = yield* obs!.admission(asRun("act-run"))
              if (adm === undefined || adm.gateClosed || !adm.permitAvailable) throw new Error("active admission")

              // Invalid owner fails requireFence -> invalid_event
              const badOwner = { hostId: "", pid: -1, nonce: "" } as unknown as OwnerId.OwnerId
              const badOwnerErr = yield* Effect.flip(j.emitDurable(mkInput("act-run", "s1", "ev", { x: 2 }), badOwner))
              if (badOwnerErr.code !== "invalid_event") throw new Error("badOwnerErr")

              // Empty heads
              if ((yield* j.heads!([])).length !== 0) throw new Error("empty heads")

              // Close journal scope, then call methods -> journal_closed
              yield* Scope.close(innerScope, Exit.void)
              const closedErrs = yield* Effect.forEach([
                j.emitLossy(mkInput("act-run", "s1", "ev", { x: 3 })),
                j.emitDurableUnfenced(mkInput("act-run", "s1", "ev", { x: 4 })),
                j.flush
              ], Effect.flip)
              if (!closedErrs.every((e) => e.code === "journal_closed")) throw new Error("closedErrs")
              return true
            }

            // layerWith + TestJournal.layer() default options (no args)
            const tjCtx = yield* Layer.build(TestJournal.layer())
            const tj = Context.get(tjCtx, Journal.Journal)
            yield* tj.emitDurableUnfenced(mkInput("tj-run", "s1", "ev", { ok: true }))

            const db2 = yield* Layer.build(migratedDb())
            const lwCtx = yield* Layer.build(
              SqlJournal.layerWith({ capacity: 8, overflow: "reject" }).pipe(
                Layer.provide(Consensus.layerLocal),
                Layer.provide(Layer.succeedContext(db2))
              )
            )
            const lw = Context.get(lwCtx, Journal.Journal)
            yield* lw.emitDurableUnfenced(mkInput("lw-run", "s1", "ev", { ok: true }))
            return true
          })).pipe(
            Effect.provide(TestClock.layer()),
            Effect.provideService(Metric.MetricRegistry, new Map()),
            Effect.provide(silentLog)
          ),
        { seed: seed + 33, executions: 24 }
      )
    )
    assertFuzz(report)
  })
})
