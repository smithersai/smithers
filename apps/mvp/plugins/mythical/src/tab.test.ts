import { Host } from "@smthrs/plugin"
import { Effect, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { make, type PluginHostShape } from "./tab.ts"

const REPO: Host.Repository = { owner: "smithersai", name: "smithers" }

describe("Mythical plugin tab", () => {
  test("subscribes to core/feeds, selects latest commit, and steps via actions.step", async () => {
    const docs = [
      {
        id: "smithersai/smithers:mythical",
        repo: "smithersai/smithers",
        name: "mythical",
        body: {
          generatedAt: "2026-11-27T00:00:00Z",
          treeEqualToMain: true,
          commits: [
            { position: 1, epic: "foundation", title: "Initial cloud store", summary: "R2 + Postgres", treeEqualToMain: true, authorLogin: "roninjin10", notes: [] },
            { position: 2, epic: "audit", title: "Lighthouse provenance", summary: "Trusted vs untrusted", treeEqualToMain: true, authorLogin: "roninjin10", notes: [] },
          ],
        },
        updatedAt: "2026-11-27T00:00:00Z",
      },
    ]
    const host = {
      query: () =>
        Effect.succeed({
          current: () => docs,
          subscribe: () => () => {},
        }),
      events: () => Stream.empty,
      open: () => Effect.void,
    } as unknown as PluginHostShape

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tab = yield* make(host)
          const watched = tab.queries.state(REPO)
          yield* Effect.sleep("20 millis")
          expect(watched.current().status).toBe("ready")
          expect(watched.current().commits.length).toBe(2)
          expect(watched.current().selectedPosition).toBe(2)

          tab.actions.select(REPO, 1)
          expect(watched.current().selectedPosition).toBe(1)

          tab.actions.step(REPO, 1)
          expect(watched.current().selectedPosition).toBe(2)

          tab.actions.step(REPO, -1)
          expect(watched.current().selectedPosition).toBe(1)
        }),
      ),
    )
  })

  test("renders refused status cleanly when core/feeds query fails", async () => {
    const host = {
      query: () => Effect.fail(new Error("private_repo")),
      events: () => Stream.empty,
      open: () => Effect.void,
    } as unknown as PluginHostShape

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tab = yield* make(host)
          const watched = tab.queries.state(REPO)
          yield* Effect.sleep("20 millis")
          expect(watched.current().status).toBe("refused")
        }),
      ),
    )
  })
})
