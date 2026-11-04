/**
 * File contents against a fake GitHub on a real socket that answers the way
 * the contents API does: a file as wrapped base64, a directory as an array, a
 * symlink or an oversized file as an object that is not base64 text.
 */
import { Effect, Option } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import * as Contents from "../src/github/Contents.vibe"
import type { GitHubClient } from "../src/github/GitHubClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"
import { gitHubLayer } from "./Http.ts"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

// GitHub wraps the base64 at 60 characters.
const wrapped = (bytes: Uint8Array): string =>
  (Buffer.from(bytes).toString("base64").match(/.{1,60}/g) ?? []).join("\n") + "\n"

const file = (text: string, sha = "a1b2c3"): unknown => ({
  type: "file",
  encoding: "base64",
  size: Buffer.byteLength(text),
  name: "x",
  path: "x",
  content: wrapped(new TextEncoder().encode(text)),
  sha
})

/** Answers keyed by `ref` then by the decoded path; the default branch is `""`. */
const startGitHub = async (answers: Record<string, Record<string, unknown>>): Promise<Fixture> => {
  fixture = await startFixture((request, response) => {
    const url = new URL(request.url, "http://github.test")
    const match = /^\/repos\/o\/r\/contents\/(.+)$/.exec(url.pathname)
    const answer = match === null
      ? undefined
      : answers[url.searchParams.get("ref") ?? ""]?.[match[1]!.split("/").map(decodeURIComponent).join("/")]
    if (answer === undefined) return json(response, 404, { message: "Not Found" })
    if (typeof answer === "number") return json(response, answer, { message: "Server Error" })
    json(response, 200, answer)
  })
  return fixture
}

const layer = () => gitHubLayer({ token: "token-for-tests", apiBaseUrl: (fixture as Fixture).origin }, {})

const run = <A>(effect: Effect.Effect<A, IntegrationError, GitHubClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer())))

const failure = <A>(effect: Effect.Effect<A, IntegrationError, GitHubClient>): Promise<IntegrationError> =>
  Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(layer())))

const TEXT = "# Triage\n\nAccept bugs with steps — reject “support” questions. ✓\n".repeat(4)

