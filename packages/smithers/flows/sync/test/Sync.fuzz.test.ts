import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import {
  Arbitrary,
  Cause,
  Clock,
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Queue,
  Redacted,
  Ref,
  Schema,
  Stream
} from "effect"
import * as Base64Url from "effect/encoding/Base64Url"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcClientError from "effect/rpc/RpcClientError"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcTest from "effect/rpc/RpcTest"
import * as Socket from "effect/socket/Socket"
import * as TestClock from "effect/testing/TestClock"
import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  BranchCommands,
  BranchIds,
  BranchPresence,
  BranchProjection,
  BranchProtocol,
  BranchRpcs,
  BranchServer,
  BranchShare,
  PresenceProtocol,
  PresenceRoom,
  PresenceSocket,
  RunCatalog,
  SharedText,
  SyncAuth,
  SyncClient,
  SyncError,
  SyncPrincipal,
  SyncProtocol,
  SyncRpcs,
  SyncServer,
  WorkspaceShare
} from "../src/index.ts"
import * as Admission from "../src/internal/Admission.ts"
import * as CauseText from "../src/internal/CauseText.ts"
import * as JournalErrorCode from "../src/internal/JournalErrorCode.ts"
import * as PolicyOptions from "../src/internal/PolicyOptions.ts"
import * as PresenceWire from "../src/internal/PresenceWire.ts"
import * as ProtocolVersion from "../src/internal/ProtocolVersion.ts"
import * as ShareSigner from "../src/internal/ShareSigner.ts"
import * as SnapshotBoundary from "../src/internal/SnapshotBoundary.ts"
import * as TestSocket from "../src/test/TestSocket.ts"
import * as TestSync from "../src/test/TestSync.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "120"))
const fastExec = Math.max(20, baseExecutions)
const medExec = Math.max(15, Math.min(60, Math.floor(baseExecutions / 2)))
const simExec = Math.max(10, Math.min(25, Math.floor(baseExecutions / 5)))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const silentLogs = Logger.layer([])

/** Synchronous HMAC-SHA-256 service for closed-world FuzzSimulation tests. */
const syncCrypto: ShareSigner.CryptoService = {
  importKey: (bytes) => Effect.sync(() => bytes.slice() as unknown as CryptoKey),
  sign: (key, bytes) =>
    Effect.sync(() => {
      const digest = createHmac("sha256", key as unknown as Uint8Array).update(bytes).digest()
      const out = new ArrayBuffer(digest.byteLength)
      new Uint8Array(out).set(digest)
      return out
    })
}

const syncCryptoLayer = Layer.succeed(ShareSigner.Crypto, syncCrypto)
const testSecret = "s".repeat(40)
const rotatedSecret = "r".repeat(40)
const defaultKeyring: BranchShare.Keyring = {
  activeKid: "k1",
  keys: [{ kid: "k1", secret: Redacted.make(testSecret) }]
}
const rotatedKeyring: BranchShare.Keyring = {
  activeKid: "k2",
  keys: [
    { kid: "k1", secret: Redacted.make(testSecret) },
    { kid: "k2", secret: Redacted.make(rotatedSecret) }
  ]
}

const runFuzz = async <A, E>(
  arb: Arbitrary.Arbitrary<A>,
  property: (value: A) => boolean | Effect.Effect<boolean, E>,
  options: {
    readonly seedOffset: number
    readonly executions?: number
    readonly simulation?: boolean
  }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(arb, property, {
      seed: seed + options.seedOffset,
      executions: options.executions ?? fastExec,
      ...(options.simulation ? { execution: FuzzSimulation.execution() } : {})
    }).pipe(Effect.provide(silentLogs))
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const mkRunId = (s: string): JournalEvent.RunId => s as JournalEvent.RunId
const mkSeq = (n: number): JournalEvent.Seq => n as JournalEvent.Seq
const mkSourceId = (s: string): JournalEvent.SourceId => s as JournalEvent.SourceId
const mkSourceSeq = (n: number): JournalEvent.SourceSeq => n as JournalEvent.SourceSeq
const mkBranchId = (s: string): BranchProtocol.BranchId => Schema.decodeSync(BranchProtocol.BranchId)(s)
const mkParticipantId = (s: string): BranchProtocol.ParticipantId => Schema.decodeSync(BranchProtocol.ParticipantId)(s)
const mkCommandId = (s: string): BranchProtocol.CommandId => Schema.decodeSync(BranchProtocol.CommandId)(s)
const isSyncCode = (err: unknown, code: SyncError.ErrorCode): boolean =>
  SyncError.SyncError.is(err) && err.code === code
const snapCharBoundary = (s: string, index: number): number => {
  const clamped = Math.max(0, Math.min(index, s.length))
  if (clamped > 0 && clamped < s.length) {
    const code = s.charCodeAt(clamped)
    if (code >= 0xdc00 && code <= 0xdfff) return clamped - 1
  }
  return clamped
}

const mkJournalEntry = (
  runId: JournalEvent.RunId,
  seq: number,
  options?: {
    readonly eventType?: string
    readonly payload?: unknown
    readonly meta?: unknown
    readonly sourceId?: string
    readonly sourceSeq?: number
  }
): JournalEvent.Entry => {
  const sourceId = mkSourceId(options?.sourceId ?? "src")
  const sourceSeq = mkSourceSeq(options?.sourceSeq ?? seq)
  return new JournalEvent.Entry({
    runId,
    seq: mkSeq(seq),
    eventId: JournalEvent.makeEventId(runId, sourceId, sourceSeq),
    sourceId,
    sourceSeq,
    emittedAtMs: 1000 + seq,
    eventType: options?.eventType ?? "test.event",
    payload: options?.payload ?? { seq },
    meta: options?.meta ?? null
  })
}

const permute = <T>(items: ReadonlyArray<T>, shift: number): Array<T> => {
  const arr = [...items]
  if (arr.length <= 1) return arr
  const rot = shift % arr.length
  return [...arr.slice(rot), ...arr.slice(0, rot)].reverse()
}

// ============================================================================
// 1. BranchProjection CRDT convergence & resolveField
// ============================================================================
describe("@smthrs/sync BranchProjection CRDT convergence fuzz invariants", () => {
  const CmdSpec = Schema.Struct({
    seq: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
    participant: Schema.Literals(["p-alice", "p-bob", "p-carol"]),
    foreign: Schema.Boolean,
    kind: Schema.Literals(["say", "edit", "noncmd", "badpayload"]),
    target: Schema.Literals(["title", "summary", "body", ""]),
    text: Schema.String
  })

  const makeEntry = (
    branchId: BranchProtocol.BranchId,
    otherBranchId: BranchProtocol.BranchId,
    spec: typeof CmdSpec.Type,
    idx: number
  ): JournalEvent.Entry => {
    const runId = BranchProtocol.branchRunId(spec.foreign ? otherBranchId : branchId)
    const commandId = mkCommandId(`cmd-${spec.id}-${idx}`)
    const participantId = mkParticipantId(spec.participant)
    const seq = mkSeq(spec.seq)
    const sourceId = mkSourceId("fuzz-src")
    const sourceSeq = mkSourceSeq(idx + 1)
    if (spec.kind === "noncmd") {
      return new JournalEvent.Entry({
        runId,
        seq,
        eventId: JournalEvent.makeEventId(runId, sourceId, sourceSeq),
        sourceId,
        sourceSeq,
        emittedAtMs: 1000 + spec.seq,
        eventType: "other/event",
        payload: { ignored: true },
        meta: {}
      })
    }
    if (spec.kind === "badpayload") {
      return new JournalEvent.Entry({
        runId,
        seq,
        eventId: JournalEvent.makeEventId(runId, sourceId, sourceSeq),
        sourceId,
        sourceSeq,
        emittedAtMs: 1000 + spec.seq,
        eventType: BranchProtocol.CommandEvent,
        payload: { broken: 123 },
        meta: {}
      })
    }
    const payload = spec.kind === "say"
      ? {
        commandId,
        participantId,
        capabilityId: "cap-1",
        name: BranchProtocol.SayCommand,
        args: (spec.text.trim() || "hello").slice(0, 64),
        target: ""
      }
      : {
        commandId,
        participantId,
        capabilityId: "cap-1",
        name: "branch.edit",
        args: spec.text.slice(0, 64),
        target: spec.target
      }
    return new JournalEvent.Entry({
      runId,
      seq,
      eventId: JournalEvent.makeEventId(runId, sourceId, sourceSeq),
      sourceId,
      sourceSeq,
      emittedAtMs: 1000 + spec.seq,
      eventType: BranchProtocol.CommandEvent,
      payload,
      meta: {}
    })
  }

  it("converges identically under reordered, duplicated, and foreign-branch polluted delivery", async () => {
    const branchId = mkBranchId("branch-main")
    const otherBranchId = mkBranchId("branch-foreign")
    const arb = Arbitrary.schema(
      Schema.Struct({
        specs: Schema.Array(CmdSpec),
        shift: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 }))
      })
    )
    await runFuzz(
      arb,
      ({ specs, shift }) => {
        const seenSeq = new Set<number>()
        const entries: Array<JournalEvent.Entry> = []
        for (let i = 0; i < Math.min(specs.length, 16); i++) {
          const sp = specs[i]!
          if (!sp.foreign && seenSeq.has(sp.seq)) continue
          if (!sp.foreign) seenSeq.add(sp.seq)
          entries.push(makeEntry(branchId, otherBranchId, sp, i))
        }

        const streamA = [...entries, ...entries.slice(0, 3)]
        const streamB = [...permute(entries, shift), ...permute(entries, shift + 1).slice(0, 4)]

        const projA = BranchProjection.project(branchId, streamA)
        const projB = BranchProjection.project(branchId, streamB)

        let foldA = BranchProjection.empty(branchId)
        for (const e of streamA) foldA = BranchProjection.apply(foldA, e)
        let foldB = BranchProjection.empty(branchId)
        for (const e of streamB) foldB = BranchProjection.apply(foldB, e)

        const norm = (s: BranchProjection.State) =>
          JSON.stringify({
            branchId: s.branchId,
            seq: s.seq,
            messages: s.messages,
            commands: s.commands.map((c) => ({
              seq: c.seq,
              commandId: c.commandId,
              participantId: c.participantId,
              capabilityId: c.capabilityId,
              name: c.name,
              args: c.args,
              target: c.target
            })),
            fields: [...s.fields].sort((a, b) => a.target.localeCompare(b.target))
          })
        if (norm(projA) !== norm(projB)) return false
        if (norm(foldA) !== norm(projA)) return false
        if (norm(foldB) !== norm(projA)) return false

        for (let i = 1; i < projA.messages.length; i++) {
          if (!(projA.messages[i - 1]!.seq < projA.messages[i]!.seq)) return false
        }

        const decodeCmdOpt = Schema.decodeUnknownOption(BranchProtocol.CommandEventPayload)
        const ownCmdCount = entries.filter(
          (e) =>
            e.runId === BranchProtocol.branchRunId(branchId) &&
            e.eventType === BranchProtocol.CommandEvent &&
            decodeCmdOpt(e.payload)._tag === "Some"
        ).length
        return projA.commands.length === ownCmdCount
      },
      { seedOffset: 0 }
    )
  })

  it("resolveField forms a commutative, associative, idempotent join-semilattice including equal-seq ties", async () => {
    const FieldSpec = Schema.Struct({
      seq: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
      participant: Schema.Literals(["p-a", "p-b", "p-c"]),
      value: Schema.String
    })
    const arb = Arbitrary.schema(Schema.Struct({ a: FieldSpec, b: FieldSpec }))
    await runFuzz(
      arb,
      ({ a, b }) => {
        const fa: BranchProjection.Field = {
          target: "title",
          value: a.value.slice(0, 20),
          seq: mkSeq(a.seq),
          participantId: mkParticipantId(a.participant),
          capabilityId: "cap-1"
        }
        const fb: BranchProjection.Field = {
          target: "title",
          value: b.value.slice(0, 20),
          seq: mkSeq(b.seq),
          participantId: mkParticipantId(b.participant),
          capabilityId: "cap-1"
        }
        if (BranchProjection.resolveField(undefined, fa) !== fa) return false
        if (BranchProjection.resolveField(fa, fa) !== fa) return false
        const ab = BranchProjection.resolveField(fa, fb)
        const ba = BranchProjection.resolveField(fb, fa)
        if (a.seq !== b.seq || a.participant !== b.participant) {
          if (ab.seq !== ba.seq || ab.participantId !== ba.participantId) return false
        }
        return ab.seq >= Math.max(fa.seq, fb.seq)
      },
      { seedOffset: 1 }
    )
  })
})

