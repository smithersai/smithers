import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { NodeHost } from "@smthrs/platform-node"
import { Effect, PlatformError } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Checkpoint from "../../src/flow/Checkpoint.ts"

describe("checkpoint private publication", () => {
  for (const stage of ["directory", "write"] as const) {
    it.live(`refuses a checkpoint when its private ${stage} service fails`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "checkpoint-publication-"))),
        (root) =>
          Effect.gen(function*() {
            const source = join(root, "source.ts")
            yield* Effect.promise(() => writeFile(source, "retained source"))
            const native = yield* NodeHost.AtomicFileSystem.ownerPrivate
            const failure = Effect.fail(PlatformError.badArgument({
              module: "FileSystem",
              method: "publish",
              description: "faulty private publication"
            }))
            const faulty = stage === "directory"
              ? { ...native, directory: () => failure }
              : { ...native, write: () => failure }
            const outcome = yield* Effect.exit(
              Checkpoint.take({
                root,
                unit: "publication",
                files: ["source.ts"],
                backupDir: join(root, "reports", "backup"),
                allowNoVcs: true
              }).pipe(Effect.provideService(NodeHost.AtomicFileSystem.ownerPrivate, faulty))
            )
            expect(outcome._tag).toBe("Failure")
            expect(yield* Effect.promise(() => readFile(source, "utf8"))).toBe("retained source")
          }),
        (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
      ).pipe(Effect.provide(NodeServices.layer)))
  }
})
