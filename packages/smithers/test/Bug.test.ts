/**
 * `smthrs bug`: the scrubbing, which is the whole reason the command exists.
 *
 * Every rule here answers a way a credential actually reached a 0.x report.
 */
import * as Redaction from "@smthrs/journal/Redaction"
import * as FastCheck from "fast-check"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Bug from "../src/Bug.ts"

it("previews a real CLI bug report without a Git OAuth credential username", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-bug-oauth-")))
  const credential = "SyntheticOpaqueUserZq7Value9"
  try {
    const child = spawnSync(process.execPath, [
      "--no-warnings",
      fileURLToPath(new URL("../src/bin.ts", import.meta.url)),
      "bug",
      `https://${credential}:x-oauth-basic@host.invalid/private.git`,
      "--dry-run",
      "--format",
      "json",
      "--root",
      root
    ], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, TMPDIR: process.env.TMPDIR },
      encoding: "utf8",
      timeout: 30_000
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout + child.stderr).not.toContain(credential)
    expect(child.stdout + child.stderr).toContain("https://[REDACTED]@host.invalid/private.git")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 40_000)

describe("scrubbing free text", () => {
  it("strips the password out of a connection string, whatever the key is called", () => {
    expect(Bug.scrubText("postgres://user:hunter2@db.internal/app"))
      .toBe("postgres://user:[REDACTED]@db.internal/app")
    expect(Bug.scrubText("postgres://user:hunter2@db.internal/app")).not.toContain("hunter2")
    const token = Bug.scrubText("https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz@github.com")
    expect(token).toContain("[REDACTED]")
    expect(token).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz")
  })

  it("redacts an OAuth username through the public report boundary", () => {
    const credential = "SyntheticOpaqueUserZq7Value9"
    const url = `https://${credential}:x-oauth-basic@host.invalid/private.git`
    expect(Bug.scrubText(url)).toBe("https://[REDACTED]@host.invalid/private.git")
    const report = Bug.report({ summary: url, version: "test", platform: "test", node: "test", runs: [{ url }] })
    expect(JSON.stringify(report)).not.toContain(credential)
    expect(report.summary).toBe("https://[REDACTED]@host.invalid/private.git")
  })

  it("strips bearer tokens and provider key formats that carry no key name", () => {
    expect(Bug.scrubText("authorization: Bearer abc123def456")).toBe("authorization: Bearer [REDACTED_TOKEN]")
    expect(Bug.scrubText("sk-abcdefghijklmnop")).toBe("[REDACTED_API_KEY]")
    expect(Bug.scrubText("ghp_abcdefghijklmnopqrstuvwxyz01")).toBe("[REDACTED]")
    expect(Bug.scrubText("github_pat_abcdefghijklmnopqrstuvwxyz")).toBe("[REDACTED]")
    expect(Bug.scrubText("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED]")
    expect(Bug.scrubText("xoxb-1234567890-abcdef")).toBe("[REDACTED]")
    expect(Bug.scrubText(`AIza${"a".repeat(35)}`)).toBe("[REDACTED]")
  })

  it("strips KEY=value pairs and quoted JSON secrets", () => {
    expect(Bug.scrubText("ANTHROPIC_API_KEY=abc123")).toBe("ANTHROPIC_API_KEY=[REDACTED]")
    expect(Bug.scrubText("api_key=abc123")).toBe("api_key=[REDACTED]")
    expect(Bug.scrubText("MY_SECRET=\"quoted value\"")).toBe("MY_SECRET=\"[REDACTED]\"")
    expect(Bug.scrubText("{\"apiToken\": \"abc123\"}")).toBe("{\"apiToken\": \"[REDACTED]\"}")
  })

  it("leaves ordinary text alone", () => {
    expect(Bug.scrubText("the run failed after 3 attempts")).toBe("the run failed after 3 attempts")
    expect(Bug.scrubText("https://smithers.sh/docs")).toBe("https://smithers.sh/docs")
  })
})

describe("scrubbing a value", () => {
  it("redacts a secret-looking key wholesale, whatever it holds", () => {
    expect(Bug.scrub({ apiKey: { nested: "structure" }, cookie: "sid", token: 42, note: "fine" }))
      .toEqual({ apiKey: "[REDACTED]", cookie: "[REDACTED]", token: "[REDACTED]", note: "fine" })
  })

  it("retains the report-only dsn and connection key coverage", () => {
    expect(Bug.scrub({ dsn: "postgres://db", connectionDetails: { host: "internal" } }))
      .toEqual({ dsn: Redaction.placeholder, connectionDetails: Redaction.placeholder })
  })

  it("recurses through arrays and objects", () => {
    expect(Bug.scrub({ runs: [{ id: 1, env: "OPENAI_API_KEY=abc123" }] }))
      .toEqual({ runs: [{ id: 1, env: "OPENAI_API_KEY=[REDACTED]" }] })
  })

  it("redacts diagnostic credential spellings", () => {
    const secret = "ZqSynthetic7Secret4Value9"
    for (const text of [`mysql -u root -p ${secret} db`, `password: correct horse ${secret}`]) {
      expect(Bug.scrubText(text)).not.toContain(secret)
      expect(Bug.scrubText(text)).toContain(Redaction.placeholder)
    }
    expect(Bug.scrub({ argv: ["sshpass", "-p", secret] })).toEqual({ argv: ["sshpass", "-p", Redaction.placeholder] })
  })

  it("passes non-string leaves through", () => {
    expect(Bug.scrub([1, true, null, undefined])).toEqual([1, true, null, undefined])
  })
})

describe("the report", () => {
  it("uses the diagnostic rules as the oracle for every posted string", () => {
    const credential = FastCheck.constantFrom(
      "Bearer abcdefghijk",
      "sk-abcdefghijk",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      "github_pat_11ABCDEFG0abcdefghijklmnop",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-1234567890-abcdef",
      `AIza${"a".repeat(35)}`,
      "api_key=lowercase-secret",
      "postgres://user:hunter2@db.internal/app"
    )
    FastCheck.assert(
      FastCheck.property(credential, FastCheck.integer(), (secret, nonce) => {
        const text = `probe-${nonce}:${secret}:end`
        const oracle = Redaction.redactDiagnostic(text)
        expect(oracle).not.toBe(text)

        const posted = Bug.report({
          summary: text,
          version: "1.0.0-rc.0",
          platform: "test",
          node: "test",
          runs: [{ text }]
        })

        expect(posted.summary).toBe(oracle)
        const body = JSON.stringify(posted)
        expect(body).not.toContain(text)
        expect(body).not.toContain(secret)
      }),
      { numRuns: 50 }
    )
  })

  it("is scrubbed before it leaves the machine", () => {
    const report = Bug.report({
      summary: "run failed with ANTHROPIC_API_KEY=sk-abcdefghijkl",
      version: "1.0.0-rc.0",
      platform: "darwin-arm64",
      node: "24.0.0",
      runs: [{ runId: "run-1", token: "secret" }]
    })

    expect(report.summary).toContain("[REDACTED]")
    expect(report.summary).not.toContain("sk-abcdefghijkl")
    expect((report.runs as ReadonlyArray<Record<string, unknown>>)[0]).toEqual({
      runId: "run-1",
      token: "[REDACTED]"
    })
  })

  it("refuses an accessor without invoking it", () => {
    let reads = 0
    const run: Record<string, unknown> = {}
    Object.defineProperty(run, "detail", {
      enumerable: true,
      get: () => {
        reads += 1
        return "api_key=must-not-be-read"
      }
    })

    expect(() =>
      Bug.report({
        summary: "failed",
        version: "1",
        platform: "test",
        node: "test",
        runs: [run]
      })
    ).toThrow(/accessor/)
    expect(reads).toBe(0)
  })

  it("refuses live and revoked proxies without invoking a trap", () => {
    let traps = 0
    const live = new Proxy({}, {
      ownKeys: () => {
        traps += 1
        return []
      }
    })
    expect(() => Bug.report({ summary: "failed", version: "1", platform: "test", node: "test", runs: live }))
      .toThrow(/^Bug report refused: .*proxy/)
    expect(() => Bug.report({ summary: "failed", version: "1", platform: "test", node: "test", runs: live }))
      .toThrow(expect.objectContaining({ _tag: "/cli/Refused", code: "bug_report_refused" }))
    expect(traps).toBe(0)

    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(() => Bug.report({ summary: "failed", version: "1", platform: "test", node: "test", runs: revoked.proxy }))
      .toThrow(/^Bug report refused: .*proxy/)
  })

  it("collapses a cycle instead of recursing forever", () => {
    const run: Record<string, unknown> = { runId: "run-1" }
    run["self"] = run

    const posted = Bug.report({
      summary: "failed",
      version: "1",
      platform: "test",
      node: "test",
      runs: [run]
    })

    expect((posted.runs as ReadonlyArray<Record<string, unknown>>)[0]?.["self"]).toBe("[Circular]")
  })

  it("refuses values outside the journal walk bounds", () => {
    let deep: unknown = "leaf"
    for (let index = 0; index <= Redaction.maxDepth; index++) deep = { deep }

    expect(() => Bug.report({ summary: "failed", version: "1", platform: "test", node: "test", runs: deep })).toThrow(
      /depth limit/
    )
    expect(() =>
      Bug.report({
        summary: "failed",
        version: "1",
        platform: "test",
        node: "test",
        runs: new Uint8Array(Redaction.binaryWalkLimit + 1)
      })
    ).toThrow(/byte walk limit/)

    const oversized = Object.fromEntries(
      Array.from({ length: Redaction.binaryWalkLimit + 1 }, (_, index) => [`member-${index}`, index])
    )
    expect(() => Bug.report({ summary: "failed", version: "1", platform: "test", node: "test", runs: oversized }))
      .toThrow(/member walk limit/)
  })

  it("refuses executable JSON hooks and callable members", () => {
    expect(() =>
      Bug.report({ summary: "failed", version: "1", platform: "test", node: "test", runs: { task: () => 1 } })
    ).toThrow(/callable/)
    expect(() =>
      Bug.report({ summary: "failed", version: "1", platform: "test", node: "test", runs: { toJSON: () => ({}) } })
    ).toThrow(/toJSON/)
  })

  it("bounds both ArrayBuffer and typed-array payloads", () => {
    for (
      const runs of [
        new ArrayBuffer(Redaction.binaryWalkLimit + 1),
        new Uint8Array(Redaction.binaryWalkLimit + 1)
      ]
    ) {
      expect(() => Bug.report({ summary: "failed", version: "1", platform: "test", node: "test", runs }))
        .toThrow(/byte walk limit/)
    }
  })

  it("names the default endpoint and a finite timeout", () => {
    expect(Bug.defaultEndpoint).toBe("https://bug.smithers.sh/api/bugs")
    expect(Bug.timeoutMs).toBe(15_000)
  })
})

it.each([new ArrayBuffer(4), new Uint8Array(4), new DataView(new ArrayBuffer(4))])(
  "inspects binary sizes without executing a byteLength accessor (%s)",
  (value) => {
    let reads = 0
    Object.defineProperty(value, "byteLength", {
      enumerable: true,
      get: () => {
        reads++
        return 4
      }
    })
    expect(() => Bug.report({ summary: "failure", version: "1", platform: "test", node: "test", runs: [value] }))
      .toThrow(/accessor/)
    expect(reads).toBe(0)
  }
)

describe("inert report snapshots", () => {
  const report = (runs: unknown) =>
    Bug.report({ summary: "failure", version: "1", platform: "test", node: "test", runs })

  it.each(["constructor", "byteLength", "toJSON", Symbol.toStringTag])(
    "refuses non-enumerable binary accessors without executing them (%s)",
    (key) => {
      let reads = 0
      const value = new Uint8Array(1)
      Object.defineProperty(value, key, {
        get: () => {
          reads++
          return { name: "caller-code" }
        }
      })
      expect(() => report(value)).toThrow(/Bug report refused:/)
      expect(reads).toBe(0)
    }
  )

  it.each(["constructor", "byteLength", "toJSON", "0"])(
    "refuses inherited accessors without executing them (%s)",
    (key) => {
      let reads = 0
      for (const value of [{}, [], new Uint8Array(1)]) {
        const prototype = Object.create(Object.getPrototypeOf(value)) as object
        Object.defineProperty(prototype, key, {
          get: () => {
            reads++
            return { name: "caller-code" }
          }
        })
        Object.setPrototypeOf(value, prototype)
        expect(() => report(value)).toThrow(/Bug report refused:/)
      }
      expect(reads).toBe(0)
    }
  )

  it("refuses a proxy prototype without invoking its traps", () => {
    let traps = 0
    const prototype = new Proxy({}, {
      get: () => {
        traps++
        return undefined
      },
      has: () => {
        traps++
        return false
      },
      getPrototypeOf: () => {
        traps++
        return null
      }
    })
    expect(() => report(Object.create(prototype))).toThrow(/Bug report refused:/)
    expect(traps).toBe(0)
  })

  it("names binary values from their internal brand and keeps redacting their own fields", () => {
    for (
      const [value, name] of [
        [new ArrayBuffer(4), "ArrayBuffer"],
        [new DataView(new ArrayBuffer(4)), "DataView"],
        [new Uint8Array(4), "Uint8Array"],
        [Buffer.alloc(4), "Buffer"]
      ] as const
    ) {
      Object.defineProperty(value, "constructor", { value: { name: "caller-controlled" } })
      Object.defineProperty(value, "note", { value: "api_key=synthetic-secret", enumerable: true })
      Object.defineProperty(value, "token", { value: "synthetic-secret", enumerable: true })
      expect(report(value).runs).toEqual({
        [Redaction.binaryMarker]: `${name} 4 bytes`,
        note: "api_key=[REDACTED]",
        token: Redaction.placeholder
      })
    }
  })

  it.each([100_000, 0xffff_ffff])(
    "refuses a sparse array of length %s before scanning its indices",
    (length) => {
      let reads = 0
      const value = new Array<unknown>(length)
      Object.defineProperty(value, "0", {
        enumerable: true,
        get: () => {
          reads++
          return "secret"
        }
      })
      expect(() => report(value)).toThrow(/member walk limit/)
      expect(reads).toBe(0)
    }
  )

  it("charges sparse slots across sibling arrays against one report budget", () => {
    const length = Math.floor(Redaction.binaryWalkLimit / 2)
    expect(() => report([new Array(length), new Array(length)])).toThrow(/member walk limit/)
  })

  it("preserves bounded sparse arrays and null-prototype records", () => {
    const value = new Array<unknown>(4)
    value[2] = { note: "fine", token: "secret" }
    const result = report(value).runs as Array<unknown>
    expect(result.length).toBe(4)
    expect(0 in result).toBe(false)
    expect(1 in result).toBe(false)
    expect(result[2]).toEqual({ note: "fine", token: Redaction.placeholder })
    expect(3 in result).toBe(false)
    const record = Object.create(null) as Record<string, unknown>
    record["__proto__"] = { token: "secret" }
    expect(report(record).runs).toEqual(Object.fromEntries([["__proto__", { token: Redaction.placeholder }]]))
  })

  it("bounds sparse array slots for generated lengths", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: Redaction.binaryWalkLimit, max: 1_000_000 }),
        (length) => {
          expect(() => report(new Array(length))).toThrow(/member walk limit/)
        }
      ),
      { numRuns: 25 }
    )
  })
})

