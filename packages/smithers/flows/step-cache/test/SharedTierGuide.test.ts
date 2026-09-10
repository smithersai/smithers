import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { readFileSync } from "node:fs"
import * as ts from "typescript"
import * as CacheStore from "../src/CacheStore.ts"

const guide = readFileSync(new URL("../docs/guides/implement-a-shared-tier.md", import.meta.url), "utf8")
const snippet = guide.match(/```ts\n(const fenceOf = [\s\S]*?)\n```/)?.[1]
if (snippet === undefined) throw new Error("shared-tier guide is missing fenceOf")
const fenceOf = new Function(
  "CacheStore",
  "Effect",
  ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText + "\nreturn fenceOf"
)(CacheStore, Effect) as (
  params: URLSearchParams
) => Effect.Effect<CacheStore.RecordedBy | undefined, CacheStore.CacheStoreError>

describe("shared-tier guide eviction fence", () => {
  it("allows an unconditional delete only without either parameter", async () => {
    expect(await Effect.runPromise(fenceOf(new URLSearchParams()))).toBeUndefined()
  })

  it.each(["0", "9", String(Number.MAX_SAFE_INTEGER)])("accepts canonical sequence %s", async (eventSeq) => {
    const params = new URLSearchParams({ recordedRunId: "run", recordedEventSeq: eventSeq })
    expect(await Effect.runPromise(fenceOf(params))).toEqual({ runId: "run", eventSeq: Number(eventSeq) })
  })

  it.each([
    "recordedRunId=run",
    "recordedEventSeq=9",
    "recordedRunId=",
    "recordedEventSeq=",
    "recordedRunId=run&recordedEventSeq=",
    "recordedRunId=&recordedEventSeq=0",
    "recordedRunId=run&recordedRunId=run&recordedEventSeq=9",
    "recordedRunId=run&recordedRunId=other&recordedEventSeq=9",
    "recordedRunId=run&recordedEventSeq=9&recordedEventSeq=9",
    "recordedRunId=run&recordedEventSeq=9&recordedEventSeq=10",
    ...[
      "00",
      "01",
      "+1",
      "-0",
      "-1",
      "1.0",
      "1e2",
      "0x10",
      " 1",
      "1 ",
      "1\n",
      "1\r",
      "NaN",
      "Infinity",
      "9007199254740992"
    ]
      .map((recordedEventSeq) => new URLSearchParams({ recordedRunId: "run", recordedEventSeq }).toString())
  ])("rejects malformed DELETE fence %s", async (query) => {
    const error = await Effect.runPromise(Effect.flip(fenceOf(new URLSearchParams(query))))
    expect(error).toBeInstanceOf(CacheStore.CacheStoreError)
    expect(error.code).toBe("invalid_cache")
  })
})

describe("shared-tier guide error vocabulary", () => {
  it("maps byte, UTF-8, and parse failures to persistence_failed", () => {
    // `RemoteCacheStore.get` wraps the bounded read and `JSON.parse` in
    // `transportFailure`, which raises `persistence_failed`. Only a body that
    // parsed and then failed `snapshotEntry` carries `decode_failed`, as
    // RemoteCacheStore.test.ts pins for both shapes.
    expect(guide).toContain("parsing it as JSON fail with `persistence_failed`")
    expect(guide).toContain("is not a bounded `CacheEntry` fails with `decode_failed`")
    expect(guide).not.toMatch(/text that is not JSON[\s\S]*?fail with `decode_failed`/)
  })
})
