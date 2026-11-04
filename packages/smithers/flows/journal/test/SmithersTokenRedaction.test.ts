import { describe, expect, it } from "@effect/vitest"
import * as Redaction from "../src/Redaction.ts"

// Invented wire forms from ops/machine-token/issue.ts and control/src/ScopedToken.ts.
// Both use 32 bytes (43 base64url characters); scoped tokens sign encoded JSON claims.
const tail = "aB0_-".repeat(8) + "aAQ"
const claims = Buffer.from(JSON.stringify({ v: 1, id: "invented", procedures: ["runs.get"], iat: 1, exp: 2 }))
  .toString("base64url")
const tokens = [["machine", `smm_${tail}`], ["scoped", `smt1.${claims}.${tail}`]] as const

const contexts = [
  ["bare message", (token: string) => `rejected ${token} upstream`],
  ["URL path", (token: string) => `GET https://example.test/${token}/status failed`],
  ["URL query", (token: string) => `GET https://example.test/?value=${token}&page=2 failed`],
  ["URL fragment", (token: string) => `https://example.test/#${token}`],
  ["custom header", (token: string) => `X-Request-Credential: ${token}`],
  ["authorization header", (token: string) => `Authorization: Bearer ${token}`],
  ["underscore wrapper", (token: string) => `_${token}_`],
  ["adjacent text", (token: string) => `prefix${token}!`]
] as const

for (const [surface, redact] of [["journal", Redaction.redact], ["diagnostic", Redaction.redactDiagnostic]] as const) {
  describe(`${surface} Smithers tokens`, () => {
    for (const [kind, token] of tokens) {
      for (const [context, message] of contexts) {
        it(`redacts ${kind} in ${context}`, () => {
          const safe = redact({ message: message(token), status: 503 })
          expect(JSON.stringify(safe)).not.toContain(token)
          expect(JSON.stringify(safe)).not.toContain(tail)
          expect(JSON.stringify(safe)).toContain("[REDACTED")
          expect(safe).toMatchObject({ status: 503 })
          expect(redact(safe)).toEqual(safe)
        })
      }
    }

    for (const prefix of ["smm_", "smt1.e30."]) {
      it(`closes fragmented contextual ${prefix} assignments`, () => {
        const signature = "A".repeat(42) + "Q"
        expect(redact(`password=${prefix}${signature}_password=tail`)).toBe("[REDACTED]")
      })
      it(`protects overlapping ${prefix} tokens with customized PEM replacement`, () => {
        const rules = (surface === "journal" ? Redaction.defaultRules : Redaction.diagnosticRules)
          .map((rule) => rule.id === "private-key-block" ? { ...rule, replace: "[CUSTOM]" } : rule)
        const signature = "A".repeat(30) + "-----BEGINABQ"
        const text = `${prefix}${signature} PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----`
        expect(Redaction.redact(text, { rules })).toBe("[REDACTED]")
        expect(Redaction.redact(text, { rules: rules.map((rule) => rule.id === "private-key-block"
          ? { ...rule, rewrite: (value: string) => value.replace(rule.pattern, "[CUSTOM]") } : rule) }))
          .toBe("[REDACTED]")
      })
    }

    for (const prefix of ["smm_", `smt1.${claims}.`]) {
      it(`redacts overlapping PEM and ${prefix.split(".")[0]} credentials as one value`, () => {
        const signature = "A".repeat(30) + "-----BEGINABQ"
        expect(Buffer.from(signature, "base64url").toString("base64url")).toBe(signature)
        expect(redact(`rejected ${prefix}${signature} PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----`))
          .toBe("[REDACTED]")
      })
    }

    for (const prefix of ["smm_", `smt1.${claims}.`]) {
      it(`redacts the complete ${prefix.split(".")[0]} token before an interior provider key`, () => {
        const token = prefix + "A".repeat(30) + "-sk-" + "B".repeat(8) + "Q"
        expect(redact(`rejected ${token} upstream`)).toBe("rejected [REDACTED] upstream")
      })
    }

    it("preserves prefix descriptions and incomplete wire forms", () => {
      const message = `smm_ prefix; smt1. format; smm_${"a".repeat(42)}; smt1.e30.${"b".repeat(42)}`
      expect(redact(message)).toBe(message)
    })

    it("redacts a scoped token before an interior machine token", () => {
      const signature = "AAAA-smm_" + "B".repeat(33) + "Q"
      expect(redact(`rejected smt1.${claims}.${signature}_upstream`)).toBe("rejected [REDACTED]")
    })

    for (const [kind, credential] of [
      ["API key", `sk-proj-ABsmm_${"B".repeat(42)}Q`],
      ["GitHub PAT", `github_pat_ABCsmm_${"B".repeat(42)}Q`],
      ["GitLab token", `glpat-ABCsmm_${"B".repeat(42)}Q`],
      ["JWT", `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJpbnZlbnRlZCJ9.smm_${"B".repeat(38)}Q_upstream`]
    ]) {
      it(`redacts an enclosing ${kind} before an interior Smithers match can fragment it`, () => {
        expect(redact(`rejected (${credential}). upstream`)).toBe("rejected ([REDACTED]). upstream")
      })
    }

    for (const [kind, token] of tokens) {
      it(`redacts contextual ${kind} Basic headers without splitting the scoped prefix`, () => {
        expect(redact(`Authorization: Basic ${token}`)).toBe(
          surface === "diagnostic" ? "[REDACTED]" : "Authorization: Basic [REDACTED]"
        )
      })
      for (const [context, message, expected] of [
        ["header", `Authorization: Bearer ${token}+remainingSecret`, "[REDACTED]"],
        ["bearer separators", `Bearer ${token}/remaining~Secret`, "[REDACTED]"],
        ["assignment name", `${token}_password=remainingSecret`, "[REDACTED]"]
      ]) {
        it(`redacts contextual ${kind} ${context} before changing its token`, () => {
          expect(redact(message)).toBe(expected)
        })
      }
      if (surface === "diagnostic") {
        it(`redacts contextual ${kind} signed queries before changing their token`, () => {
          expect(redact(`https://example.test/?sig=${token}+remainingSecret`))
            .toBe("[REDACTED]")
        })
      }
    }
  })
}

