/**
 * Child repository output reaches the parent's reporter redacted a complete
 * line at a time with the diagnostic rules, and so does the failure's stderr tail.
 */
import { afterEach, describe, expect, it } from "vitest"
import * as RepoResolution from "../src/RepoResolution.ts"
import { fixture } from "./helpers/RepositoryProcess.ts"
let host = fixture()
afterEach(async () => {
  await host.cleanup()
  host = fixture()
})
const resolution = {
  repoName: "child",
  repoPath: "child",
  absolutePath: "/child",
  label: "//:test",
  args: [],
  kinds: ["test"],
  refusal: undefined,
  externalLabel: "@child//:test"
} as import("../src/RepoResolution.ts").Resolution
const resolver = () => RepoResolution.Resolver.make({} as RepoResolution.Resolver["index"], {}, host.services)

describe("child repository output", () => {
  it("never submits an unfinished overlong line as complete", async () => {
    const secret = "ZqSynthetic7Secret4Value9"
    const seen: Array<string> = []
    const execution = RepoResolution.execute(resolver(), resolution, { output: (_stream, text) => seen.push(text) })
    await host.write("stdout", `${"x".repeat(65_537)} pass`)
    await host.write("stdout", `word=${secret}\n`)
    await host.finish()
    await execution
    expect(seen.join("")).not.toContain(secret)
    expect(seen.join("")).toContain("[overlong line omitted]")
  })

  it("redacts diagnostic spellings and values split across chunks before the reporter and the failure", async () => {
    const secret = "ZqSynthetic7Secret4Value9"
    const seen: Array<string> = []
    const resolution = {
      repoName: "child",
      repoPath: "child",
      absolutePath: "/child",
      label: "//:test",
      args: [],
      kinds: ["test"],
      refusal: undefined,
      externalLabel: "@child//:test"
    } as import("../src/RepoResolution.ts").Resolution
    const execution = RepoResolution.execute(resolver(), resolution, {
      output: (stream, text) => seen.push(`${stream}:${text}`)
    })
    const text = `sshpass -p ${secret.slice(0, 9)}`
    await host.write("stderr", text)
    await host.write("stderr", `${secret.slice(9)} ssh host\npassword: "\n${secret}\n"\n`)
    await host.write("stdout", `Authorization: Token ${secret}\n`)
    const failed = execution.then(() => undefined, (cause: unknown) => cause)
    await host.finish(1)
    const failure = (await failed) as Error
    expect(seen.join("")).not.toContain(secret)
    expect(seen.join("")).not.toContain(secret.slice(9))
    expect(seen).toContain("stdout:Authorization: [REDACTED]\n")
    expect(failure).toBeInstanceOf(RepoResolution.ExecutionError)
    expect(failure.message).toContain("sshpass -p [REDACTED] ssh host")
    expect(failure.message).not.toContain(secret)
  })
})