// ============================================================================
// 2. Protocols, SyncError, SyncPrincipal, BranchIds, and src/internal/*
// ============================================================================
describe("@smthrs/sync protocol, error, principal, ids, and internal utilities fuzzing", () => {
  it("BranchProtocol run/branch id mapping, command source id, and BranchIds layers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        raw: Schema.String,
        nonEmpty: Schema.NonEmptyString,
        count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))
      })
    )
    await runFuzz(
      arb,
      ({ raw, nonEmpty, count }) =>
        Effect.gen(function*() {
          const bId = mkBranchId(nonEmpty.slice(0, 40) || "b")
          const rId = BranchProtocol.branchRunId(bId)
          if (BranchProtocol.branchOfRunId(rId) !== bId) return false
          if (BranchProtocol.branchOfRunId(mkRunId("flows/branch/")) !== null) return false
          const parsed = BranchProtocol.branchOfRunId(mkRunId(raw))
          if (raw.startsWith("flows/branch/") && raw.length > "flows/branch/".length) {
            if (parsed !== raw.slice("flows/branch/".length)) return false
          } else {
            if (parsed !== null) return false
          }
          const cmdId = mkCommandId(nonEmpty.slice(0, 20) || "c")
          if (!BranchProtocol.commandSourceId(cmdId).endsWith(cmdId)) return false
          if (BranchProtocol.commandSourceSeq !== 0) return false

          // CommandEventPayload decoding defaults
          const decodedPayload = Schema.decodeUnknownSync(BranchProtocol.CommandEventPayload)({
            commandId: cmdId,
            participantId: mkParticipantId("p1"),
            name: "op"
          })
          if (decodedPayload.args !== "" || decodedPayload.target !== "" || decodedPayload.capabilityId !== "") {
            return false
          }

          // BranchIds sequential & webcrypto
          const seqIds = yield* Effect.gen(function*() {
            const ids = yield* BranchIds.BranchIds
            const out: Array<string> = []
            for (let i = 0; i < count; i++) out.push(yield* ids.fresh)
            return out
          }).pipe(Effect.provide(BranchIds.layerSequential("pfx")))
          if (seqIds.length !== count || seqIds[0] !== "pfx-1" || seqIds[count - 1] !== `pfx-${count}`) return false

          const wcId = yield* Effect.flatMap(BranchIds.BranchIds, (ids) => ids.fresh).pipe(
            Effect.provide(BranchIds.layer)
          )
          return wcId.length > 0
        }),
      { seedOffset: 10 }
    )
  })

  it("SyncProtocol covers, duplicateCursorRunId, and total encodedByteLength", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        runIds: Schema.Array(Schema.Literals(["r1", "r2", "r3", "r4"])),
        target: Schema.Literals(["r1", "r2", "r5"]),
        text: Schema.String,
        kind: Schema.Literals(["json", "undef", "fn", "sym", "bigint", "cycle", "throw"])
      })
    )
    await runFuzz(
      arb,
      ({ runIds, target, text, kind }) => {
        if (!SyncProtocol.covers({ _tag: "Workspace" }, mkRunId(target))) return false
        const runScope: SyncProtocol.Scope = { _tag: "Run", runId: mkRunId("r1") }
        if (SyncProtocol.covers(runScope, mkRunId(target)) !== (target === "r1")) return false

        const cursors: SyncProtocol.WorkspaceCursor = runIds.map((r, i) => ({
          runId: mkRunId(r),
          afterSeq: mkSeq(i)
        }))
        const dup = SyncProtocol.duplicateCursorRunId(cursors)
        const unique = new Set(runIds).size === runIds.length
        if (unique && dup !== undefined) return false
        if (!unique && dup === undefined) return false

        const utf8Len = new TextEncoder().encode(JSON.stringify(text)).length
        if (SyncProtocol.encodedByteLength(text) !== utf8Len) return false

        if (kind === "undef" && SyncProtocol.encodedByteLength(undefined) !== 4) return false
        if (kind === "fn" && SyncProtocol.encodedByteLength(() => 1) !== 4) return false
        if (kind === "sym" && SyncProtocol.encodedByteLength(Symbol("x")) !== 4) return false
        if (kind === "bigint" && SyncProtocol.encodedByteLength(1n) !== Number.POSITIVE_INFINITY) return false
        if (kind === "cycle") {
          const c: Record<string, unknown> = {}
          c["self"] = c
          if (SyncProtocol.encodedByteLength(c) !== Number.POSITIVE_INFINITY) return false
        }
        if (kind === "throw") {
          const bad = {
            toJSON: () => {
              throw new Error("boom")
            }
          }
          if (SyncProtocol.encodedByteLength(bad) !== Number.POSITIVE_INFINITY) return false
        }
        return true
      },
      { seedOffset: 11 }
    )
  })

  it("SyncError.is is total across all codes, optional resync/rewind, and throwing getters", async () => {
    const allCodes = [
      "invalid_request",
      "unsupported",
      "unauthorized",
      "not_found",
      "backpressure",
      "frame_too_large",
      "decode_failed",
      "transport_failed",
      "protocol_violation",
      "lineage_changed",
      "compacted",
      "closed",
      "unknown"
    ] as const
    const arb = Arbitrary.schema(
      Schema.Struct({
        codeIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 14 })),
        msg: Schema.String,
        withResync: Schema.Boolean,
        badResync: Schema.Boolean,
        withRewind: Schema.Boolean,
        badRewind: Schema.Boolean,
        throwField: Schema.Literals(["none", "_tag", "code", "message", "resync", "rewind"]),
        badType: Schema.Literals(["ok", "null", "wrongTag", "numMessage", "numCode"])
      })
    )
    await runFuzz(
      arb,
      ({ codeIdx, msg, withResync, badResync, withRewind, badRewind, throwField, badType }) => {
        const gap = new SyncError.SyncGapError({
          runId: mkRunId("r1"),
          expectedFrom: mkSeq(1),
          receivedFrom: mkSeq(5)
        })
        if (gap._tag !== "@smthrs/sync/SyncGapError") return false

        if (badType === "null") return SyncError.SyncError.is(null) === false
        if (badType === "wrongTag") {
          return SyncError.SyncError.is({ _tag: "Other", code: "unknown", message: msg }) === false
        }
        if (badType === "numMessage") {
          return SyncError.SyncError.is({ _tag: "@smthrs/sync/SyncError", code: "unknown", message: 42 }) === false
        }
        if (badType === "numCode") {
          return SyncError.SyncError.is({ _tag: "@smthrs/sync/SyncError", code: 42, message: msg }) === false
        }

        const code = codeIdx < allCodes.length ? allCodes[codeIdx]! : "bogus_code"
        const candidate: Record<string, unknown> = {
          _tag: "@smthrs/sync/SyncError",
          code,
          message: msg
        }
        if (withResync) {
          candidate["resync"] = badResync
            ? { runId: "", checkpointSeq: -5 }
            : { runId: "r1", checkpointSeq: 2, generation: 0 }
        }
        if (withRewind) {
          candidate["rewind"] = badRewind
            ? { runId: "r1", generation: -1, afterSeq: -5 }
            : { runId: "r1", generation: 1, afterSeq: 0 }
        }
        if (throwField !== "none") {
          Object.defineProperty(candidate, throwField, {
            get() {
              throw new Error("getter boom")
            }
          })
          return SyncError.SyncError.is(candidate) === false
        }

        const validCode = codeIdx < allCodes.length
        const validRewind = !withRewind || (code === "lineage_changed" && !badRewind)
        const validResync = !withResync || (code === "compacted" && !badResync)
        const expected = validCode && validRewind && validResync
        return SyncError.SyncError.is(candidate) === expected
      },
      { seedOffset: 12 }
    )
  })

  it("SyncPrincipal, CauseText, JournalErrorCode, PolicyOptions, and ProtocolVersion invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        textLen: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 700 })),
        errKind: Schema.Literals(["plain", "coded", "numCode", "nonErr", "proto"]),
        errCode: Schema.Literals(["decode_failed", "journal_closed", "queue_overflow", "other", "toString"]),
        numKind: Schema.Literals(["undef", "valid", "zero", "neg", "float", "nan", "inf", "huge"]),
        numVal: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
        ver: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 3 })),
        undefVer: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      ({ textLen, errKind, errCode, numKind, numVal, ver, undefVer }) =>
        Effect.gen(function*() {
          // SyncPrincipal
          if (SyncPrincipal.isWorkspace(SyncPrincipal.anonymous)) return false
          const p = SyncPrincipal.workspace("cap-1")
          if (!SyncPrincipal.isWorkspace(p) || p.access !== "write" || p.expiresAtMs !== Number.POSITIVE_INFINITY) {
            return false
          }
          const resolvedP = yield* SyncPrincipal.SyncPrincipal.pipe(
            Effect.provide(SyncPrincipal.layerWorkspace("cap-w"))
          )
          if (!SyncPrincipal.isWorkspace(resolvedP) || resolvedP.capabilityId !== "cap-w") return false
          const defaultP = yield* SyncPrincipal.SyncPrincipal
          if (defaultP._tag !== "Anonymous") return false

          // CauseText
          const s = "x".repeat(textLen)
          const bounded = CauseText.boundedText(s)
          if (textLen <= 512 && bounded !== s) return false
          if (textLen > 512 && !bounded.endsWith(" (truncated)")) return false

          const errObj: unknown = errKind === "nonErr"
            ? { arbitrary: s }
            : errKind === "plain"
            ? new Error(s)
            : errKind === "numCode"
            ? Object.assign(new Error(s), { code: 123 })
            : errKind === "proto"
            ? Object.assign(new Error(s), { code: "toString" })
            : Object.assign(new Error(s), { code: errCode })

          const ct = CauseText.causeText(errObj)
          const cc = CauseText.causeCode(errObj)
          if (ct.length > 524 || cc.length > 524) return false

          // JournalErrorCode
          const mapped = JournalErrorCode.journalErrorCode(errObj)
          if (errKind === "coded" && errCode === "decode_failed" && mapped !== "decode_failed") return false
          if (errKind === "coded" && errCode === "journal_closed" && mapped !== "closed") return false
          if (errKind === "coded" && errCode === "queue_overflow" && mapped !== "backpressure") return false
          if (errKind === "proto" && mapped !== "unknown") return false
          if (errKind === "nonErr" && mapped !== "unknown") return false

          // PolicyOptions
          const rawNum: number | undefined = numKind === "undef"
            ? undefined
            : numKind === "valid"
            ? numVal
            : numKind === "zero"
            ? 0
            : numKind === "neg"
            ? -numVal
            : numKind === "float"
            ? numVal + 0.5
            : numKind === "nan"
            ? Number.NaN
            : numKind === "inf"
            ? Number.POSITIVE_INFINITY
            : Number.MAX_SAFE_INTEGER + 10

          const posExit = yield* Effect.exit(PolicyOptions.positiveInt("opt", rawNum, 10))
          const expectPosOk = numKind === "undef" || numKind === "valid"
          if (Exit.isSuccess(posExit) !== expectPosOk) return false

          const bndExit = yield* Effect.exit(PolicyOptions.boundedInt("opt", rawNum, 10, 20))
          const expectBndOk = numKind === "undef" || (numKind === "valid" && numVal <= 20)
          if (Exit.isSuccess(bndExit) !== expectBndOk) return false

          if (rawNum !== undefined) {
            const rcExit = yield* Effect.exit(PolicyOptions.requestCount("cnt", rawNum, 15))
            if (Exit.isSuccess(rcExit) !== (numKind === "valid")) return false
            if (Exit.isSuccess(rcExit) && rcExit.value !== Math.min(numVal, 15)) return false
          }

          // ProtocolVersion
          const pvExit = yield* Effect.exit(ProtocolVersion.requireVersion(undefVer ? undefined : ver))
          return Exit.isSuccess(pvExit) === (!undefVer && ver === SyncProtocol.protocolVersion)
        }),
      { seedOffset: 13 }
    )
  })

  it("Admission and SnapshotBoundary enforce detachment, monotonicity, JSON safety, and identity checks", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "valid",
          "foreignBranch",
          "badCommand",
          "nonJson",
          "foreignRun",
          "nonMonotonic",
          "badDecode"
        ]),
        snapMode: Schema.Literals([
          "valid",
          "badReq",
          "badReqVer",
          "nonJson",
          "undef",
          "oversized",
          "badRespSchema",
          "badRespVer",
          "mismatchRun",
          "mismatchLineage",
          "mismatchProj",
          "mismatchProjVer",
          "shortSeq"
        ]),
        seq: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))
      })
    )
    await runFuzz(
      arb,
      ({ mode, snapMode, seq }) =>
        Effect.gen(function*() {
          const bId = mkBranchId("b-adm")
          const runId = BranchProtocol.branchRunId(bId)

          if (mode === "badDecode") {
            const fail = yield* Effect.flip(Admission.decode(BranchProtocol.BranchId, "", "invalid_request"))
            if (fail.code !== "invalid_request") return false
          } else {
            const e1 = new JournalEvent.Entry({
              runId: mode === "foreignRun" ? mkRunId("other-run") : runId,
              seq: mkSeq(seq),
              eventId: JournalEvent.makeEventId(runId, mkSourceId("s"), mkSourceSeq(seq)),
              sourceId: mkSourceId("s"),
              sourceSeq: mkSourceSeq(seq),
              emittedAtMs: 1000,
              eventType: mode === "nonJson" ? "other" : BranchProtocol.CommandEvent,
              payload: mode === "badCommand"
                ? { commandId: "" }
                : mode === "nonJson"
                ? { x: Number.NaN }
                : {
                  branchId: mode === "foreignBranch" ? "other-branch" : "b-adm",
                  commandId: "cmd-1",
                  participantId: "p-1",
                  name: "branch.say",
                  args: "hi",
                  target: ""
                },
              meta: null
            })
            const batch = mode === "nonMonotonic"
              ? [e1, mkJournalEntry(runId, seq, { sourceSeq: seq + 1 })]
              : [e1]
            const exit = yield* Effect.exit(Admission.entries(batch, runId, -1))
            if (mode === "valid") {
              if (!Exit.isSuccess(exit)) return false
              const recs = yield* Admission.records([e1])
              if (recs.length !== 1) return false
            } else {
              if (Exit.isSuccess(exit)) return false
            }
          }

          // SnapshotBoundary
          const validReq: SyncProtocol.SnapshotRequest = {
            protocolVersion: 1,
            runId: mkRunId("r-snap"),
            lineageId: "lin-1",
            projection: "proj-1",
            projectionVersion: 1,
            atLeastSeq: mkSeq(seq)
          }
          if (snapMode === "badReq") {
            const err = yield* Effect.flip(SnapshotBoundary.request({ ...validReq, extra: 1 }))
            return err.code === "invalid_request"
          }
          if (snapMode === "badReqVer") {
            const err = yield* Effect.flip(SnapshotBoundary.request({ ...validReq, protocolVersion: 99 }))
            return err.code === "protocol_violation"
          }
          const req = yield* SnapshotBoundary.request(validReq)
          const validSnap: SyncProtocol.Snapshot = {
            protocolVersion: 1,
            runId: req.runId,
            lineageId: req.lineageId,
            projection: req.projection,
            projectionVersion: req.projectionVersion,
            seq: mkSeq(seq),
            state: { ok: true }
          }
          let respVal: unknown = validSnap
          let maxBytes = 4096
          if (snapMode === "nonJson") {
            const cyc: Record<string, unknown> = {}
            cyc["c"] = cyc
            respVal = cyc
          } else if (snapMode === "undef") {
            respVal = undefined
          } else if (snapMode === "oversized") {
            maxBytes = 10
          } else if (snapMode === "badRespSchema") {
            respVal = { ...validSnap, state: { bad: Number.NaN } }
          } else if (snapMode === "badRespVer") {
            respVal = { ...validSnap, protocolVersion: 2 }
          } else if (snapMode === "mismatchRun") {
            respVal = { ...validSnap, runId: mkRunId("other") }
          } else if (snapMode === "mismatchLineage") {
            respVal = { ...validSnap, lineageId: "other" }
          } else if (snapMode === "mismatchProj") {
            respVal = { ...validSnap, projection: "other" }
          } else if (snapMode === "mismatchProjVer") {
            respVal = { ...validSnap, projectionVersion: 2 }
          } else if (snapMode === "shortSeq") {
            respVal = { ...validSnap, seq: mkSeq(seq - 1) }
          }
          const snapExit = yield* Effect.exit(SnapshotBoundary.response(req, respVal, maxBytes))
          if (snapMode === "valid") return Exit.isSuccess(snapExit)
          if (Exit.isSuccess(snapExit)) return false
          return true
        }),
      { seedOffset: 14 }
    )
  })
})

// ============================================================================
// 3. SharedText CRDT (Yjs)
// ============================================================================
describe("@smthrs/sync SharedText CRDT fuzz invariants", () => {
  const OpSpec = Schema.Struct({
    replica: Schema.Literals([0, 1]),
    kind: Schema.Literals(["edit", "replace", "replaceStale", "mark", "anchor"]),
    from: Schema.Int.check(Schema.isBetween({ minimum: -2, maximum: 24 })),
    len: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
    text: Schema.Literals(["", "a", "bc", "🚀", "hi!", "xyz", "🎉a"]),
    markKey: Schema.Literals(["m1", "m2"]),
    markVal: Schema.Literals(["v1", "v2", "v3"]),
    caretOffset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }))
  })

  it("changeOf reconstructs after from before without splitting surrogate pairs", async () => {
    const pieces = Schema.Literals(["", "a", "aa", "b", "😀", "😃", "𝒜", "𝒞", "🚀", "🎉", "hi", "🚀a", "a🎉b"])
    const arb = Arbitrary.schema(
      Schema.Struct({
        p1: Schema.Array(pieces),
        p2: Schema.Array(pieces),
        useCaret: Schema.Boolean,
        caret: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }))
      })
    )
    await runFuzz(
      arb,
      ({ p1, p2, useCaret, caret }) => {
        const before = p1.slice(0, 6).join("")
        const after = p2.slice(0, 6).join("")
        const ch = SharedText.changeOf(before, after, useCaret ? caret : undefined)
        const rebuilt = before.slice(0, ch.from) + ch.insert + before.slice(ch.to)
        return rebuilt === after
      },
      { seedOffset: 20 }
    )
  })

  it("converges across multi-replica edits, stale rebases, marks, anchors, seeds, merges, and validation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        seedText: Schema.Literals(["", "hello", "🚀 world", "abcdef"]),
        ops: Schema.Array(OpSpec),
        shift: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 32 }))
      })
    )
    await runFuzz(
      arb,
      ({ seedText, ops, shift }) =>
        Effect.scoped(
          Effect.gen(function*() {
            const a = yield* SharedText.make
            const b = yield* SharedText.make
            const c = yield* SharedText.make

            const seedBytes = SharedText.seed(seedText)
            yield* SharedText.validate(seedBytes, { seed: true })
            if (seedText.length > 0) {
              const seedAsEdit = yield* Effect.flip(SharedText.validate(seedBytes, { seed: false }))
              if (seedAsEdit.reason !== "seed_client") return false
            }
            yield* a.apply(seedBytes)
            yield* b.apply(seedBytes)
            yield* b.apply(seedBytes) // idempotent seed

            // Malformed update fails without modifying text
            const badExit = yield* Effect.exit(a.apply(new Uint8Array([0xff, 0xfe, 0x01, 0x02])))
            if (Exit.isSuccess(badExit)) return false
            const badVal = yield* Effect.exit(SharedText.validate(new Uint8Array([0xff, 0xfe, 0x01]), { seed: false }))
            if (Exit.isSuccess(badVal)) return false
            // Invalid anchor resolves to undefined
            if ((yield* a.resolve(new Uint8Array([0xff, 0xff]))) !== undefined) return false

            const updates: Array<Uint8Array> = [seedBytes]
            let staleBase: string = seedText
            for (const op of ops.slice(0, 12)) {
              const target = op.replica === 0 ? a : b
              const cur = yield* target.text
              let u: Uint8Array | undefined
              if (op.kind === "edit") {
                const from = snapCharBoundary(cur, op.from)
                const to = snapCharBoundary(cur, from + op.len)
                u = yield* target.edit([{ from, to, insert: op.text }])
              } else if (op.kind === "replace") {
                const pos = snapCharBoundary(cur, op.from)
                const end = snapCharBoundary(cur, pos + op.len)
                const next = cur.slice(0, pos) + op.text + cur.slice(end)
                u = yield* target.replace(next, { caret: op.caretOffset })
              } else if (op.kind === "replaceStale") {
                const pos = snapCharBoundary(staleBase, op.from)
                const end = snapCharBoundary(staleBase, pos + op.len)
                const next = staleBase.slice(0, pos) + op.text + staleBase.slice(end)
                u = yield* target.replace(next, { base: staleBase, caret: op.caretOffset })
              } else if (op.kind === "mark") {
                u = yield* target.mark(op.markKey, op.markVal)
                // Re-setting same value returns undefined
                const noop = yield* target.mark(op.markKey, op.markVal)
                if (noop !== undefined) return false
              } else {
                const anc = yield* target.anchor(op.from)
                const res = yield* target.resolve(anc)
                if (res === undefined || res < 0 || res > cur.length) return false
              }
              if (u !== undefined) {
                yield* SharedText.validate(u, { seed: false })
                if (op.text !== "" && op.kind !== "mark") {
                  const seedValExit = yield* Effect.exit(SharedText.validate(u, { seed: true }))
                  if (
                    Exit.isFailure(seedValExit) && Cause.squash(seedValExit.cause) instanceof SharedText.InvalidUpdate
                  ) {
                    const inv = Cause.squash(seedValExit.cause) as SharedText.InvalidUpdate
                    if (inv.reason !== "seed_client") return false
                  }
                }
                updates.push(u)
                if (updates.length % 2 === 0) {
                  yield* (op.replica === 0 ? b : a).apply(u)
                }
              }
              staleBase = cur
            }

            // Deliver all updates in permuted orders + merged snapshot
            const merged = SharedText.merge(updates)
            for (const u of permute(updates, shift)) yield* a.apply(u)
            for (const u of permute(updates, shift + 3)) yield* b.apply(u)
            yield* c.apply(merged)

            const ta = yield* a.text
            const tb = yield* b.text
            const tc = yield* c.text
            if (ta !== tb || tb !== tc) return false

            const ma = yield* a.marks
            const mb = yield* b.marks
            const mc = yield* c.marks
            if (ma.size !== mb.size || mb.size !== mc.size) return false
            for (const [k, v] of ma) {
              if (mb.get(k) !== v || mc.get(k) !== v) return false
            }

            const snap = yield* a.snapshot
            const d = yield* SharedText.make
            yield* d.apply(snap)
            return (yield* d.text) === ta
          })
        ),
      { seedOffset: 21, executions: medExec }
    )
  })
})