it("preserves custom policies, contextual-name aliases and preceding custom rules", () => {
  const token = `smm_${tail}`
  const custom = { id: "assignment", pattern: new RegExp(token, "g"), replace: "CUSTOM" }
  expect(Redaction.redact(`rejected ${token}`, { rules: [...Redaction.defaultRules, custom] }))
    .toBe("rejected [REDACTED]")
  expect(Redaction.redact(`${token}_password=public`, { rules: [custom] }))
    .toBe("CUSTOM_password=public")
  const machine = Redaction.defaultRules.find((rule) => rule.id === "smithers-machine-token")!
  const changed = { ...machine, pattern: /other/g }
  expect(Redaction.redact(`${token}_password=public`, { rules: [changed] }))
    .toBe(`${token}_password=public`)
  const preceding = { id: "custom-before", pattern: /Bearer [A-Za-z0-9_!-]+/g, replace: "[CUSTOM]" }
  expect(Redaction.redact(`Bearer ${token}!remainingSecret`, { rules: [preceding, ...Redaction.defaultRules] }))
    .toBe("[CUSTOM]")
  const pem = Redaction.defaultRules.find((rule) => rule.id === "private-key-block")!
  const block = "-----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----"
  expect(Redaction.redact(`${token}\n${block}`, { rules: [{ ...pem, replace: "[CUSTOM]" }] }))
    .toBe(`${token}\n[CUSTOM]`)
})

it("fails closed when interposed custom rules block contextual composition", () => {
  const scoped = Redaction.diagnosticRules.find((rule) => rule.id === "smithers-scoped-token")!
  const machine = Redaction.diagnosticRules.find((rule) => rule.id === "smithers-machine-token")!
  const other = Redaction.diagnosticRules.filter((rule) => rule !== scoped && rule !== machine)
  const custom = { id: "between", pattern: /Bearer [A-Za-z0-9_!-]+/g, replace: "[CUSTOM]" }
  const message = `smt1.e30.${tail}\nBearer smm_${tail}!remainingSecret`
  expect(Redaction.redact(message, { rules: [scoped, custom, machine, ...other] })).toBe("[REDACTED]")
})

