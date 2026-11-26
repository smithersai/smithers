import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Result } from "effect"
import { describe, expect, test } from "vitest"
import { decodeJevConfig, Jev, JevConfigError, type JevConfigErrorCode, resolveRepoPath } from "./config"

const decision = {
  kind: "classify",
  labels: ["bug", "feature", "question", "docs"],
  evaluators: [
    { use: "pattern", field: "title", match: { "^\\[docs\\]": "docs" } },
    { use: "judge", seat: "triage", sure: 0.8 },
  ],
  onUnsure: { action: "request-human", who: "maintainers" },
  onFailure: { action: "fail", surface: "triage-queue" },
  examples: "./jev/issue-kind.examples.jsonl",
  minAccuracy: 0.9,
}

const valid = {
  seats: { triage: { owner: "maintainer:roninjin10", runner: "node:mac-mini", dailyTokens: 2_000_000 } },
  decisions: { "issue.kind": decision },
}

const withDecision = (patch: Record<string, unknown>) => ({
  ...valid,
  decisions: { "issue.kind": { ...decision, ...patch } },
})

const without = (key: "onUnsure" | "onFailure") => {
  const { [key]: _dropped, ...rest } = decision
  return { ...valid, decisions: { "issue.kind": rest } }
}

const refusal = (input: unknown): { code: JevConfigErrorCode; path: string } | undefined => {
  const result = decodeJevConfig(input)
  if (Result.isSuccess(result)) return undefined
  expect(result.failure._tag).toBe("JevConfigError")
  return { code: result.failure.code, path: result.failure.path }
}