// ============================================================================
// 4. ShareSigner, BranchShare, WorkspaceShare, SyncAuth
// ============================================================================
describe("@smthrs/sync capability signing, rotation, expiry, and SyncAuth fuzzing", () => {
  it("ShareSigner primitives, keyring validation, real WebCrypto, and crypto fault mapping", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        fieldsA: Schema.Array(Schema.Literals(["a", "b:", "1:c", "🚀", ""])),
        fieldsB: Schema.Array(Schema.Literals(["a", "b:", "1:c", "🚀", ""])),
        sigLeft: Schema.String,
        sigRight: Schema.String,
        badMode: Schema.Literals([
          "shortSecret",
          "surrogateSecret",
          "dupKid",
          "missingActive",
          "importFail",
          "signFail",
          "surrogateClaim",
          "realWebCryptoReject"
        ])
      })
    )
    await runFuzz(
      arb,
      ({ fieldsA, fieldsB, sigLeft, sigRight, badMode }) =>
        Effect.gen(function*() {
          // lengthPrefixed injectivity
          const a = fieldsA.slice(0, 5)
          const b = fieldsB.slice(0, 5)
          const encA = ShareSigner.lengthPrefixed(a)
          const encB = ShareSigner.lengthPrefixed(b)
          if (JSON.stringify(a) !== JSON.stringify(b) && encA === encB) return false

          // constantTimeEquals
          if (ShareSigner.constantTimeEquals(sigLeft, sigRight) !== (sigLeft === sigRight)) return false

          // Real WebCrypto happy path
          const key = yield* ShareSigner.importHmacKey(testSecret)
          const sig1 = yield* ShareSigner.signHmac(key, encA)
          const sig2 = yield* ShareSigner.signHmac(key, encA)
          if (sig1 !== sig2 || sig1.length !== 64) return false

          // Real WebCrypto rejection catch paths
          if (badMode === "realWebCryptoReject") {
            const native = yield* ShareSigner.Crypto
            const impExit = yield* Effect.exit(native.importKey(new Uint8Array(0)))
            const signExit = yield* Effect.exit(native.sign({} as CryptoKey, new Uint8Array([1])))
            return !Exit.isSuccess(impExit) && !Exit.isSuccess(signExit)
          }

          // Fault & validation paths
          if (badMode === "shortSecret") {
            const err = yield* Effect.flip(ShareSigner.importHmacKey("short"))
            return err.code === "invalid_request"
          }
          if (badMode === "surrogateSecret") {
            const err = yield* Effect.flip(ShareSigner.importHmacKey("\ud800" + "a".repeat(35)))
            return err.code === "invalid_request"
          }
          if (badMode === "dupKid") {
            const err = yield* Effect.flip(
              ShareSigner.importKeyring(
                {
                  activeKid: "k1",
                  keys: [
                    { kid: "k1", secret: Redacted.make(testSecret) },
                    { kid: "k1", secret: Redacted.make(rotatedSecret) }
                  ]
                },
                "branch"
              )
            )
            return err.code === "invalid_request"
          }
          if (badMode === "missingActive") {
            const err = yield* Effect.flip(
              ShareSigner.importKeyring(
                { activeKid: "missing", keys: [{ kid: "k1", secret: Redacted.make(testSecret) }] },
                "workspace"
              )
            )
            return err.code === "invalid_request"
          }
          if (badMode === "importFail") {
            const err = yield* Effect.flip(
              ShareSigner.importHmacKey(testSecret).pipe(
                Effect.provideService(ShareSigner.Crypto, {
                  importKey: () => Effect.fail(new Error("import fail")),
                  sign: syncCrypto.sign
                })
              )
            )
            return err.code === "unknown"
          }
          if (badMode === "signFail") {
            const err = yield* Effect.flip(
              ShareSigner.signHmac(key, "payload").pipe(
                Effect.provideService(ShareSigner.Crypto, {
                  importKey: syncCrypto.importKey,
                  sign: () => Effect.fail(new Error("sign fail"))
                })
              )
            )
            return err.code === "unknown"
          }
          const surErr = yield* Effect.flip(ShareSigner.signHmac(key, "bad-\ud800-claim"))
          return surErr.code === "invalid_request"
        }),
      { seedOffset: 30, executions: medExec }
    )
  })

  it("BranchShare and WorkspaceShare enforce rotation, expiry, scope, access, config, and noop", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        branch: Schema.Literals(["b1", "b2"]),
        otherBranch: Schema.Literals(["b2", "b3"]),
        access: Schema.Literals(["read", "write"]),
        reqAccess: Schema.Literals(["read", "write"]),
        ttlMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 5000 })),
        advanceMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6000 })),
        tamper: Schema.Literals(["none", "sig", "kid", "crossBranch", "maxExpExpired", "badMint"])
      })
    )
    await runFuzz(
      arb,
      ({ branch, otherBranch, access, reqAccess, ttlMs, advanceMs, tamper }) =>
        Effect.gen(function*() {
          // Noop authorities fail closed
          const bn = BranchShare.makeNoop()
          const wn = WorkspaceShare.makeNoop()
          if (
            (yield* Effect.flip(
              bn.mint({ branchId: mkBranchId("b1"), capabilityId: "c1", access: "read", ttlMs: 100 })
            )).code !== "unauthorized"
          ) return false
          if (
            (yield* Effect.flip(wn.mint({ capabilityId: "c1", access: "read", ttlMs: 100 }))).code !== "unauthorized"
          ) return false

          // Config layers
          const bCfg = yield* BranchShare.BranchShare.pipe(
            Effect.provide(
              BranchShare.layerConfig.pipe(
                Layer.provide(
                  ConfigProvider.layer(ConfigProvider.fromUnknown({ SMITHERS_SYNC_BRANCH_SECRET: testSecret }))
                )
              )
            )
          )
          const wCfg = yield* WorkspaceShare.WorkspaceShare.pipe(
            Effect.provide(
              WorkspaceShare.layerConfig.pipe(
                Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ SMITHERS_SYNC_SECRET: testSecret })))
              )
            )
          )

          // Mint on k1, verify on rotated keyring (k1 + k2)
          const bOld = yield* BranchShare.makeHmac(defaultKeyring)
          const bRot = yield* BranchShare.makeHmac(rotatedKeyring)
          const wOld = yield* WorkspaceShare.makeHmac(defaultKeyring)
          const wRot = yield* WorkspaceShare.makeHmac(rotatedKeyring)

          if (tamper === "badMint") {
            const e1 = yield* Effect.flip(
              bOld.mint({ branchId: mkBranchId(branch), capabilityId: "", access, ttlMs: 0 })
            )
            const e2 = yield* Effect.flip(wOld.mint({ capabilityId: "", access, ttlMs: 0 }))
            return e1.code === "invalid_request" && e2.code === "invalid_request"
          }
          if (tamper === "maxExpExpired") {
            const e = yield* Effect.flip(
              bOld.mint({ branchId: mkBranchId(branch), capabilityId: "c1", access, ttlMs, maxExpiresAtMs: 0 })
            )
            return e.code === "unauthorized"
          }

          const bCap = yield* bOld.mint({
            branchId: mkBranchId(branch),
            capabilityId: "cap-b",
            access,
            ttlMs,
            maxExpiresAtMs: ttlMs + 500
          })
          const wCap = yield* wOld.mint({ capabilityId: "cap-w", access, ttlMs })

          // Config-minted cap also verifies
          const cfgCap = yield* bCfg.mint({
            branchId: mkBranchId(branch),
            capabilityId: "cfg-b",
            access: "read",
            ttlMs: 1000
          })
          yield* bCfg.verify(cfgCap, { branchId: mkBranchId(branch), access: "read" })
          const wCfgCap = yield* wCfg.mint({ capabilityId: "cfg-w", access: "read", ttlMs: 1000 })
          yield* wCfg.verify(wCfgCap, { access: "read" })

          yield* TestClock.adjust(advanceMs)

          const verifyBranch = tamper === "sig"
            ? new BranchProtocol.ShareCapability({ claims: bCap.claims, signature: "0".repeat(64) })
            : tamper === "kid"
            ? new BranchProtocol.ShareCapability({
              claims: new BranchProtocol.ShareClaims({ ...bCap.claims, kid: "unknown-kid" }),
              signature: bCap.signature
            })
            : bCap

          const verifyWs = tamper === "sig"
            ? new WorkspaceShare.WorkspaceCapability({ claims: wCap.claims, signature: "0".repeat(64) })
            : tamper === "kid"
            ? new WorkspaceShare.WorkspaceCapability({
              claims: new WorkspaceShare.WorkspaceClaims({ ...wCap.claims, kid: "unknown-kid" }),
              signature: wCap.signature
            })
            : wCap

          const targetBranch = tamper === "crossBranch" && otherBranch !== branch ? otherBranch : branch
          const bExit = yield* Effect.exit(
            bRot.verify(verifyBranch, { branchId: mkBranchId(targetBranch), access: reqAccess })
          )
          const wExit = yield* Effect.exit(wRot.verify(verifyWs, { access: reqAccess }))

          const expired = advanceMs >= ttlMs
          const accessDenied = reqAccess === "write" && access === "read"
          const bShouldPass = tamper !== "sig" && tamper !== "kid" && targetBranch === branch && !expired &&
            !accessDenied
          const wShouldPass = tamper !== "sig" && tamper !== "kid" && !expired && !accessDenied

          if (Exit.isSuccess(bExit) !== bShouldPass) return false
          if (Exit.isSuccess(wExit) !== wShouldPass) return false

          // Noop verify refuses
          const bnV = yield* Effect.flip(bn.verify(bCap, { branchId: mkBranchId(branch), access: "read" }))
          const wnV = yield* Effect.flip(wn.verify(wCap, { access: "read" }))
          return bnV.code === "unauthorized" && wnV.code === "unauthorized"
        }).pipe(Effect.provide(Layer.mergeAll(TestClock.layer(), syncCryptoLayer))),
      { seedOffset: 31, executions: medExec }
    )
  })

  it("SyncAuth header codec and RPC middleware enforce authentication end-to-end", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "none",
          "validRead",
          "validWrite",
          "badBase64",
          "badJson",
          "badSchema",
          "expired",
          "layerClient"
        ]),
        rawJunk: Schema.String
      })
    )
    await runFuzz(
      arb,
      ({ mode, rawJunk }) =>
        Effect.scoped(
          Effect.gen(function*() {
            const wsLayer = WorkspaceShare.layerHmac(defaultKeyring).pipe(Layer.provide(syncCryptoLayer))
            const engineRun = mkRunId("engine-auth-run")
            const baseLayer = Layer.mergeAll(
              SyncServer.layerHandlers,
              SyncAuth.layer
            ).pipe(
              Layer.provideMerge(SyncServer.layer),
              Layer.provideMerge(wsLayer),
              Layer.provideMerge(TestJournal.layer()),
              Layer.provideMerge(RunCatalog.layerStatic([engineRun])),
              Layer.provideMerge(syncCryptoLayer),
              Layer.provideMerge(TestClock.layer())
            )

            return yield* Effect.gen(function*() {
              const ws = yield* WorkspaceShare.WorkspaceShare
              // Bad encodeCapability fails with invalid_request
              const badEnc = yield* Effect.flip(
                SyncAuth.encodeCapability({ claims: { kid: 1 } } as unknown as WorkspaceShare.WorkspaceCapability)
              )
              if (badEnc.code !== "invalid_request") return false

              if (mode === "badBase64") {
                const err = yield* Effect.flip(SyncAuth.decodeCapability("!!!not-base64!!!"))
                return err.code === "unauthorized"
              }
              if (mode === "badJson") {
                const err = yield* Effect.flip(SyncAuth.decodeCapability(Base64Url.encode("{" + rawJunk.slice(0, 10))))
                return err.code === "unauthorized"
              }
              if (mode === "badSchema") {
                const err = yield* Effect.flip(SyncAuth.decodeCapability(Base64Url.encode(JSON.stringify({ nope: 1 }))))
                return err.code === "unauthorized"
              }

              const readReq: SyncProtocol.ReadRequest = {
                protocolVersion: 1,
                scope: { _tag: "Run", runId: engineRun },
                cursors: [],
                limit: 10
              }

              if (mode === "layerClient") {
                const cap = yield* ws.mint({ capabilityId: "c-lc", access: "write", ttlMs: 5000 })
                const client = yield* RpcTest.makeClient(SyncRpcs.SyncRpcs).pipe(
                  Effect.provide(SyncAuth.layerClient(cap))
                )
                const res = yield* client["Sync.Read"](readReq)
                return res.done === true
              }

              const client = yield* RpcTest.makeClient(SyncRpcs.SyncRpcs)
              if (mode === "none") {
                const err = yield* Effect.flip(client["Sync.Read"](readReq))
                return (err as SyncError.SyncError).code === "unauthorized"
              }

              const cap = yield* ws.mint({
                capabilityId: "c-auth",
                access: mode === "validWrite" ? "write" : "read",
                ttlMs: 1000
              })
              const header = yield* SyncAuth.encodeCapability(cap)
              const decoded = yield* SyncAuth.decodeCapability(header)
              if (decoded.signature !== cap.signature) return false

              if (mode === "expired") {
                yield* TestClock.adjust(1000)
                const err = yield* Effect.flip(
                  RpcClient.withHeaders(client["Sync.Read"](readReq), { [SyncAuth.capabilityHeader]: header })
                )
                return (err as SyncError.SyncError).code === "unauthorized"
              }

              const res = yield* RpcClient.withHeaders(client["Sync.Read"](readReq), {
                [SyncAuth.capabilityHeader]: header
              })
              return res.done === true
            }).pipe(Effect.provide(baseLayer))
          })
        ),
      { seedOffset: 32, executions: simExec }
    )
  })
})