it("closes a selected Smithers rule over PEM text and preserves a mere BEGIN mention", () => {
  const scoped = Redaction.defaultRules.find((rule) => rule.id === "smithers-scoped-token")!
  const token = `smt1.${claims}.${tail}`
  const block = "-----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----"
  expect(Redaction.redact(`${token}\n${block}`, { rules: [scoped] })).toBe("[REDACTED]")
  expect(Redaction.redact(`rejected ${token} -----BEGIN note`))
    .toBe("rejected [REDACTED] -----BEGIN note")
  expect(Redaction.redact(`smm_ prefix\n${block}`)).toBe("smm_ prefix\n[REDACTED]")
})

for (const [kind, token] of tokens) {
  it(`releases a complete ${kind} header without suppressing later stream lines`, () => {
    const stream = Redaction.lineRedactor()
    expect(stream.line(`Authorization: Bearer ${token}`)).toEqual(["[REDACTED]"])
    expect(stream.line("ordinary progress")).toEqual(["ordinary progress"])
    expect(stream.flush()).toEqual([])
  })
  it(`holds an unfinished quoted ${kind} credential until it closes`, () => {
    const stream = Redaction.lineRedactor()
    expect(stream.line(`password="${token}`)).toEqual([])
    expect(stream.line('remaining secret"')).toEqual(["[REDACTED]"])
    expect(stream.line("ordinary progress")).toEqual(["ordinary progress"])
    expect(stream.flush()).toEqual([])
  })
  for (const custom of [false, true]) {
    it(`releases a closed overlapping ${kind} PEM block in a stream (${custom ? "custom" : "default"})`, () => {
      const rules = Redaction.diagnosticRules.map((rule) => custom && rule.id === "private-key-block"
        ? { ...rule, replace: "[CUSTOM]" } : rule)
      const stream = Redaction.lineRedactor(rules)
      const prefix = kind === "machine" ? "smm_" : "smt1.e30."
      expect(stream.line(`${prefix}${"A".repeat(30)}-----BEGINABQ PRIVATE KEY-----`)).toEqual([])
      expect(stream.line("invented private body")).toEqual([])
      expect(stream.line("-----END PRIVATE KEY-----")).toEqual(["[REDACTED]"])
      expect(stream.line("ordinary progress")).toEqual(["ordinary progress"])
      expect(stream.flush()).toEqual([])
    })
  }
}

for (const prefix of ["smm_", "smt1.e30."]) {
  it(`holds a stream credential whose ${prefix} assignment name contains a provider key`, () => {
    const stream = Redaction.lineRedactor()
    const token = prefix + "A".repeat(30) + "-sk-" + "B".repeat(8) + "Q"
    expect(stream.line(`${token}_password="first secret`)).toEqual([])
    expect(stream.line('remaining secret"')).toEqual(["[REDACTED]"])
    expect(stream.line("ordinary progress")).toEqual(["ordinary progress"])
    expect(stream.flush()).toEqual([])
  })
}

for (const prefix of ["smm_", "smt1.e30."]) {
  const token = prefix + "A".repeat(42) + "Q"
  for (const [kind, first] of [
    ["assignment", `Bearer ${token}_password="first secret`],
    ["flag", `Bearer --password "${token} first secret`]
  ]) {
    it(`holds a ${prefix} stream ${kind} before destructive Bearer rewriting`, () => {
      const stream = Redaction.lineRedactor()
      expect(stream.line(first!)).toEqual([])
      expect(stream.line('remaining secret"')).toEqual(["[REDACTED]"])
      expect(stream.line("ordinary progress")).toEqual(["ordinary progress"])
      expect(stream.flush()).toEqual([])
    })
  }
}