describe("Jev.config", () => {
  test("accepts the Gate 4 example", () => {
    expect(refusal(valid)).toBeUndefined()
  })

  test("accepts every evaluator kind", () => {
    expect(refusal(withDecision({
      labels: ["bug", "docs"],
      evaluators: [
        { use: "pattern", field: "title", match: { "^fix": "bug" } },
        { use: "template", field: "body", template: "./.github/ISSUE_TEMPLATE/bug.md", label: "bug" },
        { use: "path", match: { "^docs/": "docs" } },
        { use: "schema", field: "body", schema: "./jev/bug.schema.json", label: "bug" },
        { use: "script", script: "./jev/kind.sh" },
        { use: "judge", seat: "triage", sure: 0.9 },
      ],
    }))).toBeUndefined()
  })

  test("refuses a decision without onUnsure", () => {
    expect(refusal(without("onUnsure"))?.code).toBe("invalid_shape")
  })

  test("refuses a decision without onFailure", () => {
    expect(refusal(without("onFailure"))?.code).toBe("invalid_shape")
  })

  test.each([
    { onFailure: { action: "pass" } },
    { onFailure: { action: "pass", surface: "triage-queue" } },
    { onUnsure: { action: "pass" } },
    { onFailure: "pass" },
  ])("refuses a pass handler %j", (patch) => {
    expect(refusal(withDecision(patch))?.code).toBe("invalid_shape")
  })

  test("refuses a judge on an undeclared seat", () => {
    expect(refusal(withDecision({ evaluators: [{ use: "judge", seat: "review", sure: 0.8 }] }))).toEqual({
      code: "undeclared_seat",
      path: "decisions.issue.kind.evaluators.0.seat",
    })
  })

  test("refuses a judge seat that is only an inherited property name", () => {
    expect(refusal(withDecision({ evaluators: [{ use: "judge", seat: "constructor", sure: 0.8 }] }))?.code)
      .toBe("undeclared_seat")
  })

  test("refuses an evaluator that decides a label the decision doesn't list", () => {
    expect(refusal(withDecision({ evaluators: [{ use: "path", match: { "^src/": "refactor" } }] }))).toEqual({
      code: "unknown_label",
      path: "decisions.issue.kind.evaluators.0",
    })
  })

  test.each([
    ["an unknown evaluator", { evaluators: [{ use: "llm", seat: "triage" }] }],
    ["no evaluators", { evaluators: [] }],
    ["a judge sure below 0.5", { evaluators: [{ use: "judge", seat: "triage", sure: 0.2 }] }],
    ["a single label", { labels: ["bug"] }],
  ])("refuses %s", (_name, patch) => {
    expect(refusal(withDecision(patch))?.code).toBe("invalid_shape")
  })

  test("refuses a seat that isn't a maintainer's", () => {
    expect(refusal({ ...valid, seats: { triage: { ...valid.seats.triage, owner: "contributor:someone" } } })?.code)
      .toBe("invalid_shape")
  })

  test("refuses the same configs at compile time", () => {
    const seats = valid.seats
    const ok = Jev.config({
      seats,
      decisions: {
        "issue.kind": {
          kind: "classify",
          labels: ["bug", "docs"],
          evaluators: [{ use: "judge", seat: "triage", sure: 0.8 }],
          onUnsure: { action: "request-human", who: "maintainers" },
          onFailure: { action: "fail", surface: "triage-queue" },
        },
      },
    })
    expect(refusal(ok)).toBeUndefined()
    // Never called: each line only has to fail the typecheck.
    const compileOnly = () => [
      Jev.config({
        seats,
        // @ts-expect-error onUnsure is required
        decisions: { a: { kind: "classify", labels: ["x", "y"], evaluators: [{ use: "script", script: "./a.sh" }], onFailure: { action: "fail", surface: "q" } } },
      }),
      Jev.config({
        seats,
        // @ts-expect-error onFailure is required
        decisions: { a: { kind: "classify", labels: ["x", "y"], evaluators: [{ use: "script", script: "./a.sh" }], onUnsure: { action: "fail", surface: "q" } } },
      }),
      Jev.config({
        seats,
        // @ts-expect-error pass is not a failure handler
        decisions: { a: { kind: "classify", labels: ["x", "y"], evaluators: [{ use: "script", script: "./a.sh" }], onUnsure: { action: "fail", surface: "q" }, onFailure: { action: "pass" } } },
      }),
      Jev.config({
        seats,
        // @ts-expect-error review is not a declared seat
        decisions: { a: { kind: "classify", labels: ["x", "y"], evaluators: [{ use: "judge", seat: "review", sure: 0.8 }], onUnsure: { action: "fail", surface: "q" }, onFailure: { action: "fail", surface: "q" } } },
      }),
    ]
    expect(typeof compileOnly).toBe("function")
  })

  // M6: a key the schema does not know refuses the whole config. Effect's default drops it, which would silently
  // discard a misspelled decision and leave its judgment unmade.
  test.each([
    ["a decision whose name fails the key pattern", { ...valid, decisions: { ...valid.decisions, "Issue_Kind": decision } }],
    ["only a misspelled decision", { ...valid, decisions: { "issue kind": decision } }],
    ["a misspelled top-level key", { ...valid, decision: valid.decisions }],
    ["an extra top-level key", { ...valid, fallback: { use: "judge" } }],
    ["a misspelled handler beside the real ones", withDecision({ onFailur: { action: "fail", surface: "q" } })],
    ["a pass key smuggled beside a handler", withDecision({ onFailure: { action: "fail", surface: "q", pass: true } })],
    ["an extra evaluator key", withDecision({ evaluators: [{ use: "script", script: "./a.sh", fallback: "judge" }] })],
    ["a seat whose name fails the key pattern", { ...valid, seats: { ...valid.seats, "Review Seat": valid.seats.triage } }],
    ["an extra seat key", { ...valid, seats: { triage: { ...valid.seats.triage, model: "any" } } }],
  ])("refuses %s", (_name, input) => {
    expect(refusal(input)).toEqual({ code: "invalid_shape", path: "" })
  })

  test("Jev.config validates at run time what a cast got past the compiler", () => {
    const thrown = (input: unknown) => {
      try {
        Jev.config(input as never)
      } catch (error) {
        return error
      }
      return undefined
    }
    for (const bad of [
      withDecision({ onFailure: { action: "pass" } }),
      without("onUnsure"),
      { ...valid, decisions: { ...valid.decisions, "Issue_Kind": decision } },
      withDecision({ evaluators: [{ use: "script", script: "./../outside.sh" }] }),
    ]) {
      const error = thrown(bad)
      expect(error).toBeInstanceOf(JevConfigError)
      expect((error as JevConfigError).code).toBe("invalid_shape")
    }
    expect((thrown(withDecision({ evaluators: [{ use: "judge", seat: "review", sure: 0.8 }] })) as JevConfigError).code)
      .toBe("undeclared_seat")
    // A good config comes back decoded, not as the object passed in.
    const ok = Jev.config(valid as never)
    expect(ok).toEqual(valid)
    expect(ok).not.toBe(valid)
  })

  // M7: a repository path cannot climb out of the checkout.
  test.each([
    "./../outside.sh",
    "./..",
    "./jev/../../etc/passwd",
    "./jev/..",
    "./jev/./kind.sh",
    "./jev//kind.sh",
    "./jev/",
    "../kind.sh",
    "/etc/passwd",
  ])("refuses the path %s for a script, a schema, a template and examples", (path) => {
    for (const patch of [
      { evaluators: [{ use: "script", script: path }] },
      { evaluators: [{ use: "schema", field: "body", schema: path, label: "bug" }] },
      { evaluators: [{ use: "template", field: "body", template: path, label: "bug" }] },
      { examples: path },
    ]) {
      expect(refusal(withDecision(patch))?.code).toBe("invalid_shape")
    }
  })

  test("accepts dots that are not a parent segment", () => {
    expect(refusal(withDecision({ evaluators: [{ use: "script", script: "./.github/jev..kind/..kind.sh" }] }))).toBeUndefined()
  })

  test("resolveRepoPath keeps the real file under the checkout", () => {
    const links: Record<string, string> = {
      "/checkout": "/pinned/abc123",
      "/pinned/abc123/jev/leak.sh": "/home/maintainer/.ssh/id_ed25519",
      "/pinned/abc123/jev/sibling.sh": "/pinned/abc123-evil/x.sh",
    }
    const realpath = (path: string) => {
      if (path.endsWith("missing.sh")) throw new Error("ENOENT")
      return links[path] ?? path
    }
    const resolve = (path: string) => resolveRepoPath({ checkout: "/checkout", path, realpath })
    expect(resolve("./jev/kind.sh")).toEqual(Result.succeed("/pinned/abc123/jev/kind.sh"))
    for (const path of ["./jev/leak.sh", "./jev/sibling.sh", "./jev/missing.sh", "./jev/../../x.sh", "jev/kind.sh"]) {
      const refused = resolve(path)
      expect(Result.isFailure(refused) && refused.failure.code).toBe("path_escape")
    }
  })

  test("resolveRepoPath refuses a real symlink escape and a .. traversal on disk", () => {
    const base = mkdtempSync(join(tmpdir(), "jev-resolve-"))
    try {
      const checkout = join(base, "checkout")
      const outside = join(base, "outside")
      mkdirSync(join(checkout, "jev"), { recursive: true })
      mkdirSync(outside)
      writeFileSync(join(checkout, "jev/kind.sh"), "echo bug")
      writeFileSync(join(outside, "secret.sh"), "curl attacker")
      symlinkSync(join(outside, "secret.sh"), join(checkout, "jev/leak.sh"))
      symlinkSync(outside, join(checkout, "data"))
      const resolve = (path: string) => resolveRepoPath({ checkout, path, realpath: realpathSync })
      expect(resolve("./jev/kind.sh")).toEqual(Result.succeed(join(realpathSync(checkout), "jev/kind.sh")))
      for (const path of ["./jev/leak.sh", "./data/secret.sh", "./../outside/secret.sh", "./jev/../../outside/secret.sh"]) {
        const refused = resolve(path)
        expect(Result.isFailure(refused) && refused.failure).toMatchObject({ code: "path_escape", path })
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