// ============================================================================
// 5. PresenceProtocol, PresenceRoom, PresenceSocket
// ============================================================================
describe("@smthrs/sync PresenceProtocol, PresenceRoom, and PresenceSocket fuzzing", () => {
  it("PresenceProtocol frame codecs, byte limits, close codes, and reconnectDelay invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        state: Schema.NullOr(Schema.String),
        bigState: Schema.Boolean,
        code: Schema.Int.check(Schema.isBetween({ minimum: 999, maximum: 4035 })),
        attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 14 })),
        count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 }))
      })
    )
    await runFuzz(
      arb,
      ({ state, bigState, code, attempt, count }) => {
        const finalExpected = code === PresenceProtocol.CloseCode.left ||
          code === PresenceProtocol.CloseCode.unsupported ||
          code === PresenceProtocol.CloseCode.noAccess ||
          code === PresenceProtocol.CloseCode.tooBig
        if (PresenceProtocol.isFinal(code) !== finalExpected) return false

        const delay = PresenceProtocol.reconnectDelay(attempt)
        if (attempt > PresenceProtocol.reconnect.maxAttempts) {
          if (delay !== undefined) return false
        } else {
          if (
            delay === undefined || delay < PresenceProtocol.reconnect.initialMs ||
            delay > PresenceProtocol.reconnect.maxMs
          ) {
            return false
          }
        }

        const effectiveState = bigState ? "🚀".repeat(300) : state === null ? null : state.slice(0, 120)
        const encodedClient = PresenceProtocol.encodeClientFrame({ type: "state", state: effectiveState })
        const decodedClient = PresenceProtocol.decodeClientFrame(encodedClient)
        const fitsState = effectiveState === null || PresenceWire.fits(effectiveState, PresenceProtocol.maxStateBytes)
        const fitsFrame = PresenceWire.fits(encodedClient, PresenceProtocol.maxFrameBytes)
        if (fitsState && fitsFrame) {
          if (decodedClient === undefined || decodedClient.state !== effectiveState) return false
        } else {
          if (decodedClient !== undefined) return false
        }
        if (PresenceProtocol.decodeClientFrame("not-json") !== undefined) return false
        if (PresenceProtocol.decodeClientFrame("x".repeat(PresenceProtocol.maxFrameBytes + 10)) !== undefined) {
          return false
        }

        const participants: Array<PresenceProtocol.Participant> = Array.from({ length: count }, (_, i) => ({
          id: `id-${i}`,
          principal: `u-${i}`,
          name: `User ${i}`,
          access: i % 2 === 0 ? "write" : "read",
          state: fitsState ? effectiveState : null
        }))
        const encodedServer = PresenceProtocol.encodeServerFrame({ type: "roster", self: "id-0", participants })
        const decodedServer = PresenceProtocol.decodeServerFrame(encodedServer)
        if (
          decodedServer === undefined || decodedServer.self !== "id-0" || decodedServer.participants.length !== count
        ) {
          return false
        }
        if (PresenceProtocol.decodeServerFrame("{}") !== undefined) return false
        return true
      },
      { seedOffset: 40 }
    )
  })

  it("PresenceRoom maintains attachment state, rate limits, send failures, eviction, and room cap", async () => {
    interface Raw {
      attachment: unknown
      readonly sent: Array<string>
      closed: { readonly code: number; readonly reason: string } | undefined
      sendFault: "none" | "fail" | "die" | "throw"
    }
    const makeRoomHost = () => {
      const raws: Array<Raw> = []
      const wrap = (raw: Raw): PresenceRoom.RoomSocket & { readonly raw: Raw } => ({
        raw,
        send: (text) => {
          if (raw.sendFault === "throw") throw new TypeError("send after close")
          if (raw.sendFault === "fail") return Effect.fail("closed")
          if (raw.sendFault === "die") return Effect.die(new Error("boom"))
          raw.sent.push(text)
          return Effect.void
        },
        close: (code, reason) =>
          Effect.sync(() => {
            raw.closed = { code, reason }
          }),
        serializeAttachment: (v) => {
          raw.attachment = structuredClone(v)
        },
        deserializeAttachment: <T>() =>
          (raw.attachment === undefined ? null : structuredClone(raw.attachment)) as T | null
      })
      return {
        raws,
        host: { sockets: Effect.sync(() => raws.map(wrap)) } as PresenceRoom.RoomHost<PresenceRoom.RoomSocket>,
        accept: () => {
          const raw: Raw = { attachment: undefined, sent: [], closed: undefined, sendFault: "none" }
          raws.push(raw)
          return wrap(raw)
        }
      }
    }

    const Action = Schema.Literals([
      "join",
      "joinWithData",
      "joinOversizedData",
      "joinTwice",
      "state",
      "sameState",
      "binary",
      "oversizedFrame",
      "malformed",
      "burst",
      "advanceSec",
      "sendFail",
      "leave",
      "close",
      "evict",
      "unjoined"
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        actions: Schema.Array(Action),
        who: Schema.Literals(["alice", "bob", "carol"]),
        fillFull: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      ({ actions, who, fillFull }) =>
        Effect.gen(function*() {
          const { host, accept } = makeRoomHost()
          const sockets: Array<ReturnType<typeof accept>> = []
          const unjoinedSock = accept()
          unjoinedSock.serializeAttachment({ foreign: true })

          // Unjoined operations
          yield* PresenceRoom.receive(
            host,
            unjoinedSock,
            PresenceProtocol.encodeClientFrame({ type: "state", state: "x" })
          )
          yield* PresenceRoom.leave(host, unjoinedSock)
          yield* PresenceRoom.close(host, unjoinedSock, PresenceProtocol.CloseCode.left)
          if (unjoinedSock.raw.closed?.code !== PresenceProtocol.CloseCode.left) return false

          for (const act of actions.slice(0, 14)) {
            if (act === "join" || act === "joinWithData") {
              const s = accept()
              const outcome = yield* PresenceRoom.join(host, s, {
                principal: who,
                name: who,
                access: "write",
                ...(act === "joinWithData" ? { data: "meta-1" } : {})
              })
              if (outcome !== "joined") return false
              sockets.push(s)
            } else if (act === "joinOversizedData") {
              const s = accept()
              const exit = yield* Effect.exit(
                PresenceRoom.join(host, s, { principal: who, name: who, access: "read", data: "x".repeat(600) })
              )
              if (Exit.isSuccess(exit)) return false
            } else if (act === "joinTwice" && sockets.length > 0) {
              const exit = yield* Effect.exit(
                PresenceRoom.join(host, sockets[0]!, { principal: who, name: who, access: "read" })
              )
              if (Exit.isSuccess(exit)) return false
            } else if (act === "state" && sockets.length > 0) {
              yield* PresenceRoom.receive(
                host,
                sockets[0]!,
                PresenceProtocol.encodeClientFrame({ type: "state", state: `s-${sockets[0]!.raw.sent.length}` })
              )
            } else if (act === "sameState" && sockets.length > 0) {
              const frame = PresenceProtocol.encodeClientFrame({ type: "state", state: "fixed" })
              yield* PresenceRoom.receive(host, sockets[0]!, frame)
              const before = sockets[0]!.raw.sent.length
              yield* PresenceRoom.receive(host, sockets[0]!, frame)
              if (sockets[0]!.raw.sent.length !== before) return false
            } else if (act === "binary" && sockets.length > 0) {
              const s = sockets.pop()!
              yield* PresenceRoom.receive(host, s, new Uint8Array([1, 2, 3]))
              if (s.raw.closed?.code !== PresenceProtocol.CloseCode.unsupported) return false
            } else if (act === "oversizedFrame" && sockets.length > 0) {
              const s = sockets.pop()!
              yield* PresenceRoom.receive(host, s, "x".repeat(PresenceProtocol.maxFrameBytes + 10))
              if (s.raw.closed?.code !== PresenceProtocol.CloseCode.tooBig) return false
            } else if (act === "malformed" && sockets.length > 0) {
              const s = sockets.pop()!
              yield* PresenceRoom.receive(host, s, "{bad-json")
              if (s.raw.closed?.code !== PresenceProtocol.CloseCode.unsupported) return false
            } else if (act === "burst" && sockets.length > 0) {
              const s = sockets.pop()!
              for (let i = 0; i <= PresenceProtocol.maxStatesPerSecond + 1; i++) {
                yield* PresenceRoom.receive(
                  host,
                  s,
                  PresenceProtocol.encodeClientFrame({ type: "state", state: `b-${i}` })
                )
              }
              if (s.raw.closed?.code !== PresenceProtocol.CloseCode.tooFast) return false
            } else if (act === "advanceSec") {
              yield* TestClock.adjust(1_100)
            } else if (act === "sendFail" && sockets.length >= 2) {
              const victim = sockets.pop()!
              victim.raw.sendFault = "throw"
              yield* PresenceRoom.receive(
                host,
                sockets[0]!,
                PresenceProtocol.encodeClientFrame({ type: "state", state: `drop-${sockets.length}` })
              )
              if (victim.raw.attachment !== null) return false
            } else if (act === "leave" && sockets.length > 0) {
              const s = sockets.pop()!
              yield* PresenceRoom.leave(host, s)
            } else if (act === "close" && sockets.length > 0) {
              const s = sockets.pop()!
              yield* PresenceRoom.close(host, s, PresenceProtocol.CloseCode.changed)
              if (s.raw.closed?.code !== PresenceProtocol.CloseCode.changed) return false
            } else if (act === "evict") {
              const count = yield* PresenceRoom.evict(host, who)
              const remaining = (yield* PresenceRoom.connections(host)).filter((c) => c.participant.principal === who)
              if (remaining.length !== 0 || count < 0) return false
              sockets.splice(0, sockets.length, ...sockets.filter((s) => s.raw.attachment !== null))
            }
          }

          if (fillFull) {
            const fullHost = makeRoomHost()
            for (let i = 0; i < PresenceProtocol.maxParticipants; i++) {
              const s = fullHost.accept()
              // Pre-attach directly for speed on 256 participants
              s.serializeAttachment({
                presence: 1,
                id: `p-${i}`,
                principal: `u-${i}`,
                name: `u-${i}`,
                access: "read",
                state: null,
                seq: i + 1,
                windowStart: 0,
                windowFrames: 0
              })
            }
            const extra = fullHost.accept()
            const res = yield* PresenceRoom.join(fullHost.host, extra, {
              principal: "overflow",
              name: "overflow",
              access: "read"
            })
            if (res !== "full" || extra.raw.closed?.code !== PresenceProtocol.CloseCode.full) return false
          }
          return true
        }).pipe(Effect.provide(TestClock.layer())),
      { seedOffset: 41, executions: medExec }
    )
  })

  it("PresenceSocket paces states, reconnects on transient closes, and stops on final or exhausted closes", async () => {
    type Listener = (event: Socket.WebSocketEvent) => void
    class FakeWs implements Socket.WebSocketLike {
      readyState = 1
      readonly sent: Array<string> = []
      closedWith: number | undefined
      private readonly listeners = new Map<string, Set<Listener>>()
      addEventListener(type: string, l: Listener) {
        const s = this.listeners.get(type) ?? new Set()
        s.add(l)
        this.listeners.set(type, s)
      }
      removeEventListener(type: string, l: Listener) {
        this.listeners.get(type)?.delete(l)
      }
      send(data: string | Uint8Array) {
        this.sent.push(String(data))
      }
      close(code?: number) {
        this.closedWith = code
      }
      emit(type: string, ev: Socket.WebSocketEvent) {
        for (const l of this.listeners.get(type) ?? []) l(ev)
      }
      roster(self: string, participants: ReadonlyArray<PresenceProtocol.Participant>) {
        this.emit("message", { data: PresenceProtocol.encodeServerFrame({ type: "roster", self, participants }) })
      }
      drop(code?: number) {
        this.readyState = 3
        this.emit("error", {})
        this.emit("close", code === undefined ? {} : { code })
      }
    }

    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["paceAndReconnect", "finalClose", "constructThrowAndExhaust", "oversizedSet"]),
        closeCode: Schema.Literals([1000, 1003, 1008, 1009, 1006, 1012, 1013, 4029])
      })
    )
    await runFuzz(
      arb,
      ({ mode, closeCode }) =>
        Effect.scoped(
          Effect.gen(function*() {
            const dials = yield* Queue.unbounded<FakeWs>()
            let throwOnDial = mode === "constructThrowAndExhaust"
            const wsLayer = Layer.succeed(Socket.WebSocketConstructor)((_url) => {
              if (throwOnDial) throw new Error("dial refused")
              const s = new FakeWs()
              Queue.offerUnsafe(dials, s)
              return s
            })

            const conn = yield* PresenceSocket.connect("wss://room.test/b1").pipe(Effect.provide(wsLayer))

            if (mode === "constructThrowAndExhaust") {
              const all = yield* conn.status.pipe(
                Stream.takeUntil((s) => s._tag === "Closed"),
                Stream.runCollect
              )
              const last = Array.from(all).at(-1)
              return last?._tag === "Closed" && last.code === 1006
            }

            if (mode === "oversizedSet") {
              const exit = yield* Effect.exit(conn.set("z".repeat(PresenceProtocol.maxStateBytes + 5)))
              return !Exit.isSuccess(exit)
            }

            const first = yield* Queue.take(dials)
            // Non-string and invalid messages are ignored
            first.emit("message", { data: new Uint8Array([1, 2]) })
            first.emit("message", { data: "not-json" })
            const p: PresenceProtocol.Participant = {
              id: "c1",
              principal: "u1",
              name: "Alice",
              access: "write",
              state: null
            }
            first.roster("c1", [p])
            // Wait for open
            const openStatus = yield* conn.status.pipe(
              Stream.filter((s) => s._tag === "Open"),
              Stream.runHead
            )
            if (openStatus._tag !== "Some") return false

            if (mode === "finalClose") {
              const finalCode = PresenceProtocol.isFinal(closeCode) ? closeCode : PresenceProtocol.CloseCode.noAccess
              const watchFiber = yield* conn.status.pipe(
                Stream.takeUntil((s) => s._tag === "Closed"),
                Stream.runCollect,
                Effect.forkChild
              )
              yield* Effect.yieldNow
              first.drop(finalCode)
              const seen = Array.from(yield* Fiber.join(watchFiber))
              return seen.some((s) => s._tag === "Closed" && s.code === finalCode)
            }

            // paceAndReconnect: rapid set paces, identical set skips, transient drop reconnects and resends latest
            yield* conn.set("s1")
            yield* conn.set("s1") // duplicate skipped
            yield* conn.set("s2") // paced
            yield* conn.set("s3") // supersedes s2 while paced
            yield* Effect.sleep(PresenceProtocol.stateIntervalMs + 10)
            const states1 = first.sent.map((x) => PresenceProtocol.decodeClientFrame(x)?.state)
            if (!states1.includes("s1") || states1.at(-1) !== "s3") return false

            const transientCode = PresenceProtocol.isFinal(closeCode) ? undefined : closeCode
            first.drop(transientCode)
            const second = yield* Queue.take(dials)
            second.roster("c2", [p])
            yield* Effect.sleep(PresenceProtocol.stateIntervalMs + 10)
            const states2 = second.sent.map((x) => PresenceProtocol.decodeClientFrame(x)?.state)
            return states2.includes("s3")
          })
        ),
      { seedOffset: 42, executions: simExec, simulation: true }
    )
  })
})

