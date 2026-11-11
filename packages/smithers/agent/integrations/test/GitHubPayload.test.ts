import { Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Payload from "../src/github/Payload.vibe"

describe("payload schemas", () => {
  const decodeWith = <A>(schema: Schema.Schema<A>, value: unknown) =>
    Effect.runPromise(
      Effect.exit(Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<A, unknown>)
    )

  it("passes unmodelled fields through untouched", async () => {
    const delivery = {
      action: "opened",
      pull_request: { number: 12, some_new_field: true },
      repository: { full_name: "o/r" },
      unheard_of: { nested: 1 }
    }
    const exit = await decodeWith(Payload.PullRequestEvent, delivery)
    expect(exit._tag).toBe("Success")
    expect(exit._tag === "Success" ? exit.value : undefined).toEqual(delivery)
  })

  it("still rejects a modelled field of the wrong type", async () => {
    const exit = await decodeWith(Payload.PullRequestEvent, {
      action: "opened",
      pull_request: { number: "twelve" },
      repository: { full_name: "o/r" }
    })
    expect(exit._tag).toBe("Failure")
  })

  it("types the issue, comment, and push deliveries", async () => {
    expect(
      (await decodeWith(Payload.IssuesEvent, {
        action: "opened",
        issue: { number: 1 },
        repository: { full_name: "o/r" }
      }))._tag
    ).toBe("Success")
    expect(
      (await decodeWith(Payload.IssueCommentEvent, {
        action: "created",
        issue: { number: 1 },
        comment: { body: "hi" },
        repository: { full_name: "o/r" }
      }))._tag
    ).toBe("Success")
    expect(
      (await decodeWith(Payload.PushEvent, {
        ref: "refs/heads/main",
        repository: { full_name: "o/r" },
        commits: [{ id: "abc", message: "m" }],
        pusher: { name: "will" }
      }))._tag
    ).toBe("Success")
  })
})

describe("pushSource", () => {
  const before = "a".repeat(40), after = "b".repeat(40), zeros = "0".repeat(40)
  const push = { ref: "refs/heads/feature/x", before, after, repository: { full_name: "o/r" } }

  it("names the commit a branch or a tag now points at", () => {
    expect(Payload.pushSource(push)).toEqual(
      Result.succeed({ kind: "commit", ref: "refs/heads/feature/x", branch: "feature/x", tag: null, before, after })
    )
    expect(Payload.pushSource({ ...push, ref: "refs/tags/v1" })).toEqual(
      Result.succeed({ kind: "commit", ref: "refs/tags/v1", branch: null, tag: "v1", before, after })
    )
  })

  it("admits a created ref only when the delivery says it was created", () => {
    expect(Payload.pushSource({ ...push, before: zeros, created: true })).toEqual(
      Result.succeed({ kind: "commit", ref: push.ref, branch: "feature/x", tag: null, before: zeros, after })
    )
    expect(Payload.pushSource({ ...push, before: zeros })).toEqual(Result.fail("no_candidate"))
    expect(Payload.pushSource({ ...push, before: zeros, created: false })).toEqual(Result.fail("no_candidate"))
  })

  it("names a deleted ref and no commit", () => {
    expect(Payload.pushSource({ ...push, after: zeros, deleted: true })).toEqual(
      Result.succeed({ kind: "deleted", ref: push.ref })
    )
    expect(Payload.pushSource({ ...push, deleted: true })).toEqual(Result.fail("deleted_identity"))
    expect(Payload.pushSource({ ...push, before: zeros, after: zeros, deleted: true })).toEqual(
      Result.fail("deleted_identity")
    )
    expect(Payload.pushSource({ ...push, after: zeros })).toEqual(Result.fail("no_candidate"))
  })

  it.each([
    ["a payload that is not an object", null],
    ["a payload that is a string", "push"],
    ["no before", { ref: push.ref, after }],
    ["no after", { ref: push.ref, before }],
    ["a short commit id", { ...push, after: "abc1234" }],
    ["an upper-case commit id", { ...push, after: "B".repeat(40) }],
    ["a commit id that is not a string", { ...push, before: 7 }],
    ["no ref", { before, after }],
    ["a ref outside heads and tags", { ...push, ref: "refs/pull/1/head" }],
    ["a ref with a space", { ...push, ref: "refs/heads/a b" }],
    ["a ref with no name", { ...push, ref: "refs/heads/" }],
    ["a path that is not a ref", { ...push, ref: "../../main" }]
  ])("refuses %s as malformed", (_name, payload) => {
    expect(Payload.pushSource(payload)).toEqual(Result.fail("malformed"))
  })
})