describe("getText", () => {
  it.each(["docs/\uD800.md", "docs/\uDC00.md", "docs/\uD800x.md"])(
    "reports an unpaired surrogate as IntegrationError before any request (%j)",
    async (path) => {
      await startGitHub({})
      const error = await failure(Contents.getText("o", "r", path))
      expect(error.reason).toBe("invalid-config")
      expect(error.details).toMatchObject({ field: "path", retryable: false })
      expect(fixture!.requests).toHaveLength(0)
    }
  )

  it("accepts a valid surrogate pair in a file path", async () => {
    await startGitHub({ "": { "docs/\uD83D\uDE80.md": file("rocket") } })
    expect(Option.getOrThrow(await run(Contents.getText("o", "r", "docs/\uD83D\uDE80.md"))).text).toBe("rocket")
  })

  it("decodes a file's wrapped base64 as UTF-8 text, on the default branch", async () => {
    await startGitHub({ "": { ".smithers/triage.md": file(TEXT, "f00d") } })
    expect(TEXT.length).toBeGreaterThan(60)
    const found = await run(Contents.getText("o", "r", ".smithers/triage.md"))
    expect(Option.getOrThrow(found)).toEqual({ sha: "f00d", text: TEXT })
    expect(fixture!.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /repos/o/r/contents/.smithers/triage.md"
    ])
  })

  it("reads at `ref`, and encodes each path segment", async () => {
    await startGitHub({ "release/1.x": { "docs/a b#?.md": file("at ref") } })
    const found = await run(Contents.getText("o", "r", "docs/a b#?.md", { ref: "release/1.x" }))
    expect(Option.getOrThrow(found).text).toBe("at ref")
    const [request] = fixture!.requests
    expect(new URL(request!.url, "http://x").pathname).toBe("/repos/o/r/contents/docs/a%20b%23%3F.md")
    expect(new URL(request!.url, "http://x").searchParams.get("ref")).toBe("release/1.x")
  })

  it("answers none when GitHub answers 404", async () => {
    await startGitHub({ "": {} })
    expect(Option.isNone(await run(Contents.getText("o", "r", "missing.md")))).toBe(true)
    expect(Option.isNone(await run(Contents.getText("o", "r", "missing.md", { ref: "main" })))).toBe(true)
  })

  it("decodes an empty file as empty text", async () => {
    await startGitHub({ "": { "empty.md": file("") } })
    expect(Option.getOrThrow(await run(Contents.getText("o", "r", "empty.md"))).text).toBe("")
  })

  it.each<[string, unknown]>([
    ["a directory", [{ type: "file", name: "a.md", path: "docs/a.md", sha: "1" }]],
    ["a symlink", { type: "symlink", target: "../elsewhere", sha: "1", name: "x", path: "x" }],
    ["a submodule", { type: "submodule", submodule_git_url: "https://github.test/x.git", sha: "1" }],
    ["a file over the 1 MB contents limit", { type: "file", encoding: "none", content: "", sha: "1" }],
    ["a file without a sha", { type: "file", encoding: "base64", content: "" }]
  ])("fails decode-failed on %s", async (_name, answer) => {
    await startGitHub({ "": { target: answer as Record<string, unknown> } })
    const error = await failure(Contents.getText("o", "r", "target"))
    expect(error.reason).toBe("decode-failed")
    expect(error.details).toMatchObject({ method: "GET", path: "/repos/o/r/contents/target" })
  })

  it.each<[string, string]>([
    ["content that is not base64", "@@not base64@@"],
    ["bytes that are not UTF-8", Buffer.from([0x66, 0xff, 0xfe, 0x6f]).toString("base64")]
  ])("fails decode-failed on %s", async (_name, content) => {
    await startGitHub({ "": { "image.png": { type: "file", encoding: "base64", content, sha: "1" } } })
    const error = await failure(Contents.getText("o", "r", "image.png"))
    expect(error.reason).toBe("decode-failed")
    expect(error.message).toContain("not base64 UTF-8 text")
    expect(error.details).toMatchObject({ method: "GET", path: "/repos/o/r/contents/image.png" })
  })

  it("passes a failure other than 404 through, retryable for a read", async () => {
    await startGitHub({ "": { "flaky.md": 503 as unknown as Record<string, unknown> } })
    const error = await failure(Contents.getText("o", "r", "flaky.md"))
    expect(error.reason).toBe("delivery-failed")
    expect(error.details).toMatchObject({ status: 503, retryable: true, outcomeUnknown: false })
  })

  it.each<[string, unknown]>([
    ["an empty path", ""],
    ["an absolute path", "/etc/passwd"],
    ["a trailing slash", "docs/"],
    ["an empty segment", "docs//a.md"],
    ["a `.` segment", "./a.md"],
    ["a `..` segment", "docs/../../../user"],
    ["a lone `..`", ".."],
    ["a backslash", "docs\\a.md"],
    ["a control character", "docs/a\u0000.md"],
    ["a newline", "docs/a\n.md"],
    ["a delete character", "a\u007F"],
    ["a path that is not a string", 7]
  ])("refuses %s before any request", async (_name, path) => {
    await startGitHub({})
    const error = await failure(Contents.getText("o", "r", path as string))
    expect(error.reason).toBe("invalid-config")
    expect(error.details).toMatchObject({ field: "path", retryable: false })
    expect(fixture!.requests).toHaveLength(0)
  })

  it.each<[string, unknown]>([
    ["an empty ref", ""],
    ["a ref with a space", "main branch"],
    ["a ref with a control character", "main\u0001"],
    [`a ${Contents.MAX_REF_LENGTH + 1}-character ref`, "r".repeat(Contents.MAX_REF_LENGTH + 1)],
    ["a ref that is not a string", 1]
  ])("refuses %s before any request", async (_name, ref) => {
    await startGitHub({})
    const error = await failure(Contents.getText("o", "r", "a.md", { ref: ref as string }))
    expect(error.reason).toBe("invalid-config")
    expect(error.details).toMatchObject({ field: "ref", retryable: false })
    expect(fixture!.requests).toHaveLength(0)
  })

  it(`accepts a ${Contents.MAX_REF_LENGTH}-character ref`, async () => {
    const ref = "r".repeat(Contents.MAX_REF_LENGTH)
    await startGitHub({ [ref]: { "a.md": file("long ref") } })
    expect(Option.getOrThrow(await run(Contents.getText("o", "r", "a.md", { ref }))).text).toBe("long ref")
  })

  it("refuses a traversing owner before any request", async () => {
    await startGitHub({})
    expect((await failure(Contents.getText("..", "r", "a.md"))).details).toMatchObject({ field: "owner" })
    expect(fixture!.requests).toHaveLength(0)
  })
})
