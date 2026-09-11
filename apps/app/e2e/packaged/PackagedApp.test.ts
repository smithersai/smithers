import { expect, test } from "bun:test"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { PackagedApp } from "./PackagedApp"

test.skipIf(process.platform === "win32")("quit leaves another process group using the same executable alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-owned-process-test-"))
  const executable = join(root, "sleep")
  await writeFile(join(root, "sleep.c"), `
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  if (getenv("FORK_CHILD") != NULL) {
    pid_t child = fork();
    if (child > 0) { printf("%d\\n", child); fflush(stdout); }
  }
  for (;;) pause();
}
`)
  await promisify(execFile)("/usr/bin/cc", [join(root, "sleep.c"), "-o", executable])
  const owned = spawn(executable, [], {
    detached: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, FORK_CHILD: "1" }
  })
  const descendant = once(owned.stdout!, "data").then(([chunk]) => Number(String(chunk).trim()))
  const other = spawn(executable, ["60"], { detached: true, stdio: "ignore" })
  const ownedExit = once(owned, "exit")
  const otherExit = once(other, "exit")
  try {
    await Promise.all([once(owned, "spawn"), once(other, "spawn")])
    const app = Object.assign(Object.create(PackagedApp.prototype), {
      executable, child: owned, processGroup: owned.pid, logBuffer: "",
      exit: ownedExit,
      request: async () => { owned.kill("SIGTERM") }
    }) as PackagedApp
    const descendantPid = await descendant
    expect(Number.isSafeInteger(descendantPid) && descendantPid > 1).toBe(true)
    await app.quit()
    expect(owned.signalCode).toBe("SIGTERM")
    expect(() => process.kill(descendantPid, 0)).toThrow()
    expect(other.exitCode).toBeNull()
    expect(other.signalCode).toBeNull()
    expect(() => process.kill(other.pid!, 0)).not.toThrow()
  } finally {
    try { process.kill(-owned.pid!, "SIGKILL") } catch { /* The owned group already exited. */ }
    owned.kill("SIGKILL")
    other.kill("SIGKILL")
    await Promise.all([ownedExit, otherExit])
    await rm(root, { recursive: true, force: true })
  }
})
