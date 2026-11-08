import { Effect } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { withProductionRegistries } from "./fixtures/host-registries.ts"

test("built native and coding hosts expose their actual private registrations", { timeout: 120_000 }, async () => {
  await withProductionRegistries((inventories, runtimes) =>
    Effect.sync(() => {
      assert.deepEqual(inventories.map((inventory) => inventory.host), ["native", "coding", "coding-wiki"])
      assert.equal(runtimes.length, 3)
      assert.ok(inventories[0]!.tags.some((tag) => tag.id === "agent/run"))
      for (const inventory of inventories) {
        for (
          const id of [
            "coding/prepare-vibe-candidate",
            "coding/fast-forward-vibe",
            "coding/open-vibe-local-pull",
            "coding/merge-vibe-local-pull",
            "coding/AwaitVibePullChecks",
            "coding/read-vibe-delivery",
            "coding/open-vibe-pull",
            "coding/prepare-vibe-append",
            "coding/create-vibe-landing",
            "coding/queue-vibe-append",
            "coding/observe-vibe-append",
            "coding/verify-vibe-landed",
            "coding/AwaitVibeAppend"
          ]
        ) {
          assert.equal(inventory.tags.some((tag) => tag.id === id), false, `${inventory.host}: ${id}`)
        }
      }
      const coding = inventories[1]!.tags
      assert.ok(coding.some((tag) => tag.id === "coding/ImplementAtom"))
      for (const inventory of inventories.filter((row) => row.host !== "native")) {
        for (const id of ["coding/LandVibe", "coding/read-vibe-stack", "coding/submit-vibe-lane"]) {
          assert.ok(inventory.tags.some((tag) => tag.id === id), `${inventory.host}: ${id}`)
        }
      }
      assert.ok(inventories[2]!.tags.some((tag) => tag.id === "coding/RefreshWiki"))
      assert.ok(
        coding.some((tag) => tag.id === "coding/prepare-atom" && tag.source === ".smithers/flows/coding/atoms.vibe")
      )
      // These are the actual private layers, not the already-clean public
      // repository route inventory. Keep identifying pending migrations.
      assert.equal(coding.some((tag) => tag.id === "coding/Vibe"), false, "delivery is inlined in the TODO plan")
      assert.equal(coding.some((tag) => tag.id === "coding/Request"), false, "request is inlined in the TODO plan")
    })
  )
})

test(
  "hosted maintainer composition retains its repository execution and recovery layers",
  { timeout: 120_000 },
  async () => {
    const inventory = await withProductionRegistries((inventories) => Effect.succeed(inventories), undefined, true)
    for (const host of inventory.filter((row) => row.host !== "native")) {
      for (
        const id of [
          "repository/RunJob",
          "repository/RunSetup",
          "repository/ScoreExecution",
          "repository/CheckStep",
          "repository/RegisterCandidate",
          "repository/DeliverChange",
          "coding/prepare-vibe-candidate",
          "coding/fast-forward-vibe",
          "coding/open-vibe-local-pull",
          "coding/merge-vibe-local-pull",
          "coding/AwaitVibePullChecks",
          "coding/read-vibe-delivery",
          "coding/open-vibe-pull",
          "coding/prepare-vibe-append",
          "coding/create-vibe-landing",
          "coding/queue-vibe-append",
          "coding/observe-vibe-append",
          "coding/verify-vibe-landed",
          "coding/AwaitVibeAppend"
        ]
      ) {
        assert.ok(host.tags.some((tag) => tag.id === id), `${host.host}: ${id}`)
      }
    }
  }
)