it("keeps preceding custom stream rules ahead of independent contextual checks", () => {
  const token = `smm_${tail}`
  const custom = { id: "stream-custom-first", pattern: /^Bearer [^\n]+/g, replace: "[CUSTOM]" }
  const stream = Redaction.lineRedactor([custom, ...Redaction.diagnosticRules])
  expect(stream.line(`Bearer ${token}_password="first secret`)).toEqual(["[CUSTOM]"])
  expect(stream.line("ordinary progress")).toEqual(["ordinary progress"])
  expect(stream.flush()).toEqual([])
})

for (const prefix of ["smm_", "smt1.e30."]) {
  for (const before of [true, false]) {
    it(`respects the ${before ? "preceding" : "interposed"} custom stream boundary (${prefix})`, () => {
      const custom = { id: "stream-custom", pattern: /^Bearer [^\n]+/g, replace: "[CUSTOM]" }
      const smithers = Redaction.diagnosticRules.filter((rule) => rule.id.startsWith("smithers-"))
      const other = Redaction.diagnosticRules.filter((rule) => !rule.id.startsWith("smithers-"))
      const rules = before ? [custom, ...smithers, ...other] : [...smithers, custom, ...other]
      const stream = Redaction.lineRedactor(rules)
      const first = `Bearer ${prefix}${"A".repeat(42)}Q_password="first secret`
      expect(stream.line(first)).toEqual(before ? ["[CUSTOM]"] : [])
      if (!before) expect(stream.line('remaining secret"')).toEqual([])
      expect(stream.line("ordinary progress")).toEqual(before ? ["ordinary progress"] : [])
      expect(stream.flush()).toEqual(before ? [] : ["[REDACTED]"])
    })
  }
}

for (const prefix of ["%73mm_", "%73mt1.e30."]) {
  it(`recognizes ${prefix} at its ordered position after a preceding custom rewrite`, () => {
    const decode = { id: "decode-prefix", pattern: /%73/g, replace: "s" }
    const stream = Redaction.lineRedactor([decode, ...Redaction.diagnosticRules])
    expect(stream.line(`Bearer ${prefix}${"A".repeat(42)}Q_password="first secret`)).toEqual([])
    expect(stream.line('remaining secret"')).toEqual(["[REDACTED]"])
    expect(stream.line("ordinary progress")).toEqual(["ordinary progress"])
    expect(stream.flush()).toEqual([])
  })
}

for (const prefix of ["smm_", "smt1.e30."]) {
  it(`tracks ordered ${prefix} recognition over multiple fixed-point decoding passes`, () => {
    const decode = { id: "percent-decoder", pattern: /%[0-9a-f]{2}/gi, rewrite: decodeURIComponent }
    const stream = Redaction.lineRedactor([decode, ...Redaction.diagnosticRules])
    const encodedPrefix = prefix.replace(/^s/, "%2573")
    expect(stream.line(`%2542earer%2520${encodedPrefix}${"A".repeat(42)}Q_password%253D%2522first%2520secret`)).toEqual([])
    expect(stream.line('remaining secret"')).toEqual(["[REDACTED]"])
    expect(stream.line("ordinary progress")).toEqual(["ordinary progress"])
    expect(stream.flush()).toEqual([])
  })
  it(`holds an unfinished overlapping ${prefix} PEM with a completed-block-only custom rewrite`, () => {
    const rules = Redaction.diagnosticRules.map((rule) => rule.id === "private-key-block" ? {
      ...rule, rewrite: (text: string) => text.replace(rule.pattern, (block) => block.includes("-----END") ? "[CUSTOM]" : block)
    } : rule)
    const stream = Redaction.lineRedactor(rules)
    expect(stream.line(`${prefix}${"A".repeat(30)}-----BEGINABQ PRIVATE KEY-----`)).toEqual([])
    expect(stream.line("invented private body")).toEqual([])
    expect(stream.line("-----END PRIVATE KEY-----")).toEqual(["[REDACTED]"])
    expect(stream.line("ordinary progress")).toEqual(["ordinary progress"])
    expect(stream.flush()).toEqual([])
  })
}
