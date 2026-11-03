/**
 * Repository coordinates as request-path segments.
 *
 * The property under test is that a hostile `owner` or `repo` cannot leave the
 * endpoint it was interpolated into. Encoding alone does not achieve that:
 * `encodeURIComponent("..")` is `".."`, and even a hand-written `%2E%2E` is
 * decoded before the URL parser removes dot segments. The first test here
 * proves that against `new URL` itself, so the reason this module validates
 * rather than encodes is recorded in an assertion instead of a comment.
 */
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Actions from "../src/github/Actions.ts"
import {
  fullNamePath,
  isOwner,
  isRepo,
  Owner,
  Repo,
  repositoryPath,
  requireFullNamePath,
  requireRepositoryPath
} from "../src/github/Repository.vibe"

describe("the traversal this module exists for", () => {
  it("survives encodeURIComponent and percent-encoding, which is why segments are validated", () => {
    expect(encodeURIComponent("..")).toBe("..")
    expect(new URL("https://api.github.com/repos/../../user/issues/1/comments").pathname)
      .toBe("/user/issues/1/comments")
    expect(new URL("https://api.github.com/repos/%2E%2E/%2E%2E/user/hooks").pathname).toBe("/user/hooks")
  })
})

describe("repositoryPath", () => {
  it("encodes a well-formed pair", () => {
    expect(repositoryPath("smithersai", "smithers")).toBe("smithersai/smithers")
    expect(repositoryPath("a-b", "c.d_e-f")).toBe("a-b/c.d_e-f")
    expect(fullNamePath("smithersai/smithers")).toBe("smithersai/smithers")
  })

  it("refuses every segment that could leave the endpoint", () => {
    for (const [owner, repo] of [["..", ".."], [".", "x"], ["x", ".."], ["a/b", "c"], ["x", "a/b"], ["", "x"]]) {
      expect(() => repositoryPath(owner as string, repo as string)).toThrow(/not a valid name/)
    }
    expect(() => fullNamePath("../..")).toThrow(/not a valid name/)
    expect(() => fullNamePath("one-part")).toThrow(/not a valid name/)
  })

  it("refuses a name longer than GitHub issues", () => {
    expect(() => repositoryPath("a".repeat(40), "x")).toThrow(/not a valid name/)
    expect(() => repositoryPath("a", "x".repeat(101))).toThrow(/not a valid name/)
  })

  it("classifies the refusal as invalid-config in the Effect channel", async () => {
    const failure = await Effect.runPromise(Effect.flip(requireRepositoryPath("..", "..")))
    expect(failure.reason).toBe("invalid-config")
    expect(failure.details).toMatchObject({ field: "owner" })
  })

  it("refuses a value that is not a string, without quoting it back", () => {
    expect(() => fullNamePath(7 as unknown as string)).toThrow(/not a valid name/)
    expect(() => repositoryPath(null as unknown as string, "r")).toThrow(/not a valid name/)
  })

  it("agrees with its refinements", () => {
    expect(isOwner("smithersai")).toBe(true)
    expect(isOwner("-leading")).toBe(false)
    expect(isRepo("a.b")).toBe(true)
    expect(isRepo("..")).toBe(false)
    expect(isRepo(".")).toBe(false)
  })

  // A GitHub Enterprise Managed User's login is `<name>_<enterprise shortcode>`
  // and it owns repositories in its own namespace. Refusing the underscore
  // locked every enterprise-managed account out of this package, and it bought
  // nothing: only `.` and `/` can leave the endpoint.
  it("accepts a managed user's underscore login", () => {
    expect(isOwner("mona_contoso")).toBe(true)
    expect(repositoryPath("mona_contoso", "repo")).toBe("mona_contoso/repo")
    expect(fullNamePath("octo_admin/notes")).toBe("octo_admin/notes")
  })

  it("still refuses an underscore where GitHub does not allow one", () => {
    expect(isOwner("_leading")).toBe(false)
    expect(isOwner("trailing_")).toBe(false)
    expect(isOwner("a_b_c_d_e_f")).toBe(false)
  })
})

const decode = <A>(schema: Schema.Schema<A>, value: unknown) =>
  Effect.runPromise(Effect.exit(Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<A, unknown>))

describe("the schemas an action payload demands", () => {
  it("accepts real coordinates", async () => {
    expect((await decode(Owner, "smithersai"))._tag).toBe("Success")
    expect((await decode(Repo, "smithers"))._tag).toBe("Success")
  })

  it("refuses a dot segment", async () => {
    expect((await decode(Owner, ".."))._tag).toBe("Failure")
    expect((await decode(Repo, ".."))._tag).toBe("Failure")
    expect((await decode(Repo, "."))._tag).toBe("Failure")
  })

  // A flow that passes a webhook-derived or model-derived repository string
  // must not be able to drive an authenticated write to an arbitrary path.
  it("stops a traversal at the CommentOnIssue payload boundary", async () => {
    const exit = await decode(
      Actions.CommentOnIssuePayload,
      { owner: "..", repo: "..", issueNumber: 1, body: "hello" }
    )
    expect(exit._tag).toBe("Failure")
    expect((await decode(Actions.CommentOnIssuePayload, { owner: "o", repo: "r", issueNumber: 0, body: "b" }))._tag)
      .toBe("Failure")
    expect((await decode(Actions.CommentOnIssuePayload, { owner: "o", repo: "r", issueNumber: 1.5, body: "b" }))._tag)
      .toBe("Failure")
    expect((await decode(Actions.CommentOnIssuePayload, { owner: "o", repo: "r", issueNumber: 7, body: "b" }))._tag)
      .toBe("Success")
  })
})

describe("requireFullNamePath", () => {
  it("resolves a declared repository and refuses one that is not a name", async () => {
    expect(await Effect.runPromise(requireFullNamePath("smithersai/smithers"))).toBe("smithersai/smithers")
    const failure = await Effect.runPromise(Effect.flip(requireFullNamePath("../..")))
    expect(failure.reason).toBe("invalid-config")
  })
})