// ============================================================================
// 6. BranchPresence & BranchCommands & BranchServer
// ============================================================================
describe("@smthrs/sync BranchPresence, BranchCommands, and BranchServer fuzzing", () => {
  it("BranchPresence enforces options, validation, ownership, cap, multi-session, sweep, and presenceOn", async () => {
    const WhereSpec = Schema.Literals(["none", "file", "terminal", "step", "branch", "bad"])
    const arb = Arbitrary.schema(
      Schema.Struct({
        whereKind: WhereSpec,
        withCursor: Schema.Boolean,
        badCase: Schema.Literals([
          "none",
          "emptyName",
          "emptySession",
          "badCursorCard",
          "badCursorOffset",
          "nonObjCursor",
          "readOnly",
          "foreignCap",
          "capFull",
          "badOpts"
        ]),
        advanceMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600 })),
        ready: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      ({ whereKind, withCursor, badCase, advanceMs, ready }) =>
        Effect.gen(function*() {
          // Noop & default layer (also covers default sourcesReady after startup grace)
          const noop = BranchPresence.makeNoop()
          const defShare = yield* BranchShare.makeHmac(defaultKeyring)
          const defLayerPres = yield* BranchPresence.BranchPresence.pipe(
            Effect.provide(BranchPresence.layer),
            Effect.provideService(BranchShare.BranchShare, defShare)
          )
          if (defLayerPres.leaseMs !== BranchPresence.defaultLeaseMs) return false
          const defCap = yield* defShare.mint({
            branchId: mkBranchId("b-def"),
            capabilityId: "cd",
            access: "read",
            ttlMs: 60_000
          })
          yield* TestClock.adjust(BranchPresence.defaultLeaseMs)
          if ((yield* defLayerPres.presenceOn({ capability: defCap, branchId: mkBranchId("b-def") })) !== "unknown") {
            return false
          }
          const b1 = mkBranchId("b-pres-1")
          const p1 = mkParticipantId("p1")
          const p2 = mkParticipantId("p2")
          const share = yield* BranchShare.makeHmac(defaultKeyring)
          const cap1 = yield* share.mint({ branchId: b1, capabilityId: "c1", access: "write", ttlMs: 10_000 })
          const cap2 = yield* share.mint({ branchId: b1, capabilityId: "c2", access: "write", ttlMs: 10_000 })
          const capRead = yield* share.mint({ branchId: b1, capabilityId: "cr", access: "read", ttlMs: 10_000 })

          if ((yield* noop.presenceOn({ capability: cap1, branchId: b1 })) !== "unknown") return false
          if ((yield* Effect.flip(noop.list({ capability: cap1, branchId: b1 }))).code !== "unsupported") return false
          if (
            (yield* Effect.flip(noop.leave({ capability: cap1, branchId: b1, participantId: p1 }))).code !==
              "unsupported"
          ) return false
          if (
            (yield* Effect.flip(
              noop.announce({ capability: cap1, branchId: b1, participantId: p1, displayName: "A", cursor: null })
            )).code !== "unsupported"
          ) return false

          if (badCase === "badOpts") {
            const err = yield* Effect.flip(
              BranchPresence.makeMemory({ leaseMs: 0 }).pipe(Effect.provideService(BranchShare.BranchShare, share))
            )
            return err.code === "invalid_request"
          }

          const presence = yield* BranchPresence.makeMemory({
            leaseMs: 300,
            maxParticipants: 2,
            changesCapacity: 16,
            sourcesReady: () => Effect.succeed(ready)
          }).pipe(Effect.provideService(BranchShare.BranchShare, share))

          // During startup grace window (< leaseMs), presenceOn is always "unknown"
          if ((yield* presence.presenceOn({ capability: capRead, branchId: b1 })) !== "unknown") return false

          const where = whereKind === "file"
            ? { kind: "file" as const, path: "a.ts", line: 10 }
            : whereKind === "terminal"
            ? { kind: "terminal" as const, id: "t1" }
            : whereKind === "step"
            ? { kind: "step" as const, label: "build" }
            : whereKind === "branch"
            ? { kind: "branch" as const }
            : undefined

          if (whereKind === "bad") {
            const err = yield* Effect.flip(
              presence.announce({
                capability: cap1,
                branchId: b1,
                participantId: p1,
                displayName: "Alice",
                cursor: null,
                where: { kind: "file", path: "" }
              } as unknown as BranchProtocol.Announcement)
            )
            return err.code === "invalid_request"
          }

          if (badCase === "emptyName") {
            const err = yield* Effect.flip(
              presence.announce({ capability: cap1, branchId: b1, participantId: p1, displayName: "", cursor: null })
            )
            return err.code === "invalid_request"
          }
          if (badCase === "emptySession") {
            const err = yield* Effect.flip(
              presence.announce({
                capability: cap1,
                branchId: b1,
                participantId: p1,
                displayName: "A",
                sessionId: "",
                cursor: null
              })
            )
            return err.code === "invalid_request"
          }
          if (badCase === "badCursorCard") {
            const err = yield* Effect.flip(
              presence.announce({
                capability: cap1,
                branchId: b1,
                participantId: p1,
                displayName: "A",
                cursor: { cardId: "", offset: 0 } as unknown as BranchProtocol.Cursor
              })
            )
            return err.code === "invalid_request"
          }
          if (badCase === "badCursorOffset") {
            const err = yield* Effect.flip(
              presence.announce({
                capability: cap1,
                branchId: b1,
                participantId: p1,
                displayName: "A",
                cursor: { cardId: "c1", offset: -1 } as unknown as BranchProtocol.Cursor
              })
            )
            return err.code === "invalid_request"
          }
          if (badCase === "nonObjCursor") {
            const err = yield* Effect.flip(
              presence.announce({
                capability: cap1,
                branchId: b1,
                participantId: p1,
                displayName: "A",
                cursor: "bad" as unknown as BranchProtocol.Cursor
              })
            )
            return err.code === "invalid_request"
          }
          if (badCase === "readOnly") {
            const err = yield* Effect.flip(
              presence.announce({
                capability: capRead,
                branchId: b1,
                participantId: p1,
                displayName: "A",
                cursor: null
              })
            )
            return err.code === "unauthorized"
          }

          const cursor = withCursor ? new BranchProtocol.Cursor({ cardId: "card-1", offset: 4 }) : null
          const announced = yield* presence.announce({
            capability: cap1,
            branchId: b1,
            participantId: p1,
            displayName: "Alice",
            cursor,
            sessionId: "s1",
            kind: "agent",
            ...(where === undefined ? {} : { where }),
            watching: "w1",
            for_member: "m1",
            agentKind: "smithers",
            via: "cli",
            runId: "r-1"
          })
          if (announced.participantId !== p1) return false

          if (badCase === "foreignCap") {
            const errA = yield* Effect.flip(
              presence.announce({
                capability: cap2,
                branchId: b1,
                participantId: p1,
                sessionId: "s2",
                displayName: "Mallory",
                cursor: null
              })
            )
            const errL = yield* Effect.flip(
              presence.leave({ capability: cap2, branchId: b1, participantId: p1 })
            )
            return errA.code === "unauthorized" && errL.code === "unauthorized"
          }

          // Second session for same capability succeeds
          yield* presence.announce({
            capability: cap1,
            branchId: b1,
            participantId: p1,
            sessionId: "s2",
            displayName: "Alice-2",
            cursor: null
          })

          if (badCase === "capFull") {
            const err = yield* Effect.flip(
              presence.announce({ capability: cap2, branchId: b1, participantId: p2, displayName: "Bob", cursor: null })
            )
            return err.code === "backpressure"
          }

          // Leave one session, then all sessions
          yield* presence.leave({ capability: cap1, branchId: b1, participantId: p1, sessionId: "s1" })
          const afterOne = yield* presence.list({ capability: capRead, branchId: b1 })
          if (afterOne.length !== 1) return false

          // Seed >16 branches to exercise cross-branch sweep wrap-around
          for (let i = 0; i < 18; i++) {
            const bi = mkBranchId(`sweep-${i}`)
            const ci = yield* share.mint({ branchId: bi, capabilityId: `cs-${i}`, access: "write", ttlMs: 10_000 })
            yield* presence.announce({
              capability: ci,
              branchId: bi,
              participantId: p1,
              displayName: "S",
              cursor: null
            })
          }
          if ((yield* presence.retainedBranchCount) < 18) return false

          yield* TestClock.adjust(advanceMs)
          const status = yield* presence.presenceOn({ capability: capRead, branchId: b1 })
          if (advanceMs < 300 || !ready) {
            if (status !== "unknown") return false
          } else {
            if (status !== "empty") return false
            // Re-announce after grace window to observe "present"
            yield* presence.announce({
              capability: cap1,
              branchId: b1,
              participantId: p1,
              displayName: "A",
              cursor: null
            })
            if ((yield* presence.presenceOn({ capability: capRead, branchId: b1 })) !== "present") return false
          }
          // Leave remaining
          yield* presence.leave({ capability: cap1, branchId: b1, participantId: p1 })
          return true
        }).pipe(Effect.provide(Layer.mergeAll(TestClock.layer(), syncCryptoLayer))),
      { seedOffset: 50, executions: medExec }
    )
  })

  it("BranchCommands admits concurrently with idempotency, eviction, conflict recovery, limits, and compaction", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["concurrent", "evictAndConflict", "limits", "compactedWalk", "journalFail", "badOpts"]),
        cmdCount: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 5 }))
      })
    )
    await runFuzz(
      arb,
      ({ mode, cmdCount }) =>
        Effect.scoped(
          Effect.gen(function*() {
            const b1 = mkBranchId("b-cmd-1")
            const p1 = mkParticipantId("p1")
            const share = yield* BranchShare.makeHmac(defaultKeyring)
            const cap = yield* share.mint({ branchId: b1, capabilityId: "c-w", access: "write", ttlMs: 60_000 })

            // Noop & submission helper
            const noop = BranchCommands.makeNoop()
            const subOk = yield* BranchCommands.submission({
              branchId: b1,
              commandId: mkCommandId("c-ok"),
              participantId: p1,
              name: "branch.say",
              args: "hello"
            })
            if ((yield* Effect.flip(noop.submit({ capability: cap, submission: subOk }))).code !== "closed") {
              return false
            }
            const badSub = yield* Effect.flip(
              BranchCommands.submission({ branchId: b1, commandId: mkCommandId("c"), participantId: p1, name: "" })
            )
            if (badSub.code !== "invalid_request") return false

            if (mode === "badOpts") {
              const err = yield* Effect.flip(
                BranchCommands.makeLiveWith({ maxCommandBytes: -1 }).pipe(
                  Effect.provide(TestJournal.layer()),
                  Effect.provideService(BranchShare.BranchShare, share)
                )
              )
              return isSyncCode(err, "invalid_request")
            }

            if (mode === "compactedWalk") {
              // Compacted journal moves cursor forward on first refusal, then returns empty page
              let calls = 0
              const compactedJournal = Journal.layerNoop({
                entries: (req) => {
                  calls += 1
                  if (req.after === undefined) {
                    return Effect.fail(
                      new Journal.JournalError({
                        code: "compacted",
                        message: "compacted",
                        checkpointSeq: mkSeq(5)
                      })
                    )
                  }
                  return Effect.succeed({ entries: [], hasMore: false })
                },
                emitDurableUnfenced: () =>
                  Effect.succeed({ _tag: "Durable", seq: mkSeq(6) } as unknown as Journal.DurableReceipt)
              })
              const r = yield* Effect.flatMap(
                BranchCommands.BranchCommands,
                (cmds) => cmds.submit({ capability: cap, submission: subOk })
              ).pipe(
                Effect.provide(
                  BranchCommands.layerWith({ hydrationLimit: 10 }).pipe(
                    Layer.provide(compactedJournal),
                    Layer.provide(Layer.succeed(BranchShare.BranchShare, share))
                  )
                )
              )
              return r.status === "admitted" && r.seq === 6 && calls >= 2
            }

            if (mode === "journalFail") {
              const failJournal = Journal.layerNoop({
                entries: () => Effect.succeed({ entries: [], hasMore: false }),
                emitDurableUnfenced: () =>
                  Effect.fail(new Journal.JournalError({ code: "idempotency_conflict", message: "conflict" }))
              })
              const cmds = yield* BranchCommands.makeLiveWith({ ledgerCapacity: 2 }).pipe(
                Effect.provide(failJournal),
                Effect.provideService(BranchShare.BranchShare, share)
              )
              const err = yield* Effect.flip(cmds.submit({ capability: cap, submission: subOk }))
              if (err.code !== "unknown") return false

              // Non-conflict journal error (journal_closed -> closed)
              const closedJournal = Journal.layerNoop({
                entries: () => Effect.succeed({ entries: [], hasMore: false }),
                emitDurableUnfenced: () =>
                  Effect.fail(new Journal.JournalError({ code: "journal_closed", message: "closed" }))
              })
              const cmdsClosed = yield* BranchCommands.makeLive.pipe(
                Effect.provide(closedJournal),
                Effect.provideService(BranchShare.BranchShare, share)
              )
              if ((yield* Effect.flip(cmdsClosed.submit({ capability: cap, submission: subOk }))).code !== "closed") {
                return false
              }

              // Durable Duplicate receipt from journal
              const dupJournal = Journal.layerNoop({
                entries: () => Effect.succeed({ entries: [], hasMore: false }),
                emitDurableUnfenced: () =>
                  Effect.succeed({ _tag: "Duplicate", seq: mkSeq(3) } as unknown as Journal.DurableReceipt)
              })
              const cmdsDup = yield* BranchCommands.makeLive.pipe(
                Effect.provide(dupJournal),
                Effect.provideService(BranchShare.BranchShare, share)
              )
              const dupRes = yield* cmdsDup.submit({ capability: cap, submission: subOk })
              return dupRes.status === "duplicate" && dupRes.seq === 3
            }

            const journalCtx = yield* Layer.build(TestJournal.layer())
            const env = Layer.mergeAll(
              Layer.succeedContext(journalCtx),
              Layer.succeed(BranchShare.BranchShare, share)
            )

            if (mode === "limits") {
              const cmdsSmall = yield* BranchCommands.makeLiveWith({
                maxCommandBytes: 120,
                maxFrameBytes: 400
              }).pipe(Effect.provide(env))
              const bigCmd = yield* BranchCommands.submission({
                branchId: b1,
                commandId: mkCommandId("big-1"),
                participantId: p1,
                name: "branch.say",
                args: "a".repeat(200)
              })
              const e1 = yield* Effect.flip(cmdsSmall.submit({ capability: cap, submission: bigCmd }))
              if (e1.code !== "frame_too_large") return false

              const cmdsTightFrame = yield* BranchCommands.makeLiveWith({
                maxCommandBytes: 1000,
                maxFrameBytes: 180
              }).pipe(Effect.provide(env))
              const medCmd = yield* BranchCommands.submission({
                branchId: b1,
                commandId: mkCommandId("med-1"),
                participantId: p1,
                name: "branch.say",
                args: "a".repeat(100)
              })
              const e2 = yield* Effect.flip(cmdsTightFrame.submit({ capability: cap, submission: medCmd }))
              return e2.code === "frame_too_large"
            }

            const cmdsA = yield* BranchCommands.makeLiveWith({
              ledgerCapacity: 2,
              hydrationLimit: 2,
              branchIdleMs: 200
            }).pipe(Effect.provide(env))
            const cmdsB = yield* BranchCommands.makeLiveWith({
              ledgerCapacity: 2,
              hydrationLimit: 2,
              branchIdleMs: 200
            }).pipe(Effect.provide(env))

            if (mode === "concurrent") {
              const raceSubA = yield* BranchCommands.submission({
                branchId: b1,
                commandId: mkCommandId("race-1"),
                participantId: p1,
                name: "branch.say",
                args: "from-a"
              })
              const raceSubB = yield* BranchCommands.submission({
                branchId: b1,
                commandId: mkCommandId("race-1"),
                participantId: p1,
                name: "branch.say",
                args: "from-b"
              })
              const [ra, rb] = yield* Effect.all(
                [
                  cmdsA.submit({ capability: cap, submission: raceSubA }),
                  cmdsB.submit({ capability: cap, submission: raceSubB })
                ],
                { concurrency: "unbounded" }
              )
              if (ra.seq !== rb.seq) return false
              const statuses = [ra.status, rb.status].sort()
              return statuses[0] === "admitted" && statuses[1] === "duplicate"
            }

            // evictAndConflict: fill past ledgerCapacity (2), then resubmit evicted commandId with different args
            const firstId = mkCommandId("evict-0")
            const receipts: Array<BranchProtocol.CommandReceipt> = []
            for (let i = 0; i < cmdCount + 2; i++) {
              const sub = yield* BranchCommands.submission({
                branchId: b1,
                commandId: mkCommandId(`evict-${i}`),
                participantId: p1,
                name: "branch.say",
                args: `msg-${i}`
              })
              receipts.push(yield* cmdsA.submit({ capability: cap, submission: sub }))
            }
            const conflictSub = yield* BranchCommands.submission({
              branchId: b1,
              commandId: firstId,
              participantId: p1,
              name: "branch.say",
              args: "different-payload-triggering-admittedSeq"
            })
            const dup = yield* cmdsA.submit({ capability: cap, submission: conflictSub })
            if (dup.status !== "duplicate" || dup.seq !== receipts[0]!.seq) return false
            // Same payload via fast path / duplicate receipt
            const dup2 = yield* cmdsB.submit({ capability: cap, submission: conflictSub })
            return dup2.status === "duplicate" && dup2.seq === receipts[0]!.seq
          })
        ).pipe(Effect.provide(syncCryptoLayer)),
      { seedOffset: 51, executions: simExec, simulation: true }
    )
  })

  it("BranchServer RPC handlers enforce bootstrap auth, share mint expiry cap, and WatchRoster updates", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        principalKind: Schema.Literals(["anon", "read", "write"]),
        mintAccess: Schema.Literals(["read", "write"]),
        childTtl: Schema.Int.check(Schema.isBetween({ minimum: 600, maximum: 5000 })),
        slowIdsExpire: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      ({ principalKind, mintAccess, childTtl, slowIdsExpire }) =>
        Effect.scoped(
          Effect.gen(function*() {
            const principal: SyncPrincipal.Principal = principalKind === "anon"
              ? SyncPrincipal.anonymous
              : SyncPrincipal.workspace("ws-cap", Number.POSITIVE_INFINITY, principalKind)
            const authLayer = Layer.succeed(SyncRpcs.SyncAuth)((eff) =>
              Effect.provideService(eff, SyncPrincipal.SyncPrincipal, principal)
            )
            let seqNum = 0
            const idsLayer = Layer.succeed(BranchIds.BranchIds)(
              BranchIds.BranchIds.of({
                fresh: Effect.gen(function*() {
                  seqNum += 1
                  if (slowIdsExpire && seqNum >= 3) {
                    yield* Effect.sleep(2000)
                  }
                  return `id-${seqNum}`
                })
              })
            )
            const shareLayer = BranchShare.layerHmac(defaultKeyring).pipe(Layer.provide(syncCryptoLayer))
            const presLayer = BranchPresence.layerWith({ leaseMs: 250, sourcesReady: () => Effect.succeed(true) }).pipe(
              Layer.provide(shareLayer)
            )
            const cmdLayer = BranchCommands.layer.pipe(
              Layer.provide(Layer.mergeAll(TestJournal.layer(), shareLayer))
            )
            const fullLayer = BranchServer.layerHandlers.pipe(
              Layer.provideMerge(Layer.mergeAll(shareLayer, presLayer, cmdLayer, idsLayer, authLayer)),
              Layer.provideMerge(syncCryptoLayer)
            )

            return yield* Effect.gen(function*() {
              const client = yield* RpcTest.makeClient(BranchRpcs.BranchRpcs)
              const createExit = yield* Effect.exit(client["Branch.CreateBranch"]({ ttlMs: 1000 }))
              if (principalKind !== "write") {
                return !Exit.isSuccess(createExit)
              }
              if (!Exit.isSuccess(createExit)) return false
              const { branchId, capability } = createExit.value

              // MintShare
              const mintExit = yield* Effect.exit(
                client["Branch.MintShare"]({ capability, access: mintAccess, ttlMs: childTtl })
              )
              if (slowIdsExpire) {
                return !Exit.isSuccess(mintExit)
              }
              if (!Exit.isSuccess(mintExit)) return false
              const child = mintExit.value
              if (child.claims.expiresAtMs > capability.claims.expiresAtMs) return false

              // Submit, Announce, Roster, PresenceOn, WatchRoster, Leave
              const sub = yield* BranchCommands.submission({
                branchId,
                commandId: mkCommandId("srv-cmd-1"),
                participantId: mkParticipantId("p1"),
                name: "branch.say",
                args: "hi"
              })
              const rec = yield* client["Branch.Submit"]({ capability, submission: sub })
              if (rec.status !== "admitted") return false

              const watchFiber = yield* client["Branch.WatchRoster"]({ capability: child, branchId }).pipe(
                Stream.take(5),
                Stream.runCollect,
                Effect.forkChild
              )
              yield* Effect.sleep(5)
              yield* client["Branch.Announce"]({
                capability,
                branchId,
                participantId: mkParticipantId("p1"),
                displayName: "Alice",
                cursor: new BranchProtocol.Cursor({ cardId: "c1", offset: 2 })
              })
              const roster = yield* client["Branch.Roster"]({ capability: child, branchId })
              if (roster.length !== 1) return false
              const presStatus = yield* client["Branch.PresenceOn"]({ capability: child, branchId })
              if (presStatus !== "unknown" && presStatus !== "present") return false
              yield* Effect.sleep(5)
              yield* client["Branch.Leave"]({ capability, branchId, participantId: mkParticipantId("p1") })
              // Re-announce and let periodic re-list observe lease expiry!
              yield* Effect.sleep(5)
              yield* client["Branch.Announce"]({
                capability,
                branchId,
                participantId: mkParticipantId("p1"),
                displayName: "Alice",
                cursor: null
              })
              const frames = Array.from(yield* Fiber.join(watchFiber))
              return frames.length === 5 && frames[4]!.participants.length === 0
            }).pipe(Effect.provide(fullLayer))
          })
        ),
      { seedOffset: 52, executions: simExec, simulation: true }
    )
  })
})