it("refuses a non-enumerable array index accessor and preserves a data index", () => {
  let reads = 0
  const value = new Array<unknown>(1)
  Object.defineProperty(value, "0", {
    configurable: true,
    get: () => {
      reads++
      return "secret"
    }
  })
  expect(() => Bug.scrub(value)).toThrow(/accessor/)
  expect(reads).toBe(0)
  Object.defineProperty(value, "0", { value: "api_key=synthetic-secret" })
  expect(Bug.scrub(value)).toEqual(["api_key=[REDACTED]"])
})

it("admits the exact sparse-slot budget and refuses the next slot", () => {
  const value = new Array<unknown>(Redaction.binaryWalkLimit - 1)
  expect((Bug.scrub(value) as Array<unknown>).length).toBe(value.length)
  expect(() => Bug.scrub(new Array(Redaction.binaryWalkLimit))).toThrow(/member walk limit/)
})

it("refuses setter-only members without invoking them", () => {
  let writes = 0
  const value = {}
  Object.defineProperty(value, "detail", {
    set: () => {
      writes++
    }
  })
  expect(() => Bug.scrub(value)).toThrow(/accessor/)
  expect(writes).toBe(0)
})

it("omits symbol and hidden data properties from the inert diagnostic snapshot", () => {
  const value = { note: "fine", [Symbol("hidden")]: "private" }
  Object.defineProperty(value, "hidden", { value: "private" })
  expect(Bug.scrub(value)).toEqual({ note: "fine" })
})

it("keeps the host's available typed-array binary storage supported", () => {
  const Constructor = Object.getOwnPropertyDescriptor(globalThis, "Float16Array")?.value as
    | (new(length: number) => ArrayBufferView)
    | undefined
  const value = Constructor === undefined ? new Uint16Array(2) : new Constructor(2)
  const name = Constructor === undefined ? "Uint16Array" : "Float16Array"
  expect(Bug.scrub(value)).toEqual({ [Redaction.binaryMarker]: `${name} 4 bytes` })
})
