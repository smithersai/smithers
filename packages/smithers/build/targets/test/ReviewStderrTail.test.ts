import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import { Process } from "../src/internal/Process.ts"
import * as Review from "../src/LlmLint.ts"

it("retains the diagnostic suffix when a host stderr chunk exceeds the entire tail buffer", async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "review-stderr-tail-")))
  try {
    const executable = Path.join(root, "reviewer.mjs")
    const stderrPath = Path.join(root, "stderr.txt")
    await Fs.writeFile(
      executable,
      "#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>process.exit(3));\n"
    )
    await Fs.chmod(executable, 0o755)
    await Fs.writeFile(stderrPath, "discarded-prefix:" + "x".repeat(128 * 1024) + ":retained-suffix")
    const chunk = await Fs.readFile(stderrPath)
    const error = await Effect.runPromise(Effect.flip(
      Review.promptEngine({ workspaceRoot: root, executable }, {
        engine: "claude",
        model: "fixture",
        prompt: "Review"
      }).pipe(Effect.provideService(Process, {
        spawn: (options) =>
          ScopedProcess.spawn(options).pipe(Effect.map((handle) => ({
            ...handle,
            stderr: Stream.fromIterable([chunk])
          }))),
        status: ScopedProcess.status
      }))
    ))
    expect(error).toMatchObject({ phase: "review" })
    expect(error.message).toContain("exited 3")
    expect(error.message).toContain(":retained-suffix")
    expect(error.message).not.toContain("discarded-prefix")
    expect(error.message.length).toBeLessThan(8192)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})