// ============================================================================
// 7. RunCatalog (static, memory, polling with transient failure & recovery)
// ============================================================================
describe("@smthrs/sync RunCatalog fuzzing", () => {
  it("static, memory, and polling catalogs deduplicate, return fresh arrays, and survive transient read failures", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        initial: Schema.Array(Schema.Literals(["r1", "r2", "r3"])),
        second: Schema.Array(Schema.Literals(["r2", "r3", "r4"])),
        failCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
        badOpt: Schema.Boolean
      })
    )
    await runFuzz(
      arb,
      ({ initial, second, failCount, badOpt }) =>
        Effect.scoped(
          Effect.gen(function*() {
            // Static & Noop
            const staticIds = initial.map(mkRunId)
            const sList1 = yield* Effect.flatMap(RunCatalog.RunCatalog, (c) => c.list).pipe(
              Effect.provide(RunCatalog.layerStatic(staticIds))
            )
            const sList2 = yield* Effect.flatMap(RunCatalog.RunCatalog, (c) => c.list).pipe(
              Effect.provide(RunCatalog.layerStatic(staticIds))
            )
            if (sList1 === sList2 || sList1.length !== new Set(initial).size) return false
            const noopList = yield* Effect.flatMap(RunCatalog.RunCatalog, (c) => c.list).pipe(
              Effect.provide(RunCatalog.layerNoop)
            )
            if (noopList.length !== 0) return false

            if (badOpt) {
              const e1 = yield* Effect.flip(RunCatalog.makeMemory({ changesCapacity: 0 }))
              const e2 = yield* Effect.flip(RunCatalog.makePolling({ read: Effect.succeed([]), intervalMs: 0 }))
              return e1.code === "invalid_request" && e2.code === "invalid_request"
            }

            // Memory
            const mem = yield* RunCatalog.makeMemory({ changesCapacity: 16 })
            const memFiber = yield* mem.catalog.changes.pipe(
              Stream.take(new Set(initial).size),
              Stream.runCollect,
              Effect.forkChild
            )
            yield* Effect.sleep(5)
            for (const r of [...staticIds, ...staticIds]) yield* mem.register(r)
            const memSeen = Array.from(yield* Fiber.join(memFiber))
            if (memSeen.length !== new Set(initial).size) return false
            if ((yield* mem.catalog.list).length !== new Set(initial).size) return false

            // Polling via layerPolling with transient failures + recovery
            let pollNum = 0
            const polling = yield* RunCatalog.RunCatalog.pipe(
              Effect.provide(
                RunCatalog.layerPolling({
                  intervalMs: 50,
                  changesCapacity: 16,
                  read: Effect.suspend(() => {
                    pollNum += 1
                    if (pollNum === 1) return Effect.succeed(staticIds)
                    if (pollNum <= 1 + failCount) return Effect.fail("transient-outage")
                    return Effect.succeed(second.map(mkRunId))
                  })
                })
              )
            )
            // Note: provide(layerPolling) scoped to that step; also run makePolling inside our scope for live ticks
            if ((yield* polling.list).length !== new Set(initial).size) return false
            let pollNum2 = 0
            const livePolling = yield* RunCatalog.makePolling({
              intervalMs: 50,
              changesCapacity: 16,
              read: Effect.suspend(() => {
                pollNum2 += 1
                if (pollNum2 === 1) return Effect.succeed(staticIds)
                if (pollNum2 <= 1 + failCount) return Effect.fail("transient-outage")
                return Effect.succeed(second.map(mkRunId))
              })
            })
            if ((yield* livePolling.list).length !== new Set(initial).size) return false
            // Advance past failures and recovery
            yield* Effect.sleep(50 * (failCount + 2) + 20)
            const after = yield* livePolling.list
            return after.length === new Set(second).size
          })
        ),
      { seedOffset: 60, executions: simExec, simulation: true }
    )
  })
})

// ============================================================================
// 8. SyncServer (snapshot, read paging/fair-share/budget/rewind/compaction, subscribe run & workspace)
// ============================================================================
describe("@smthrs/sync SyncServer fuzzing", () => {
  it("SyncServer read fair-share paging, byte budget truncation, oversize refusal, auth, snapshot, and rewind", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "fairShare",
          "byteTruncate",
          "oversize",
          "authAndBranch",
          "snapshot",
          "compacted",
          "rewind",
          "badInputs"
        ]),
        limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        nRuns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))
      })
    )
    await runFuzz(
      arb,
      ({ mode, limit, nRuns }) =>
        Effect.scoped(
          Effect.gen(function*() {
            // Noop server
            const noop = SyncServer.makeNoop()
            if (
              (yield* noop.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit: 1 })).done !==
                true
            ) {
              return false
            }
            const noopSnap = yield* Effect.flip(
              noop.snapshot({
                protocolVersion: 1,
                runId: mkRunId("r1"),
                lineageId: "l1",
                projection: "p1",
                projectionVersion: 1,
                atLeastSeq: mkSeq(0)
              })
            )
            if (noopSnap.code !== "not_found") return false
            const noopFrames = Array.from(
              yield* Stream.runCollect(
                noop.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 1 })
              )
            )
            if (noopFrames[0]?._tag !== "Closed") return false

            const journalCtx = yield* Layer.build(TestJournal.layer())
            const journal = yield* Effect.provide(Journal.Journal, journalCtx)
            const mem = yield* RunCatalog.makeMemory()
            const share = yield* BranchShare.makeHmac(defaultKeyring)

            if (mode === "badInputs") {
              const badOpt = yield* Effect.flip(
                SyncServer.makeLiveWith({ maxFrameBytes: 0 }).pipe(
                  Effect.provideService(Journal.Journal, journal),
                  Effect.provideService(RunCatalog.RunCatalog, mem.catalog)
                )
              )
              if (badOpt.code !== "invalid_request") return false
              const srv = yield* SyncServer.makeLive.pipe(
                Effect.provideService(Journal.Journal, journal),
                Effect.provideService(RunCatalog.RunCatalog, mem.catalog)
              )
              const r1 = mkRunId("r-bad")
              const eVer = yield* Effect.flip(
                srv.read({ protocolVersion: 99, scope: { _tag: "Run", runId: r1 }, cursors: [], limit: 1 })
              )
              const eDup = yield* Effect.flip(
                srv.read({
                  protocolVersion: 1,
                  scope: { _tag: "Run", runId: r1 },
                  cursors: [
                    { runId: r1, afterSeq: mkSeq(0) },
                    { runId: r1, afterSeq: mkSeq(1) }
                  ],
                  limit: 1
                })
              )
              const eLim = yield* Effect.flip(
                srv.read({ protocolVersion: 1, scope: { _tag: "Run", runId: r1 }, cursors: [], limit: 0 })
              )
              return eVer.code === "protocol_violation" && eDup.code === "invalid_request" &&
                eLim.code === "invalid_request"
            }

            if (mode === "snapshot") {
              const r1 = mkRunId("r-snap")
              const snapReq: SyncProtocol.SnapshotRequest = {
                protocolVersion: 1,
                runId: r1,
                lineageId: "lin",
                projection: "proj",
                projectionVersion: 1,
                atLeastSeq: mkSeq(2)
              }
              const srvNoSnap = yield* SyncServer.makeLive.pipe(
                Effect.provideService(Journal.Journal, journal),
                Effect.provideService(RunCatalog.RunCatalog, mem.catalog)
              )
              const eMissing = yield* Effect.flip(
                srvNoSnap.snapshot(snapReq).pipe(Effect.provide(SyncPrincipal.layerWorkspace("w1")))
              )
              if (eMissing.code !== "not_found") return false

              // Failing SnapshotSource folds to not_found
              const srvFailSnap = yield* SyncServer.makeLive.pipe(
                Effect.provideService(Journal.Journal, journal),
                Effect.provideService(RunCatalog.RunCatalog, mem.catalog),
                Effect.provideService(SyncServer.SnapshotSource, {
                  read: () => Effect.fail(new SyncError.SyncError({ code: "unknown", message: "db down" }))
                })
              )
              const eFail = yield* Effect.flip(
                srvFailSnap.snapshot(snapReq).pipe(Effect.provide(SyncPrincipal.layerWorkspace("w1")))
              )
              if (eFail.code !== "not_found") return false

              // Working SnapshotSource + expired principal check
              const srvOkSnap = yield* SyncServer.makeLive.pipe(
                Effect.provideService(Journal.Journal, journal),
                Effect.provideService(RunCatalog.RunCatalog, mem.catalog),
                Effect.provideService(SyncServer.SnapshotSource, {
                  read: (req) =>
                    Effect.succeed({
                      protocolVersion: 1,
                      runId: req.runId,
                      lineageId: req.lineageId,
                      projection: req.projection,
                      projectionVersion: req.projectionVersion,
                      seq: mkSeq(3),
                      state: { count: 3 }
                    })
                })
              )
              // Exercise SyncServer.layerHandlers for Sync.Snapshot too
              const rpcClient = yield* RpcTest.makeClient(SyncRpcs.SyncRpcs).pipe(
                Effect.provide(SyncServer.layerHandlers),
                Effect.provideService(SyncServer.SyncServer, srvOkSnap),
                Effect.provide(TestSync.layerTrustAllAsOwner)
              )
              const ok = yield* rpcClient["Sync.Snapshot"](snapReq)
              if (ok.seq !== 3) return false
              // Also exercise SyncServer.layerHandlers Sync.Subscribe + TestSync.layerNoop
              const noopRpc = yield* RpcTest.makeClient(SyncRpcs.SyncRpcs).pipe(
                Effect.provide(SyncServer.layerHandlers),
                Effect.provide(TestSync.layerNoop)
              )
              const noopRead = yield* noopRpc["Sync.Read"]({
                protocolVersion: 1,
                scope: { _tag: "Workspace" },
                cursors: [],
                limit: 1
              })
              const noopSubFrames = Array.from(
                yield* Stream.runCollect(
                  noopRpc["Sync.Subscribe"]({
                    protocolVersion: 1,
                    scope: { _tag: "Workspace" },
                    cursors: [],
                    credit: 1
                  })
                )
              )
              if (!noopRead.done || noopSubFrames[0]?._tag !== "Closed") return false
              const expErr = yield* Effect.flip(
                srvOkSnap.snapshot(snapReq).pipe(
                  Effect.provideService(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("w-exp", 0, "read"))
                )
              )
              // Slow snapshot provider whose credential expires mid-flight
              const srvSlowSnap = yield* SyncServer.makeLive.pipe(
                Effect.provideService(Journal.Journal, journal),
                Effect.provideService(RunCatalog.RunCatalog, mem.catalog),
                Effect.provideService(SyncServer.SnapshotSource, {
                  read: (req) =>
                    TestClock.adjust(200).pipe(
                      Effect.as({
                        protocolVersion: 1,
                        runId: req.runId,
                        lineageId: req.lineageId,
                        projection: req.projection,
                        projectionVersion: req.projectionVersion,
                        seq: mkSeq(3),
                        state: {}
                      })
                    )
                })
              )
              const nowMs = yield* Clock.currentTimeMillis
              const slowExp = yield* Effect.flip(
                srvSlowSnap.snapshot(snapReq).pipe(
                  Effect.provideService(
                    SyncPrincipal.SyncPrincipal,
                    SyncPrincipal.workspace("w-slow", nowMs + 100, "read")
                  )
                )
              )
              // Read with already-expired principal
              const readExp = yield* Effect.flip(
                srvOkSnap
                  .read({ protocolVersion: 1, scope: { _tag: "Run", runId: r1 }, cursors: [], limit: 1 })
                  .pipe(Effect.provideService(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("w-exp", 0, "read")))
              )
              return expErr.code === "unauthorized" && slowExp.code === "unauthorized" &&
                readExp.code === "unauthorized"
            }

            if (mode === "compacted") {
              const r1 = mkRunId("r-comp")
              const compJournal = Journal.layerNoop({
                entries: () =>
                  Effect.fail(
                    new Journal.JournalError({ code: "compacted", message: "gone", checkpointSeq: mkSeq(10) })
                  )
              })
              const srv = yield* SyncServer.makeLive.pipe(
                Effect.provide(compJournal),
                Effect.provideService(RunCatalog.RunCatalog, mem.catalog)
              )
              const err = yield* Effect.flip(
                srv.read({ protocolVersion: 1, scope: { _tag: "Run", runId: r1 }, cursors: [], limit: 5 }).pipe(
                  Effect.provide(SyncPrincipal.layerWorkspace("w1"))
                )
              )
              return err.code === "compacted" && err.resync?.checkpointSeq === 10 && err.resync?.runId === r1
            }

            if (mode === "rewind") {
              const r1 = mkRunId("r-rew")
              let gen = 1
              const rewJournal = Journal.layerNoop({
                generation: () => Effect.sync(() => ({ generation: gen, afterSeq: 0 })),
                entries: () => Effect.succeed({ entries: [], hasMore: false })
              })
              const srv = yield* SyncServer.makeLive.pipe(
                Effect.provide(rewJournal),
                Effect.provideService(RunCatalog.RunCatalog, mem.catalog)
              )
              const err = yield* Effect.flip(
                srv.read({
                  protocolVersion: 1,
                  scope: { _tag: "Run", runId: r1 },
                  cursors: [{ runId: r1, afterSeq: mkSeq(5), generation: 0 }],
                  limit: 5
                }).pipe(Effect.provide(SyncPrincipal.layerWorkspace("w1")))
              )
              return err.code === "lineage_changed" && err.rewind?.generation === 1
            }

            // Seed runs in journal
            const runIds: Array<JournalEvent.RunId> = []
            for (let i = 0; i < nRuns; i++) {
              const r = mkRunId(`run-${i}`)
              runIds.push(r)
              yield* mem.register(r)
              for (let s = 0; s < 4; s++) {
                yield* journal.emitDurableUnfenced(
                  new JournalEvent.Input({
                    runId: r,
                    sourceId: mkSourceId("src"),
                    sourceSeq: mkSourceSeq(s),
                    eventType: "ev",
                    payload: { i, s, pad: mode === "oversize" ? "x".repeat(400) : "p".repeat(60) },
                    meta: null
                  })
                )
              }
            }

            if (mode === "authAndBranch") {
              const b1 = mkBranchId("b-sec-1")
              const b2 = mkBranchId("b-sec-2")
              const br1 = BranchProtocol.branchRunId(b1)
              const br2 = BranchProtocol.branchRunId(b2)
              yield* mem.register(br1)
              yield* mem.register(br2)
              const cap1 = yield* share.mint({ branchId: b1, capabilityId: "c1", access: "read", ttlMs: 5000 })
              const srv = yield* SyncServer.makeLive.pipe(
                Effect.provideService(Journal.Journal, journal),
                Effect.provideService(RunCatalog.RunCatalog, mem.catalog),
                Effect.provideService(BranchShare.BranchShare, share)
              )
              // Anonymous refused on engine run, workspace, and branch without cap
              if (
                (yield* Effect.flip(
                  srv.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit: 5 })
                )).code !== "unauthorized"
              ) return false
              if (
                (yield* Effect.flip(
                  srv.read({ protocolVersion: 1, scope: { _tag: "Run", runId: br1 }, cursors: [], limit: 5 })
                )).code !== "unauthorized"
              ) return false
              // Valid branch cap works anonymously for br1, refused for br2
              const okB = yield* srv.read({
                protocolVersion: 1,
                scope: { _tag: "Run", runId: br1 },
                cursors: [],
                limit: 5,
                capability: cap1
              })
              if (!okB.done) return false
              const badB = yield* Effect.flip(
                srv.read({
                  protocolVersion: 1,
                  scope: { _tag: "Run", runId: br2 },
                  cursors: [],
                  limit: 5,
                  capability: cap1
                })
              )
              if (badB.code !== "unauthorized") return false
              // Workspace read with principal + cap1 skips br2 silently and admits br1
              const wsRes = yield* srv.read({
                protocolVersion: 1,
                scope: { _tag: "Workspace" },
                cursors: [],
                limit: 20,
                capability: cap1
              }).pipe(Effect.provide(SyncPrincipal.layerWorkspace("w1")))
              return wsRes.entries.every((e) => e.runId !== br2)
            }

            const maxFrameBytes = mode === "oversize" ? 100 : mode === "byteTruncate" ? 320 : 100_000
            const srv = yield* SyncServer.SyncServer.pipe(
              Effect.provide(SyncServer.layerWith({ maxFrameBytes })),
              Effect.provideService(Journal.Journal, journal),
              Effect.provideService(RunCatalog.RunCatalog, mem.catalog)
            )

            if (mode === "oversize") {
              const wsPage = yield* srv.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit })
                .pipe(
                  Effect.provide(SyncPrincipal.layerWorkspace("w1"))
                )
              if (wsPage.entries.length !== 0 || !wsPage.done) return false
              const err = yield* Effect.flip(
                srv.read({ protocolVersion: 1, scope: { _tag: "Run", runId: runIds[0]! }, cursors: [], limit }).pipe(
                  Effect.provide(SyncPrincipal.layerWorkspace("w1"))
                )
              )
              return err.code === "frame_too_large"
            }

            // Page until done and verify every entry across all runs is delivered exactly once
            let cursors: SyncProtocol.WorkspaceCursor = []
            const seen = new Map<string, Array<number>>()
            for (let round = 0; round < 30; round++) {
              const page = yield* srv.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors, limit }).pipe(
                Effect.provide(SyncPrincipal.layerWorkspace("w1"))
              )
              for (const e of page.entries) {
                const arr = seen.get(e.runId) ?? []
                arr.push(e.seq)
                seen.set(e.runId, arr)
              }
              cursors = page.cursors
              if (page.done) break
            }
            for (const r of runIds) {
              const arr = seen.get(r) ?? []
              if (arr.length !== 4) return false
              for (let i = 0; i < 4; i++) if (arr[i] !== i) return false
            }
            return true
          })
        ).pipe(Effect.provide(Layer.mergeAll(TestClock.layer(), syncCryptoLayer))),
      { seedOffset: 70, executions: medExec }
    )
  })

  it("SyncServer subscribe handles Run and Workspace streams, dirty wakes, reconciliation, and expiry", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "runLive",
          "runExpiry",
          "workspaceLive",
          "workspaceBranchDeadline",
          "workspaceBacklogAndRemoval",
          "runFrameTooLarge",
          "runNoGeneration"
        ]),
        nAppends: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }))
      })
    )
    await runFuzz(
      arb,
      ({ mode, nAppends }) =>
        Effect.scoped(
          Effect.gen(function*() {
            const journalCtx = yield* Layer.build(TestJournal.layer())
            const journal = yield* Effect.provide(Journal.Journal, journalCtx)
            const mem = yield* RunCatalog.makeMemory()
            const share = yield* BranchShare.makeHmac(defaultKeyring)
            const r1 = mkRunId("sub-r1")
            const r2 = mkRunId("sub-r2")
            yield* mem.register(r1)

            if (mode === "runNoGeneration") {
              // Journal without optional `generation` method hits fast path
              const noGenJournal = Journal.layerNoop({
                stream: () => Stream.succeed(mkJournalEntry(r1, 0))
              })
              const srvNoGen = yield* SyncServer.makeLive.pipe(
                Effect.provide(noGenJournal),
                Effect.provideService(RunCatalog.RunCatalog, mem.catalog)
              )
              const frames = Array.from(
                yield* Stream.runCollect(
                  srvNoGen
                    .subscribe({
                      protocolVersion: 1,
                      scope: { _tag: "Run", runId: r1 },
                      cursors: [],
                      credit: 1
                    })
                    .pipe(Stream.provideService(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("w1")))
                )
              )
              return frames.length === 1 && frames[0]?._tag === "Entries"
            }

            if (mode === "workspaceBacklogAndRemoval") {
              // Exercises hasMore dirty wake + interval reconcile removing an excluded branch
              const bExcl = BranchProtocol.branchRunId(mkBranchId("b-drop-excl"))
              let includeExcl = true
              let pageCall = 0
              const dynCatalog: RunCatalog.Service = {
                list: Effect.sync(() => (includeExcl ? [r1, bExcl] : [r1])),
                changes: Stream.empty
              }
              const backlogJournal = Journal.layerNoop({
                entries: (req) => {
                  pageCall += 1
                  if (req.after === undefined) {
                    return Effect.succeed({ entries: [mkJournalEntry(r1, 0)], hasMore: true })
                  }
                  if (req.after === 0) {
                    includeExcl = false
                    return Effect.succeed({ entries: [mkJournalEntry(r1, 1)], hasMore: false })
                  }
                  return Effect.succeed({ entries: [], hasMore: false })
                }
              })
              const srvDyn = yield* SyncServer.makeLiveWith({ tailIntervalMs: 30 }).pipe(
                Effect.provide(backlogJournal),
                Effect.provideService(RunCatalog.RunCatalog, dynCatalog),
                Effect.provideService(BranchShare.BranchShare, share)
              )
              const frames = Array.from(
                yield* Stream.runCollect(
                  srvDyn
                    .subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 2 })
                    .pipe(Stream.provideService(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("w1")))
                )
              )
              return frames.length === 2 && pageCall >= 2
            }

            const srv = yield* SyncServer.makeLiveWith({
              maxFrameBytes: mode === "runFrameTooLarge" ? 100 : 100_000,
              concurrency: 2,
              tailIntervalMs: 80
            }).pipe(
              Effect.provideService(Journal.Journal, journal),
              Effect.provideService(RunCatalog.RunCatalog, mem.catalog),
              Effect.provideService(BranchShare.BranchShare, share)
            )

            const emit = (runId: JournalEvent.RunId, seq: number, pad = "ok") =>
              journal.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId,
                  sourceId: mkSourceId("s"),
                  sourceSeq: mkSourceSeq(seq),
                  eventType: "ev",
                  payload: { seq, pad },
                  meta: null
                })
              )

            if (mode === "runFrameTooLarge") {
              yield* emit(r1, 0, "x".repeat(300))
              const err = yield* Effect.flip(
                Stream.runCollect(
                  srv.subscribe({ protocolVersion: 1, scope: { _tag: "Run", runId: r1 }, cursors: [], credit: 5 }).pipe(
                    Stream.provideService(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("w1"))
                  )
                )
              )
              return err.code === "frame_too_large"
            }

            if (mode === "runExpiry") {
              const now = yield* Clock.currentTimeMillis
              const stream = srv.subscribe({
                protocolVersion: 1,
                scope: { _tag: "Run", runId: r1 },
                cursors: [],
                credit: 10
              }).pipe(
                Stream.provideService(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("w-exp", now + 100, "read"))
              )
              const err = yield* Effect.flip(Stream.runCollect(stream))
              return err.code === "unauthorized"
            }

            if (mode === "runLive") {
              const fiber = yield* srv.subscribe({
                protocolVersion: 1,
                scope: { _tag: "Run", runId: r1 },
                cursors: [],
                credit: nAppends
              }).pipe(
                Stream.provideService(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("w1")),
                Stream.runCollect,
                Effect.forkChild
              )
              yield* Effect.sleep(5)
              for (let i = 0; i < nAppends; i++) {
                yield* emit(r1, i)
              }
              const frames = Array.from(yield* Fiber.join(fiber))
              return frames.length === nAppends && frames.every((f) => f._tag === "Entries")
            }

            if (mode === "workspaceBranchDeadline") {
              // Discover a branch with shorter expiry mid-subscription, lowering workspace deadline
              const b1 = mkBranchId("b-dl")
              const b2 = mkBranchId("b-excl")
              const br1 = BranchProtocol.branchRunId(b1)
              const br2 = BranchProtocol.branchRunId(b2)
              const cap1 = yield* share.mint({ branchId: b1, capabilityId: "c-dl", access: "read", ttlMs: 120 })
              const fiber = yield* srv.subscribe({
                protocolVersion: 1,
                scope: { _tag: "Workspace" },
                cursors: [],
                credit: 50,
                capability: cap1
              }).pipe(
                Stream.provideService(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("w-inf")),
                Stream.runCollect,
                Effect.exit,
                Effect.forkChild
              )
              yield* Effect.sleep(5)
              yield* mem.register(br2) // unauthorized -> excluded
              yield* mem.register(br1) // authorized -> lowers deadline to +120ms
              const exit = yield* Fiber.join(fiber)
              return !Exit.isSuccess(exit)
            }

            // workspaceLive: initial run + dirty appends + newly announced run r2
            const fiber = yield* srv.subscribe({
              protocolVersion: 1,
              scope: { _tag: "Workspace" },
              cursors: [],
              credit: nAppends + 1
            }).pipe(
              Stream.provideService(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("w1")),
              Stream.runCollect,
              Effect.forkChild
            )
            yield* Effect.sleep(5)
            for (let i = 0; i < nAppends; i++) yield* emit(r1, i)
            yield* mem.register(r2)
            yield* emit(r2, 0)
            const frames = Array.from(yield* Fiber.join(fiber))
            return frames.length === nAppends + 1
          })
        ).pipe(Effect.provide(syncCryptoLayer)),
      { seedOffset: 71, executions: simExec, simulation: true }
    )
  })
})

