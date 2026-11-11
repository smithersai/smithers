// The idle probe in a real branch sandbox: PID 1 is tini, which reaps orphans. The probe still ignores zombies and
// the box's own idle process. A person's running process keeps it awake. Skips only when Docker is absent.
import { execFileSync, spawnSync } from "node:child_process"
import { sandboxImage } from "../test/sandboxImage.globalSetup.ts"
import { asPerson } from "../test/sandboxPersons.ts"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { PROBE } from "./Machine.ts"

const image = sandboxImage

const docker = (args: ReadonlyArray<string>) => spawnSync("docker", args, { encoding: "utf8" })
const present = docker(["--version"]).status === 0
/** A person's numeric user in the `workspace` group, as a deployed box runs one. */
const PERSON = "585780777:2000"
/** A case that runs a command as `PERSON`: broken where Docker can't run that uid (worker/test/sandboxPersons.ts). */
const personTest = asPerson("docker", PERSON, present)

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

  personTest("PID 1 reaps an orphan a person leaves behind", () => {
    expect(read(["cat", "/proc/1/comm"])).toBe("tini")
    expect(exec(PERSON, ["sh", "-c", "(sleep 0.2 &); true"])).toBe(0)
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

  personTest("a zombie its live parent hasn't reaped is not work", () => {
    // The shell waits for the pipe to open while its child exits.
    expect(docker([
      "exec", "-d", "--user", PERSON, container,
      "sh", "-c", "mkfifo /tmp/f; sleep 0.1 & read x < /tmp/f",
    ]).status).toBe(0)
    try {
      execFileSync("sleep", ["1"])
      expect(zombies()).toBeGreaterThan(0)
      expect(probe()).toBe(0)
    } finally {
      // protected_fifos refuses another user's FIFO even for container root.
      expect(exec(PERSON, ["timeout", "5", "sh", "-c", "echo done > /tmp/f"])).toBe(0)
    }
  }, 60_000)

  personTest("a process a person runs keeps the machine awake", () => {
    expect(docker(["exec", "-d", "--user", PERSON, container, "sleep", "30"]).status).toBe(0)
    execFileSync("sleep", ["1"])
    expect(probe()).toBe(4)
  }, 60_000)
})
