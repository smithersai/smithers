// The sandbox suites' cases that run a command as a person's numeric user. A rootless container engine maps only its
// user's /etc/subuid range, 65,536 ids by default, and every person's uid is above it (worker/branch/Users.ts), so on
// such a host those commands fail ("unable to setup user: chown /dev/stdout"). There the cases are marked broken
// (TEST-5): they still run, are expected to fail, and fail the run if they pass. docs/infrastructure.md says what a host
// needs for them to run as they do on a deployed box.
import { spawnSync } from "node:child_process"
import { test } from "vitest"
import { sandboxImage } from "./sandboxImage.globalSetup.ts"

/**
 * Whether `engine` runs a container of the sandbox image as `user` (`uid:gid`). Its stdout is a pipe, as a suite's
 * exec's is: the runtime gives it to the user, which an unmapped uid can't own.
 */
export const runsAs = (engine: string, user: string): boolean =>
  spawnSync(engine, ["run", "--rm", "--entrypoint", "/bin/sh", "--user", user, sandboxImage, "-c", "true"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  }).status === 0

/** A case: its name, its body and its timeout. */
export type Case = (name: string, body: () => unknown, timeout?: number) => void

/**
 * How a suite declares a case that runs commands as `user` with `engine`: as `test`, unless `engine` runs the image as
 * root but not as `user`. Then the case is `test.fails`, its name saying it is broken on this host and why. Measured
 * once per suite, and not at all where `present` is false (the suite is skipped).
 */
export const asPerson = (engine: string, user: string, present: boolean): Case =>
  !present || !runsAs(engine, "0:0") || runsAs(engine, user)
    ? (name, body, timeout) => test(name, body, timeout)
    : (name, body, timeout) =>
      test.fails(
        `${name} (broken on this host: ${engine} can't run uid ${user.split(":")[0]}; docs/infrastructure.md)`,
        body,
        timeout,
      )
