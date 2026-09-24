import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deployedSource, HOST_PIN_CONTEXT_ENV, hostProducer, readHostPin } from "../run-inspection/revisions"

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", ...args], { cwd, encoding: "utf8" }).trim()

describe("run-inspection source evidence on a git-only clone", () => {
  let root = ""
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "run-inspection-git-"))
    git(root, "init", "-q")
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const commit = (path: string, content: string): string => {
    writeFileSync(join(root, path), content)
    git(root, "add", path)
    git(root, "commit", "-q", "-m", path)
    return git(root, "rev-parse", "HEAD")
  }

  test("deployed sources compare against the working copy without a jj checkout", () => {
    const deployed = commit("card.ts", "old\n")
    expect(deployedSource(deployed, ["card.ts"], root)._tag).toBe("DeployedSourceMatchesWorkingCopy")
    writeFileSync(join(root, "card.ts"), "new\n")
    expect(deployedSource(deployed, ["card.ts"], root)).toMatchObject({ _tag: "DeployedSourcePredatesWorkingCopy", files: ["card.ts"] })
  })

  test("the host producer is read from ancestry without a jj checkout", () => {
    const producer = commit("a.txt", "a\n")
    const host = commit("b.txt", "b\n")
    const pin = { _tag: "HostPinRead" as const, sourceCommit: host, sha256: "0".repeat(64), object: "gs://pin" }
    expect(hostProducer(pin, producer, root)).toBe("HostContainsCommit")
    expect(hostProducer({ ...pin, sourceCommit: producer }, host, root)).toBe("HostPredatesCommit")
  })
})

describe("the coding host pin", () => {
  let bin = ""
  let saved: string | undefined
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "run-inspection-kubectl-"))
    // A kubectl on PATH that records its argv and answers with a manifest, so
    // the test observes which cluster the tier asked and whether it asked at all.
    writeFileSync(join(bin, "kubectl"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(bin, "argv")}"\nprintf '%s' '${JSON.stringify(
      { sourceCommit: "a".repeat(40), sha256: "b".repeat(64), object: "gs://pin" })}'\n`)
    chmodSync(join(bin, "kubectl"), 0o755)
    saved = process.env.PATH
    process.env.PATH = `${bin}:${saved}`
  })
  afterEach(() => {
    process.env.PATH = saved
    rmSync(bin, { recursive: true, force: true })
  })

  test("with no operator context the pin is unread and no cluster is contacted", () => {
    const pin = readHostPin(undefined)
    expect(pin).toMatchObject({ _tag: "HostPinUnread" })
    expect(pin._tag === "HostPinUnread" && pin.message).toContain(HOST_PIN_CONTEXT_ENV)
    expect(existsSync(join(bin, "argv"))).toBe(false)
    expect(hostProducer(pin, "c".repeat(40))).toBe("HostPinUnread")
  })

  test("an operator context names the cluster the pin is read from", () => {
    expect(readHostPin("gke_example_cluster")).toEqual(
      { _tag: "HostPinRead", sourceCommit: "a".repeat(40), sha256: "b".repeat(64), object: "gs://pin" })
    const argv = readFileSync(join(bin, "argv"), "utf8").trim().split("\n")
    expect(argv.slice(0, 2)).toEqual(["--context", "gke_example_cluster"])
    expect(argv.at(-1)).toBe("/usr/local/lib/smithers/coding-host.json")
  })
})
