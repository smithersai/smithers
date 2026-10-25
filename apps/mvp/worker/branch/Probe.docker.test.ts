// The idle probe in a real branch sandbox: PID 1 is tini, which reaps orphans. The probe still ignores zombies and
// the box's own idle process. A person's running process keeps it awake. Skips only when Docker is absent.
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { PROBE } from "./Machine.ts"

const image = "smithers-branch-sandbox:test"
const context = fileURLToPath(new URL("../../infra/sandbox", import.meta.url))

const docker = (args: ReadonlyArray<string>) => spawnSync("docker", args, { encoding: "utf8" })
const present = docker(["--version"]).status === 0

let container = ""

/** Runs `argv` in the container as `user` (uid:gid): its exit status. */
const exec = (user: string, argv: ReadonlyArray<string>) => docker(["exec", "--user", user, container, ...argv]).status

/** Reads the container as root, including processes owned by a person. */
const read = (argv: ReadonlyArray<string>) => {
  const result = docker(["exec", "--user", "0:0", container, ...argv])
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

const zombies = () => Number(read([
  "sh", "-c", "grep -l '^State:[[:space:]]*Z' /proc/[0-9]*/status 2>/dev/null | wc -l",
]))

/** The probe, run as root as the machine runs it, with an idle time of a minute. */
const probe = () => exec("0:0", ["sh", "-c", PROBE, "probe", "60"])

describe.skipIf(!present)("the idle probe in a real container", () => {
  beforeAll(() => {
    execFileSync("docker", ["build", "-t", image, context], { stdio: "inherit" })
  }, 600_000)

  beforeEach(() => {
    const started = docker(["run", "-d", "--rm", image])
    container = started.stdout.trim()
    expect(started.status, started.stderr).toBe(0)
    expect(container).not.toBe("")
  })

  afterEach(() => {
    if (container !== "") {
      const removed = docker(["rm", "-f", container])
      container = ""
      expect(removed.status, removed.stderr).toBe(0)
    }
  })

  test("PID 1 reaps an orphan a person leaves behind", () => {
    expect(read(["cat", "/proc/1/comm"])).toBe("tini")
    expect(exec("585780777:2000", ["sh", "-c", "(sleep 0.2 &); true"])).toBe(0)
    execFileSync("sleep", ["1"])
    expect(zombies()).toBe(0)
    expect(probe()).toBe(0)
  }, 60_000)

  test("the box's own idle process is not work", () => {
    const uid = read(["sh", "-c", `for p in /proc/[0-9]*; do
      [ "$(cat "$p/comm" 2>/dev/null)" = smithers-idle ] || continue
      stat -c %u "$p"
    done`])
    expect(Number(uid)).toBeGreaterThan(0)
    expect(probe()).toBe(0)
  })

  test("a zombie its live parent hasn't reaped is not work", () => {
    // The shell waits for the pipe to open while its child exits.
    expect(docker([
      "exec", "-d", "--user", "585780777:2000", container,
      "sh", "-c", "mkfifo /tmp/f; sleep 0.1 & read x < /tmp/f",
    ]).status).toBe(0)
    try {
      execFileSync("sleep", ["1"])
      expect(zombies()).toBeGreaterThan(0)
      expect(probe()).toBe(0)
    } finally {
      expect(exec("0:0", ["timeout", "5", "sh", "-c", "echo done > /tmp/f"])).toBe(0)
    }
  }, 60_000)

  test("a process a person runs keeps the machine awake", () => {
    expect(docker(["exec", "-d", "--user", "585780777:2000", container, "sleep", "30"]).status).toBe(0)
    execFileSync("sleep", ["1"])
    expect(probe()).toBe(4)
  }, 60_000)
})