// ============================================================================
// 9. SyncClient, TestSocket, and TestSync
// ============================================================================
describe("@smthrs/sync SyncClient, TestSocket, and TestSync fuzzing", () => {
  type RawClient = Parameters<typeof SyncClient.make>[0]["client"]
  const makeMockClient = (
    impl: Partial<{
      readonly snapshot: (req: SyncProtocol.SnapshotRequest) => Effect.Effect<unknown, unknown>
      readonly read: (req: SyncProtocol.ReadRequest) => Effect.Effect<unknown, unknown>
      readonly subscribe: (req: SyncProtocol.SubscribeRequest) => Stream.Stream<unknown, unknown>
    }>,
    opts?: SyncClient.Options
  ) => {
    const raw = {
      "Sync.Snapshot": impl.snapshot ??
        (() => Effect.fail(new SyncError.SyncError({ code: "not_found", message: "none" }))),
      "Sync.Read": impl.read ?? (() => Effect.succeed({ entries: [], cursors: [], done: true })),
      "Sync.Subscribe": impl.subscribe ?? (() => Stream.succeed({ _tag: "Closed" }))
    } as unknown as RawClient
    return opts === undefined ? SyncClient.make({ client: raw }) : SyncClient.makeWith({ ...opts, client: raw })
  }

  it("SyncClient options, snapshot, and bootstrap page validation fuzzing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals([
          "noopAndOpts",
          "snapshotOkAndErrors",
          "pageMissingGen",
          "pageOutOfScope",
          "pageBelowCursor",
          "pageNonMonotonic",
          "pageMissingRunCursor",
          "pageDupCursor",
          "pageOversized",
          "pageEmptyIncomplete",
          "pageLineageChanged",
          "multiPageBootstrap",
          "nonErrorTransport"
        ])
      })
    )
    await runFuzz(
      arb,
      ({ scenario }) =>
        Effect.gen(function*() {
          const r1 = mkRunId("c-r1")
          const r2 = mkRunId("c-r2")
          const scope: SyncProtocol.Scope = { _tag: "Run", runId: r1 }

          if (scenario === "noopAndOpts") {
            const noop = SyncClient.makeNoop()
            const p = yield* noop.progress
            if (p.delivered.length !== 0 || p.applied.length !== 0) return false
            if (
              !isSyncCode(
                yield* Effect.flip(noop.snapshot({
                  protocolVersion: 1,
                  runId: r1,
                  lineageId: "l",
                  projection: "p",
                  projectionVersion: 1,
                  atLeastSeq: mkSeq(0)
                })),
                "closed"
              )
            ) return false
            if (
              !isSyncCode(yield* Effect.flip(Stream.runDrain(noop.subscribe({ scope, cursors: [] }))), "closed")
            ) return false
            const e1 = yield* Effect.flip(makeMockClient({}, { maxFrameBytes: 0 }))
            const e2 = yield* Effect.flip(makeMockClient({}, { bootstrapLimit: SyncProtocol.maxReadLimit + 1 }))
            const c = yield* makeMockClient({})
            const eDup = yield* Effect.flip(
              Stream.runDrain(
                c.subscribe({
                  scope,
                  cursors: [
                    { runId: r1, afterSeq: mkSeq(0) },
                    { runId: r1, afterSeq: mkSeq(1) }
                  ]
                })
              )
            )
            const eCred = yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [], credit: 0 })))
            return (
              e1.code === "invalid_request" &&
              e2.code === "invalid_request" &&
              isSyncCode(eDup, "invalid_request") &&
              isSyncCode(eCred, "invalid_request")
            )
          }

          if (scenario === "snapshotOkAndErrors") {
            const snapReq: SyncProtocol.SnapshotRequest = {
              protocolVersion: 1,
              runId: r1,
              lineageId: "l",
              projection: "p",
              projectionVersion: 1,
              atLeastSeq: mkSeq(1)
            }
            const cOk = yield* makeMockClient({
              snapshot: (req) =>
                Effect.succeed({
                  protocolVersion: 1,
                  runId: req.runId,
                  lineageId: req.lineageId,
                  projection: req.projection,
                  projectionVersion: req.projectionVersion,
                  seq: mkSeq(2),
                  state: { v: 2 }
                })
            })
            if ((yield* cOk.snapshot(snapReq)).seq !== 2) return false

            const cDefect = yield* makeMockClient({
              snapshot: () =>
                Effect.fail(
                  new RpcClientError.RpcClientError({
                    reason: new RpcClientError.RpcClientDefect({ message: "proto", cause: new Error("proto") })
                  })
                )
            })
            if ((yield* Effect.flip(cDefect.snapshot(snapReq))).code !== "protocol_violation") return false

            const cDieSchema = yield* makeMockClient({
              snapshot: () =>
                Effect.sync(() => {
                  Schema.decodeUnknownSync(Schema.Number)("not-a-number")
                })
            })
            return (yield* Effect.flip(cDieSchema.snapshot(snapReq))).code === "decode_failed"
          }

          if (scenario === "nonErrorTransport") {
            const c = yield* makeMockClient({ read: () => Effect.fail({ raw: "disconnect" }) })
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "transport_failed"
            )
          }

          if (scenario === "multiPageBootstrap") {
            let page = 0
            const fakeCap = new BranchProtocol.ShareCapability({
              claims: new BranchProtocol.ShareClaims({
                kid: "k1",
                branchId: mkBranchId("b1"),
                capabilityId: "c1",
                access: "read",
                issuedAtMs: 0,
                expiresAtMs: 1000
              }),
              signature: "0".repeat(64)
            })
            const c = yield* makeMockClient({
              read: () => {
                page += 1
                if (page === 1) {
                  return Effect.succeed({
                    entries: [mkJournalEntry(r2, 0), mkJournalEntry(r1, 0)],
                    cursors: [
                      { runId: r2, afterSeq: mkSeq(0), generation: 0 },
                      { runId: r1, afterSeq: mkSeq(0), generation: 0 }
                    ],
                    done: false
                  })
                }
                if (page === 2) {
                  return Effect.succeed({
                    entries: [mkJournalEntry(r1, 1)],
                    cursors: [{ runId: r1, afterSeq: mkSeq(1), generation: 0 }],
                    done: true
                  })
                }
                return Effect.succeed({ entries: [], cursors: [], done: true })
              }
            })
            const seen: Array<number> = []
            const err = yield* Effect.flip(
              c.subscribe({ scope: { _tag: "Workspace" }, cursors: [], capability: fakeCap }).pipe(
                Stream.tap((e) =>
                  Effect.sync(() => {
                    seen.push(e.seq)
                  })
                ),
                Stream.runDrain
              )
            )
            // Second subscription behind shared progress gets fast-forwarded
            const err2 = yield* Effect.flip(
              Stream.runDrain(
                c.subscribe({
                  scope: { _tag: "Run", runId: r1 },
                  cursors: [{ runId: r1, afterSeq: mkSeq(0), generation: 0 }]
                })
              )
            )
            const prog = yield* c.progress
            return (
              isSyncCode(err, "closed") &&
              isSyncCode(err2, "closed") &&
              seen.length === 3 &&
              prog.delivered.length === 2
            )
          }

          if (scenario === "pageMissingGen") {
            const c = yield* makeMockClient({
              read: () =>
                Effect.succeed({
                  entries: [mkJournalEntry(r1, 0)],
                  cursors: [{ runId: r1, afterSeq: mkSeq(0) }],
                  done: true
                })
            })
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "protocol_violation"
            )
          }
          if (scenario === "pageOutOfScope") {
            const c = yield* makeMockClient({
              read: () =>
                Effect.succeed({
                  entries: [mkJournalEntry(r2, 0)],
                  cursors: [{ runId: r2, afterSeq: mkSeq(0), generation: 0 }],
                  done: true
                })
            })
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "protocol_violation"
            )
          }
          if (scenario === "pageBelowCursor") {
            const c = yield* makeMockClient({
              read: () =>
                Effect.succeed({
                  entries: [mkJournalEntry(r1, 0)],
                  cursors: [{ runId: r1, afterSeq: mkSeq(0), generation: 0 }],
                  done: true
                })
            })
            return isSyncCode(
              yield* Effect.flip(
                Stream.runDrain(c.subscribe({ scope, cursors: [{ runId: r1, afterSeq: mkSeq(1), generation: 0 }] }))
              ),
              "protocol_violation"
            )
          }
          if (scenario === "pageNonMonotonic") {
            const c = yield* makeMockClient({
              read: () =>
                Effect.succeed({
                  entries: [mkJournalEntry(r1, 2), mkJournalEntry(r1, 1)],
                  cursors: [{ runId: r1, afterSeq: mkSeq(2), generation: 0 }],
                  done: true
                })
            })
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "protocol_violation"
            )
          }
          if (scenario === "pageMissingRunCursor") {
            const c = yield* makeMockClient({
              read: () => Effect.succeed({ entries: [mkJournalEntry(r1, 0)], cursors: [], done: true })
            })
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "protocol_violation"
            )
          }
          if (scenario === "pageDupCursor") {
            const c = yield* makeMockClient({
              read: () =>
                Effect.succeed({
                  entries: [mkJournalEntry(r1, 0)],
                  cursors: [
                    { runId: r1, afterSeq: mkSeq(0), generation: 0 },
                    { runId: r1, afterSeq: mkSeq(0), generation: 0 }
                  ],
                  done: true
                })
            })
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "protocol_violation"
            )
          }
          if (scenario === "pageOversized") {
            const c = yield* makeMockClient(
              {
                read: () =>
                  Effect.succeed({
                    entries: [mkJournalEntry(r1, 0, { payload: "x".repeat(200) })],
                    cursors: [{ runId: r1, afterSeq: mkSeq(0), generation: 0 }],
                    done: true
                  })
              },
              { maxFrameBytes: 50 }
            )
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "frame_too_large"
            )
          }
          if (scenario === "pageEmptyIncomplete") {
            const c = yield* makeMockClient({
              read: () => Effect.succeed({ entries: [], cursors: [], done: false })
            })
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "protocol_violation"
            )
          }
          const c = yield* makeMockClient({
            read: () =>
              Effect.succeed({
                entries: [],
                cursors: [{ runId: r1, afterSeq: mkSeq(0), generation: 2 }],
                done: true
              })
          })
          return isSyncCode(
            yield* Effect.flip(
              Stream.runDrain(c.subscribe({ scope, cursors: [{ runId: r1, afterSeq: mkSeq(0), generation: 1 }] }))
            ),
            "lineage_changed"
          )
        }),
      { seedOffset: 80, executions: fastExec }
    )
  })

  it("SyncClient live frame validation, apply, onResync, and transport retry fuzzing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals([
          "frameMissingGen",
          "frameOutOfScope",
          "frameOversized",
          "frameForeignRun",
          "frameNonMonotonic",
          "frameOutsideInterval",
          "frameLineageChanged",
          "frameGap",
          "frameTrailingHole",
          "frameClosed",
          "frameEmptyWindow",
          "applyAndFail",
          "resyncFlow",
          "resyncBadReceipt",
          "resyncOutOfScope",
          "resyncNoGen",
          "resyncAlreadyCovered",
          "resyncDefectPassthrough",
          "transportRetryAndReplenish"
        ])
      })
    )
    await runFuzz(
      arb,
      ({ scenario }) =>
        Effect.gen(function*() {
          const r1 = mkRunId("c-r1")
          const r2 = mkRunId("c-r2")
          const scope: SyncProtocol.Scope = { _tag: "Run", runId: r1 }

          if (scenario === "frameMissingGen") {
            const c = yield* makeMockClient({
              subscribe: () =>
                Stream.succeed({
                  _tag: "Entries",
                  runId: r1,
                  fromSeq: mkSeq(0),
                  toSeq: mkSeq(0),
                  entries: [mkJournalEntry(r1, 0)]
                })
            })
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "protocol_violation"
            )
          }
          if (scenario === "frameOutOfScope") {
            const c = yield* makeMockClient({
              subscribe: () =>
                Stream.succeed({
                  _tag: "Entries",
                  runId: r2,
                  generation: 0,
                  fromSeq: mkSeq(0),
                  toSeq: mkSeq(0),
                  entries: [mkJournalEntry(r2, 0)]
                })
            })
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "protocol_violation"
            )
          }
          if (scenario === "frameOversized") {
            const c = yield* makeMockClient(
              {
                subscribe: () =>
                  Stream.succeed({
                    _tag: "Entries",
                    runId: r1,
                    generation: 0,
                    fromSeq: mkSeq(0),
                    toSeq: mkSeq(0),
                    entries: [mkJournalEntry(r1, 0, { payload: "x".repeat(200) })]
                  })
              },
              { maxFrameBytes: 50 }
            )
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "frame_too_large"
            )
          }
          if (scenario === "frameForeignRun") {
            const c = yield* makeMockClient({
              subscribe: () =>
                Stream.succeed({
                  _tag: "Entries",
                  runId: r1,
                  generation: 0,
                  fromSeq: mkSeq(0),
                  toSeq: mkSeq(0),
                  entries: [mkJournalEntry(r2, 0)]
                })
            })
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "protocol_violation"
            )
          }
          if (scenario === "frameNonMonotonic") {
            const c = yield* makeMockClient({
              subscribe: () =>
                Stream.succeed({
                  _tag: "Entries",
                  runId: r1,
                  generation: 0,
                  fromSeq: mkSeq(0),
                  toSeq: mkSeq(2),
                  entries: [mkJournalEntry(r1, 2), mkJournalEntry(r1, 1)]
                })
            })
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "protocol_violation"
            )
          }
          if (scenario === "frameOutsideInterval") {
            const c = yield* makeMockClient({
              subscribe: () =>
                Stream.succeed({
                  _tag: "Entries",
                  runId: r1,
                  generation: 0,
                  fromSeq: mkSeq(0),
                  toSeq: mkSeq(0),
                  entries: [mkJournalEntry(r1, 2)]
                })
            })
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "protocol_violation"
            )
          }
          if (scenario === "frameLineageChanged") {
            const c = yield* makeMockClient({
              subscribe: () =>
                Stream.succeed({
                  _tag: "Entries",
                  runId: r1,
                  generation: 2,
                  fromSeq: mkSeq(1),
                  toSeq: mkSeq(1),
                  entries: [mkJournalEntry(r1, 1)]
                })
            })
            return isSyncCode(
              yield* Effect.flip(
                Stream.runDrain(c.subscribe({ scope, cursors: [{ runId: r1, afterSeq: mkSeq(0), generation: 0 }] }))
              ),
              "lineage_changed"
            )
          }
          if (scenario === "frameGap") {
            const c = yield* makeMockClient({
              subscribe: () =>
                Stream.succeed({
                  _tag: "Entries",
                  runId: r1,
                  generation: 0,
                  fromSeq: mkSeq(3),
                  toSeq: mkSeq(3),
                  entries: [mkJournalEntry(r1, 3)]
                })
            })
            const err = yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] })))
            return err instanceof SyncError.SyncGapError
          }
          if (scenario === "frameTrailingHole") {
            const c = yield* makeMockClient({
              subscribe: () =>
                Stream.fromIterable([
                  { _tag: "Heartbeat" },
                  {
                    _tag: "Entries",
                    runId: r1,
                    generation: 0,
                    fromSeq: mkSeq(0),
                    toSeq: mkSeq(2),
                    entries: [mkJournalEntry(r1, 0)]
                  },
                  {
                    _tag: "Entries",
                    runId: r1,
                    generation: 0,
                    fromSeq: mkSeq(0),
                    toSeq: mkSeq(2),
                    entries: [mkJournalEntry(r1, 0)]
                  },
                  {
                    _tag: "Entries",
                    runId: r1,
                    generation: 0,
                    fromSeq: mkSeq(3),
                    toSeq: mkSeq(3),
                    entries: [mkJournalEntry(r1, 3)]
                  },
                  { _tag: "Closed", reason: "eof" }
                ])
            })
            const err = yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] })))
            const prog = yield* c.progress
            return isSyncCode(err, "closed") && prog.delivered[0]?.afterSeq === 3
          }
          if (scenario === "frameClosed") {
            const c = yield* makeMockClient({
              subscribe: () => Stream.succeed({ _tag: "Closed", reason: "done" })
            })
            return isSyncCode(yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))), "closed")
          }
          if (scenario === "frameEmptyWindow") {
            const c = yield* makeMockClient({ subscribe: () => Stream.empty })
            return isSyncCode(
              yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] }))),
              "protocol_violation"
            )
          }
          if (scenario === "applyAndFail") {
            const c = yield* makeMockClient({
              read: () =>
                Effect.succeed({
                  entries: [mkJournalEntry(r1, 0), mkJournalEntry(r1, 1)],
                  cursors: [{ runId: r1, afterSeq: mkSeq(1), generation: 0 }],
                  done: true
                })
            })
            const err = yield* Effect.flip(
              Stream.runDrain(
                c.subscribe({
                  scope,
                  cursors: [],
                  apply: (e) =>
                    e.seq === 1
                      ? Effect.fail(new SyncError.SyncError({ code: "transport_failed", message: "consumer error" }))
                      : Effect.void
                })
              )
            )
            const prog = yield* c.progress
            if (!SyncError.SyncError.is(err) || prog.applied[0]?.afterSeq !== 0) return false
            // Fast-forward behind shared progress, and lineage_changed on mismatched generation
            const linErr = yield* Effect.flip(
              Stream.runDrain(
                c.subscribe({
                  scope,
                  cursors: [{ runId: r1, afterSeq: mkSeq(0), generation: 1 }],
                  apply: () => Effect.void
                })
              )
            )
            return isSyncCode(linErr, "lineage_changed")
          }
          if (scenario === "resyncFlow") {
            let calls = 0
            const c = yield* makeMockClient({
              read: (req) => {
                calls += 1
                if (calls === 1) {
                  return Effect.fail(
                    new SyncError.SyncError({
                      code: "compacted",
                      message: "compacted",
                      resync: { runId: r1, checkpointSeq: mkSeq(5), generation: 1 }
                    })
                  )
                }
                const after = req.cursors[0]?.afterSeq ?? -1
                return Effect.succeed({
                  entries: [mkJournalEntry(r1, after + 1)],
                  cursors: [{ runId: r1, afterSeq: mkSeq(after + 1), generation: 1 }],
                  done: true
                })
              }
            })
            const err = yield* Effect.flip(
              Stream.runDrain(
                c.subscribe({
                  scope,
                  cursors: [],
                  onResync: (resync) => Effect.succeed({ runId: resync.runId, afterSeq: resync.checkpointSeq })
                })
              )
            )
            const prog = yield* c.progress
            return isSyncCode(err, "closed") && prog.applied[0]?.afterSeq === 5 && prog.delivered[0]?.afterSeq === 6
          }
          if (scenario === "resyncBadReceipt") {
            const c = yield* makeMockClient({
              read: () =>
                Effect.fail(
                  new SyncError.SyncError({
                    code: "compacted",
                    message: "compacted",
                    resync: { runId: r1, checkpointSeq: mkSeq(5), generation: 0 }
                  })
                )
            })
            const e1 = yield* Effect.flip(
              Stream.runDrain(
                c.subscribe({
                  scope,
                  cursors: [],
                  onResync: () => Effect.succeed({ runId: r1, afterSeq: mkSeq(2) })
                })
              )
            )
            const e2 = yield* Effect.flip(Stream.runDrain(c.subscribe({ scope, cursors: [] })))
            return isSyncCode(e1, "invalid_request") && isSyncCode(e2, "compacted")
          }
          if (scenario === "resyncOutOfScope") {
            const c = yield* makeMockClient({
              read: () =>
                Effect.fail(
                  new SyncError.SyncError({
                    code: "compacted",
                    message: "compacted",
                    resync: { runId: r2, checkpointSeq: mkSeq(5), generation: 0 }
                  })
                )
            })
            return isSyncCode(
              yield* Effect.flip(
                Stream.runDrain(
                  c.subscribe({
                    scope,
                    cursors: [],
                    onResync: (resync) => Effect.succeed({ runId: resync.runId, afterSeq: resync.checkpointSeq })
                  })
                )
              ),
              "protocol_violation"
            )
          }
          if (scenario === "resyncNoGen") {
            const c = yield* makeMockClient({
              read: () =>
                Effect.fail(
                  new SyncError.SyncError({
                    code: "compacted",
                    message: "compacted",
                    resync: { runId: r1, checkpointSeq: mkSeq(5) }
                  })
                )
            })
            return isSyncCode(
              yield* Effect.flip(
                Stream.runDrain(
                  c.subscribe({
                    scope,
                    cursors: [],
                    onResync: (resync) => Effect.succeed({ runId: resync.runId, afterSeq: resync.checkpointSeq })
                  })
                )
              ),
              "protocol_violation"
            )
          }
          if (scenario === "resyncAlreadyCovered") {
            const c = yield* makeMockClient({
              read: () =>
                Effect.fail(
                  new SyncError.SyncError({
                    code: "compacted",
                    message: "compacted",
                    resync: { runId: r1, checkpointSeq: mkSeq(3), generation: 0 }
                  })
                )
            })
            return isSyncCode(
              yield* Effect.flip(
                Stream.runDrain(
                  c.subscribe({
                    scope,
                    cursors: [{ runId: r1, afterSeq: mkSeq(5), generation: 0 }],
                    onResync: (resync) => Effect.succeed({ runId: resync.runId, afterSeq: resync.checkpointSeq })
                  })
                )
              ),
              "compacted"
            )
          }
          if (scenario === "resyncDefectPassthrough") {
            const c = yield* makeMockClient({ read: () => Effect.die("unexpected-defect") })
            const exit = yield* Effect.exit(Stream.runDrain(c.subscribe({ scope, cursors: [] })))
            return Exit.isFailure(exit) && Cause.hasDies(exit.cause)
          }
          // transportRetryAndReplenish: transient transport failure retries, then credit window replenishes
          let attempts = 0
          const c = yield* makeMockClient({
            subscribe: () => {
              attempts += 1
              if (attempts === 1) return Stream.fail(new Error("socket reset"))
              if (attempts === 2) {
                return Stream.succeed({
                  _tag: "Entries",
                  runId: r1,
                  generation: 0,
                  fromSeq: mkSeq(0),
                  toSeq: mkSeq(0),
                  entries: [mkJournalEntry(r1, 0)]
                })
              }
              return Stream.fromIterable([
                {
                  _tag: "Entries",
                  runId: r1,
                  generation: 0,
                  fromSeq: mkSeq(1),
                  toSeq: mkSeq(1),
                  entries: [mkJournalEntry(r1, 1)]
                },
                { _tag: "Closed", reason: "done" }
              ])
            }
          })
          const collected: Array<number> = []
          const err = yield* Effect.flip(
            c.subscribe({ scope, cursors: [], credit: 1 }).pipe(
              Stream.tap((e) =>
                Effect.sync(() => {
                  collected.push(e.seq)
                })
              ),
              Stream.runDrain
            )
          )
          return isSyncCode(err, "closed") && attempts === 3 && collected.length === 2
        }),
      { seedOffset: 82, executions: medExec, simulation: true }
    )
  })

  it("TestSocket faults and TestSync end-to-end SyncClient <-> SyncServer replication", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nEntries: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        faultMode: Schema.Literals(["clean", "stallResume", "dropRange", "transform", "disconnect"])
      })
    )
    await runFuzz(
      arb,
      ({ nEntries, faultMode }) =>
        Effect.scoped(
          Effect.gen(function*() {
            // Exercise TestSocket directly with filter/dropRange/stall/resume/writeAll/CloseEvent/disconnect
            if (faultMode === "dropRange" || faultMode === "transform" || faultMode === "disconnect") {
              const pair = yield* TestSocket.makePair()
              if (faultMode === "dropRange") {
                pair.faults.dropRange("r-drop", 1, 2)
              } else if (faultMode === "transform") {
                pair.faults.installFilter((bytes) => bytes)
              }
              const writer = yield* pair.client.writer
              const msgKeep = JSON.stringify({ _tag: "Entries", runId: "r-drop", fromSeq: 0, toSeq: 0, entries: [] })
              const msgDrop = JSON.stringify({
                _tag: "Chunk",
                values: [{ _tag: "Entries", runId: "r-drop", fromSeq: 1, toSeq: 2, entries: [] }]
              })
              const msgDropObj = JSON.stringify({
                nested: { _tag: "Entries", runId: "r-drop", fromSeq: 1, toSeq: 2, entries: [] }
              })
              if (faultMode === "disconnect") {
                const readerFiber = yield* Stream.runDrain(Socket.toStream(pair.server)).pipe(
                  Effect.exit,
                  Effect.forkChild
                )
                yield* Effect.sleep(5)
                yield* pair.faults.disconnect()
                const ex = yield* Fiber.join(readerFiber)
                return !Exit.isSuccess(ex)
              }
              const expectedCount = faultMode === "dropRange" ? 3 : 5
              const readerFiber = yield* Socket.toStream(pair.server).pipe(
                Stream.take(expectedCount),
                Stream.map((bytes) => (typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes))),
                Stream.runCollect,
                Effect.forkChild
              )
              yield* writer.writeAll([msgKeep, msgDrop, msgDropObj, "null", "not-json"])
              yield* writer.write(new Socket.CloseEvent(1000))
              const received = Array.from(yield* Fiber.join(readerFiber))
              if (faultMode === "dropRange") {
                return received.includes(msgKeep) && !received.includes(msgDrop) && !received.includes(msgDropObj)
              }
              return received.length === 5
            }

            // Full TestSync.layerTest + TestSync.connect end-to-end
            return yield* Effect.gen(function*() {
              const journal = yield* Journal.Journal
              const r1 = mkRunId("e2e-run")
              for (let i = 0; i < nEntries; i++) {
                yield* journal.emitDurableUnfenced(
                  new JournalEvent.Input({
                    runId: r1,
                    sourceId: mkSourceId("e2e"),
                    sourceSeq: mkSourceSeq(i),
                    eventType: "step",
                    payload: { i },
                    meta: null
                  })
                )
              }
              const pair = yield* TestSocket.makePair()
              if (faultMode === "stallResume") {
                pair.faults.stall()
              }
              const client = yield* TestSync.connect(pair)
              const fiber = yield* client
                .subscribe({ scope: { _tag: "Run", runId: r1 }, cursors: [], credit: 2 })
                .pipe(Stream.take(nEntries), Stream.runCollect, Effect.forkChild)
              if (faultMode === "stallResume") {
                yield* Effect.yieldNow
                pair.faults.resume()
              }
              const entries = Array.from(yield* Fiber.join(fiber))
              // Also exercise SyncClient.layer and SyncClient.layerWith
              const pair2 = yield* TestSocket.makePair()
              const proto2 = yield* RpcClient.makeProtocolSocket().pipe(
                Effect.provideService(Socket.Socket, pair2.client),
                Effect.provide(RpcSerialization.layerJson)
              )
              const cLayer = yield* SyncClient.SyncClient.pipe(
                Effect.provide(SyncClient.layerWith({ bootstrapLimit: 10 })),
                Effect.provideService(RpcClient.Protocol, proto2)
              )
              const cDefault = yield* SyncClient.SyncClient.pipe(
                Effect.provide(SyncClient.layer),
                Effect.provideService(RpcClient.Protocol, proto2)
              )
              const p2 = yield* cLayer.progress
              const p3 = yield* cDefault.progress
              return entries.length === nEntries && p2.delivered.length === 0 && p3.delivered.length === 0
            }).pipe(Effect.provide(TestSync.layerTest))
          })
        ),
      { seedOffset: 81, executions: simExec, simulation: true }
    )
  })
})
