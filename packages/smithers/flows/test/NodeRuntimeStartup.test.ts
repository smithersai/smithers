import { expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as NodeRuntime from "../src/NodeRuntime.ts"

it("builds the host before the runtime creates its repository and database parent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flows-startup-"))
  const previous = process.env.SMITHERS_JJ_PATH
  const binary = join(directory, "jj")
  writeFileSync(binary, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"jj 0.39.0\"; fi\n", { mode: 0o755 })
  process.env.SMITHERS_JJ_PATH = binary
  const root = join(directory, "missing", "repository")
  const filename = join(root, "runtime.sqlite")
  try {
    await Effect.runPromise(Effect.provide(Jj, NodeHost.layerAt(root)))
    expect(existsSync(join(directory, "missing"))).toBe(false)
    await Effect.runPromise(
      Effect.void.pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            { filename, workspaceRoot: root, owner: { hostId: "startup" }, signals: [] },
            Layer.empty
          )
        ),
        Effect.scoped
      )
    )
    const database = new DatabaseSync(filename, { readOnly: true })
    try {
      // The contained jj layer validates its pinned executable at startup.
      expect(database.prepare("SELECT event_type FROM flows_journal_events ORDER BY seq").all()).toEqual([
        { event_type: "flows.host.process-spawned.v1" },
        { event_type: "flows.host.process-exited.v1" }
      ])
    } finally {
      database.close()
    }
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_JJ_PATH
    else process.env.SMITHERS_JJ_PATH = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
